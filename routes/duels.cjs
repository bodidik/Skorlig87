"use strict";

const express = require("express");
const router = express.Router();
const path = require("path");
const fsp = require("fs").promises;
const { withFileLock, writeJsonAtomic } = require("../lib/fileLock.cjs");
const { verifyToken } = require("../middleware/verifyToken.cjs");

const DATA_DIR = path.join(__dirname, "..", "data");
const DUELS_FILE = path.join(DATA_DIR, "duels.json");
const WALLET_FILE = path.join(DATA_DIR, "lc-wallet.json");

const MIN_STAKE = 1;
const MAX_STAKE = 12;

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function readJson(file, fb) {
  try { return JSON.parse(await fsp.readFile(file, "utf8")); }
  catch { return fb; }
}

async function loadDuels() {
  const raw = await readJson(DUELS_FILE, []);
  return Array.isArray(raw) ? raw : [];
}

async function saveDuels(list) {
  await writeJsonAtomic(DUELS_FILE, list);
}

function genId() {
  return "duel_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

function getDb(req) {
  return req?.app?.locals?.db || null;
}

// ─── File-based LC helpers ────────────────────────────────────────────────────

async function loadWallet() {
  const fb = { users: [], ledger: [], updatedAt: null };
  const w = (await readJson(WALLET_FILE, fb)) || fb;
  if (!Array.isArray(w.users)) w.users = [];
  if (!Array.isArray(w.ledger)) w.ledger = [];
  return w;
}

async function saveWallet(state) {
  state.updatedAt = new Date().toISOString();
  await writeJsonAtomic(WALLET_FILE, state);
}

function walletUser(state, uid) {
  const u = uid.toLowerCase();
  return state.users.find(x => String(x.userId || "").toLowerCase() === u) || null;
}

function addLedger(state, { userId, kind, amount, reason, duelId }) {
  state.ledger.push({
    id: "tx_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8),
    userId, kind, amount,
    reason: reason || null,
    duelId: duelId || null,
    createdAt: new Date().toISOString(),
  });
}

async function deductLcFile(uid, amount, reason, duelId) {
  return withFileLock(WALLET_FILE, async () => {
    const state = await loadWallet();
    const u = walletUser(state, uid);
    if (!u) return { ok: false, error: "WALLET_NOT_FOUND" };
    const bal = Number(u.balance || 0);
    if (bal < amount) return { ok: false, error: "LC_NOT_ENOUGH", lc: bal, needed: amount };
    u.balance = bal - amount;
    u.totalSpent = (u.totalSpent || 0) + amount;
    u.updatedAt = new Date().toISOString();
    addLedger(state, { userId: uid, kind: "spend", amount: -amount, reason, duelId });
    await saveWallet(state);
    return { ok: true, lc: u.balance };
  });
}

async function creditLcFile(uid, amount, reason, duelId) {
  return withFileLock(WALLET_FILE, async () => {
    const state = await loadWallet();
    let u = walletUser(state, uid);
    if (!u) {
      const now = new Date().toISOString();
      u = { userId: uid, balance: 0, createdAt: now, updatedAt: now, totalEarned: 0, totalSpent: 0, lastDailyAt: null };
      state.users.push(u);
    }
    u.balance = Number(u.balance || 0) + amount;
    u.totalEarned = (u.totalEarned || 0) + amount;
    u.updatedAt = new Date().toISOString();
    addLedger(state, { userId: uid, kind: "earn", amount, reason, duelId });
    await saveWallet(state);
    return { ok: true, lc: u.balance };
  });
}

// ─── Mongo LC helpers ─────────────────────────────────────────────────────────

async function deductLcMongo(db, uid, amount, reason, duelId) {
  const col = db.collection("lc_wallet_users");
  const ledger = db.collection("lc_wallet_ledger");
  const uidL = uid.toLowerCase();
  const user = await col.findOne({ userIdLower: uidL });
  if (!user) return { ok: false, error: "WALLET_NOT_FOUND" };
  const bal = Number(user.balance || 0);
  if (bal < amount) return { ok: false, error: "LC_NOT_ENOUGH", lc: bal, needed: amount };
  const r = await col.updateOne(
    { userIdLower: uidL, balance: bal },
    { $inc: { balance: -amount, totalSpent: amount }, $set: { updatedAt: new Date().toISOString() } }
  );
  if (!r.matchedCount) return { ok: false, error: "CONCURRENT_WRITE" };
  await ledger.insertOne({
    id: "tx_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8),
    userId: uid, userIdLower: uidL, kind: "spend", amount: -amount,
    reason: reason || null, duelId: duelId || null, createdAt: new Date().toISOString(),
  });
  return { ok: true, lc: bal - amount };
}

async function creditLcMongo(db, uid, amount, reason, duelId) {
  const col = db.collection("lc_wallet_users");
  const ledger = db.collection("lc_wallet_ledger");
  const uidL = uid.toLowerCase();
  await col.updateOne(
    { userIdLower: uidL },
    { $inc: { balance: amount, totalEarned: amount }, $set: { updatedAt: new Date().toISOString() } },
    { upsert: true }
  );
  await ledger.insertOne({
    id: "tx_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8),
    userId: uid, userIdLower: uidL, kind: "earn", amount,
    reason: reason || null, duelId: duelId || null, createdAt: new Date().toISOString(),
  });
  return { ok: true };
}

async function deductLc(db, uid, amount, reason, duelId) {
  return db ? deductLcMongo(db, uid, amount, reason, duelId) : deductLcFile(uid, amount, reason, duelId);
}

async function creditLc(db, uid, amount, reason, duelId) {
  return db ? creditLcMongo(db, uid, amount, reason, duelId) : creditLcFile(uid, amount, reason, duelId);
}

// ─── Exported: settle duels for a fixture (called from settle2.cjs) ──────────
// scoresMap: { [userId]: points }

async function settleDuelsForFixture(fixtureId, scoresMap, db) {
  const fid = String(fixtureId || "").trim();
  if (!fid || !scoresMap) return { settled: 0 };

  const settled = [];

  await withFileLock(DUELS_FILE, async () => {
    const list = await loadDuels();
    const nowISO = new Date().toISOString();
    let changed = false;

    for (const duel of list) {
      if (duel.fixtureId !== fid || duel.status !== "active") continue;

      // Normalize userId lookups (case-insensitive)
      function getPoints(uid) {
        if (!uid) return 0;
        const k = Object.keys(scoresMap).find(
          k => k.toLowerCase() === String(uid).toLowerCase()
        );
        return k != null ? Number(scoresMap[k] || 0) : 0;
      }

      const cp = getPoints(duel.creatorId);
      const ap = getPoints(duel.acceptorId);

      duel.creatorPoints = cp;
      duel.acceptorPoints = ap;
      duel.status = "settled";
      duel.settledAt = nowISO;
      duel.winnerId = cp > ap ? duel.creatorId : ap > cp ? duel.acceptorId : null;

      settled.push({ ...duel });
      changed = true;
    }

    if (changed) await saveDuels(list);
  });

  // Credit winners outside lock (different file = safe)
  for (const duel of settled) {
    try {
      if (duel.winnerId) {
        await creditLc(db, duel.winnerId, duel.pot, "duel_win", duel.id);
      } else {
        // Tie: refund both
        await creditLc(db, duel.creatorId, duel.stake, "duel_tie_refund", duel.id);
        await creditLc(db, duel.acceptorId, duel.stake, "duel_tie_refund", duel.id);
      }
      if (db) {
        try { await db.collection("duels").updateOne({ id: duel.id }, { $set: duel }); } catch {}
      }
    } catch (e) {
      console.error("[duels] settle credit failed for", duel.id, e);
    }
  }

  return { settled: settled.length, items: settled };
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// POST /api/duels/create
router.post("/duels/create", verifyToken, async (req, res) => {
  try {
    const db = getDb(req);
    const { fixtureId, stake, challengedId, creatorName, home, away, league, kickoffISO } = req.body || {};
    const creatorId = req.uid;
    const fx = String(fixtureId || "").trim();
    if (!fx) return res.status(400).json({ ok: false, error: "FIXTURE_ID_REQUIRED" });

    const s = Math.floor(Number(stake));
    if (!Number.isFinite(s) || s < MIN_STAKE || s > MAX_STAKE) {
      return res.status(400).json({ ok: false, error: "INVALID_STAKE", min: MIN_STAKE, max: MAX_STAKE });
    }

    const targetId = challengedId ? String(challengedId).trim() : null;
    if (targetId && targetId.toLowerCase() === creatorId.toLowerCase()) {
      return res.status(400).json({ ok: false, error: "CANNOT_CHALLENGE_YOURSELF" });
    }

    // Deduct stake from creator
    const spend = await deductLc(db, creatorId, s, "duel_create", null);
    if (!spend.ok) {
      return res.status(400).json({ ok: false, error: spend.error || "LC_NOT_ENOUGH", lc: spend.lc, needed: s });
    }

    const nowISO = new Date().toISOString();
    const id = genId();
    const duel = {
      id, fixtureId: fx, stake: s,
      creatorId, creatorName: String(creatorName || "").trim() || null,
      challengedId: targetId, acceptorId: null, acceptorName: null,
      status: "open",
      home: String(home || "").trim() || null,
      away: String(away || "").trim() || null,
      league: String(league || "").trim() || null,
      kickoffISO: kickoffISO || null,
      creatorPoints: null, acceptorPoints: null, winnerId: null,
      pot: s * 2,
      createdAt: nowISO, acceptedAt: null, settledAt: null,
    };

    await withFileLock(DUELS_FILE, async () => {
      const list = await loadDuels();
      list.push(duel);
      await saveDuels(list);
    });

    if (db) {
      try { await db.collection("duels").insertOne(duel); } catch (e) { console.error("[duels] mongo create:", e); }
    }

    return res.json({ ok: true, duel });
  } catch (e) {
    console.error("[duels] create failed:", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// POST /api/duels/accept
router.post("/duels/accept", verifyToken, async (req, res) => {
  try {
    const db = getDb(req);
    const acceptorId = req.uid;
    const did = String(req.body?.duelId || "").trim();
    const acceptorName = String(req.body?.acceptorName || "").trim() || null;
    if (!did) return res.status(400).json({ ok: false, error: "DUEL_ID_REQUIRED" });

    let result = null;

    await withFileLock(DUELS_FILE, async () => {
      const list = await loadDuels();
      const duel = list.find(d => d.id === did);

      if (!duel) { result = { err: "DUEL_NOT_FOUND" }; return; }
      if (duel.status !== "open") { result = { err: "NOT_OPEN" }; return; }
      if (duel.creatorId.toLowerCase() === acceptorId.toLowerCase()) { result = { err: "CANNOT_ACCEPT_OWN" }; return; }
      if (duel.challengedId && duel.challengedId.toLowerCase() !== acceptorId.toLowerCase()) {
        result = { err: "NOT_YOUR_CHALLENGE" }; return;
      }

      // Deduct inside DUELS lock — same pattern as pred.cjs
      const spend = await deductLc(db, acceptorId, duel.stake, "duel_accept", did);
      if (!spend.ok) { result = { err: spend.error || "LC_NOT_ENOUGH", lc: spend.lc, needed: duel.stake }; return; }

      duel.acceptorId = acceptorId;
      duel.acceptorName = acceptorName;
      duel.status = "active";
      duel.acceptedAt = new Date().toISOString();
      await saveDuels(list);
      result = { duel: { ...duel } };
    });

    if (!result) return res.status(500).json({ ok: false, error: "UNKNOWN" });
    if (result.err === "DUEL_NOT_FOUND") return res.status(404).json({ ok: false, error: result.err });
    if (result.err) return res.status(400).json({ ok: false, error: result.err, lc: result.lc, needed: result.needed });

    if (db) {
      try { await db.collection("duels").updateOne({ id: did }, { $set: result.duel }); } catch {}
    }
    return res.json({ ok: true, duel: result.duel });
  } catch (e) {
    console.error("[duels] accept failed:", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// POST /api/duels/cancel
router.post("/duels/cancel", verifyToken, async (req, res) => {
  try {
    const db = getDb(req);
    const uid = req.uid;
    const did = String(req.body?.duelId || "").trim();
    if (!did) return res.status(400).json({ ok: false, error: "DUEL_ID_REQUIRED" });

    let result = null;

    await withFileLock(DUELS_FILE, async () => {
      const list = await loadDuels();
      const duel = list.find(d => d.id === did);
      if (!duel) { result = { err: "DUEL_NOT_FOUND" }; return; }
      if (duel.status !== "open") { result = { err: "NOT_OPEN" }; return; }
      if (duel.creatorId.toLowerCase() !== uid.toLowerCase()) { result = { err: "NOT_YOUR_DUEL" }; return; }
      duel.status = "cancelled";
      duel.settledAt = new Date().toISOString();
      await saveDuels(list);
      result = { duel: { ...duel } };
    });

    if (!result || result.err === "DUEL_NOT_FOUND") return res.status(404).json({ ok: false, error: "DUEL_NOT_FOUND" });
    if (result.err) return res.status(400).json({ ok: false, error: result.err });

    // Refund outside the lock
    await creditLc(db, result.duel.creatorId, result.duel.stake, "duel_cancel_refund", did);

    if (db) {
      try { await db.collection("duels").updateOne({ id: did }, { $set: result.duel }); } catch {}
    }
    return res.json({ ok: true, duel: result.duel });
  } catch (e) {
    console.error("[duels] cancel failed:", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// GET /api/duels/open?fixtureId=&userId=
router.get("/duels/open", async (req, res) => {
  try {
    const fx = String(req.query.fixtureId || "").trim();
    const uid = String(req.query.userId || "").trim();
    if (!fx) return res.status(400).json({ ok: false, error: "FIXTURE_ID_REQUIRED" });

    const list = await loadDuels();
    const uidL = uid.toLowerCase();
    const open = list.filter(d => {
      if (d.fixtureId !== fx || d.status !== "open") return false;
      if (uid && d.creatorId.toLowerCase() === uidL) return false; // own duel
      if (d.challengedId && uid && d.challengedId.toLowerCase() !== uidL) return false; // targeted at another
      return true;
    });

    return res.json({ ok: true, count: open.length, items: open });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// GET /api/duels/my?userId=&fixtureId=
router.get("/duels/my", async (req, res) => {
  try {
    const uid = String(req.query.userId || "").trim();
    const fx = String(req.query.fixtureId || "").trim();
    if (!uid) return res.status(400).json({ ok: false, error: "USER_ID_REQUIRED" });

    const uidL = uid.toLowerCase();
    const list = await loadDuels();
    const mine = list
      .filter(d => {
        const isMe = d.creatorId.toLowerCase() === uidL || (d.acceptorId && d.acceptorId.toLowerCase() === uidL);
        if (!isMe) return false;
        if (fx && d.fixtureId !== fx) return false;
        return true;
      })
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return res.json({ ok: true, count: mine.length, items: mine });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// GET /api/duels/fixture-board?fixtureId= — tüm duellolar (settle sonrası skor karşılaştırması için)
router.get("/duels/fixture-board", async (req, res) => {
  try {
    const fx = String(req.query.fixtureId || "").trim();
    if (!fx) return res.status(400).json({ ok: false, error: "FIXTURE_ID_REQUIRED" });
    const list = await loadDuels();
    const items = list.filter(d => d.fixtureId === fx);
    return res.json({ ok: true, count: items.length, items });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

module.exports = router;
module.exports.settleDuelsForFixture = settleDuelsForFixture;
