"use strict";

const express = require("express");
const router = express.Router();

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

const { getRuntimeMode, setRuntimeMode } = require("../lib/runtime-mode.cjs");

/* =========================================================
   Admin token (testte basit koruma)
   - SKORLIG_ADMIN_TOKEN set ise:
     header: x-admin-token: <token> zorunlu
   - Token boşsa (unset) -> koruma devre dışı
   ========================================================= */
function requireAdminToken(req, res, next) {
  const token = String(process.env.SKORLIG_ADMIN_TOKEN || "").trim();
  if (!token) return next();

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
   ========================================================= */
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

    if (j >= 0) items[j] = { ...items[j], ...rec };
    else items.push(rec);

    results.items = items;
    await saveResultsStore(results);

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

module.exports = router;
