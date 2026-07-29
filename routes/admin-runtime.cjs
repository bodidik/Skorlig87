"use strict";

const express = require("express");
const router = express.Router();

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

const { getRuntimeMode, setRuntimeMode } = require("../lib/runtime-mode.cjs");

/* =========================================================
   Admin token (fail-closed koruma)
   - SKORLIG_ADMIN_TOKEN set DEĞİLSE: endpoint tamamen kapalı (503).
     Token unutulursa açıkta kalmasın diye güvenlik adına reddedilir.
   - Set ise: header x-admin-token / ?token eşleşmeli, yoksa 401.
   ========================================================= */
function requireAdminToken(req, res, next) {
  const token = String(process.env.SKORLIG_ADMIN_TOKEN || "").trim();
  if (!token) {
    return res.status(503).json({ ok: false, error: "ADMIN_TOKEN_NOT_CONFIGURED" });
  }

  const got =
    String(req.headers["x-admin-token"] || "").trim() ||
    String(req.query.token || "").trim();

  if (got && got === token) return next();

  return res.status(401).json({ ok: false, error: "ADMIN_TOKEN_REQUIRED" });
}

/* =========================================================
   Files
   ========================================================= */
const DATA_DIR = path.join(__dirname, "..", "data");
const FIXTURES_FILE = path.join(DATA_DIR, "fixtures.json");
const RESULTS_FILE = path.join(DATA_DIR, "results.json");

/* =========================================================
   JSON helpers (atomic write)
   ========================================================= */
async function readJson(file, fb) {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"));
  } catch {
    return fb;
  }
}
async function writeJsonAtomic(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fsp.rename(tmp, file);
}

/* =========================================================
   Fixtures store helpers
   - fixtures.json formatı projende bazen {fixtures:[...]} / {items:[...]} / direkt [...]
   ========================================================= */
function pickFixtures(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw.fixtures)) return raw.fixtures;
  if (Array.isArray(raw.items)) return raw.items;
  return [];
}
function wrapFixturesLike(raw, list) {
  if (Array.isArray(raw)) return list;
  if (raw && typeof raw === "object") {
    if (Array.isArray(raw.fixtures)) return { ...raw, fixtures: list };
    if (Array.isArray(raw.items)) return { ...raw, items: list };
    return { fixtures: list };
  }
  return { fixtures: list };
}
async function loadFixturesStore() {
  const raw = await readJson(FIXTURES_FILE, null);
  const list = pickFixtures(raw);
  return { raw, list };
}
async function saveFixturesStore(rawShape, list) {
  const out = wrapFixturesLike(rawShape, list);
  await writeJsonAtomic(FIXTURES_FILE, out);
}

/* =========================================================
   Results store helpers
   results.json:
   { items:[ { fixtureId, home, away, meta, updatedAt, updatedBy } ] }
   ========================================================= */
function emptyResultsStore() {
  return { items: [] };
}
async function loadResultsStore() {
  const raw = await readJson(RESULTS_FILE, null);
  if (!raw || typeof raw !== "object") return emptyResultsStore();
  if (!Array.isArray(raw.items)) raw.items = [];
  return raw;
}
async function saveResultsStore(store) {
  await writeJsonAtomic(RESULTS_FILE, store || emptyResultsStore());
}

/* =========================================================
   Time parsing helpers
   - kickoffISO örn: "2026-01-01T23:00:00Z" veya "27.12.2025 15:30:00"
   ========================================================= */
function parseKickoffMs(s) {
  const v = String(s || "").trim();
  if (!v) return null;

  // DD.MM.YYYY HH:mm(:ss)?
  const m1 = v.match(
    /^(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/
  );
  if (m1) {
    const dd = Number(m1[1]);
    const mm = Number(m1[2]);
    const yy = Number(m1[3]);
    const hh = Number(m1[4]);
    const mi = Number(m1[5]);
    const ss = Number(m1[6] || "0");
    const dt = new Date(yy, mm - 1, dd, hh, mi, ss, 0);
    const t = dt.getTime();
    return Number.isFinite(t) ? t : null;
  }

  // YYYY-MM-DD (saat yok) -> pending hesabında kullanma
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;

  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

function normId(x) {
  return String(x || "").trim();
}

function scoreFromFixture(fx) {
  const h =
    fx?.score?.home ??
    (typeof fx?.homeGoals === "number" ? fx.homeGoals : null) ??
    (typeof fx?.home === "number" ? fx.home : null);

  const a =
    fx?.score?.away ??
    (typeof fx?.awayGoals === "number" ? fx.awayGoals : null) ??
    (typeof fx?.away === "number" ? fx.away : null);

  const hh = typeof h === "number" && Number.isFinite(h) ? h : null;
  const aa = typeof a === "number" && Number.isFinite(a) ? a : null;
  return { hh, aa };
}

function safeTimeMs(x) {
  const t = new Date(x || 0).getTime();
  return Number.isFinite(t) ? t : 0;
}

/* =========================================================
   RUNTIME MODE ENDPOINTS
   ========================================================= */

// GET /api/admin/runtime-mode
router.get("/runtime-mode", requireAdminToken, async (req, res) => {
  try {
    const mode = await getRuntimeMode();
    return res.json({ ok: true, mode });
  } catch (e) {
    console.error("[runtime-mode] GET failed:", e);
    return res.status(500).json({
      ok: false,
      error: "RUNTIME_MODE_GET_FAILED",
      detail: String(e && (e.message || e)),
    });
  }
});

// POST /api/admin/runtime-mode
router.post(
  "/runtime-mode",
  requireAdminToken,
  express.json(),
  async (req, res) => {
    try {
      const body = req.body || {};
      const patch = {};

      const PRESETS = {
        DEV_4_TEAMS: {
          profile: "DEV_4_TEAMS",
          maxTeams: 4,
          maxLeagues: 1,
          notes: "4 takımlı geliştirme modu",
        },
        // Pilot: provider sıfır, tüm maçlar admin tarafından fixtures.json'a elle girilir.
        // Maksimum 10 aktif maç. Gerçek oyuncular, gerçek tahminler.
        PILOT_MANUAL: {
          profile: "PILOT_MANUAL",
          maxTeams: 0,        // provider çağrısı yok
          maxLeagues: 0,
          maxFixtures: 10,    // tek seferde en fazla 10 açık maç
          providerDisabled: true,
          notes: "Pilot: provider yok, maçlar elle girilir (max 10)",
        },
        TR_30_TEAMS: {
          profile: "TR_30_TEAMS",
          maxTeams: 30,
          maxLeagues: 1,
          notes: "Türkiye ligi (örnek 30 takım) modu",
        },
        GLOBAL_100_TEAMS: {
          profile: "GLOBAL_100_TEAMS",
          maxTeams: 100,
          maxLeagues: 5,
          notes: "Kısıtlı global test modu",
        },
        GLOBAL_456_TEAMS: {
          profile: "GLOBAL_456_TEAMS",
          maxTeams: 456,
          maxLeagues: 20,
          notes: "Tam global yüksek yük modu",
        },
      };

      if (body.preset) {
        const key = String(body.preset).toUpperCase();
        if (!PRESETS[key]) {
          return res.status(400).json({ ok: false, error: "UNKNOWN_PRESET" });
        }
        Object.assign(patch, PRESETS[key]);
      }

      if (typeof body.profile === "string") patch.profile = body.profile;
      if (typeof body.maxTeams === "number") patch.maxTeams = body.maxTeams;
      if (typeof body.maxLeagues === "number") patch.maxLeagues = body.maxLeagues;
      if (typeof body.notes === "string") patch.notes = body.notes;
      if (body.updatedBy) patch.updatedBy = String(body.updatedBy);

      const saved = await setRuntimeMode(patch);
      return res.json({ ok: true, mode: saved });
    } catch (e) {
      console.error("[runtime-mode] POST failed:", e);
      return res.status(500).json({
        ok: false,
        error: "RUNTIME_MODE_SET_FAILED",
        detail: String(e && (e.message || e)),
      });
    }
  }
);

// GET /api/admin/runtime-mode/ping
router.get("/runtime-mode/ping", (req, res) => {
  res.json({ ok: true, where: "admin-runtime-router-alive" });
});

/* =========================================================
   3.1) GET /api/admin/results/pending
   ========================================================= */
router.get("/results/pending", requireAdminToken, async (req, res) => {
  try {
    // guard: 5 dk - 24 saat arası
    let graceMin = Number(req.query.graceMin || 120);
    if (!Number.isFinite(graceMin)) graceMin = 120;
    graceMin = Math.max(5, Math.min(24 * 60, Math.floor(graceMin)));

    const nowMs = Date.now();

    const fxStore = await loadFixturesStore();
    const list = fxStore.list;

    const results = await loadResultsStore();
    const doneSet = new Set(
      (results.items || []).map((x) => normId(x.fixtureId)).filter(Boolean)
    );

    const pending = [];
    for (const fx of list) {
      const fixtureId = normId(fx?.fixtureId);
      if (!fixtureId) continue;
      if (doneSet.has(fixtureId)) continue;

      const kickoffISO = fx?.kickoffISO || fx?.kickoffDate || null;
      const kMs = parseKickoffMs(kickoffISO);
      if (!kMs) continue;

      const dueMs = kMs + graceMin * 60 * 1000;
      if (nowMs < dueMs) continue;

      const st = String(fx?.status || "").toUpperCase();
      const { hh, aa } = scoreFromFixture(fx);
      const hasScore = typeof hh === "number" && typeof aa === "number";

      if (!hasScore) {
        pending.push({
          fixtureId,
          home: fx?.home || null,
          away: fx?.away || null,
          kickoffISO: kickoffISO || null,
          status: st || null,
          minute: typeof fx?.minute === "number" ? fx.minute : null,
          reason: st === "FT" ? "FT_NO_SCORE" : "OVERDUE_NO_SCORE",
        });
      }
    }

    pending.sort((a, b) => {
      const ta = parseKickoffMs(a.kickoffISO) || 0;
      const tb = parseKickoffMs(b.kickoffISO) || 0;
      return ta - tb;
    });

    return res.json({
      ok: true,
      graceMin,
      count: pending.length,
      items: pending,
    });
  } catch (e) {
    console.error("ADMIN_RESULTS_PENDING_FAILED", e);
    return res.status(500).json({
      ok: false,
      error: "ADMIN_RESULTS_PENDING_FAILED",
      detail: String(e && (e.message || e)),
    });
  }
});

/* =========================================================
   3.2) POST /api/admin/results/set
   Body: { fixtureId, home, away,
           htHome?, htAway?, firstGoal?,           // mikro sonuçlar
           redHome?, redAway?, penaltyAny?, penaltySide?,
           meta?, updatedBy? }
   - fixtures.json + results.json günceller
   - data/live/<fid>.json state dosyasını RESMİ sonuçla ezer
     (settle2 bu dosyayı okur; canlı panelde kalan eski skor
      settle'ı bozmasın diye)
   ========================================================= */
const LIVE_DIR = path.join(DATA_DIR, "live");
function liveSafePart(s) {
  return String(s || "").trim().replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").slice(0, 180);
}
const LIVE_STATE_FILE = (fid) => path.join(LIVE_DIR, `${liveSafePart(fid)}.json`);

router.post("/results/set", requireAdminToken, express.json(), async (req, res) => {
  try {
    const body = req.body || {};
    const fixtureId = normId(body.fixtureId);
    const home = Number(body.home);
    const away = Number(body.away);

    if (!fixtureId) {
      return res.status(400).json({ ok: false, error: "FIXTURE_REQUIRED" });
    }
    if (!Number.isFinite(home) || !Number.isFinite(away)) {
      return res.status(400).json({ ok: false, error: "SCORE_REQUIRED" });
    }

    // Mikro sonuçlar (opsiyonel)
    const htHome = Number.isFinite(Number(body.htHome)) && body.htHome !== "" && body.htHome != null ? Number(body.htHome) : null;
    const htAway = Number.isFinite(Number(body.htAway)) && body.htAway !== "" && body.htAway != null ? Number(body.htAway) : null;
    const hasHT = htHome != null && htAway != null;
    const firstGoal = body.firstGoal === "H" || body.firstGoal === "A" ? body.firstGoal : null;
    const redHome = typeof body.redHome === "boolean" ? body.redHome : null;
    const redAway = typeof body.redAway === "boolean" ? body.redAway : null;
    const penaltyAny = typeof body.penaltyAny === "boolean" ? body.penaltyAny : null;
    const penaltySide = body.penaltySide === "H" || body.penaltySide === "A" ? body.penaltySide : null;

    const meta = body.meta && typeof body.meta === "object" ? body.meta : {};
    const updatedBy = normId(body.updatedBy) || "admin";
    const nowISO = new Date().toISOString();

    // 1) fixtures.json içinde var mı, bul + patchle
    const fxStore = await loadFixturesStore();
    const idx = fxStore.list.findIndex((x) => normId(x?.fixtureId) === fixtureId);
    if (idx < 0) {
      return res.status(404).json({ ok: false, error: "FIXTURE_NOT_FOUND" });
    }

    const fx = fxStore.list[idx] || {};
    fxStore.list[idx] = {
      ...fx,
      status: "FT",
      minute: fx.minute ?? null,
      score: { ...(fx.score || {}), home, away },
      homeGoals: home,
      awayGoals: away,
      updatedAt: nowISO,
      updatedBy,
      adminMeta: meta,
    };

    await saveFixturesStore(fxStore.raw, fxStore.list);

    // 2) results.json upsert
    const results = await loadResultsStore();
    const items = Array.isArray(results.items) ? results.items : [];
    const j = items.findIndex((x) => normId(x?.fixtureId) === fixtureId);

    const rec = {
      fixtureId,
      home,
      away,
      meta,
      updatedAt: nowISO,
      updatedBy,
    };
    if (hasHT) rec.htScore = { home: htHome, away: htAway };
    if (firstGoal) rec.firstGoal = firstGoal;
    if (redHome != null) rec.redHome = redHome;
    if (redAway != null) rec.redAway = redAway;
    if (penaltyAny != null) rec.penaltyAny = penaltyAny;
    if (penaltySide) rec.penaltySide = penaltySide;

    if (j >= 0) items[j] = { ...items[j], ...rec };
    else items.push(rec);

    results.items = items;
    await saveResultsStore(results);

    // 3) data/live/<fid>.json state dosyasını RESMİ sonuçla güncelle.
    //    settle2 bu dosyayı okur — canlı panelde kalan eski/yanlış skor
    //    settle'ı bozmasın. Mevcut dosyadaki event-stamp vb. alanlar korunur,
    //    skor/HT/mikro alanlar resmi değerlerle ezilir.
    try {
      const prev = await readJson(LIVE_STATE_FILE(fixtureId), null);
      const st = {
        ...(prev && typeof prev === "object" ? prev : {}),
        fixtureId,
        status: "FT",
        isLive: false,
        kickoffISO: (prev && prev.kickoffISO) || fx.kickoffISO || null,
        country: (prev && prev.country) || fx.country || null,
        league: (prev && prev.league) || fx.league || null,
        teamHome: (prev && prev.teamHome) || fx.home || null,
        teamAway: (prev && prev.teamAway) || fx.away || null,
        score: { home, away },
        updatedAt: nowISO,
        source: "admin-results-set",
      };
      if (hasHT) st.htScore = { home: htHome, away: htAway };
      if (firstGoal) st.firstGoal = firstGoal;
      if (redHome != null) st.redHome = redHome;
      if (redAway != null) st.redAway = redAway;
      if (penaltyAny != null) st.penaltyAny = penaltyAny;
      if (penaltySide) st.penaltySide = penaltySide;
      await writeJsonAtomic(LIVE_STATE_FILE(fixtureId), st);
    } catch (e) {
      console.error("RESULTS_SET_LIVE_STATE_SYNC_FAILED", e);
    }

    // 4) rt-live-gs.json (canlı admin panelin okuduğu model) da senkron olsun
    try {
      const RT_LIVE_GS_FILE = path.join(DATA_DIR, "rt-live-gs.json");
      const liveModel = await readJson(RT_LIVE_GS_FILE, null);
      if (liveModel && liveModel.fixtures && liveModel.fixtures[fixtureId]) {
        const g = liveModel.fixtures[fixtureId];
        g.status = "FT";
        g.homeGoals = home;
        g.awayGoals = away;
        if (hasHT) { g.htHome = htHome; g.htAway = htAway; }
        if (firstGoal) g.firstGoal = firstGoal;
        if (redHome != null) g.redHome = redHome;
        if (redAway != null) g.redAway = redAway;
        if (penaltyAny != null) g.penaltyAny = penaltyAny;
        if (penaltySide) g.penaltySide = penaltySide;
        g.updatedAt = nowISO;
        await writeJsonAtomic(RT_LIVE_GS_FILE, liveModel);
      }
    } catch (e) {
      console.error("RESULTS_SET_RT_LIVE_GS_SYNC_FAILED", e);
    }

    return res.json({ ok: true, fixtureId, saved: rec });
  } catch (e) {
    console.error("ADMIN_RESULTS_SET_FAILED", e);
    return res.status(500).json({
      ok: false,
      error: "ADMIN_RESULTS_SET_FAILED",
      detail: String(e && (e.message || e)),
    });
  }
});

/* =========================================================
   GET /api/admin/results/recent?limit=50
   - results.json içinden son girilen sonuçları döner (updatedAt desc)
   ========================================================= */
router.get("/results/recent", requireAdminToken, async (req, res) => {
  try {
    const limitRaw = Number(req.query.limit || 50);
    const limit = Math.max(
      1,
      Math.min(200, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 50)
    );

    const results = await loadResultsStore();
    const items = Array.isArray(results.items) ? results.items : [];

    const sorted = items
      .slice()
      .sort((a, b) => safeTimeMs(b?.updatedAt) - safeTimeMs(a?.updatedAt))
      .slice(0, limit);

    return res.json({
      ok: true,
      count: sorted.length,
      items: sorted,
    });
  } catch (e) {
    console.error("ADMIN_RESULTS_RECENT_FAILED", e);
    return res.status(500).json({
      ok: false,
      error: "ADMIN_RESULTS_RECENT_FAILED",
      detail: String(e && (e.message || e)),
    });
  }
});

/* =========================================================
   MATCH NOTES (kullanıcıya görünür admin notu)
   data/match-notes.json: { notes: { "<fixtureId>": {note, home, away, updatedAt, updatedBy} } }
   ========================================================= */
const MATCH_NOTES_FILE = path.join(DATA_DIR, "match-notes.json");

async function loadNotesStore() {
  const raw = await readJson(MATCH_NOTES_FILE, null);
  if (!raw || typeof raw !== "object" || typeof raw.notes !== "object" || !raw.notes) {
    return { notes: {} };
  }
  return raw;
}
async function saveNotesStore(store) {
  await writeJsonAtomic(MATCH_NOTES_FILE, store || { notes: {} });
}

/* POST /api/admin/match-note
   Body: { fixtureId, note, home?, away? }
   - note boş/whitespace ise notu siler.
   - Notu hem match-notes.json'a hem de (varsa) fixtures.json kaydına yazar. */
router.post("/match-note", requireAdminToken, express.json(), async (req, res) => {
  try {
    const body = req.body || {};
    const fixtureId = normId(body.fixtureId);
    if (!fixtureId) return res.status(400).json({ ok: false, error: "FIXTURE_REQUIRED" });

    const note = String(body.note == null ? "" : body.note).trim().slice(0, 500);
    const updatedBy = normId(body.updatedBy) || "admin";
    const nowISO = new Date().toISOString();

    const store = await loadNotesStore();
    if (!note) {
      delete store.notes[fixtureId];
    } else {
      store.notes[fixtureId] = {
        note,
        home: normId(body.home) || store.notes[fixtureId]?.home || null,
        away: normId(body.away) || store.notes[fixtureId]?.away || null,
        updatedAt: nowISO,
        updatedBy,
      };
    }
    await saveNotesStore(store);

    // fixtures.json içinde varsa ayrıca patchle (manuel maçlar not'u taşısın)
    try {
      const fxStore = await loadFixturesStore();
      const idx = fxStore.list.findIndex((x) => normId(x?.fixtureId) === fixtureId);
      if (idx >= 0) {
        if (!note) delete fxStore.list[idx].note;
        else fxStore.list[idx].note = note;
        fxStore.list[idx].noteUpdatedAt = nowISO;
        await saveFixturesStore(fxStore.raw, fxStore.list);
      }
    } catch (e) {
      console.error("MATCH_NOTE_FIXTURE_SYNC_FAILED", e);
    }

    return res.json({ ok: true, fixtureId, note: note || null });
  } catch (e) {
    console.error("ADMIN_MATCH_NOTE_FAILED", e);
    return res.status(500).json({ ok: false, error: "ADMIN_MATCH_NOTE_FAILED", detail: String(e && (e.message || e)) });
  }
});

/* GET /api/admin/match-note?fixtureId=  (admin düzenleme için tekil not) */
router.get("/match-note", requireAdminToken, async (req, res) => {
  try {
    const fixtureId = normId(req.query.fixtureId);
    if (!fixtureId) return res.status(400).json({ ok: false, error: "FIXTURE_REQUIRED" });
    const store = await loadNotesStore();
    return res.json({ ok: true, fixtureId, entry: store.notes[fixtureId] || null });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e && (e.message || e)) });
  }
});

/* =========================================================
   POST /api/admin/fixtures/add   (token)
   Body: { home, away, kickoffISO, league?, country?, fixtureId?, note? }
   - fixtures.json listesine yeni maç ekler. fixtureId verilmezse üretir.
   ========================================================= */
function slugPart(s) {
  return String(s || "").toLocaleUpperCase("tr-TR")
    .replace(/[İIı]/g, "I").replace(/Ş/g, "S").replace(/Ğ/g, "G")
    .replace(/Ü/g, "U").replace(/Ö/g, "O").replace(/Ç/g, "C")
    .replace(/[^A-Z0-9]+/g, "").slice(0, 6);
}
router.post("/fixtures/add", requireAdminToken, express.json(), async (req, res) => {
  try {
    const b = req.body || {};
    const home = normId(b.home);
    const away = normId(b.away);
    const kickoffISO = normId(b.kickoffISO);
    if (!home || !away) return res.status(400).json({ ok: false, error: "HOME_AWAY_REQUIRED" });
    if (!kickoffISO) return res.status(400).json({ ok: false, error: "KICKOFF_REQUIRED" });

    const ko = parseKickoffMs(kickoffISO);
    if (ko == null) return res.status(400).json({ ok: false, error: "KICKOFF_INVALID" });

    const league = normId(b.league) || null;
    const country = normId(b.country) || "Turkey";
    const note = String(b.note == null ? "" : b.note).trim().slice(0, 500);

    let fixtureId = normId(b.fixtureId);
    if (!fixtureId) {
      const day = new Date(ko).toISOString().slice(0, 10);
      fixtureId = `${slugPart(home)}-${day}-${slugPart(away)}`;
    }

    const fxStore = await loadFixturesStore();
    if (fxStore.list.some((x) => normId(x?.fixtureId) === fixtureId)) {
      return res.status(409).json({ ok: false, error: "FIXTURE_EXISTS", fixtureId });
    }

    const nowISO = new Date().toISOString();
    const fx = {
      fixtureId, home, away, league, country,
      kickoffISO,
      status: "NS",
      source: "MANUAL",
      createdAt: nowISO,
      updatedBy: normId(b.updatedBy) || "admin",
    };
    if (note) fx.note = note;
    fxStore.list.push(fx);
    await saveFixturesStore(fxStore.raw, fxStore.list);

    // KALICI YAZ: fixtures.json her deploy'da siliniyor (Render'da kalıcı disk
    // yok). FDO maçları kendini onarır, elle girilen maç GERİ GELMEZ.
    await require("../lib/manual-fixtures.cjs").save(fx, req.app?.locals?.db || null);

    if (note) {
      const store = await loadNotesStore();
      store.notes[fixtureId] = { note, home, away, updatedAt: nowISO, updatedBy: fx.updatedBy };
      await saveNotesStore(store);
    }

    return res.json({ ok: true, fixture: fx });
  } catch (e) {
    console.error("ADMIN_FIXTURE_ADD_FAILED", e);
    return res.status(500).json({ ok: false, error: "ADMIN_FIXTURE_ADD_FAILED", detail: String(e && (e.message || e)) });
  }
});

/* POST /api/admin/fixtures/delete  (token)  Body: { fixtureId } */
router.post("/fixtures/delete", requireAdminToken, express.json(), async (req, res) => {
  try {
    const fixtureId = normId((req.body || {}).fixtureId);
    if (!fixtureId) return res.status(400).json({ ok: false, error: "FIXTURE_REQUIRED" });
    const fxStore = await loadFixturesStore();
    const before = fxStore.list.length;
    fxStore.list = fxStore.list.filter((x) => normId(x?.fixtureId) !== fixtureId);
    if (fxStore.list.length === before) return res.status(404).json({ ok: false, error: "FIXTURE_NOT_FOUND" });
    await saveFixturesStore(fxStore.raw, fxStore.list);
    // Kalıcı depodan da sil, yoksa açılışta geri yüklenir.
    await require("../lib/manual-fixtures.cjs").remove(fixtureId, req.app?.locals?.db || null);
    // notu da temizle
    try {
      const store = await loadNotesStore();
      if (store.notes[fixtureId]) { delete store.notes[fixtureId]; await saveNotesStore(store); }
    } catch {}
    return res.json({ ok: true, fixtureId, removed: before - fxStore.list.length });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e && (e.message || e)) });
  }
});

/* =========================================================
   GET /api/admin/fixtures
   fixtures.json'daki tüm maçları döner (zaman filtresi yok)
   Admin live panel için kullanılır.
   ========================================================= */
router.get("/fixtures", async (req, res) => {
  try {
    const raw = await readJson(FIXTURES_FILE, { fixtures: [] });
    const list = Array.isArray(raw?.fixtures) ? raw.fixtures : [];
    const sorted = [...list].sort((a, b) => {
      const ta = new Date(a.kickoffISO || a.kickoffDate || 0).getTime();
      const tb = new Date(b.kickoffISO || b.kickoffDate || 0).getTime();
      return tb - ta; // en yeni önce
    });
    return res.json({ ok: true, count: sorted.length, fixtures: sorted });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/* =========================================================
   TheSportsDB – takım ara → yaklaşan maçları getir
   GET /api/admin/search-match?q=karabag
   ========================================================= */
router.get("/search-match", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (!q || q.length < 2) return res.status(400).json({ ok: false, error: "QUERY_TOO_SHORT" });

    const teamRes = await fetch(
      `https://www.thesportsdb.com/api/v1/json/3/searchteams.php?t=${encodeURIComponent(q)}`
    );
    const teamData = await teamRes.json();
    const teams = (teamData.teams || []).filter(t => t.strSport === "Soccer").slice(0, 5);

    if (teams.length === 0) return res.json({ ok: true, teams: [], events: [] });

    const allEvents = [];
    for (const team of teams) {
      try {
        const evRes = await fetch(
          `https://www.thesportsdb.com/api/v1/json/3/eventsnext.php?id=${team.idTeam}`
        );
        const evData = await evRes.json();
        for (const e of (evData.events || [])) {
          allEvents.push({
            idEvent: e.idEvent,
            home: e.strHomeTeam,
            away: e.strAwayTeam,
            dateEvent: e.dateEvent,
            time: (e.strTime || "00:00:00").slice(0, 5),
            league: e.strLeague,
            country: e.strCountry || "",
            teamId: team.idTeam,
            teamName: team.strTeam,
          });
        }
      } catch { /* skip failed team */ }
    }

    const seen = new Set();
    const unique = allEvents.filter(e => {
      const k = e.idEvent;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    unique.sort((a, b) => (a.dateEvent + a.time).localeCompare(b.dateEvent + b.time));

    res.json({
      ok: true,
      teams: teams.map(t => ({ id: t.idTeam, name: t.strTeam, league: t.strLeague, country: t.strCountry, badge: t.strBadge })),
      events: unique.slice(0, 15),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/* =========================================================
   GET /api/admin/scraper-health
   Canlı skor şelalesinin durumu: cache tazeliği, kaynak başarı oranları,
   kaç yedek ayakta. Sorun varsa `status` warn/critical döner.

   Neden gerekli: şelale 10 kaynaklı görünüyor ama gerçekte tek kaynağa
   dayanıyor (mackolik). Bu uç olmadan Maçkolik'in bozulduğu ancak
   kullanıcı şikâyetinden anlaşılıyordu.
   ========================================================= */
router.get("/scraper-health", requireAdminToken, async (req, res) => {
  try {
    const health = require("../services/scraper-health.cjs");
    const r = await health.report();
    // Sağlıksızsa 200 dışında dönmek izleme araçlarının yakalamasını kolaylaştırır.
    return res.status(r.status === "critical" ? 503 : 200).json({ ok: true, ...r });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/* =========================================================
   POST /api/admin/scraper-probe
   Kaynakları tek tek, şelaleden bağımsız dener ve sonucu kaydeder.
   Yedek sayımının tek güvenilir ölçüsü budur: şelale ilk başarıda durduğu
   için sonraki kaynaklar neredeyse hiç denenmez, istatistikleri yanıltır.
   Pahalı (kaynak başına Chrome açar) — normalde 24 saatte bir otomatik.
   Gövde: { sources?: ["goal","espn"] } — verilmezse tümü.
   ========================================================= */
router.post("/scraper-probe", requireAdminToken, express.json(), async (req, res) => {
  try {
    const health = require("../services/scraper-health.cjs");
    const names = Array.isArray(req.body?.sources) ? req.body.sources : null;
    const doc = await health.probeSources(names);
    const working = Object.entries(doc.results).filter(([, r]) => r.ok);
    return res.json({
      ok: true,
      checkedAt: doc.checkedAt,
      working: working.map(([n, r]) => ({ name: n, count: r.count })),
      results: doc.results,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/* GET /api/admin/alerts?limit=50&kind=scraper_down */
router.get("/alerts", requireAdminToken, async (req, res) => {
  try {
    const { listAlerts } = require("../lib/admin-alerts.cjs");
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
    const kind = String(req.query.kind || "").trim() || null;
    const items = await listAlerts(limit, kind);
    return res.json({ ok: true, count: items.length, items });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/* =========================================================
   GET /api/admin/mongo-health   — SALT OKUNUR
   Bağlantı durumu + son hata + risk uyarısı. `?check=1` verilirse
   zamanlayıcıyı beklemeden HEMEN bir kontrol turu çalıştırır (ping atar,
   gerekirse app.locals.db'yi canlı onarır).
   ========================================================= */
router.get("/mongo-health", requireAdminToken, async (req, res) => {
  try {
    const mh = require("../services/mongo-health.cjs");
    if (String(req.query.check || "") === "1") await mh.tick();
    const r = mh.report();
    // Bağlantı katmanının kendi sayaçları: kaç deneme yapıldı, açılıştaki
    // asıl hata neydi, soğuma penceresi açık mı. İzleme servisinin gördüğü
    // özet, başarısızlığın SEBEBİNİ göstermiyordu.
    const conn = require("../lib/mongo.cjs").status();
    // Bağlantı yoksa 503: harici izleme aracı bunu yakalayabilsin.
    return res
      .status(r.configured && !r.connected ? 503 : 200)
      .json({ ok: true, ...r, connection: conn });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/* =========================================================
   GET /api/admin/migration-status   — SALT OKUNUR
   Production'da Shell yoksa (Render free kademe) geçiş durumunu görmenin
   tek yolu. Hiçbir şey yazmaz.

   Dosya sayıları vs Mongo koleksiyon sayıları + ayna bayrakları.
   ⚠️ Render free kademede kalıcı disk YOKTUR: data/*.json her deploy'da
   sıfırlanır, yani "dosya" sütunu yalnızca son deploy'dan beri birikeni
   gösterir. Asıl doğruluk kaynağı Mongo sütunudur.
   ========================================================= */
router.get("/migration-status", requireAdminToken, async (req, res) => {
  const fs = require("fs");
  const path = require("path");
  const DATA_DIR = process.env.SKORLIG_DATA_DIR || path.join(__dirname, "..", "data");

  const fileCount = (name, pick) => {
    try {
      const p = path.join(DATA_DIR, name);
      const st = fs.statSync(p);
      const raw = JSON.parse(fs.readFileSync(p, "utf8"));
      return { exists: true, kb: Math.round(st.size / 1024), count: pick(raw) };
    } catch {
      return { exists: false, kb: 0, count: 0 };
    }
  };

  const arrLen = (r) => (Array.isArray(r) ? r.length : (r?.items || []).length);

  const files = {
    preds: fileCount("preds.json", arrLen),
    wallet: fileCount("lc-wallet.json", (r) => (r?.users || []).length),
    walletLedger: fileCount("lc-wallet.json", (r) => (r?.ledger || []).length),
    users: fileCount("users.json", (r) => (r?.items || r?.users || []).length),
    matchResults: fileCount("match-results.json", arrLen),
  };

  const mirrors = {
    preds: String(process.env.SKORLIG_PREDS_FILE_MIRROR ?? "1") !== "0",
    wallet: String(process.env.SKORLIG_WALLET_FILE_MIRROR ?? "1") !== "0",
    matchResults: String(process.env.SKORLIG_MATCHRESULTS_FILE_MIRROR ?? "1") !== "0",
    users: String(process.env.SKORLIG_USERS_FILE_MIRROR ?? "1") !== "0",
  };

  const db = req.app?.locals?.db || null;
  const mongo = { connected: !!db, collections: {} };
  if (db) {
    for (const c of ["predictions", "lc_wallet_users", "lc_wallet_ledger", "match_results", "users"]) {
      try {
        mongo.collections[c] = await db.collection(c).countDocuments();
      } catch (e) {
        mongo.collections[c] = `hata: ${e.message}`;
      }
    }
  }

  // Karar yardımı: her ayna için kapatılabilir mi?
  const verdict = {};
  if (db) {
    const m = mongo.collections;
    verdict.preds =
      m.predictions >= files.preds.count ? "KAPATILABILIR" : `BEKLE (mongo ${m.predictions} < dosya ${files.preds.count})`;
    verdict.wallet =
      m.lc_wallet_users >= files.wallet.count ? "KAPATILABILIR" : `BEKLE (mongo ${m.lc_wallet_users} < dosya ${files.wallet.count})`;
    verdict.matchResults =
      m.match_results >= files.matchResults.count ? "KAPATILABILIR" : `BEKLE (mongo ${m.match_results} < dosya ${files.matchResults.count})`;
    // ⚠️ Profil verisi (ülke, takım, takma ad, ligler, dil). Kalıcı disk
    // olmadığı için dosya sayısı yanıltıcı düşük olabilir — asıl kaynak Mongo.
    verdict.users =
      m.users >= files.users.count ? "KAPATILABILIR" : `BEKLE (mongo ${m.users} < dosya ${files.users.count})`;
  } else {
    verdict.hepsi = "MONGO YOK — hicbir ayna kapatilamaz (bayraklar zaten yok sayilir)";
  }

  res.json({
    ok: true,
    checkedAt: new Date().toISOString(),
    not: "Render free kademede kalici disk yok; dosya sayilari son deploy'dan beri birikeni gosterir.",
    mongo,
    files,
    mirrors,
    verdict,
    redis: process.env.REDIS_URL ? "TANIMLI" : "YOK",
  });
});

/* =========================================================
   POST /api/admin/run-migration   — YAZAR
   Shell olmadan migration çalıştırmanın yolu. Gövde:
     { "target": "preds" | "match-results" | "users", "confirm": true }

   `confirm` olmadan yalnızca DOĞRULAMA yapar (dry-run) — kazara
   tetiklenmesin diye. Her iki script de idempotenttir.
   ========================================================= */
router.post("/run-migration", requireAdminToken, express.json(), async (req, res) => {
  const { execFile } = require("child_process");
  const path = require("path");

  const target = String(req.body?.target || "").trim();
  const confirm = req.body?.confirm === true;

  const SCRIPTS = {
    preds: { file: "migrate-preds-to-mongo.cjs", verify: "verify-migration.cjs" },
    "match-results": { file: "migrate-match-results.cjs", verify: null }, // kendi doğrulamasını yapar
    users: { file: "migrate-users.cjs", verify: null }, // kendi doğrulamasını yapar
  };
  const spec = SCRIPTS[target];
  if (!spec) {
    return res.status(400).json({
      ok: false,
      error: "TARGET_INVALID",
      kabul: Object.keys(SCRIPTS),
    });
  }

  // confirm yoksa: yalnızca doğrulama çalıştır (hiçbir şey yazmaz)
  const script = confirm ? spec.file : spec.verify || spec.file;
  const args = confirm ? [] : spec.verify ? [] : ["--verify"];

  const scriptPath = path.join(__dirname, "..", "scripts", script);

  execFile(
    process.execPath,
    [scriptPath, ...args],
    { cwd: path.join(__dirname, ".."), timeout: 10 * 60 * 1000, env: process.env },
    (err, stdout, stderr) => {
      const out = String(stdout || "") + String(stderr || "");
      res.json({
        ok: !err,
        mode: confirm ? "MIGRATION (yazdi)" : "DOGRULAMA (yazmadi)",
        target,
        script,
        exitCode: err ? err.code ?? 1 : 0,
        output: out.split("\n").filter(Boolean).slice(-40),
      });
    }
  );
});

/* =========================================================
   GET /api/admin/mongo-diagnose   — SALT OKUNUR

   NEDEN VAR: Atlas `tlsv1 alert internal error` (alert 80) veriyor ve bu hata
   SEBEBİ göstermiyor — kimlik doğrulamasına hiç gelinmiyor, el sıkışma
   sırasında reddediliyor. Aynı bağlantı dizesi geliştirici makinesinden
   ÇALIŞIYOR, Render'dan çalışmıyordu; yani fark ağ yolunda ya da TLS
   yığınında. Bunu dışarıdan tahmin etmek yerine Render'ın İÇİNDEN ölçüyoruz.

   Dört ölçüm, sorunu katmanına göre ayırıyor:
     1) sürümler   — Node/OpenSSL yereldekinden farklı mı
     2) SRV        — DNS çözümleniyor mu, hangi kabuklara
     3) kontrol    — dışarıya TLS genel olarak çalışıyor mu (Atlas dışı hedef)
     4) atlas TLS  — ham el sıkışma; başarısızsa alert burada görünür

   ⚠️ Parola ASLA yazdırılmaz: bağlantı dizesinden yalnızca ana bilgisayar adı
   ayrıştırılır.
   ========================================================= */
router.get("/mongo-diagnose", requireAdminToken, async (req, res) => {
  const dns = require("dns").promises;
  const tls = require("tls");

  /** Ham TLS el sıkışması — MongoDB sürücüsünü aradan çıkarır. */
  function tlsProbe(host, port, timeoutMs = 10000) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      let done = false;
      const bitir = (r) => {
        if (done) return;
        done = true;
        try { sock.destroy(); } catch {}
        resolve({ ...r, ms: Date.now() - t0 });
      };
      const sock = tls.connect(
        { host, port, servername: host, timeout: timeoutMs },
        () => bitir({ ok: true, protocol: sock.getProtocol(), authorized: sock.authorized })
      );
      sock.on("error", (e) => bitir({ ok: false, error: String(e?.message || e).slice(0, 300) }));
      sock.on("timeout", () => bitir({ ok: false, error: `zaman asimi (${timeoutMs}ms)` }));
    });
  }

  const rapor = {
    versions: {
      node: process.version,
      openssl: process.versions.openssl,
      // Sürücü sürümü de farklı olabilir (lockfile / kurulum farkı)
      mongodb: (() => {
        try { return require("mongodb/package.json").version; } catch { return "?"; }
      })(),
    },
  };

  // — Bağlantı dizesinden yalnızca host —
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI || "";
  if (!uri) return res.status(400).json({ ok: false, error: "MONGODB_URI tanimsiz" });

  let scheme = "", hostname = "";
  try {
    const m = uri.match(/^(mongodb(?:\+srv)?):\/\/(?:[^@]*@)?([^/?,]+)/);
    scheme = m?.[1] || "";
    hostname = m?.[2] || "";
  } catch {}
  rapor.uri = { scheme, hostname, hasCredentials: /:\/\/[^@]+@/.test(uri) };

  if (!hostname) {
    return res.status(400).json({ ok: false, error: "URI ayristirilamadi", ...rapor });
  }

  // — SRV çözümlemesi (yalnızca +srv şemasında) —
  if (scheme === "mongodb+srv") {
    try {
      const kayitlar = await dns.resolveSrv(`_mongodb._tcp.${hostname}`);
      rapor.srv = { ok: true, count: kayitlar.length, hosts: kayitlar.map((r) => `${r.name}:${r.port}`) };
    } catch (e) {
      rapor.srv = { ok: false, error: String(e?.message || e).slice(0, 200) };
    }
    try {
      rapor.txt = { ok: true, records: (await dns.resolveTxt(hostname)).flat() };
    } catch (e) {
      rapor.txt = { ok: false, error: String(e?.message || e).slice(0, 200) };
    }
  }

  // — Kontrol: Atlas DIŞI bir hedefe TLS. Bu da düşerse sorun Atlas'ta değil,
  //   Render'ın giden bağlantılarında demektir. —
  rapor.controlTls = await tlsProbe("www.mongodb.com", 443);

  // — Asıl sınav: çözümlenen ilk kabuğa ham TLS —
  const hedef = rapor.srv?.hosts?.[0];
  if (hedef) {
    const [h, p] = hedef.split(":");
    rapor.atlasTls = await tlsProbe(h, Number(p) || 27017);
  } else if (scheme === "mongodb") {
    const [h, p] = hostname.split(":");
    rapor.atlasTls = await tlsProbe(h, Number(p) || 27017);
  }

  // — Yorum: hangi katman suçlu —
  let verdict;
  if (rapor.srv && rapor.srv.ok === false) {
    verdict = "DNS: SRV cozumlenemedi — kume duraklatilmis ya da URI yanlis";
  } else if (rapor.controlTls.ok === false) {
    verdict = "AG: Render'dan disariya TLS kurulamiyor — sorun Atlas'a ozgu degil";
  } else if (rapor.atlasTls && rapor.atlasTls.ok === false) {
    verdict =
      "ATLAS: DNS ve genel TLS calisiyor ama Atlas el sikismayi REDDEDIYOR — " +
      "en olasi sebep IP erisim listesi (0.0.0.0/0 eksik ya da henuz Active degil)";
  } else if (rapor.atlasTls?.ok) {
    verdict = "TLS SORUNSUZ — hata TLS'ten sonra (kimlik dogrulama / yetki) olmali";
  } else {
    verdict = "belirsiz";
  }

  res.json({ ok: true, verdict, ...rapor });
});

/* =========================================================
   GET /api/admin/rate-store   — hız sınırı deposunun gerçek modu

   NEDEN VAR: DEPLOY.md doğrulamayı Shell'den bir node komutuyla yaptırıyordu;
   Render ücretsiz katmanda Shell YOK. Yani REDIS_URL eklendikten sonra
   gerçekten Redis'e mi yazıldığı, yoksa sessizce bellek moduna mı düşüldüğü
   görülemiyordu. İkisi tek instance'ta aynı davranır — fark ancak instance
   sayısı artınca ve limitler N katına çıkınca ortaya çıkar ki o noktada
   sebebi bulmak zordur.

   `?probe=1` GERÇEK bir sayaç yazar (kısa TTL'li, ayrı anahtar alanı):
   yapılandırma doğru ama bağlantı kurulamıyorsa fark burada anlaşılır.
   ========================================================= */
router.get("/rate-store", requireAdminToken, async (req, res) => {
  try {
    const store = require("../lib/rate-store.cjs");
    const out = { ok: true, ...store.stats() };

    let saydi = null; // probe gerçekten saydı mı

    if (String(req.query.probe || "") === "1") {
      const t0 = Date.now();
      let son = null;
      let deneme = 0;

      // SOĞUK BAŞLANGIÇ: rate-store `enableOfflineQueue: false` ile çalışıyor
      // (hız sınırı isteğin önünde durduğu için Redis yavaşken beklemek yerine
      // fail-open davranır). Bunun yan etkisi: bağlantı `ready` olmadan giden
      // ilk komut ağa ÇIKMADAN reddedilir (~2ms). Probe o ilk çağrı olursa
      // sağlıklı bir Redis'e "calismiyor" der — yaşandı. Birkaç kez dene.
      for (deneme = 1; deneme <= 3; deneme++) {
        try {
          const r = await store.hit(`admin-probe:${Date.now()}`, 10000);
          // hit() arızada FIRLATMAZ (fail-open) ve bellek moduna DÜŞER.
          // Dolayısıyla "sayıldı" tek başına Redis kanıtı değil — sayımın
          // hangi modda gerçekleştiğini de sormak gerekiyor, yoksa bellek
          // sayacı Redis başarısı gibi raporlanır (ölçüldü).
          const modu = store.stats().mode;
          son = { ok: true, count: r?.count ?? null, countedIn: modu };
          if (Number(r?.count ?? 0) >= 1 && modu === "redis") break;
        } catch (e) {
          son = { ok: false, error: String(e?.message || e).slice(0, 200) };
        }
        if (deneme < 3) await new Promise((r) => setTimeout(r, 400));
      }

      saydi =
        son?.ok === true &&
        Number(son.count ?? 0) >= 1 &&
        son.countedIn === "redis";
      out.probe = { ...son, counted: saydi, attempts: deneme, ms: Date.now() - t0 };

      // ioredis hata olayı ASENKRON gelir: probe'un hemen ardından okunan mod
      // henüz "redis" görünür ve yanıltır (ölçüldü). Olay döngüsüne fırsat ver.
      await new Promise((r) => setTimeout(r, 200));
      out.modeAfterProbe = store.stats().mode;

      // Sayaç işlenmediyse SEBEBİ göster. hit() fail-open olduğu için hatayı
      // yutuyor; sebebi görmeden "neden çalışmıyor" sorusuna cevap yok.
      if (!saydi && out.redisConfigured) {
        try {
          out.diagnose = await store.diagnose();
        } catch (e) {
          out.diagnose = { error: String(e?.message || e).slice(0, 300) };
        }
      }
    }

    // Karar: mod "redis" OLMALI ve probe yapıldıysa gerçekten saymalı.
    const calisiyor =
      (out.modeAfterProbe || out.mode) === "redis" && (saydi === null || saydi);

    out.verdict =
      !out.redisConfigured
        ? "BELLEK MODU — REDIS_URL tanimsiz. Tek instance'ta dogru calisir; " +
          "birden fazla instance'ta limit her birinde ayri isler."
        : calisiyor
          ? "REDIS AKTIF"
          : "UYARI: REDIS_URL tanimli ama sayac Redis'e islenmiyor — " +
            "baglanti kurulamiyor, bellek moduna dusuldu";

    // Yapılandırılmış ama çalışmıyorsa 503: sessizce yanlış modda kalmasın.
    const bozuk = out.redisConfigured && !calisiyor;
    return res.status(bozuk ? 503 : 200).json(out);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/* =========================================================
   GET /api/admin/economy?days=7   — SALT OKUNUR

   NEDEN VAR: LC arzı kontrolsüz büyüyordu ve bu ancak elle ölçünce görüldü
   (2026-07-29: giriş 2.182 / çıkış 15 — oran 145:1). Denge ayarları bu rapor
   olmadan körlemesine yapılır; bir ayarın etkisi ertesi gün burada görünmeli.

   ⚠️ Defteri tarar, pahalıdır. Yalnızca yönetim; istek yolunda kullanılmaz.
   ========================================================= */
router.get("/economy", requireAdminToken, async (req, res) => {
  try {
    const gun = Math.max(1, Math.min(90, Number(req.query.days || 7)));
    const { economyReport } = require("../lib/economy-report.cjs");
    const rapor = await economyReport(req.app?.locals?.db || null, gun);

    // Gider fiilen yoksa 200 dönmek "her şey yolunda" izlenimi verir; harici
    // izleme aracı bunu yakalayabilsin diye uyarı varsa 409.
    return res.status(rapor.uyarilar.length ? 409 : 200).json({ ok: true, ...rapor });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

module.exports = router;
