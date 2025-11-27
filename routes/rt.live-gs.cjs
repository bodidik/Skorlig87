"use strict";

const express = require("express");
const router  = express.Router();
const fs      = require("fs");
const fsp     = fs.promises;
const path    = require("path");

// Aynı data klasörü standardı
const DATA_DIR   = path.join(__dirname, "..", "data");
const LIVE_FILE  = path.join(DATA_DIR, "rt-live-gs.json");

// İç API’yi çağırmak için (provider tarafı hazırda bekliyor)
const INTERNAL_PORT = Number(process.env.PORT || 4102);
const INTERNAL_BASE = `http://127.0.0.1:${INTERNAL_PORT}`;

// Sağlayıcıyı 8 dakikada 1’den sık çağırma
const PROVIDER_COOLDOWN_MS = 8 * 60 * 1000;

// Şimdilik test döneminde takip edeceğimiz takımlar
const AUTO_TEAMS = [
  "galatasaray",
  "fenerbahce",
  "fenerbahçe"
];

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
    fixtures: {},             // fixtureId -> state
    updatedAt: null
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

// ---- FIXTURE STATE YÖNETİMİ ----

async function getFixtureState(fixtureId) {
  const m = await loadLive();
  const fx = normFixtureId(fixtureId);
  return m.fixtures[fx] || null;
}

/**
 * patch:
 *  - minute, status, homeGoals, awayGoals, phase
 *  - note (event)
 *  - teamHome, teamAway
 *  - source ("manual" | "provider")
 *  - providerName, providerRaw
 *  - resetEvents (true => events sıfırlanır)
 */
async function upsertFixtureState(fixtureId, patch) {
  const fx = normFixtureId(fixtureId);
  if (!fx) throw new Error("FIXTURE_ID_REQUIRED");

  const m = await loadLive();
  const existing = m.fixtures[fx] || {
    fixtureId: fx,
    createdAt: new Date().toISOString(),
    events: []
  };

  const events = Array.isArray(existing.events)
    ? existing.events.slice()
    : [];

  // resetEvents istenmişse temizle
  if (patch.resetEvents) {
    events.length = 0;
  }

  // Not geldiyse event ekle (dakika/score ile birlikte)
  if (patch.note) {
    const ev = {
      at: new Date().toISOString(),
      minute: patch.minute != null ? patch.minute : existing.minute ?? null,
      homeGoals:
        patch.homeGoals != null ? patch.homeGoals : existing.homeGoals ?? null,
      awayGoals:
        patch.awayGoals != null ? patch.awayGoals : existing.awayGoals ?? null,
      note: patch.note,
      source: patch.source || "manual"
    };
    events.push(ev);
  }

  const merged = {
    ...existing,
    ...patch,
    fixtureId: fx,
    events,
    updatedAt: new Date().toISOString()
  };

  m.fixtures[fx] = merged;
  await saveLive(m);
  return merged;
}

// ---- PROVIDER TARAFI (İÇ API üstünden) ----

async function safeFetchJson(url, opts = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(tid);
    const text = await res.text();
    let j = null;
    try {
      j = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`BAD_JSON_FROM ${url}: ${text.slice(0, 200)}`);
    }
    if (!res.ok) {
      throw new Error(
        `HTTP_${res.status} from ${url}: ${JSON.stringify(j).slice(0, 200)}`
      );
    }
    return j;
  } catch (e) {
    clearTimeout(tid);
    throw e;
  }
}

/**
 * Sağlayıcıdan, kendi live2 fav endpoint’imiz üzerinden çek.
 * - Sadece Galatasaray / Fenerbahçe için
 * - Sadece maç saatine yakınsa anlamlı olacak (ama burada pencere kontrolünü live2 yapıyor)
 */
async function pullFromProviderIfNeeded(fixtureId, teamName) {
  const fx = normFixtureId(fixtureId);
  const team = normTeamName(teamName);

  if (!fx || !team) return null;
  if (!isAutoTeam(team)) return null; // sadece GS/FB

  const state = (await getFixtureState(fx)) || {};
  const lastPull = state.lastProviderPullAt
    ? new Date(state.lastProviderPullAt).getTime()
    : 0;
  const now = Date.now();

  // 8 dakikadan sık provider çağırma
  if (lastPull && now - lastPull < PROVIDER_COOLDOWN_MS) {
    return state; // mevcut state’i kullanalım
  }

  // live2 fav çağrısı (provider kuyruğunu o yönetiyor)
  const url = `${INTERNAL_BASE}/api/live2/fav?team=${encodeURIComponent(team)}`;
  let fav;
  try {
    fav = await safeFetchJson(url);
  } catch (e) {
    // Sağlayıcı göçerse sessizce dön, kullanıcıya yansıtma
    return state;
  }

  if (!fav?.ok || !Array.isArray(fav.fixtures) || fav.fixtures.length === 0) {
    // Sağlayıcı hala boşsa, mevcut state’e dokunma
    return state;
  }

  // Önce fixtureId eşleşmesi arıyoruz (ileride sağlayıcı ID’sini fixtureId yapınca çalışacak)
  let match =
    fav.fixtures.find(
      (it) => String(it.fixtureId || "") === fx
    ) || null;

  // Bulunamadıysa, aynı takımın içinde en yakın maçı seç (home/away üzerinden)
  if (!match) {
    const lc = team.toLowerCase();
    const candidates = fav.fixtures.filter((it) => {
      const h = String(it.home || "").toLowerCase();
      const a = String(it.away || "").toLowerCase();
      return h.includes(lc) || a.includes(lc);
    });

    // kickoffISO’ya göre en yakın maçı al
    match =
      candidates
        .slice()
        .sort(
          (a, b) =>
            new Date(a.kickoffISO || 0) - new Date(b.kickoffISO || 0)
        )[0] || null;
  }

  if (!match) {
    return state;
  }

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
    lastProviderPullAt: new Date().toISOString()
  };

  return await upsertFixtureState(fx, patch);
}

// ---- ROUTES ----

/**
 * GET /api/rt/live-gs
 *  - fixtureId: zorunlu
 *  - team: GS/FB için provider denemesi (opsiyonel ama önerilir)
 *
 * Örnek:
 *  GET /api/rt/live-gs?fixtureId=UCL-GS-USG-20251125&team=Galatasaray
 */
router.get("/live-gs", async (req, res) => {
  try {
    const fixtureId = normFixtureId(req.query.fixtureId);
    const team = normTeamName(req.query.team || "");

    if (!fixtureId) {
      return res
        .status(400)
        .json({ ok: false, error: "FIXTURE_ID_REQUIRED" });
    }

    let state = await getFixtureState(fixtureId);

    // Eğer GS/FB ve provider’a izinliysek → 8 dakikada bir iç API’den çek
    if (team && isAutoTeam(team)) {
      state =
        (await pullFromProviderIfNeeded(fixtureId, team)) || state;
    }

    if (!state) {
      return res.json({
        ok: true,
        fixtureId,
        exists: false,
        state: null
      });
    }

    // Kullanıcıya sade view
    res.json({
      ok: true,
      fixtureId,
      exists: true,
      minute: state.minute ?? null,
      status: state.status || "LIVE",
      homeGoals: state.homeGoals ?? null,
      awayGoals: state.awayGoals ?? null,
      teamHome: state.teamHome || null,
      teamAway: state.teamAway || null,
      source: state.source || "manual",
      updatedAt: state.updatedAt || null,
      kickoffISO: state.kickoffISO || null,
      // Admin panel vs için timeline da dursun
      events: Array.isArray(state.events) ? state.events : []
    });
  } catch (e) {
    res
      .status(500)
      .json({ ok: false, error: "LIVE_GS_FAILED", detail: String(e && (e.message || e)) });
  }
});

/**
 * POST /api/rt/admin-live-gs
 *  - fixtureId (zorunlu)
 *  - teamHome / teamAway (isteğe bağlı, ilk seferde doldurmak iyi olur)
 *  - minute, status, homeGoals, awayGoals, phase (opsiyonel)
 *  - note: timeline satırı için açıklama (opsiyonel)
 *  - resetEvents: true → timeline temizle
 *
 * Örnek body:
 * {
 *   "fixtureId": "UCL-GS-USG-20251125",
 *   "teamHome": "Galatasaray",
 *   "teamAway": "Union SG",
 *   "minute": 27,
 *   "status": "1H",
 *   "homeGoals": 1,
 *   "awayGoals": 0,
 *   "note": "27' Icardi (1-0)"
 * }
 */
router.post("/admin-live-gs", express.json(), async (req, res) => {
  try {
    const fixtureId = normFixtureId(req.body.fixtureId);
    if (!fixtureId) {
      return res
        .status(400)
        .json({ ok: false, error: "FIXTURE_ID_REQUIRED" });
    }

    const patch = {};

    if (req.body.teamHome != null)
      patch.teamHome = normTeamName(req.body.teamHome);
    if (req.body.teamAway != null)
      patch.teamAway = normTeamName(req.body.teamAway);
    if (req.body.kickoffISO != null)
      patch.kickoffISO = String(req.body.kickoffISO);

    if (req.body.minute != null)
      patch.minute = Number(req.body.minute);
    if (req.body.status != null)
      patch.status = String(req.body.status);

    if (req.body.homeGoals != null)
      patch.homeGoals = Number(req.body.homeGoals);
    if (req.body.awayGoals != null)
      patch.awayGoals = Number(req.body.awayGoals);

    if (req.body.phase != null)
      patch.phase = String(req.body.phase);

    if (req.body.note != null)
      patch.note = String(req.body.note);

    if (req.body.resetEvents)
      patch.resetEvents = true;

    patch.source = "manual";

    const updated = await upsertFixtureState(fixtureId, patch);

    res.json({
      ok: true,
      fixtureId,
      state: updated
    });
  } catch (e) {
    res
      .status(500)
      .json({ ok: false, error: "ADMIN_LIVE_GS_FAILED", detail: String(e && (e.message || e)) });
  }
});

/**
 * GET /api/rt/admin-live-gs
 *  - fixtureId zorunlu
 *  → admin için ham state’i döner
 */
router.get("/admin-live-gs", async (req, res) => {
  try {
    const fixtureId = normFixtureId(req.query.fixtureId);
    if (!fixtureId) {
      return res
        .status(400)
        .json({ ok: false, error: "FIXTURE_ID_REQUIRED" });
    }
    const state = await getFixtureState(fixtureId);
    res.json({
      ok: true,
      fixtureId,
      state: state || null
    });
  } catch (e) {
    res
      .status(500)
      .json({ ok: false, error: "ADMIN_LIVE_GS_GET_FAILED", detail: String(e && (e.message || e)) });
  }
});

/**
 * Küçük debug:
 * GET /api/rt/admin-live-gs-all
 */
router.get("/admin-live-gs-all", async (req, res) => {
  try {
    const m = await loadLive();
    res.json({ ok: true, data: m });
  } catch (e) {
    res
      .status(500)
      .json({ ok: false, error: "ADMIN_LIVE_GS_ALL_FAILED", detail: String(e && (e.message || e)) });
  }
});

module.exports = router;
