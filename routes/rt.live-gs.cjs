"use strict";

const express = require("express");
const router = express.Router();

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

// Node 18+ global fetch; yoksa node-fetch fallback
const _fetch = globalThis.fetch || require("node-fetch");

// Aynı data klasörü standardı
const DATA_DIR = path.join(__dirname, "..", "data");
const LIVE_FILE = path.join(DATA_DIR, "rt-live-gs.json");
const LIVE_DIR = path.join(DATA_DIR, "live");

// fixtureId -> dosya adı: Windows güvenli hale getir
function safeFilePart(s) {
  return String(s || "")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .slice(0, 180);
}
const LIVE_STATE_FILE = (fid) => path.join(LIVE_DIR, `${safeFilePart(fid)}.json`);

// İç API’yi çağırmak için (provider tarafı hazırda bekliyor)
const INTERNAL_PORT = Number(process.env.PORT || 4102);
const INTERNAL_BASE = `http://127.0.0.1:${INTERNAL_PORT}`;

// Sağlayıcıyı 8 dakikada 1’den sık çağırma
const PROVIDER_COOLDOWN_MS = 8 * 60 * 1000;

// Şimdilik test döneminde takip edeceğimiz takımlar (auto provider pull)
const AUTO_TEAMS = ["galatasaray", "fenerbahce", "fenerbahçe"];

// ---- JSON helpers ----
async function readJson(file, fb) {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"));
  } catch {
    return fb;
  }
}
async function writeJson(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(data, null, 2), "utf8");
}

function emptyLiveModel() {
  return {
    fixtures: {}, // fixtureId -> state
    updatedAt: null,
  };
}

async function loadLive() {
  const m = await readJson(LIVE_FILE, null);
  if (!m || typeof m !== "object") return emptyLiveModel();
  if (!m.fixtures || typeof m.fixtures !== "object") m.fixtures = {};
  return m;
}

async function saveLive(m) {
  m.updatedAt = new Date().toISOString();
  await writeJson(LIVE_FILE, m);
}

// Küçük yardımcı
function normFixtureId(id) {
  return String(id || "").trim();
}
function normTeamName(name) {
  return String(name || "").trim();
}
function isAutoTeam(name) {
  const n = normTeamName(name).toLowerCase();
  return AUTO_TEAMS.includes(n);
}

function isLiveStatus(st) {
  const s = String(st || "").toUpperCase();
  if (!s) return false;
  if (s === "NS" || s === "FT") return false;
  return true; // LIVE/HT/1H/2H/ET/PEN vb.
}

// ---- LIVE STATE SYNC (settle2 / realtime için) ----
async function syncLiveStateForFixture(merged) {
  try {
    const fid = normFixtureId(merged && merged.fixtureId);
    if (!fid) return;

    const nowISO = new Date().toISOString();

    const scoreHome = Number(
      merged.homeGoals ??
        merged.scoreHome ??
        (merged.score && merged.score.home) ??
        0
    );
    const scoreAway = Number(
      merged.awayGoals ??
        merged.scoreAway ??
        (merged.score && merged.score.away) ??
        0
    );

    const htHome = merged.htScore?.home ?? merged.htHome;
    const htAway = merged.htScore?.away ?? merged.htAway;
    const hasHT = Number.isFinite(Number(htHome)) && Number.isFinite(Number(htAway));

    const entryLCVal =
      merged.entryLC != null && !Number.isNaN(Number(merged.entryLC))
        ? Number(merged.entryLC)
        : null;

    const rewardBoostVal =
      merged.rewardBoost != null && !Number.isNaN(Number(merged.rewardBoost))
        ? Number(merged.rewardBoost)
        : null;

    // ✅ event-stamp alanları ROOT’TA
    const st = {
      fixtureId: fid,
      status: merged.status || "NS",
      minute:
        typeof merged.minute === "number"
          ? merged.minute
          : merged.minute == null
          ? null
          : Number(merged.minute) || null,

      isLive: isLiveStatus(merged.status),

      country: merged.country || "Türkiye",
      league: merged.league || "Süper Lig",

      teamHome: merged.teamHome || merged.home || null,
      teamAway: merged.teamAway || merged.away || null,
      kickoffISO: merged.kickoffISO || null,

      score: {
        home: Number.isFinite(scoreHome) ? scoreHome : 0,
        away: Number.isFinite(scoreAway) ? scoreAway : 0,
      },

      redEventAtISO: merged.redEventAtISO || null,
      redEventMinute:
        merged.redEventMinute == null ? null : Number(merged.redEventMinute),

      penEventAtISO: merged.penEventAtISO || null,
      penEventMinute:
        merged.penEventMinute == null ? null : Number(merged.penEventMinute),

      updatedAt: nowISO,
    };

    if (hasHT) {
      st.htScore = { home: Number(htHome), away: Number(htAway) };
    }

    if (merged.firstGoal) st.firstGoal = merged.firstGoal;
    if (typeof merged.redHome !== "undefined") st.redHome = !!merged.redHome;
    if (typeof merged.redAway !== "undefined") st.redAway = !!merged.redAway;
    if (typeof merged.penaltyAny !== "undefined") st.penaltyAny = !!merged.penaltyAny;
    if (typeof merged.penaltySide !== "undefined") st.penaltySide = merged.penaltySide;

    if (entryLCVal != null) st.entryLC = entryLCVal;
    if (rewardBoostVal != null) st.rewardBoost = rewardBoostVal;

    await writeJson(LIVE_STATE_FILE(fid), st);
  } catch (e) {
    console.error("SYNC_LIVE_STATE_FAILED", e);
  }
}

// ---- FIXTURE STATE YÖNETİMİ ----
async function getFixtureState(fixtureId) {
  const m = await loadLive();
  const fx = normFixtureId(fixtureId);
  return m.fixtures[fx] || null;
}

/**
 * patch:
 *  - minute, status, homeGoals, awayGoals, phase
 *  - htHome, htAway, firstGoal
 *  - redHome, redAway, penaltyAny, penaltySide
 *  - country, league
 *  - entryLC, rewardBoost
 *  - note (event)
 *  - resetEvents (true => events sıfırlanır)
 *  - eventsOverride: Timeline’ı komple override et (admin-edit için)
 *  - teamHome, teamAway
 *  - source ("manual" | "provider")
 *  - providerName, providerRaw
 */
async function upsertFixtureState(fixtureId, patch) {
  const fx = normFixtureId(fixtureId);
  if (!fx) throw new Error("FIXTURE_ID_REQUIRED");

  const m = await loadLive();
  const existing = m.fixtures[fx] || {
    fixtureId: fx,
    createdAt: new Date().toISOString(),
    events: [],
  };

  // ✅ önceki event durumu (stamp için)
  const prevRedHome = typeof existing.redHome !== "undefined" ? !!existing.redHome : null;
  const prevRedAway = typeof existing.redAway !== "undefined" ? !!existing.redAway : null;
  const prevPenAny = typeof existing.penaltyAny !== "undefined" ? !!existing.penaltyAny : null;

  // event zamanı için referans dakika: patch.minute varsa onu al, yoksa existing.minute
  const refMinute =
    patch.minute != null
      ? Number(patch.minute)
      : existing.minute != null
      ? Number(existing.minute)
      : null;

  const nowEventISO = new Date().toISOString();

  let events;

  // 1) eventsOverride
  if (Array.isArray(patch.eventsOverride)) {
    events = patch.eventsOverride.map((ev) => {
      const minute =
        ev.minute == null ? null : Number.isFinite(Number(ev.minute)) ? Number(ev.minute) : null;

      const homeGoals =
        ev.homeGoals == null
          ? null
          : Number.isFinite(Number(ev.homeGoals))
          ? Number(ev.homeGoals)
          : null;

      const awayGoals =
        ev.awayGoals == null
          ? null
          : Number.isFinite(Number(ev.awayGoals))
          ? Number(ev.awayGoals)
          : null;

      return {
        at: ev.at || new Date().toISOString(),
        minute,
        homeGoals,
        awayGoals,
        note: ev.note || "",
        source: ev.source || "manual",
      };
    });
  } else {
    // 2) normal: mevcut events kopyala, reset + note yönet
    events = Array.isArray(existing.events) ? existing.events.slice() : [];

    if (patch.resetEvents) {
      events.length = 0;

      // ✅ reset ile stamp’leri de temizle
      existing.redEventAtISO = null;
      existing.redEventMinute = null;
      existing.penEventAtISO = null;
      existing.penEventMinute = null;
    }

    if (patch.note) {
      const ev = {
        at: new Date().toISOString(),
        minute: patch.minute != null ? patch.minute : existing.minute ?? null,
        homeGoals: patch.homeGoals != null ? patch.homeGoals : existing.homeGoals ?? null,
        awayGoals: patch.awayGoals != null ? patch.awayGoals : existing.awayGoals ?? null,
        note: patch.note,
        source: patch.source || "manual",
      };
      events.push(ev);
    }
  }

  const cleanPatch = { ...patch };
  delete cleanPatch.eventsOverride;
  delete cleanPatch.resetEvents;
  delete cleanPatch.note;

  const merged = {
    ...existing,
    ...cleanPatch,
    fixtureId: fx,
    events,
    updatedAt: new Date().toISOString(),
  };

  // ---- EVENT STAMP (hile engeli için) ----
  const prevRedAny = (prevRedHome === true) || (prevRedAway === true);

  const nextRedHome =
    typeof merged.redHome !== "undefined" ? !!merged.redHome : null;
  const nextRedAway =
    typeof merged.redAway !== "undefined" ? !!merged.redAway : null;
  const nextRedAny = (nextRedHome === true) || (nextRedAway === true);

  if (!prevRedAny && nextRedAny) {
    if (!merged.redEventAtISO) merged.redEventAtISO = nowEventISO;
    if (merged.redEventMinute == null && Number.isFinite(refMinute)) {
      merged.redEventMinute = refMinute;
    }
  }

  const prevPenAnyBool = (prevPenAny === true);
  const nextPenAny =
    typeof merged.penaltyAny !== "undefined" ? !!merged.penaltyAny : null;

  if (prevPenAnyBool !== true && nextPenAny === true) {
    if (!merged.penEventAtISO) merged.penEventAtISO = nowEventISO;
    if (merged.penEventMinute == null && Number.isFinite(refMinute)) {
      merged.penEventMinute = refMinute;
    }
  }

  m.fixtures[fx] = merged;
  await saveLive(m);
  await syncLiveStateForFixture(merged);
  return merged;
}

// ---- PROVIDER TARAFI (İÇ API üstünden) ----
async function safeFetchJson(url, opts = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await _fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(tid);

    const ct = String(res.headers?.get?.("content-type") || "");
    const text = await res.text();
    const head = String(text || "").slice(0, 240).replace(/\s+/g, " ");
    const looksHtml =
      head.startsWith("<!DOCTYPE") || head.startsWith("<html") || ct.includes("text/html");

    if (!res.ok) {
      throw new Error(`HTTP_${res.status} from ${url}: ${head}`);
    }
    if (looksHtml) {
      throw new Error(`NON_JSON_RESPONSE from ${url}: ${head}`);
    }

    try {
      return text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`BAD_JSON_FROM ${url}: ${head}`);
    }
  } catch (e) {
    clearTimeout(tid);
    throw e;
  }
}

/**
 * Sağlayıcıdan, kendi live2 fav endpoint’imiz üzerinden çek.
 * - Sadece Galatasaray / Fenerbahçe için
 * - 8 dakikadan sık çekmez
 */
async function pullFromProviderIfNeeded(fixtureId, teamName) {
  const fx = normFixtureId(fixtureId);
  const team = normTeamName(teamName);

  if (!fx || !team) return null;
  if (!isAutoTeam(team)) return null;

  const state = (await getFixtureState(fx)) || {};
  const lastPull = state.lastProviderPullAt ? new Date(state.lastProviderPullAt).getTime() : 0;
  const now = Date.now();

  if (lastPull && now - lastPull < PROVIDER_COOLDOWN_MS) {
    return state;
  }

  const url = `${INTERNAL_BASE}/api/live2/fav?team=${encodeURIComponent(team)}`;

  let fav;
  try {
    fav = await safeFetchJson(url);
  } catch {
    return state; // sağlayıcı göçerse sessizce dön
  }

  if (!fav?.ok || !Array.isArray(fav.fixtures) || fav.fixtures.length === 0) {
    return state;
  }

  // 1) fixtureId eşleşmesi
  let match = fav.fixtures.find((it) => String(it.fixtureId || "") === fx) || null;

  // 2) yoksa takım adına göre en yakın
  if (!match) {
    const lc = team.toLowerCase();
    const candidates = fav.fixtures.filter((it) => {
      const h = String(it.home || "").toLowerCase();
      const a = String(it.away || "").toLowerCase();
      return h.includes(lc) || a.includes(lc);
    });

    match =
      candidates
        .slice()
        .sort((a, b) => new Date(a.kickoffISO || 0) - new Date(b.kickoffISO || 0))[0] || null;
  }

  if (!match) return state;

  const homeGoals = Number(match.homeGoals ?? match.goalsHome ?? match.homeScore ?? 0);
  const awayGoals = Number(match.awayGoals ?? match.goalsAway ?? match.awayScore ?? 0);

  const patch = {
    fixtureId: fx,
    teamHome: match.home || state.teamHome || null,
    teamAway: match.away || state.teamAway || null,
    kickoffISO: match.kickoffISO || state.kickoffISO || null,
    minute: match.minute ?? state.minute ?? null,
    status: match.status || state.status || "LIVE",
    homeGoals: Number.isFinite(homeGoals) ? homeGoals : state.homeGoals ?? null,
    awayGoals: Number.isFinite(awayGoals) ? awayGoals : state.awayGoals ?? null,
    source: "provider",
    providerName: match.source || "provider",
    providerRaw: match,
    lastProviderPullAt: new Date().toISOString(),
  };

  return await upsertFixtureState(fx, patch);
}

// ---- ROUTES ----
router.get("/live-gs", async (req, res) => {
  try {
    const fixtureId = normFixtureId(req.query.fixtureId);
    const team = normTeamName(req.query.team || "");

    if (!fixtureId) {
      return res.status(400).json({ ok: false, error: "FIXTURE_ID_REQUIRED" });
    }

    let state = await getFixtureState(fixtureId);

    // Eğer GS/FB ve provider’a izinliysek → 8 dakikada bir iç API’den çek
    if (team && isAutoTeam(team)) {
      state = (await pullFromProviderIfNeeded(fixtureId, team)) || state;
    }

    if (!state) {
      return res.json({ ok: true, fixtureId, exists: false, state: null });
    }

    res.json({
      ok: true,
      fixtureId,
      exists: true,
      minute: state.minute ?? null,
      status: state.status || "NS",
      homeGoals: state.homeGoals ?? null,
      awayGoals: state.awayGoals ?? null,
      teamHome: state.teamHome || null,
      teamAway: state.teamAway || null,
      source: state.source || "manual",
      updatedAt: state.updatedAt || null,
      kickoffISO: state.kickoffISO || null,

      country: state.country || null,
      league: state.league || null,

      entryLC: state.entryLC ?? null,
      rewardBoost: state.rewardBoost ?? null,

      // event stamp alanlarını API’den de göstersin (debug)
      redEventAtISO: state.redEventAtISO || null,
      redEventMinute: state.redEventMinute ?? null,
      penEventAtISO: state.penEventAtISO || null,
      penEventMinute: state.penEventMinute ?? null,

      events: Array.isArray(state.events) ? state.events : [],
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: "LIVE_GS_FAILED",
      detail: String(e && (e.message || e)),
    });
  }
});

router.post("/admin-live-gs", express.json(), async (req, res) => {
  try {
    const fixtureId = normFixtureId(req.body.fixtureId);
    if (!fixtureId) {
      return res.status(400).json({ ok: false, error: "FIXTURE_ID_REQUIRED" });
    }

    const patch = {};

    if (req.body.teamHome != null) patch.teamHome = normTeamName(req.body.teamHome);
    if (req.body.teamAway != null) patch.teamAway = normTeamName(req.body.teamAway);
    if (req.body.kickoffISO != null) patch.kickoffISO = String(req.body.kickoffISO);

    if (req.body.country != null) patch.country = String(req.body.country);
    if (req.body.league != null) patch.league = String(req.body.league);

    if (req.body.minute != null) patch.minute = Number(req.body.minute);
    if (req.body.status != null) patch.status = String(req.body.status);

    if (req.body.homeGoals != null) patch.homeGoals = Number(req.body.homeGoals);
    if (req.body.awayGoals != null) patch.awayGoals = Number(req.body.awayGoals);

    if (req.body.phase != null) patch.phase = String(req.body.phase);

    if (req.body.htHome != null) patch.htHome = Number(req.body.htHome);
    if (req.body.htAway != null) patch.htAway = Number(req.body.htAway);

    if (req.body.firstGoal != null) patch.firstGoal = String(req.body.firstGoal);

    if (typeof req.body.redHome !== "undefined") patch.redHome = !!req.body.redHome;
    if (typeof req.body.redAway !== "undefined") patch.redAway = !!req.body.redAway;

    if (typeof req.body.penaltyAny !== "undefined") patch.penaltyAny = !!req.body.penaltyAny;
    if (req.body.penaltySide != null) patch.penaltySide = String(req.body.penaltySide);

    if (req.body.entryLC != null) patch.entryLC = Number(req.body.entryLC);
    if (req.body.rewardBoost != null) patch.rewardBoost = Number(req.body.rewardBoost);

    if (req.body.note != null) patch.note = String(req.body.note);
    if (req.body.resetEvents) patch.resetEvents = true;
    if (Array.isArray(req.body.eventsOverride)) patch.eventsOverride = req.body.eventsOverride;

    patch.source = "manual";

    const updated = await upsertFixtureState(fixtureId, patch);
    res.json({ ok: true, fixtureId, state: updated });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: "ADMIN_LIVE_GS_FAILED",
      detail: String(e && (e.message || e)),
    });
  }
});

router.get("/admin-live-gs", async (req, res) => {
  try {
    const fixtureId = normFixtureId(req.query.fixtureId);
    if (!fixtureId) {
      return res.status(400).json({ ok: false, error: "FIXTURE_ID_REQUIRED" });
    }
    const state = await getFixtureState(fixtureId);
    res.json({ ok: true, fixtureId, state: state || null });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: "ADMIN_LIVE_GS_GET_FAILED",
      detail: String(e && (e.message || e)),
    });
  }
});

router.get("/admin-live-gs-all", async (req, res) => {
  try {
    const m = await loadLive();
    res.json({ ok: true, data: m });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: "ADMIN_LIVE_GS_ALL_FAILED",
      detail: String(e && (e.message || e)),
    });
  }
});

module.exports = router;
