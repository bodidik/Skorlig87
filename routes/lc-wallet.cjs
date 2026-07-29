"use strict";

const express = require("express");
const router  = express.Router();
const fs      = require("fs");
const fsp     = fs.promises;
const path    = require("path");

const { withFileLock, writeJsonAtomic } = require("../lib/fileLock.cjs");
const { verifyToken } = require("../middleware/verifyToken.cjs");

const DATA_DIR    = path.join(__dirname, "..", "data");
const WALLET_FILE = path.join(DATA_DIR, "lc-wallet.json");
const USERS_FILE  = path.join(DATA_DIR, "users.json");

// LC ekonomi sabitleri – pred.cjs ve settle2.cjs ile SENKRON
const DAILY_LC         = 5;

/**
 * GÜNLÜK HAK: TABANA TAMAMLAMA (koşulsuz ekleme değil).
 *
 * NEDEN DEĞİŞTİ (ölçüldü 2026-07-29): Günlük hak koşulsuz ekleniyordu ve
 * oynamayan kullanıcı bile biriktiriyordu — aylık +143 LC. LC arzının
 * giriş/çıkış oranı 145:1 ölçüldü; bu iki büyük delikten biriydi.
 *
 * Yeni kural: bakiye tabanın ALTINDAYSA tabana tamamlanır, üstündeyse HİÇBİR
 * ŞEY verilmez.
 *
 *   - Zengin oyuncuya 0 → birikim kanalı kapanır
 *   - Parasız oyuncuya can suyu → oyundan kopmaz
 *   - Toplam arz oyuncu sayısıyla sınırlı kalır (sonsuz birikmez)
 *
 * Premium ayrıcalığı da aynı mantıkla YÜKSEK TABAN olarak işler; koşulsuz
 * para basmaz.
 */
/**
 * ⚠️ TABAN NEDEN DÜŞÜK: Taban, bir günlük oyun bedelinden AZ olmalı.
 *
 * Aksi hâlde kaybetmek bedava olur: taban 15 iken oyuncu 5 tahmin yapıp
 * (5×3=15 LC) hepsini kaybetse ertesi gün yine 15'e tamamlanır — zararı sistem
 * karşılar ve iade eşiği düzeltmesiyle kurulan denge (%81 zarar eder)
 * anlamsızlaşır.
 *
 * 6 LC = 2 maç. Oyundan kopmaya yetmeyecek kadar az, kaybı sübvanse
 * etmeyecek kadar da düşük. Daha fazla oynamak isteyen kazanmak zorunda.
 *
 * İlk gün tek seferlik ~3.185 LC basılır (mevcut 838 cüzdanın çoğu taban
 * altında); sonrası oyuncunun harcamasına bağlı ve üst sınırı 6/gün.
 */
const DAILY_FLOOR      = Number(process.env.SKORLIG_DAILY_FLOOR || 6);
const DAILY_FLOOR_PREM = Number(process.env.SKORLIG_DAILY_FLOOR_PREMIUM || 12);

/**
 * Bugün verilecek LC miktarı.
 * @param {number} bakiye  kullanıcının mevcut bakiyesi
 * @param {boolean} premium
 * @returns {number} 0 ise verilecek bir şey yok (taban zaten aşılmış)
 */
function gunlukMiktar(bakiye, premium) {
  const taban = premium ? DAILY_FLOOR_PREM : DAILY_FLOOR;
  const b = Number(bakiye || 0);
  return b >= taban ? 0 : Math.round((taban - b) * 10) / 10;
}
const INITIAL_DEFAULT  = 30;
const INITIAL_1987     = 60;
const MATCH_ENTRY_COST = 3; // Maç girişi LC bedeli (bilgi amaçlı)

// 🚀 Tanıtım dönemi: ilk N üyeye başlangıç LC bonusu (erken kuş ödülü).
// Kapatmak için SKORLIG_EARLY_LIMIT=0. Cüzdanı ilk oluşan üyeler faydalanır.
const EARLY_LIMIT = Number(process.env.SKORLIG_EARLY_LIMIT || 1000);
const EARLY_BONUS = Number(process.env.SKORLIG_EARLY_BONUS || 200);

// Otomatik birikim (token bitince bekle): lib/lc-regen.cjs
const { applyRegen, regenInfo } = require("../lib/lc-regen.cjs");

// Premium ayrıcalıkları (tek kaynak)
const premium = require("../lib/premium.cjs");
const UsersStore = require("../lib/users-store.cjs");
// settle2 ile AYNI bayrak: cüzdan dosyası aynası.
const WALLET_FILE_MIRROR =
  String(process.env.SKORLIG_WALLET_FILE_MIRROR ?? "1") !== "0";

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
  // Atomik yazma (tmp + rename) — yarım/bozuk dosya oluşmaz.
  await writeJsonAtomic(file, data);
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

/**
 * 1987 üyeliği — DEPODAN. Adındaki "FromFile" tarihsel; dosyadan okumak,
 * profil verisi Mongo'ya taşındıktan sonra herkesi "üye değil" yapardı.
 * Küçük harfli sorgu: kimlikler karışık harfli.
 */
async function isUser1987MemberFromFile(userId, db) {
  const uid = String(userId || "").trim().toLowerCase();
  if (!uid) return false;

  const map = await UsersStore.getUsersByIdsLower([uid], db);
  const u = map[uid];
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
    const is1987 = await isUser1987MemberFromFile(uid, null); // dosya modu
    const baseBalance = is1987 ? INITIAL_1987 : INITIAL_DEFAULT;
    const nowISO = new Date().toISOString();

    // 🚀 Erken kuş bonusu: bu cüzdan oluşurken toplam üye sayısı sınırın
    // altındaysa ekstra LC. (state.users bu kullanıcı henüz eklenmeden sayılır.)
    const memberIndex = state.users.length; // 0-tabanlı sıra
    const earlyEligible = EARLY_LIMIT > 0 && EARLY_BONUS > 0 && memberIndex < EARLY_LIMIT;
    const earlyBonus = earlyEligible ? EARLY_BONUS : 0;
    const initialBalance = baseBalance + earlyBonus;

    u = {
      userId: uid,
      balance: initialBalance,
      createdAt: nowISO,
      updatedAt: nowISO,
      lastDailyAt: null,
      totalEarned: initialBalance,
      totalSpent: 0,
      memberNo: memberIndex + 1, // 1-tabanlı kayıt sırası (rozet/istatistik için)
      early: earlyEligible || undefined,
    };
    state.users.push(u);

    addLedgerEntryFile(state, {
      userId: uid,
      kind: "init",
      amount: baseBalance,
      reason: is1987 ? "initial_1987" : "initial_default",
    });
    if (earlyBonus > 0) {
      addLedgerEntryFile(state, {
        userId: uid,
        kind: "reward",
        amount: earlyBonus,
        reason: "early_adopter_bonus",
        meta: { memberNo: memberIndex + 1, limit: EARLY_LIMIT },
      });
    }

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

// 1987 üyelik artık kullanıcı deposundan (Mongo varsa Mongo) okunuyor.
async function isUser1987MemberMongoOrFile(db, userId) {
  return isUser1987MemberFromFile(userId, db);
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
      //
      // ⚠️ Bu dal eskiden yalnızca bakiyeyi OKUYUP dönüyordu; dosya dalının
      // yaptığı iki işi atlıyordu:
      //   • premium aylık kasa  → abone 2. aydan sonra hiç LC almıyordu
      //   • otomatik token birikimi (applyRegen) → LC'si biten kullanıcı
      //     KALICI olarak takılı kalıyordu; oyunun ücretsiz döngüsü ölüydü
      // Ayrıca fiyatlar sabitlerden dönüyordu, yani premium indirimi
      // görünmüyordu. Üçü de burada düzeltildi.
      const isPrem = await premium.isPremium(userId, getDb(req));
      const regenOpts = premium.regenParams(isPrem);
      const col = db.collection("lc_wallet_users");
      const uidLower = userId.toLowerCase();

      const user = await ensureWalletUserMongo(db, userId);

      // applyRegen/grantMonthlyIfDue düz nesne üzerinde çalışır — Mongo
      // dokümanına uygulanıp değişen alanlar geri yazılır.
      const prevRegenAt = user.lastRegenAt ?? null;
      const monthlyGranted = premium.grantMonthlyIfDue(user, isPrem);
      const regenEarned = applyRegen(user, Date.now(), regenOpts);

      if (monthlyGranted > 0 || regenEarned > 0 || (user.lastRegenAt ?? null) !== prevRegenAt) {
        // Koşullu filtre: eşzamanlı iki summary çağrısından yalnızca biri
        // yazabilir, diğerinin hesabı düşer (çift birikim olmaz).
        const r = await col.updateOne(
          { userIdLower: uidLower, lastRegenAt: prevRegenAt },
          {
            $set: {
              balance: user.balance,
              totalEarned: user.totalEarned || 0,
              lastRegenAt: user.lastRegenAt ?? null,
              lastMonthlyAt: user.lastMonthlyAt ?? null,
              updatedAt: user.updatedAt || new Date().toISOString(),
            },
          }
        );

        if (r.modifiedCount && monthlyGranted > 0) {
          await addLedgerEntryMongo(db, {
            userId,
            kind: "reward",
            amount: monthlyGranted,
            reason: "premium_monthly",
            meta: { month: premium.monthKey() },
          });
        }
        if (!r.modifiedCount) {
          // Yarışı kaybettik: taze veriyle yanıtla, kendi hesabımızı at.
          const fresh = await col.findOne({ userIdLower: uidLower });
          if (fresh) Object.assign(user, fresh);
        }
      }

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
          is1987: !!user.is1987,
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
        updatedAt: user.updatedAt || null,
      });
    }

    // 🟢 Dosya modu — kilitli read-modify-write
    const isPrem = await premium.isPremium(userId, getDb(req));
    const regenOpts = premium.regenParams(isPrem);

    let user, updatedAt;
    await withFileLock(WALLET_FILE, async () => {
      const loaded = await ensureWalletUserFile(userId);
      const state = loaded.state;
      const u = loaded.user;

      // Premium aylık kasa: bu takvim ayı henüz verilmediyse otomatik yatır
      const monthlyGranted = premium.grantMonthlyIfDue(u, isPrem);
      if (monthlyGranted > 0) {
        addLedgerEntryFile(state, {
          userId,
          kind: "reward",
          amount: monthlyGranted,
          reason: "premium_monthly",
          meta: { month: premium.monthKey() },
        });
      }

      // Otomatik birikim: bakiye düşükse zamanla token toplanır
      const regenEarned = applyRegen(u, Date.now(), regenOpts);
      if (monthlyGranted > 0 || regenEarned > 0) await saveWalletState(state);

      user = { ...u };
      updatedAt = state.updatedAt;
    });

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
      updatedAt: updatedAt || null,
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
router.post("/lc-wallet/daily-claim", verifyToken, express.json(), async (req, res) => {
  try {
    const userId = req.uid;
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

      // TABANA TAMAMLAMA — koşulsuz ekleme DEĞİL. Bkz. gunlukMiktar().
      const verilecek = gunlukMiktar(Number(user.balance || 0), isPrem);

      const updateResult = await col.updateOne(
        {
          userIdLower: uidLower,
          lastDailyAt: user.lastDailyAt || null,
        },
        {
          $inc: {
            balance: verilecek,
            totalEarned: verilecek,
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

      // Defter kaydı GERÇEK verilen miktarı yazmalı; sabit DAILY_LC yazmak
      // ekonomi raporunu (bkz. /api/admin/economy) yalan söyletirdi.
      if (verilecek > 0) {
        await addLedgerEntryMongo(db, {
          userId,
          kind: "reward",
          amount: verilecek,
          reason: "daily",
        });
      }

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
          amount: verilecek,
          floor: isPrem ? DAILY_FLOOR_PREM : DAILY_FLOOR,
          claimed: true,
        },
      });
    }

    // 🟢 Dosya modu — kilitli read-modify-write (lost update önlenir)
    const isPrem = await premium.isPremium(userId, getDb(req));
    const today = todayKey();

    const result = await withFileLock(WALLET_FILE, async () => {
      const state = await loadWalletState();

      let u = state.users.find(
        (x) =>
          String(x.userId || "")
            .trim()
            .toLowerCase() === userId.toLowerCase()
      );

      if (!u) {
        const is1987 = await isUser1987MemberFromFile(userId, null); // dosya modu
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

      const last = u.lastDailyAt ? u.lastDailyAt.slice(0, 10) : null;
      if (last === today) {
        return {
          status: 400,
          body: { ok: false, error: "DAILY_ALREADY_CLAIMED", today, lastDailyAt: u.lastDailyAt },
        };
      }

      // TABANA TAMAMLAMA — Mongo dalıyla aynı kural (bkz. gunlukMiktar).
      // İki dal ayrışırsa kullanıcı hangi modda olduğuna göre farklı para alır.
      const dailyAmount = gunlukMiktar(Number(u.balance || 0), isPrem);

      u.balance += dailyAmount;
      u.totalEarned = (u.totalEarned || 0) + dailyAmount;
      u.lastDailyAt = new Date().toISOString();
      u.updatedAt   = u.lastDailyAt;

      if (dailyAmount > 0) {
        addLedgerEntryFile(state, {
          userId,
          kind: "reward",
          amount: dailyAmount,
          reason: isPrem ? "daily_premium" : "daily",
        });
      }

      await saveWalletState(state);

      return {
        status: 200,
        body: {
          ok: true,
          user: {
            userId: u.userId,
            balance: u.balance,
            lastDailyAt: u.lastDailyAt,
            totalEarned: u.totalEarned || 0,
            totalSpent: u.totalSpent || 0,
            premium: isPrem,
          },
          daily: { today, amount: dailyAmount, claimed: true },
        },
      };
    });

    return res.status(result.status).json(result.body);
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
router.post("/lc-wallet/purchase", verifyToken, express.json(), async (req, res) => {
  try {
    const userId = req.uid;
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
    const nowISO = new Date().toISOString();

    // Premium ayrıcalığı: satın alımda bonus LC
    const isPrem = await premium.isPremium(userId, getDb(req));
    const bonus = isPrem ? Math.round(pkg.lc * premium.PERKS.storeBonusPct) : 0;
    const totalLc = pkg.lc + bonus;

    const ledgerMeta = {
      packageId: pkg.id,
      priceTRY: pkg.priceTRY,
      mode: "mock",
      baseLc: pkg.lc,
      premiumBonus: bonus,
    };

    // ⚠️ MONGO DALI ŞART: summary/daily-claim/ledger uçları db varken
    // Mongo'dan okuyup ERKEN DÖNER. Burası yalnızca dosyaya yazsaydı (eski
    // hâli) kullanıcı paketi satın alır, bakiyesi lc-wallet.json'a yazılır,
    // uygulama summary'yi açar ve Mongo'dan okuduğu için ALDIĞI LC GÖRÜNMEZ.
    // Gerçek ödeme açıldığında bu doğrudan para kaybı demek.
    const db = getDb(req);

    let newBalance;
    if (db) {
      await ensureWalletUserMongo(db, userId);
      const col = db.collection("lc_wallet_users");
      const uidLower = userId.toLowerCase();

      // $inc atomiktir. Harcamadan farklı olarak yükleme bir ön koşul
      // taşımaz (bakiye yeterliliği aranmaz), bu yüzden optimistic
      // concurrency turuna gerek yok — yarış koşulu oluşmaz.
      await col.updateOne(
        { userIdLower: uidLower },
        { $inc: { balance: totalLc, totalEarned: totalLc }, $set: { updatedAt: nowISO } }
      );

      await addLedgerEntryMongo(db, {
        userId,
        kind: "purchase",
        amount: totalLc,
        reason: "store_purchase_mock",
        fixtureId: null,
        meta: ledgerMeta,
      });

      const fresh = await col.findOne({ userIdLower: uidLower });
      newBalance = Number(fresh?.balance ?? 0);
    } else {
      // 🟢 Dosya modu — kilitli (lost update önlenir)
      newBalance = await withFileLock(WALLET_FILE, async () => {
        const { state, user } = await ensureWalletUserFile(userId);

        user.balance = Number(user.balance || 0) + totalLc;
        user.totalEarned = Number(user.totalEarned || 0) + totalLc;
        user.updatedAt = nowISO;

        addLedgerEntryFile(state, {
          userId,
          kind: "purchase",
          amount: totalLc,
          reason: "store_purchase_mock",
          fixtureId: null,
          meta: ledgerMeta,
        });

        await saveWalletState(state);
        return user.balance;
      });
    }

    // users.json lc alanını da senkron tut — ayrı dosya, ayrı kilit.
    // Mongo varken ve ayna kapalıyken atlanır: yetkili bakiye cüzdanda
    // (lc_wallet_users), bu alan yalnızca eski dosya modu için tutuluyor.
    // Koşulsuz yazmak, kimsenin okumadığı geçici bir dosyayı büyütürdü.
    const usersLcSenkronGerekli = !getDb(req) || WALLET_FILE_MIRROR;
    try {
      if (usersLcSenkronGerekli) await withFileLock(USERS_FILE, async () => {
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
      });
    } catch (e) {
      console.warn("[lc-store] users.json senkron yazılamadı:", e && e.message ? e.message : e);
    }

    return res.json({
      ok: true,
      mode: "mock",
      package: pkg,
      premiumBonus: bonus,
      lcLoaded: totalLc,
      newBalance,
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
    const status = await premium.premiumStatus(userId, getDb(req));
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
router.post("/lc-wallet/premium/subscribe", verifyToken, express.json(), async (req, res) => {
  try {
    const userId = req.uid;
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

    // Premium alanları KULLANICI DEPOSUNA yazılır (Mongo varsa Mongo).
    // Eskiden doğrudan users.json'a yazılıyordu; premium okuması depoya
    // geçtikten sonra bu, ödeme yapan kullanıcının premium'unun hiç
    // görünmemesi demek olurdu — para alınır, ayrıcalık verilmez.
    const untilStore = await (async () => {
      const mevcut = await UsersStore.getUser(userId, getDb(req));
      // Mevcut premium süresi varsa üstüne ekle (uzatma), yoksa şimdiden başlat
      const base =
        mevcut?.premium && mevcut?.premiumUntil && new Date(mevcut.premiumUntil).getTime() > Date.now()
          ? new Date(mevcut.premiumUntil).getTime()
          : Date.now();
      const untilISO = new Date(base + plan.days * 86400000).toISOString();

      await UsersStore.updateUser(
        userId,
        { premium: true, premiumUntil: untilISO, premiumPlan: plan.id },
        { mainTeam: null, lc: 0, lcLastDaily: null },
        getDb(req)
      );
      return untilISO;
    })();
    const until = untilStore;

    // Bu ayın kasasını hemen yatır (abone olur olmaz değer görsün).
    // Purchase ile aynı gerekçe: db varken summary Mongo'dan okur, bu LC
    // yalnızca dosyaya yazılsaydı kullanıcıya hiç görünmezdi.
    const db = getDb(req);
    let monthlyGranted = 0;
    try {
      if (db) {
        const col = db.collection("lc_wallet_users");
        const uidLower = userId.toLowerCase();
        const mk = premium.monthKey();
        const amount = premium.PERKS.monthlyLc;

        await ensureWalletUserMongo(db, userId);

        if (amount > 0) {
          // Koşullu güncelleme dosya sürümünden DAHA güvenli: filtre
          // "bu ay verilmemiş" şartını yazmayla aynı atomik işleme koyar,
          // yani eşzamanlı iki istek de gelse ay içinde tek kez yatar.
          const r = await col.updateOne(
            { userIdLower: uidLower, lastMonthlyAt: { $ne: mk } },
            {
              $inc: { balance: amount, totalEarned: amount },
              $set: { lastMonthlyAt: mk, updatedAt: nowISO },
            }
          );
          if (r.modifiedCount) {
            monthlyGranted = amount;
            await addLedgerEntryMongo(db, {
              userId,
              kind: "reward",
              amount,
              reason: "premium_monthly",
              meta: { month: mk },
            });
          }
        }
      } else {
        monthlyGranted = await withFileLock(WALLET_FILE, async () => {
          const { state, user } = await ensureWalletUserFile(userId);
          const granted = premium.grantMonthlyIfDue(user, true);
          if (granted > 0) {
            addLedgerEntryFile(state, {
              userId,
              kind: "reward",
              amount: granted,
              reason: "premium_monthly",
              meta: { month: premium.monthKey() },
            });
            await saveWalletState(state);
          }
          return granted;
        });
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
