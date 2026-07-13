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

// Otomatik birikim (token bitince bekle): lib/lc-regen.cjs
const { applyRegen, regenInfo } = require("../lib/lc-regen.cjs");

// Premium ayrıcalıkları (tek kaynak)
const premium = require("../lib/premium.cjs");

/* =========================
 *  LC MAĞAZASI (ücret karşılığı token)
 *  SKORLIG_STORE_MODE=mock  -> test modu: anında yüklenir (varsayılan)
 *  SKORLIG_STORE_MODE=disabled -> satın alma kapalı
 *  Gerçek yayında: Google Play Billing / App Store IAP makbuz doğrulaması
 *  purchase endpoint'ine eklenmeli (provider:"google"|"apple" dalı).
 * ========================= */
const STORE_MODE = String(process.env.SKORLIG_STORE_MODE || "mock").toLowerCase();

const LC_PACKAGES = [
  // Tokeni tükenen kullanıcı için ucuz, hızlı "acil giriş" paketi (en az 3 maç girişi eder)
  { id: "lc_10",  lc: 10,  priceTRY: 7.99,  label: "Acil Token", emergency: true },
  { id: "lc_30",  lc: 30,  priceTRY: 19.99, label: "Başlangıç Paketi" },
  { id: "lc_80",  lc: 80,  priceTRY: 44.99, label: "Taraftar Paketi",  popular: true },
  { id: "lc_200", lc: 200, priceTRY: 99.99, label: "Şampiyon Paketi" },
];

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

    const isPrem = await premium.isPremium(userId);
    const regenOpts = premium.regenParams(isPrem);

    // Premium aylık kasa: bu takvim ayı henüz verilmediyse otomatik yatır
    const monthlyGranted = premium.grantMonthlyIfDue(user, isPrem);
    if (monthlyGranted > 0) {
      addLedgerEntryFile(state, {
        userId,
        kind: "reward",
        amount: monthlyGranted,
        reason: "premium_monthly",
        meta: { month: premium.monthKey() },
      });
    }

    // Otomatik birikim: bakiye düşükse zamanla token toplanır (premium daha hızlı/yüksek)
    const regenEarned = applyRegen(user, Date.now(), regenOpts);
    if (monthlyGranted > 0 || regenEarned > 0) await saveWalletState(state);

    const today = todayKey();
    const last  = user.lastDailyAt ? user.lastDailyAt.slice(0, 10) : null;
    const canClaim = !last || last !== today;
    const dailyAmount = premium.dailyLc(isPrem);

    return res.json({
      ok: true,
      user: {
        userId: user.userId,
        balance: user.balance,
        lastDailyAt: user.lastDailyAt,
        totalEarned: user.totalEarned || 0,
        totalSpent: user.totalSpent || 0,
        premium: isPrem,
      },
      daily: {
        today,
        canClaim,
        amount: dailyAmount,
      },
      pricing: {
        daily: dailyAmount,
        matchEntryCost: premium.matchCost(isPrem, MATCH_ENTRY_COST),
        initialDefault: INITIAL_DEFAULT,
        initial1987: INITIAL_1987,
      },
      premium: isPrem,
      premiumMonthly: premium.monthlyInfo(user, isPrem),
      regen: regenInfo(user, Date.now(), regenOpts),
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

    const isPrem = await premium.isPremium(userId);
    const dailyAmount = premium.dailyLc(isPrem);

    u.balance += dailyAmount;
    u.totalEarned = (u.totalEarned || 0) + dailyAmount;
    u.lastDailyAt = new Date().toISOString();
    u.updatedAt   = u.lastDailyAt;

    addLedgerEntryFile(state, {
      userId,
      kind: "reward",
      amount: dailyAmount,
      reason: isPrem ? "daily_premium" : "daily",
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
        premium: isPrem,
      },
      daily: {
        today,
        amount: dailyAmount,
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

/**
 * GET /api/rt/lc-wallet/store
 * LC paketlerini ve mağaza modunu döner.
 */
router.get("/lc-wallet/store", (req, res) => {
  res.json({
    ok: true,
    mode: STORE_MODE, // "mock" | "disabled"
    packages: LC_PACKAGES,
    note:
      STORE_MODE === "mock"
        ? "Test modu: satın alma anında yüklenir, gerçek ödeme alınmaz."
        : "Satın alma şu anda kapalı.",
  });
});

/**
 * POST /api/rt/lc-wallet/purchase
 * body: { userId, packageId }
 *
 * mock modunda anında yükler (test). Gerçek yayında bu endpoint'e
 * Google Play / App Store makbuz doğrulaması eklenmeli:
 *   body: { userId, packageId, provider: "google"|"apple", receipt }
 */
router.post("/lc-wallet/purchase", express.json(), async (req, res) => {
  try {
    const userId = String(req.body?.userId || "").trim();
    const packageId = String(req.body?.packageId || "").trim();
    if (!userId || !packageId) {
      return res.status(400).json({ ok: false, error: "USER_OR_PACKAGE_MISSING" });
    }

    const pkg = LC_PACKAGES.find((p) => p.id === packageId);
    if (!pkg) return res.status(404).json({ ok: false, error: "PACKAGE_NOT_FOUND" });

    if (STORE_MODE === "disabled") {
      return res.status(403).json({
        ok: false,
        error: "STORE_DISABLED",
        detail: "Satın alma şu anda kapalı. Günlük LC hakkını kullanabilir veya token birikmesini bekleyebilirsin.",
      });
    }

    if (STORE_MODE !== "mock") {
      // Gerçek sağlayıcı entegrasyonu buraya (makbuz doğrulama).
      return res.status(501).json({ ok: false, error: "STORE_PROVIDER_NOT_IMPLEMENTED", mode: STORE_MODE });
    }

    // --- mock: anında yükle ---
    const { state, user } = await ensureWalletUserFile(userId);
    const nowISO = new Date().toISOString();

    // Premium ayrıcalığı: satın alımda bonus LC
    const isPrem = await premium.isPremium(userId);
    const bonus = isPrem ? Math.round(pkg.lc * premium.PERKS.storeBonusPct) : 0;
    const totalLc = pkg.lc + bonus;

    user.balance = Number(user.balance || 0) + totalLc;
    user.totalEarned = Number(user.totalEarned || 0) + totalLc;
    user.updatedAt = nowISO;

    addLedgerEntryFile(state, {
      userId,
      kind: "purchase",
      amount: totalLc,
      reason: "store_purchase_mock",
      fixtureId: null,
      meta: { packageId: pkg.id, priceTRY: pkg.priceTRY, mode: "mock", baseLc: pkg.lc, premiumBonus: bonus },
    });

    await saveWalletState(state);

    // users.json lc alanını da senkron tut (settle2/pred ile aynı çift-yazım)
    try {
      const usersRaw = await readJson(USERS_FILE, { items: [] });
      const items = Array.isArray(usersRaw) ? usersRaw : usersRaw.items || [];
      let u = items.find((x) => String(x.userId) === userId);
      if (!u) {
        u = { userId, mainTeam: null, createdAt: nowISO, lc: 0, lcLastDaily: null };
        items.push(u);
      }
      u.lc = Number(u.lc || 0) + totalLc;
      u.lcUpdatedAt = nowISO;
      u.lcLastReason = "store_purchase_mock";
      u.lcLastAmount = totalLc;
      await writeJson(USERS_FILE, Array.isArray(usersRaw) ? items : { ...usersRaw, items });
    } catch (e) {
      console.warn("[lc-store] users.json senkron yazılamadı:", e && e.message ? e.message : e);
    }

    return res.json({
      ok: true,
      mode: "mock",
      package: pkg,
      premiumBonus: bonus,
      lcLoaded: totalLc,
      newBalance: user.balance,
    });
  } catch (e) {
    console.error("LC_STORE_PURCHASE_ERR", e);
    return res.status(500).json({
      ok: false,
      error: "LC_STORE_PURCHASE_ERR",
      detail: String(e && (e.message || e)),
    });
  }
});

/**
 * GET /api/rt/lc-wallet/premium/status?userId=
 * Premium durumu + ayrıcalıklar + abonelik paketleri.
 */
router.get("/lc-wallet/premium/status", async (req, res) => {
  try {
    const userId = String(req.query.userId || "").trim();
    if (!userId) return res.status(400).json({ ok: false, error: "USER_REQUIRED" });
    const status = await premium.premiumStatus(userId);
    res.json({ ok: true, mode: STORE_MODE, ...status });
  } catch (e) {
    res.status(500).json({ ok: false, error: "PREMIUM_STATUS_ERR", detail: String(e?.message || e) });
  }
});

/**
 * POST /api/rt/lc-wallet/premium/subscribe { userId, planId }
 * mock modunda aboneliği anında açar (test). Gerçek yayında Google Play/
 * App Store abonelik makbuzu doğrulaması buraya eklenecek.
 */
router.post("/lc-wallet/premium/subscribe", express.json(), async (req, res) => {
  try {
    const userId = String(req.body?.userId || "").trim();
    const planId = String(req.body?.planId || "").trim();
    if (!userId || !planId) return res.status(400).json({ ok: false, error: "USER_OR_PLAN_MISSING" });

    const plan = premium.PLANS.find((p) => p.id === planId);
    if (!plan) return res.status(404).json({ ok: false, error: "PLAN_NOT_FOUND" });

    if (STORE_MODE === "disabled") {
      return res.status(403).json({ ok: false, error: "STORE_DISABLED" });
    }
    if (STORE_MODE !== "mock") {
      return res.status(501).json({ ok: false, error: "STORE_PROVIDER_NOT_IMPLEMENTED", mode: STORE_MODE });
    }

    const nowISO = new Date().toISOString();
    const usersRaw = await readJson(USERS_FILE, { items: [] });
    const items = Array.isArray(usersRaw) ? usersRaw : usersRaw.items || [];
    let u = items.find((x) => String(x.userId) === userId);
    if (!u) {
      u = { userId, mainTeam: null, createdAt: nowISO, lc: 0, lcLastDaily: null };
      items.push(u);
    }

    // Mevcut premium süresi varsa üstüne ekle (uzatma), yoksa şimdiden başlat
    const base = u.premium && u.premiumUntil && new Date(u.premiumUntil).getTime() > Date.now()
      ? new Date(u.premiumUntil).getTime()
      : Date.now();
    const until = new Date(base + plan.days * 86400000).toISOString();
    u.premium = true;
    u.premiumUntil = until;
    u.premiumPlan = plan.id;
    u.updatedAt = nowISO;

    await writeJson(USERS_FILE, Array.isArray(usersRaw) ? items : { ...usersRaw, items });

    // Bu ayın kasasını hemen yatır (abone olur olmaz değer görsün)
    let monthlyGranted = 0;
    try {
      const { state, user } = await ensureWalletUserFile(userId);
      monthlyGranted = premium.grantMonthlyIfDue(user, true);
      if (monthlyGranted > 0) {
        addLedgerEntryFile(state, {
          userId,
          kind: "reward",
          amount: monthlyGranted,
          reason: "premium_monthly",
          meta: { month: premium.monthKey() },
        });
        await saveWalletState(state);
      }
    } catch (e) {
      console.warn("[premium] abonelik aylık kasa yatırılamadı:", e && e.message ? e.message : e);
    }

    res.json({ ok: true, mode: "mock", plan, premiumUntil: until, monthlyGranted });
  } catch (e) {
    console.error("PREMIUM_SUBSCRIBE_ERR", e);
    res.status(500).json({ ok: false, error: "PREMIUM_SUBSCRIBE_ERR", detail: String(e?.message || e) });
  }
});

module.exports = router;
