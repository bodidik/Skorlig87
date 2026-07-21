"use strict";

/**
 * 1987 Modu — haftalık basit tahmin
 *
 * Tüm maçları gösterir, maçtan 24 saat önce açılır.
 * 1987 üyelerine LC girişi sıfır.
 * Sıralama: 1987 segmenti kendi aralarında (match-results.json üzerinden).
 */

const express = require("express");
const router  = express.Router();
const fsp     = require("fs").promises;
const path    = require("path");
const { verifyToken }              = require("../middleware/verifyToken.cjs");
const { withFileLock, writeJsonAtomic } = require("../lib/fileLock.cjs");

const DATA_DIR           = path.join(__dirname, "..", "data");
const FIXTURES_FILE      = path.join(DATA_DIR, "fixtures.json");
const PREDS_FILE         = path.join(DATA_DIR, "preds.json");
const USERS_FILE         = path.join(DATA_DIR, "users.json");
const WALLET_FILE        = path.join(DATA_DIR, "lc-wallet.json");
const MATCH_RESULTS_FILE = path.join(DATA_DIR, "match-results.json");
const LIVE_DIR           = path.join(DATA_DIR, "live");

const WINDOW_BEFORE_MS = 24 * 60 * 60 * 1000;  // 24 saat önce açılır
const WINDOW_AFTER_MS  =  4 * 60 * 60 * 1000;  // bitimden 4 saat sonra kapanır
const LC_COST_NORMAL   = 3;
const WEEK_MS          = 7 * 24 * 60 * 60 * 1000;

async function readJson(file, fb = null) {
  try { return JSON.parse(await fsp.readFile(file, "utf8")); } catch { return fb; }
}

async function getLiveState(fixtureId) {
  try { return JSON.parse(await fsp.readFile(path.join(LIVE_DIR, `${fixtureId}.json`), "utf8")); }
  catch { return null; }
}

async function is1987User(userId) {
  const uid  = String(userId || "").trim().toLowerCase();
  const raw  = await readJson(USERS_FILE, { items: [] });
  const list = Array.isArray(raw.items) ? raw.items : [];
  const u    = list.find(x => String(x.userId || x.id || "").toLowerCase() === uid);
  return !!(u && (u.is1987 || String(u.segment || "").toLowerCase() === "1987"));
}

async function getUserPred(userId, fixtureId) {
  const raw  = await readJson(PREDS_FILE, []);
  const list = Array.isArray(raw) ? raw : (raw?.items ?? []);
  const uid  = String(userId || "").toLowerCase();
  return list.find(p =>
    String(p.fixtureId || "") === fixtureId &&
    String(p.userId    || "").toLowerCase() === uid
  ) || null;
}

async function spendLc(userId, amount) {
  const uid = String(userId || "").trim();
  return withFileLock(WALLET_FILE, async () => {
    const state = await readJson(WALLET_FILE, { users: [], ledger: [] });
    if (!Array.isArray(state.users))  state.users  = [];
    if (!Array.isArray(state.ledger)) state.ledger = [];

    let wu = state.users.find(x => String(x.userId || "").toLowerCase() === uid.toLowerCase());
    if (!wu) {
      wu = { userId: uid, balance: 30, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastDailyAt: null, totalEarned: 30, totalSpent: 0 };
      state.users.push(wu);
    }
    if (Number(wu.balance || 0) < amount) return { ok: false, lc: Number(wu.balance || 0), needed: amount };

    wu.balance    = Number(wu.balance) - amount;
    wu.totalSpent = (wu.totalSpent || 0) + amount;
    wu.updatedAt  = new Date().toISOString();
    state.ledger.push({ id: "tx_" + Date.now().toString(36), userId: uid, kind: "spend", amount: -amount, reason: "weekly_pick_1987", createdAt: new Date().toISOString() });
    state.updatedAt = new Date().toISOString();
    await writeJsonAtomic(WALLET_FILE, state);
    return { ok: true, lc: Number(wu.balance) };
  });
}

/**
 * GET /api/weekly-picks?userId=xxx
 * Önümüzdeki 7 günde olan tüm maçları döndürür.
 * 24 saat penceresi başlamışsa open:true.
 */
router.get("/", async (req, res) => {
  try {
    const userId = String(req.query.userId || "").trim();
    const now    = Date.now();

    const raw = await readJson(FIXTURES_FILE, { fixtures: [] });
    const all = Array.isArray(raw) ? raw : (raw?.fixtures ?? []);

    const picks = [];
    for (const fx of all) {
      const ko = new Date(fx.kickoffISO || fx.kickoffDate || "").getTime();
      if (!Number.isFinite(ko)) continue;
      if (now < ko - WINDOW_BEFORE_MS) continue;  // pencere açılmamış
      if (now > ko + WINDOW_AFTER_MS)  continue;  // çok geçmiş
      if (ko > now + WEEK_MS)          continue;  // 7 günden uzak

      const live   = await getLiveState(fx.fixtureId);
      const status = live?.status ?? (ko <= now ? "LIVE" : "NS");
      const open   = now >= ko - WINDOW_BEFORE_MS && status !== "FT";

      let pred = null;
      if (userId) pred = await getUserPred(userId, fx.fixtureId);

      picks.push({
        fixtureId:    fx.fixtureId,
        home:         fx.home,
        away:         fx.away,
        kickoffISO:   fx.kickoffISO,
        league:       fx.league  || "—",
        country:      fx.country || "—",
        status,
        score:        live?.score ?? null,
        htScore:      live?.htScore ?? null,
        open,
        minutesUntil: Math.max(0, Math.round((ko - now) / 60000)),
        pred:         pred ? {
          outcome:    pred.outcome,
          firstGoal:  pred.firstGoal  ?? null,
          firstHalf:  pred.firstHalf  ?? null,
          redAny:     pred.redAny     ?? null,
          penaltyAny: pred.penaltyAny ?? null,
        } : null,
        result: status === "FT" && live?.score ? {
          outcome:  live.score.home > live.score.away ? "H" : live.score.away > live.score.home ? "A" : "D",
          score:    live.score,
          htScore:  live.htScore ?? null,
          firstGoal:live.firstGoal ?? null,
          redAny:   !!(live.redHome || live.redAway),
          penaltyAny: !!live.penaltyAny,
        } : null,
      });
    }

    picks.sort((a, b) => new Date(a.kickoffISO).getTime() - new Date(b.kickoffISO).getTime());
    res.json({ ok: true, count: picks.length, picks });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * POST /api/weekly-picks/predict
 * body: { fixtureId, outcome, firstGoal?, firstHalf?, redAny?, penaltyAny? }
 * 1987 üyeleri ücretsiz; diğerleri 3 LC.
 */
router.post("/predict", verifyToken, async (req, res) => {
  try {
    const uid = req.uid;
    const { fixtureId, outcome, firstGoal, firstHalf, redAny, penaltyAny } = req.body || {};

    if (!fixtureId || !["H", "D", "A"].includes(outcome)) {
      return res.status(400).json({ ok: false, error: "INVALID_INPUT" });
    }

    const raw = await readJson(FIXTURES_FILE, { fixtures: [] });
    const all = Array.isArray(raw) ? raw : (raw?.fixtures ?? []);
    const fx  = all.find(f => f.fixtureId === fixtureId);
    if (!fx) return res.status(404).json({ ok: false, error: "FIXTURE_NOT_FOUND" });

    const now = Date.now();
    const ko  = new Date(fx.kickoffISO || "").getTime();
    if (!Number.isFinite(ko) || now < ko - WINDOW_BEFORE_MS) {
      return res.status(400).json({ ok: false, error: "NOT_OPEN_YET" });
    }
    const live = await getLiveState(fixtureId);
    if (live?.status && live.status !== "NS") {
      return res.status(400).json({ ok: false, error: "MATCH_ALREADY_STARTED" });
    }

    const existing = await getUserPred(uid, fixtureId);
    const free     = await is1987User(uid);
    let lc         = 0;
    let lcCharged  = 0;

    if (!free && !existing) {
      const spend = await spendLc(uid, LC_COST_NORMAL);
      if (!spend.ok) return res.status(400).json({ ok: false, error: "LC_NOT_ENOUGH", lc: spend.lc, needed: spend.needed });
      lc        = spend.lc;
      lcCharged = LC_COST_NORMAL;
    }

    await withFileLock(PREDS_FILE, async () => {
      const predsRaw = await readJson(PREDS_FILE, []);
      const list     = Array.isArray(predsRaw) ? predsRaw : (predsRaw?.items ?? []);
      const uidLower = uid.toLowerCase();

      const filtered = list.filter(p =>
        !(String(p.fixtureId || "") === fixtureId &&
          String(p.userId    || "").toLowerCase() === uidLower)
      );

      filtered.push({
        fixtureId,
        userId:     uid,
        outcome,
        firstGoal:  firstGoal  || null,
        firstHalf:  firstHalf  || null,
        redAny:     typeof redAny     === "boolean" ? redAny     : null,
        penaltyAny: typeof penaltyAny === "boolean" ? penaltyAny : null,
        home: null, away: null,
        at:   new Date().toISOString(),
        source: "weekly_pick_1987",
        is1987Free: free,
      });

      const toWrite = Array.isArray(predsRaw) ? filtered : { ...predsRaw, items: filtered };
      await writeJsonAtomic(PREDS_FILE, toWrite);
    });

    res.json({ ok: true, fixtureId, outcome, lc, lcCharged, free });
  } catch (e) {
    console.error("[weekly-picks] predict error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * GET /api/weekly-picks/leaderboard
 * 1987 segmentinin bu haftalık sıralaması
 * match-results.json'dan son 7 günü toplar, is1987 kullanıcılarını filtreler
 */
router.get("/leaderboard", async (req, res) => {
  try {
    const limit  = Math.min(200, Number(req.query.limit  || 50));
    const userId = String(req.query.userId || "").trim();
    const now    = Date.now();
    const weekAgo = now - WEEK_MS;

    // 1987 kullanıcıları
    const usersRaw = await readJson(USERS_FILE, { items: [] });
    const userList = Array.isArray(usersRaw.items) ? usersRaw.items : [];
    const is1987Set = new Set(
      userList
        .filter(u => u.is1987 || String(u.segment || "").toLowerCase() === "1987")
        .map(u => String(u.userId || u.id || "").toLowerCase())
        .filter(Boolean)
    );

    if (!is1987Set.size) return res.json({ ok: true, count: 0, items: [], week: new Date(weekAgo).toISOString() });

    // match-results.json — son 7 günün maçları
    const book   = await readJson(MATCH_RESULTS_FILE, { items: [] });
    const snaps  = (book?.items ?? []).filter(s => {
      const t = new Date(s.computedAt || 0).getTime();
      return t >= weekAgo;
    });

    // Kullanıcı bazında toplam puan
    const totals = new Map(); // uid → { userId, points, matches, correct }
    for (const snap of snaps) {
      for (const row of snap.rows ?? []) {
        const uid = String(row.userId || "").toLowerCase();
        if (!is1987Set.has(uid)) continue;
        const cur = totals.get(uid) || { userId: row.userId, points: 0, matches: 0, correct: 0 };
        cur.points  += Number(row.points || 0);
        cur.matches += 1;
        cur.correct += (row.detail?.outcome > 0) ? 1 : 0;
        totals.set(uid, cur);
      }
    }

    const sorted = Array.from(totals.values())
      .sort((a, b) => b.points - a.points || b.correct - a.correct)
      .slice(0, limit)
      .map((u, i) => ({ rank: i + 1, ...u, points: Math.round(u.points * 10) / 10 }));

    let me = null;
    if (userId) {
      me = sorted.find(r => r.userId.toLowerCase() === userId.toLowerCase()) ?? null;
      if (!me) {
        const myData = totals.get(userId.toLowerCase());
        if (myData) {
          const allSorted = Array.from(totals.values()).sort((a, b) => b.points - a.points);
          const rank = allSorted.findIndex(u => u.userId.toLowerCase() === userId.toLowerCase()) + 1;
          me = { rank, ...myData, points: Math.round(myData.points * 10) / 10 };
        }
      }
    }

    res.json({ ok: true, count: sorted.length, total1987: is1987Set.size, week: new Date(weekAgo).toISOString(), items: sorted, me });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * GET /api/weekly-picks/my
 * Kullanıcının bu haftaki tahminleri + sonuçlar
 */
router.get("/my", verifyToken, async (req, res) => {
  try {
    const uid      = req.uid;
    const predsRaw = await readJson(PREDS_FILE, []);
    const list     = Array.isArray(predsRaw) ? predsRaw : (predsRaw?.items ?? []);
    const uidLower = uid.toLowerCase();

    const myPreds = list.filter(p =>
      String(p.userId || "").toLowerCase() === uidLower &&
      p.source === "weekly_pick_1987"
    );

    const result = [];
    for (const pred of myPreds) {
      const live   = await getLiveState(pred.fixtureId);
      const isFT   = live?.status === "FT";
      const actual = isFT && live?.score
        ? (live.score.home > live.score.away ? "H" : live.score.away > live.score.home ? "A" : "D")
        : null;

      result.push({
        fixtureId:  pred.fixtureId,
        outcome:    pred.outcome,
        firstGoal:  pred.firstGoal  ?? null,
        firstHalf:  pred.firstHalf  ?? null,
        redAny:     pred.redAny     ?? null,
        penaltyAny: pred.penaltyAny ?? null,
        at:         pred.at,
        is1987Free: pred.is1987Free || false,
        status:     live?.status ?? "NS",
        score:      live?.score  ?? null,
        correct:    actual ? pred.outcome === actual : null,
        actual,
      });
    }

    res.json({ ok: true, count: result.length, items: result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * POST /api/weekly-picks/verify-code
 * 1987GS Facebook grup kodunu doğrular; doğruysa kullanıcıya is1987 bayrağı verir.
 */
router.post("/verify-code", verifyToken, async (req, res) => {
  try {
    const uid  = req.uid;
    const code = String(req.body?.code || "").trim();
    const expected = String(process.env.GS1987_CODE || "1987GS").trim();

    if (!code || code.toUpperCase() !== expected.toUpperCase()) {
      return res.status(400).json({ ok: false, error: "WRONG_CODE" });
    }

    await withFileLock(USERS_FILE, async () => {
      const raw   = await readJson(USERS_FILE, { items: [] });
      const items = Array.isArray(raw.items) ? raw.items : [];
      const uidL  = uid.toLowerCase();
      let u = items.find(x => String(x.userId || x.id || "").toLowerCase() === uidL);
      if (!u) {
        u = { userId: uid, is1987: true, createdAt: new Date().toISOString() };
        items.push(u);
      } else {
        u.is1987   = true;
        u.is1987At = new Date().toISOString();
      }
      await writeJsonAtomic(USERS_FILE, { ...raw, items });
    });

    res.json({ ok: true, is1987: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
