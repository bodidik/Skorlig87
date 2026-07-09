/**
 * routes/admin-live.cjs
 * Yalın admin uçları: bootstrap, goal, status, red, halfscore, penalty, ht, final
 * Bu router server.cjs içinde "/api/admin" altına mount edilir.
 *
 * Not: Token kontrolünü bu router'a koymadım (senin projende farklı admin router'lar var).
 * İstersen burada da x-admin-token kontrolü ekleyebiliriz.
 */
"use strict";

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const express = require("express");
const router = express.Router();

const DATA_DIR = path.join(__dirname, "..", "data");
const LIVE_DIR = path.join(DATA_DIR, "live");

function stFile(id) {
  return path.join(LIVE_DIR, `${id}.json`);
}

async function readJson(file, fb = null) {
  try {
    const txt = await fsp.readFile(file, "utf8");
    return JSON.parse(txt);
  } catch {
    return fb;
  }
}

async function writeJson(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fsp.rename(tmp, file);
}

/* ---- POST /api/admin/match/bootstrap ----
   Body: { fixtureId, home, away, kickoffISO? }
*/
router.post("/match/bootstrap", async (req, res) => {
  try {
    const b = req.body || {};
    const fixtureId = String(b.fixtureId || "").trim();
    const home = String(b.home || "").trim();
    const away = String(b.away || "").trim();
    const kickoffISO = String(b.kickoffISO || new Date().toISOString());

    if (!fixtureId || !home || !away) {
      return res.status(400).json({ ok: false, error: "fixtureId_home_away_required" });
    }

    const file = stFile(fixtureId);
    const st =
      (await readJson(file, null)) || {
        fixtureId,
        pollCount: 0,
        lastPolledAt: null,
        kickoffISO,
        status: "NS",
        score: { home: 0, away: 0 },
        minute: 0,
        firstGoal: null,
        redHome: 0,
        redAway: 0,
        htScore: null,
        htOutcome: null,
        pen: null,
      };

    await writeJson(file, st);
    return res.json({ ok: true, fixtureId, created: true, state: st });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e && (e.message || e)) });
  }
});

/* ---- POST /api/admin/match/goal?fixtureId=&team=H|A ---- */
router.post("/match/goal", async (req, res) => {
  try {
    const fixtureId = String(req.query.fixtureId || "").trim();
    const team = String(req.query.team || "").toUpperCase();

    if (!fixtureId || !["H", "A"].includes(team)) {
      return res.status(400).json({ ok: false, error: "fixtureId_or_team_invalid" });
    }

    const file = stFile(fixtureId);
    const st = await readJson(file, null);
    if (!st) return res.status(404).json({ ok: false, error: "STATE_NOT_FOUND" });

    st.score = st.score || { home: 0, away: 0 };
    if (team === "H") st.score.home = Number(st.score.home || 0) + 1;
    if (team === "A") st.score.away = Number(st.score.away || 0) + 1;

    if (!st.firstGoal) st.firstGoal = team;
    st.minute = Math.max(Number(st.minute || 0), 1);

    await writeJson(file, st);
    return res.json({ ok: true, fixtureId, score: st.score, firstGoal: st.firstGoal });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e && (e.message || e)) });
  }
});

/* ---- POST /api/admin/match/status?fixtureId=&s=NS|1H|HT|2H|ET|P|FT&minute?=int ---- */
router.post("/match/status", async (req, res) => {
  try {
    const fixtureId = String(req.query.fixtureId || "").trim();
    const s = String(req.query.s || "").toUpperCase();
    const minute = req.query.minute != null ? Number(req.query.minute) : null;
    const allowed = ["NS", "1H", "HT", "2H", "ET", "P", "FT"];

    if (!fixtureId || !allowed.includes(s)) {
      return res.status(400).json({ ok: false, error: "fixtureId_or_status_invalid" });
    }

    const file = stFile(fixtureId);
    const st = await readJson(file, null);
    if (!st) return res.status(404).json({ ok: false, error: "STATE_NOT_FOUND" });

    st.status = s;
    if (Number.isFinite(minute)) st.minute = minute;

    await writeJson(file, st);
    return res.json({ ok: true, fixtureId, status: st.status, minute: Number(st.minute || 0) });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e && (e.message || e)) });
  }
});

/* ---- POST /api/admin/match/red?fixtureId=&team=H|A ---- */
router.post("/match/red", async (req, res) => {
  try {
    const fixtureId = String(req.query.fixtureId || "").trim();
    const team = String(req.query.team || "").toUpperCase();

    if (!fixtureId || !["H", "A"].includes(team)) {
      return res.status(400).json({ ok: false, error: "fixtureId_or_team_invalid" });
    }

    const file = stFile(fixtureId);
    const st = await readJson(file, null);
    if (!st) return res.status(404).json({ ok: false, error: "STATE_NOT_FOUND" });

    st.redHome = Number(st.redHome || 0);
    st.redAway = Number(st.redAway || 0);
    if (team === "H") st.redHome += 1;
    if (team === "A") st.redAway += 1;

    await writeJson(file, st);
    return res.json({ ok: true, fixtureId, redHome: st.redHome, redAway: st.redAway });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e && (e.message || e)) });
  }
});

/* ---- POST /api/admin/match/halfscore?fixtureId=&home=&away= ---- */
router.post("/match/halfscore", async (req, res) => {
  try {
    const fixtureId = String(req.query.fixtureId || "").trim();
    const home = Number(req.query.home);
    const away = Number(req.query.away);

    if (!fixtureId || !Number.isFinite(home) || !Number.isFinite(away)) {
      return res.status(400).json({ ok: false, error: "fixtureId_home_away_required" });
    }

    const file = stFile(fixtureId);
    const st = await readJson(file, null);
    if (!st) return res.status(404).json({ ok: false, error: "STATE_NOT_FOUND" });

    st.htScore = { home, away };
    st.htOutcome = home > away ? "H" : away > home ? "A" : "D";

    await writeJson(file, st);
    return res.json({ ok: true, fixtureId, htScore: st.htScore, htOutcome: st.htOutcome });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e && (e.message || e)) });
  }
});

/* ---- POST /api/admin/match/penalty?fixtureId=&team=H|A ---- */
router.post("/match/penalty", async (req, res) => {
  try {
    const fixtureId = String(req.query.fixtureId || "").trim();
    const team = String(req.query.team || "").toUpperCase();

    if (!fixtureId || !["H", "A"].includes(team)) {
      return res.status(400).json({ ok: false, error: "fixtureId_or_team_invalid" });
    }

    const file = stFile(fixtureId);
    const st = await readJson(file, null);
    if (!st) return res.status(404).json({ ok: false, error: "STATE_NOT_FOUND" });

    st.pen = st.pen || { home: 0, away: 0 };
    if (team === "H") st.pen.home = Number(st.pen.home || 0) + 1;
    if (team === "A") st.pen.away = Number(st.pen.away || 0) + 1;

    await writeJson(file, st);
    return res.json({ ok: true, fixtureId, pen: st.pen });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e && (e.message || e)) });
  }
});

/* ---- POST /api/admin/match/final?fixtureId=&home=&away=&firstGoal?=H|A ---- */
router.post("/match/final", async (req, res) => {
  try {
    const fixtureId = String(req.query.fixtureId || "").trim();
    const home = Number(req.query.home);
    const away = Number(req.query.away);
    const fg = req.query.firstGoal != null ? String(req.query.firstGoal).toUpperCase() : null;

    if (!fixtureId || !Number.isFinite(home) || !Number.isFinite(away)) {
      return res.status(400).json({ ok: false, error: "fixtureId_home_away_required" });
    }

    const file = stFile(fixtureId);
    const st = await readJson(file, null);
    if (!st) return res.status(404).json({ ok: false, error: "STATE_NOT_FOUND" });

    st.score = { home, away };
    if (fg === "H" || fg === "A" || fg === null) st.firstGoal = fg;
    st.status = "FT";

    await writeJson(file, st);
    return res.json({ ok: true, fixtureId, final: st.score, firstGoal: st.firstGoal ?? null, status: st.status });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e && (e.message || e)) });
  }
});

module.exports = router;
