"use strict";

const express = require("express");
const router  = express.Router();
const fs      = require("fs");
const fsp     = fs.promises;
const path    = require("path");

const DATA_DIR    = path.join(__dirname, "..", "data");
const WALLET_FILE = path.join(DATA_DIR, "lc-wallet.json");
const USERS_FILE  = path.join(DATA_DIR, "users.json");

// LC ekonomi sabitleri – pred.cjs ve settle2.cjs ile SENKRON
const DAILY_LC         = 5;
const INITIAL_DEFAULT  = 30;
const INITIAL_1987     = 60;
const MATCH_ENTRY_COST = 3; // Maç girişi LC bedeli (bilgi amaçlı)

/* =========================
 *  Ortak dosya yardımcıları
 * ========================= */

async function readJson(file, fb) {
  try {
    const txt = await fsp.readFile(file, "utf8");
    return JSON.parse(txt);
  } catch {
    return fb;
  }
}

async function writeJson(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(data, null, 2), "utf8");
}

/* =========================
 *  DOSYA TABANLI CÜZDAN
 * ========================= */

async function loadWalletState() {
  const fb = { users: [], ledger: [], updatedAt: null };
  const state = (await readJson(WALLET_FILE, fb)) || fb;
  if (!Array.isArray(state.users))  state.users  = [];
  if (!Array.isArray(state.ledger)) state.ledger = [];
  return state;
}

async function saveWalletState(state) {
  state.updatedAt = new Date().toISOString();
  await writeJson(WALLET_FILE, state);
}

async function isUser1987MemberFromFile(userId) {
  const uid = String(userId || "").trim();
  if (!uid) return false;

  const raw = (await readJson(USERS_FILE, { users: [], items: [] })) || {};

  const list = [];
  const pushUser = (u) => {
    if (!u) return;
    const id = String(u.userId || u.id || "").trim();
    if (!id) return;
    list.push({ ...u, userId: id });
  };

  if (Array.isArray(raw.users)) raw.users.forEach(pushUser);
  if (Array.isArray(raw.items)) raw.items.forEach(pushUser);

  const u = list.find(
    (u) =>
      String(u.userId || "")
        .trim()
        .toLowerCase() === uid.toLowerCase()
  );
  if (!u) return false;

  const seg = String(u.segment || "").toLowerCase();
  return u.is1987 === true || seg === "1987";
}

function todayKey(d = new Date()) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function addLedgerEntryFile(state, { userId, kind, amount, reason, fixtureId, meta }) {
  const nowISO = new Date().toISOString();
  state.ledger.push({
    id:
      "tx_" +
      Date.now().toString(36) +
      "_" +
      Math.random().toString(36).slice(2, 8),
    userId,
    kind,
    amount,
    reason: reason || null,
    fixtureId: fixtureId || null,
    meta: meta || null,
    createdAt: nowISO,
  });
}

async function ensureWalletUserFile(userId) {
  const uid = String(userId || "").trim();
  if (!uid) throw new Error("USER_REQUIRED");

  const state = await loadWalletState();

  let u = state.users.find(
    (x) =>
      String(x.userId || "")
        .trim()
        .toLowerCase() === uid.toLowerCase()
  );

  if (!u) {
    const is1987 = await isUser1987MemberFromFile(uid);
    const initialBalance = is1987 ? INITIAL_1987 : INITIAL_DEFAULT;
    const nowISO = new Date().toISOString();
    u = {
      userId: uid,
      balance: initialBalance,
      createdAt: nowISO,
      updatedAt: nowISO,
      lastDailyAt: null,
      totalEarned: initialBalance,
      totalSpent: 0,
    };
    state.users.push(u);

    addLedgerEntryFile(state, {
      userId: uid,
      kind: "init",
      amount: initialBalance,
      reason: is1987 ? "initial_1987" : "initial_default",
    });

    await saveWalletState(state);
  }

  return { state, user: u };
}

/* =========================
 *  MONGO YARDIMCILARI
 * ========================= */

function getDb(req) {
  const db = req.app?.locals?.db;
  return db || null;
}

// Şimdilik 1987 üyelik dosyadan okunuyor; ileride Mongo'ya taşınabilir.
async function isUser1987MemberMongoOrFile(db, userId) {
  return isUser1987MemberFromFile(userId);
}

async function addLedgerEntryMongo(db, { userId, kind, amount, reason, fixtureId, meta }) {
  const nowISO = new Date().toISOString();
  const uid = String(userId || "").trim();
  if (!uid) return;

  const ledgerCol = db.collection("lc_wallet_ledger");

  await ledgerCol.insertOne({
    id:
      "tx_" +
      Date.now().toString(36) +
      "_" +
      Math.random().toString(36).slice(2, 8),
    userId: uid,
    userIdLower: uid.toLowerCase(),
    kind,
    amount,
    reason: reason || null,
    fixtureId: fixtureId || null,
    meta: meta || null,
    createdAt: nowISO,
  });
}

async function ensureWalletUserMongo(db, userId) {
  const uid = String(userId || "").trim();
  if (!uid) throw new Error("USER_REQUIRED");

  const uidLower = uid.toLowerCase();
  const col = db.collection("lc_wallet_users");

  let user = await col.findOne({ userIdLower: uidLower });

  if (!user) {
    const is1987 = await isUser1987MemberMongoOrFile(db, uid);
    const initialBalance = is1987 ? INITIAL_1987 : INITIAL_DEFAULT;
    const nowISO = new Date().toISOString();

    const doc = {
      userId: uid,
      userIdLower: uidLower,
      balance: initialBalance,
      createdAt: nowISO,
      updatedAt: nowISO,
      lastDailyAt: null,
      totalEarned: initialBalance,
      totalSpent: 0,
      is1987: !!is1987,
    };

    await col.insertOne(doc);

    await addLedgerEntryMongo(db, {
      userId: uid,
      kind: "init",
      amount: initialBalance,
      reason: is1987 ? "initial_1987" : "initial_default",
    });

    user = doc;
  }

  return user;
}

/* =========================
 *  ROUTES
 * ========================= */

/**
 * GET /api/rt/lc-wallet/summary?userId=...
 * - Kullanıcının cüzdanını döner (gerekirse oluşturur).
 * - Bugünkü günlük LC hakkı var mı bilgisini de döner.
 * - Ayrıca ekonomi sabitlerini (günlük, maç girişi vs.) verir.
 */
router.get("/lc-wallet/summary", async (req, res) => {
  try {
    const userId = String(req.query.userId || "").trim();
    if (!userId) {
      return res
        .status(400)
        .json({ ok: false, error: "USER_REQUIRED" });
    }

    const db = getDb(req);

    if (db) {
      // 🔵 Mongo modu
      const user = await ensureWalletUserMongo(db, userId);

      const today = todayKey();
      const last  = user.lastDailyAt ? user.lastDailyAt.slice(0, 10) : null;
      const canClaim = !last || last !== today;

      return res.json({
        ok: true,
        user: {
          userId: user.userId,
          balance: user.balance,
          lastDailyAt: user.lastDailyAt,
          totalEarned: user.totalEarned || 0,
          totalSpent: user.totalSpent || 0,
          is1987: !!user.is1987,
        },
        daily: {
          today,
          canClaim,
          amount: DAILY_LC,
        },
        pricing: {
          daily: DAILY_LC,
          matchEntryCost: MATCH_ENTRY_COST,
          initialDefault: INITIAL_DEFAULT,
          initial1987: INITIAL_1987,
        },
        updatedAt: user.updatedAt || null,
      });
    }

    // 🟢 Dosya modu (mevcut davranış)
    const { state, user } = await ensureWalletUserFile(userId);

    const today = todayKey();
    const last  = user.lastDailyAt ? user.lastDailyAt.slice(0, 10) : null;
    const canClaim = !last || last !== today;

    return res.json({
      ok: true,
      user: {
        userId: user.userId,
        balance: user.balance,
        lastDailyAt: user.lastDailyAt,
        totalEarned: user.totalEarned || 0,
        totalSpent: user.totalSpent || 0,
      },
      daily: {
        today,
        canClaim,
        amount: DAILY_LC,
      },
      pricing: {
        daily: DAILY_LC,
        matchEntryCost: MATCH_ENTRY_COST,
        initialDefault: INITIAL_DEFAULT,
        initial1987: INITIAL_1987,
      },
      updatedAt: state.updatedAt || null,
    });
  } catch (e) {
    console.error("LC_WALLET_SUMMARY_ERR", e);
    return res.status(500).json({
      ok: false,
      error: "LC_WALLET_SUMMARY_ERR",
      detail: String(e && (e.message || e)),
    });
  }
});

/**
 * POST /api/rt/lc-wallet/daily-claim
 * body: { userId }
 * - Günde 1 kez 5 LC ekler.
 */
router.post("/lc-wallet/daily-claim", express.json(), async (req, res) => {
  try {
    const userId = String(req.body?.userId || "").trim();
    if (!userId) {
      return res
        .status(400)
        .json({ ok: false, error: "USER_REQUIRED" });
    }

    const db = getDb(req);

    if (db) {
      // 🔵 Mongo modu – yarış koşullarına dayanıklı
      const col = db.collection("lc_wallet_users");
      const uidLower = userId.toLowerCase();
      const today = todayKey();

      const user = await ensureWalletUserMongo(db, userId);

      const last = user.lastDailyAt ? user.lastDailyAt.slice(0, 10) : null;
      if (last === today) {
        return res.status(400).json({
          ok: false,
          error: "DAILY_ALREADY_CLAIMED",
          today,
          lastDailyAt: user.lastDailyAt,
        });
      }

      const nowISO = new Date().toISOString();

      const updateResult = await col.updateOne(
        {
          userIdLower: uidLower,
          lastDailyAt: user.lastDailyAt || null,
        },
        {
          $inc: {
            balance: DAILY_LC,
            totalEarned: DAILY_LC,
          },
          $set: {
            lastDailyAt: nowISO,
            updatedAt: nowISO,
          },
        }
      );

      if (!updateResult.matchedCount) {
        const fresh = await col.findOne({ userIdLower: uidLower });
        const freshLast = fresh?.lastDailyAt
          ? fresh.lastDailyAt.slice(0, 10)
          : null;

        if (freshLast === today) {
          return res.status(400).json({
            ok: false,
            error: "DAILY_ALREADY_CLAIMED",
            today,
            lastDailyAt: fresh.lastDailyAt,
          });
        }

        console.warn("LC_WALLET_DAILY_CONFLICT", {
          userId,
          expectedLast: user.lastDailyAt || null,
          actualLast: fresh?.lastDailyAt || null,
        });

        return res.status(500).json({
          ok: false,
          error: "LC_WALLET_DAILY_CONFLICT",
        });
      }

      const updatedUser = await col.findOne({ userIdLower: uidLower });

      await addLedgerEntryMongo(db, {
        userId,
        kind: "reward",
        amount: DAILY_LC,
        reason: "daily",
      });

      return res.json({
        ok: true,
        user: {
          userId: updatedUser.userId,
          balance: updatedUser.balance,
          lastDailyAt: updatedUser.lastDailyAt,
          totalEarned: updatedUser.totalEarned || 0,
          totalSpent: updatedUser.totalSpent || 0,
          is1987: !!updatedUser.is1987,
        },
        daily: {
          today,
          amount: DAILY_LC,
          claimed: true,
        },
      });
    }

    // 🟢 Dosya modu (mevcut davranış)
    const state = await loadWalletState();

    let u = state.users.find(
      (x) =>
        String(x.userId || "")
          .trim()
          .toLowerCase() === userId.toLowerCase()
    );

    if (!u) {
      const is1987 = await isUser1987MemberFromFile(userId);
      const initialBalance = is1987 ? INITIAL_1987 : INITIAL_DEFAULT;
      const nowISO = new Date().toISOString();
      u = {
        userId,
        balance: initialBalance,
        createdAt: nowISO,
        updatedAt: nowISO,
        lastDailyAt: null,
        totalEarned: initialBalance,
        totalSpent: 0,
      };
      state.users.push(u);

      addLedgerEntryFile(state, {
        userId,
        kind: "init",
        amount: initialBalance,
        reason: is1987 ? "initial_1987" : "initial_default",
      });
    }

    const today = todayKey();
    const last  = u.lastDailyAt ? u.lastDailyAt.slice(0, 10) : null;
    if (last === today) {
      return res.status(400).json({
        ok: false,
        error: "DAILY_ALREADY_CLAIMED",
        today,
        lastDailyAt: u.lastDailyAt,
      });
    }

    u.balance += DAILY_LC;
    u.totalEarned = (u.totalEarned || 0) + DAILY_LC;
    u.lastDailyAt = new Date().toISOString();
    u.updatedAt   = u.lastDailyAt;

    addLedgerEntryFile(state, {
      userId,
      kind: "reward",
      amount: DAILY_LC,
      reason: "daily",
    });

    await saveWalletState(state);

    return res.json({
      ok: true,
      user: {
        userId: u.userId,
        balance: u.balance,
        lastDailyAt: u.lastDailyAt,
        totalEarned: u.totalEarned || 0,
        totalSpent: u.totalSpent || 0,
      },
      daily: {
        today,
        amount: DAILY_LC,
        claimed: true,
      },
    });
  } catch (e) {
    console.error("LC_WALLET_DAILY_ERR", e);
    return res.status(500).json({
      ok: false,
      error: "LC_WALLET_DAILY_ERR",
      detail: String(e && (e.message || e)),
    });
  }
});

/**
 * GET /api/rt/lc-wallet/ledger?userId=...&limit=50
 * - Kullanıcının son işlemlerini döner.
 */
router.get("/lc-wallet/ledger", async (req, res) => {
  try {
    const userId = String(req.query.userId || "").trim();
    const limit  = Number(req.query.limit || 50) || 50;
    if (!userId) {
      return res
        .status(400)
        .json({ ok: false, error: "USER_REQUIRED" });
    }

    const db = getDb(req);

    if (db) {
      // 🔵 Mongo modu
      const ledgerCol = db.collection("lc_wallet_ledger");
      const uidLower = userId.toLowerCase();

      const items = await ledgerCol
        .find({ userIdLower: uidLower })
        .sort({ createdAt: -1 })
        .limit(limit)
        .toArray();

      return res.json({
        ok: true,
        userId,
        count: items.length,
        items,
      });
    }

    // 🟢 Dosya modu (mevcut davranış)
    const state = await loadWalletState();

    const items = state.ledger
      .filter(
        (tx) =>
          String(tx.userId || "")
            .trim()
            .toLowerCase() === userId.toLowerCase()
      )
      .sort(
        (a, b) =>
          new Date(b.createdAt || 0).getTime() -
          new Date(a.createdAt || 0).getTime()
      )
      .slice(0, limit);

    return res.json({
      ok: true,
      userId,
      count: items.length,
      items,
    });
  } catch (e) {
    console.error("LC_WALLET_LEDGER_ERR", e);
    return res.status(500).json({
      ok: false,
      error: "LC_WALLET_LEDGER_ERR",
      detail: String(e && (e.message || e)),
    });
  }
});

module.exports = router;
