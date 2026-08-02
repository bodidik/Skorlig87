"use strict";

const express = require("express");
const router  = express.Router();
const fs      = require("fs");
const fsp     = fs.promises;
const path    = require("path");

const { withFileLock, writeJsonAtomic } = require("../lib/fileLock.cjs");
const { verifyToken } = require("../middleware/verifyToken.cjs");
const { kimlikVeyaHata } = require("../lib/kimlik-kontrol.cjs");
// Gun anahtari TZ'ye gore (bkz. lib/season.cjs dayKey notu): ISO dilimlemek UTC verir.
const Season = require("../lib/season.cjs");

// ⚠️ SKORLIG_DATA_DIR: sabit yol testleri GERÇEK data/ dizinine yazdırır.
const DATA_DIR    = process.env.SKORLIG_DATA_DIR || path.join(__dirname, "..", "data");
const WALLET_FILE = path.join(DATA_DIR, "lc-wallet.json");
const USERS_FILE  = path.join(DATA_DIR, "users.json");

// LC ekonomi sabitleri – pred.cjs ve settle2.cjs ile SENKRON

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
/* ⚠️ TEK KAYNAK: lib/ekonomi.cjs. Bu dort deger burada yereldi ve
 * lib/premium.cjs ayni env degiskenini FARKLI varsayilanla (6) okuyordu —
 * satis ekrani 6 gosterirken odeme yolu 3 veriyordu. */
const DAILY_FLOOR      = require("../lib/ekonomi.cjs").GUNLUK_TABAN;
const DAILY_FLOOR_PREM = require("../lib/ekonomi.cjs").GUNLUK_TABAN_PREM;
// Üst üste gün kademeleri (bkz. gunlukTaban). Kullanıcı isteği: temel miktar
// 3-4 LC, süreklilik ödüllensin.
const DAILY_FLOOR_3 = require("../lib/ekonomi.cjs").GUNLUK_TABAN_SERI3;
const DAILY_FLOOR_7 = require("../lib/ekonomi.cjs").GUNLUK_TABAN_SERI7;

/**
 * Bugün verilecek LC miktarı.
 * @param {number} bakiye  kullanıcının mevcut bakiyesi
 * @param {boolean} premium
 * @returns {number} 0 ise verilecek bir şey yok (taban zaten aşılmış)
 */
/**
 * ÜST ÜSTE GÜN SAYISINA GÖRE TABAN.
 *
 * Kullanıcı isteği: günlük miktar 3-4 LC yeterli, ama üst üste alana bonus
 * olsun. Bonusu TABANA EKLEMEK yerine TABANI YÜKSELTEREK veriyoruz —
 * koşulsuz ekleme birikir, tamamlama birikmez. (Aynı gerekçe premium aylık
 * kasasını 300 LC'den 60 LC tabanına çevirirken de geçerliydi.)
 *
 *   1-2. gün : 3 LC   (1 maç)
 *   3-6. gün : 5 LC
 *   7+  gün  : 7 LC   (2 maç + artakalan)
 *
 * ⚠️ ÜST SINIR KURALI KORUNUYOR: taban, günlük oyun bedelinin 3 katından az
 * kalmalı (7 < 9). Aksi halde her şeyini kaybeden oyuncu ertesi gün tam
 * tamamlanır ve kaybetmek bedava olur — iade eşiği düzeltmesi anlamsızlaşır.
 * bkz. tests/economy.test.cjs
 */
function gunlukTaban(seri, premium) {
  if (premium) return DAILY_FLOOR_PREM;
  const g = Number(seri || 0);
  if (g >= 7) return DAILY_FLOOR_7;
  if (g >= 3) return DAILY_FLOOR_3;
  return DAILY_FLOOR;
}

/**
 * Bugün gerçekte kaç LC verilecek.
 *
 * ⚠️ BU DEĞER ARAYÜZE DE GİDER. Eskiden özet yanıtı `daily.amount` alanında
 * TABANI bildiriyordu (6), oysa bakiye tabanın üstündeyse verilen 0 oluyordu.
 * Yani sistem 6 vaat edip 0 veriyor, `canClaim` de true kalıyordu: kullanıcı
 * butona basıyor, hiçbir şey almıyor, üstüne GÜNÜN HAKKI YANIYORDU
 * (lastDailyAt yazılıyor). Ölçüldü (2026-07-30): bakiye 21, amount 6,
 * canClaim true, gerçek kazanç 0.
 */
function gunlukMiktar(bakiye, premium, seri) {
  const taban = gunlukTaban(seri, premium);
  const b = Number(bakiye || 0);
  return b >= taban ? 0 : Math.round((taban - b) * 10) / 10;
}

/** Dünden bugüne kesintisiz mi? "2026-07-29" → "2026-07-30" ise evet. */
function seriDevamMi(lastDailyAt, bugun) {
  if (!lastDailyAt) return false;
  // ⚠️ İkisi de TZ gün anahtarı olmalı; ISO dilimlemek UTC verir ve yerel
  // olarak ardışık iki gün arada boşluk varmış gibi görünür (seri kırılır).
  const onceki = gunAnahtari(lastDailyAt);
  if (!onceki) return false;
  return onceki === Season.previousDayKey(new Date(bugun + "T12:00:00Z"));
}
// ⚠️ Tek kaynak: lib/ekonomi.cjs. Bu değer DÖRT dosyada İKİ AYRI ADLA
// (LC_START / INITIAL_DEFAULT) tanımlıydı; birini değiştiren diğerini
// aramazdı ve açılış bakiyesi kod yoluna göre değişebilirdi.
const { INITIAL_DEFAULT, INITIAL_1987 } = require("../lib/ekonomi.cjs");
// ⚠️ ÜÇÜNCÜ AD, AYNI DEĞER. Bu sabit arayüze GÖSTERILEN fiyatı üretiyor
// (pricing.matchEntryCost), oysa TAHSILATI pred.cjs LC_MATCH_COST ile
// yapıyor. İkisi ayrı tanımlıyken sapma, uygulamanın bir fiyat gösterip
// BAŞKA fiyat kesmesi demekti. Artık ikisi de lib/ekonomi.cjs'ten.
const { MAC_GIRIS_BEDELI: MATCH_ENTRY_COST } = require("../lib/ekonomi.cjs");

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
 *
 *  SKORLIG_STORE_MODE=disabled -> satın alma kapalı  ⬅ VARSAYILAN
 *  SKORLIG_STORE_MODE=mock     -> test modu: ÖDEME ALMADAN anında yükler
 *
 *  ⚠️ VARSAYILAN `mock`TAN `disabled`A ÇEVRİLDİ.
 *
 *  Eskiden değişken tanımlı değilse mod `mock` oluyordu, yani üretimde bu
 *  değişkeni ayarlamayı unutmak "herkese bedava LC" demekti. Kimlik doğrulaması
 *  olan her kullanıcı `/purchase` çağırıp `lc_200` paketini (200 LC / 99,99 TL)
 *  ödemesiz alabilirdi; hız sınırı 5/dk olduğu için hesap başına dakikada
 *  1000 LC. Günlük LC hakkı 3-7 LC.
 *
 *  Bugün aynı desen iki yerde daha çıktı (yönetici token'ı, 1987 grup kodu):
 *  yapılandırma eksikse KAPALI kal, zayıf bir varsayılana düşme. Test modunu
 *  isteyen açıkça `SKORLIG_STORE_MODE=mock` yazar.
 *
 *  Gerçek yayında: Google Play Billing / App Store IAP makbuz doğrulaması
 *  purchase endpoint'ine eklenmeli (provider:"google"|"apple" dalı). O gelene
 *  kadar doğru davranış satın almayı kapalı tutmaktır — kullanıcı LC'yi
 *  günlük hak, seri bonusu ve oyunla kazanır.
 * ========================= */
const STORE_MODE = String(process.env.SKORLIG_STORE_MODE || "disabled").toLowerCase();

// ⚠️ Mock açıkken SESSİZ KALMA: üretimde yanlışlıkla açık kalırsa log'da
// görünsün. Sessiz bir "bedava LC" modu, fark edilmesi en zor para hatasıdır.
if (STORE_MODE === "mock") {
  console.warn(
    "[lc-wallet] ⚠️ MAGAZA MOCK MODUNDA — satin almalar ODEME ALINMADAN yukleniyor. " +
    "Bu yalnizca gelistirme icindir; uretimde SKORLIG_STORE_MODE=disabled olmali."
  );
}

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

  // Tek kaynak: lib/premium.cjs uyeMi1987 (kopya kural ayrisiyordu).
  return premium.uyeMi1987(u);
}

/**
 * ⚠️ ARTIK UTC DEĞIL. Eskiden `d.toISOString().slice(0,10)` idi; sunucu UTC
 * çalışıyor (Render) ama kullanıcılar UTC+3'te, yani "gün" yerel saatle
 * 03:00'te dönüyordu. Sonuçları için bkz. lib/season.cjs `dayKey` notu:
 * 00:00–03:00 arasında "bugün zaten aldın" cevabı, ve seri kademelerinin
 * haksız yere kırılması.
 */
function todayKey(d = new Date()) {
  return Season.dayKey(d);
}

/** Saklanan ISO damgasını TZ gün anahtarına çevirir (dilimleme UTC verirdi). */
function gunAnahtari(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : Season.dayKey(d);
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
router.get("/lc-wallet/summary", verifyToken, async (req, res) => {
  try {
    // ⚠️ SAHIPLİK: `?userId=` istekten geliyor. Denetim olmadan herkes
    // başkasının cüzdanını okuyabiliyordu (bkz. lib/kimlik-kontrol.cjs).
    const _k = kimlikVeyaHata(req, res, req.query.userId);
    if (!_k) return;
    const userId = _k.uid;

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
      const prevBalance = Number(user.balance || 0);
      const monthlyGranted = premium.grantMonthlyIfDue(user, isPrem);
      const regenEarned = applyRegen(user, Date.now(), regenOpts);
      // Eklenen miktar — aşağıda MUTLAK değil GÖRELİ yazmak için.
      const eklenen = Number(user.balance || 0) - prevBalance;

      if (monthlyGranted > 0 || regenEarned > 0 || (user.lastRegenAt ?? null) !== prevRegenAt) {
        // Koşullu filtre: eşzamanlı iki summary çağrısından yalnızca biri
        // yazabilir, diğerinin hesabı düşer (çift birikim olmaz).
        // ⚠️ BAKİYE GÖRELİ ($inc) YAZILIR, MUTLAK ($set) DEĞİL.
        // Eskiden `balance: user.balance` mutlak yazılıyordu. `lastRegenAt`
        // filtresi yalnızca eşzamanlı BİRİKİMİ engelliyor; araya giren bir
        // HARCAMA'yı değil. Sıra şuydu: bakiye 10 okundu → tahmin 3 LC harcadı
        // (bakiye 7) → birikim 12'yi mutlak yazdı. Harcanan 3 LC geri geldi,
        // yani yoktan para üretildi. $inc okunan değere dayanmaz.
        // Not: boş `$inc: {}` Mongo tarafından REDDEDİLİR — koşullu kurulur.
        const guncelleme = {
          $set: {
            lastRegenAt: user.lastRegenAt ?? null,
            lastMonthlyAt: user.lastMonthlyAt ?? null,
            updatedAt: user.updatedAt || new Date().toISOString(),
          },
        };
        if (eklenen) guncelleme.$inc = { balance: eklenen, totalEarned: eklenen };

        const r = await col.updateOne(
          { userIdLower: uidLower, lastRegenAt: prevRegenAt },
          guncelleme
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
        /* ⚠️ BİRİKİM DEFTERE YAZILMIYORDU.
         *
         * `eklenen` iki kalemin toplamı (aylık kasa + otomatik birikim) ama
         * defter kaydı YALNIZCA aylık kasa için yazılıyordu. Yani birikimle
         * gelen LC bakiyeye ekleniyor, hiçbir iz bırakmıyordu.
         *
         * ÖLÇÜLDÜ: bakiye 2 → 14 (12 LC üretildi), defterde 0 kayıt.
         *
         * İki sonucu vardı:
         *  1) DENETİM İZİ KOPUK: `bakiye = açılış + defter toplamı` değişmezi
         *     birikim alan her kullanıcı için bozuktu.
         *  2) EKONOMİ RAPORU KÖR: `lib/economy-report.cjs` YALNIZCA defterden
         *     topluyor. Birikim oyunun sürekli çalışan ücretsiz muslugu —
         *     yani muslukları ölçmek için yazılmış rapor, en büyük muslugu
         *     hiç görmüyordu.
         *
         * Rapor pozitif ve listelerde olmayan sebebi "tekrarlayan giriş"
         * kovasına koyuyor; birikim için doğru kova o. */
        if (r.modifiedCount && regenEarned > 0) {
          await addLedgerEntryMongo(db, {
            userId,
            kind: "reward",
            amount: regenEarned,
            reason: "regen",
            meta: { isPremium: isPrem },
          });
        }
        if (!r.modifiedCount) {
          // Yarışı kaybettik: taze veriyle yanıtla, kendi hesabımızı at.
          const fresh = await col.findOne({ userIdLower: uidLower });
          if (fresh) Object.assign(user, fresh);
        }
      }

      const today = todayKey();
      const last  = gunAnahtari(user.lastDailyAt);
      const bugunAlindi = last === today;

      // ⚠️ ARAYÜZE GERÇEK MİKTAR GİDER, TABAN DEĞİL.
      // Eskiden `premium.dailyLc(isPrem)` (yani TABAN) bildiriliyordu; bakiye
      // tabanın üstündeyse verilen 0 olduğu hâlde arayüz "6 LC" vaat ediyordu.
      // Ölçüldü (2026-07-30): bakiye 21, amount 6, canClaim true, gerçek 0.
      const seri = bugunAlindi
        ? Number(user.dailyStreak || 0)
        : (seriDevamMi(user.lastDailyAt, today) ? Number(user.dailyStreak || 0) + 1 : 1);
      const dailyAmount = bugunAlindi ? 0 : gunlukMiktar(Number(user.balance || 0), isPrem, seri);

      // Bakiye zaten tabanın üstündeyse buton AÇIK KALMAMALI: basınca 0 LC gelir
      // ve günün hakkı boşa yanar (lastDailyAt yazılır).
      const canClaim = !bugunAlindi && dailyAmount > 0;
      const claimReason = bugunAlindi
        ? "ALREADY_CLAIMED"
        : dailyAmount > 0
        ? null
        : "BALANCE_ABOVE_FLOOR";

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
          reason: claimReason,   // neden alınamıyor — arayüz sessiz kalmasın
          streak: seri,
          floor: gunlukTaban(seri, isPrem),
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
    const last  = gunAnahtari(user.lastDailyAt);
    const bugunAlindi = last === today;

    // ⚠️ ARAYÜZE GERÇEK MİKTAR GİDER, TABAN DEĞİL.
    // Eskiden `premium.dailyLc(isPrem)` (yani TABAN) bildiriliyordu; bakiye
    // tabanın üstündeyse verilen 0 olduğu hâlde arayüz "6 LC" vaat ediyordu.
    // Ölçüldü (2026-07-30): bakiye 21, amount 6, canClaim true, gerçek 0.
    const seri = bugunAlindi
      ? Number(user.dailyStreak || 0)
      : (seriDevamMi(user.lastDailyAt, today) ? Number(user.dailyStreak || 0) + 1 : 1);
    const dailyAmount = bugunAlindi ? 0 : gunlukMiktar(Number(user.balance || 0), isPrem, seri);

    // Bakiye zaten tabanın üstündeyse buton AÇIK KALMAMALI: basınca 0 LC gelir
    // ve günün hakkı boşa yanar (lastDailyAt yazılır).
    const canClaim = !bugunAlindi && dailyAmount > 0;
    const claimReason = bugunAlindi
      ? "ALREADY_CLAIMED"
      : dailyAmount > 0
      ? null
      : "BALANCE_ABOVE_FLOOR";

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
        reason: claimReason,
        streak: seri,
        floor: gunlukTaban(seri, isPrem),
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

      // ⚠️ `isPrem` BU HANDLER'DA HİÇ TANIMLI DEĞİLDİ.
      // Aşağıda `gunlukMiktar(..., isPrem, ...)` çağrılıyordu → ReferenceError
      // → HTTP 500. Yani günlük hak talebi HER SEFERİNDE sunucuyu çökertiyordu;
      // kullanıcı "alınamıyor" diyordu ve sebebi hiçbir yerde görünmüyordu.
      // Cihaz logunda ortaya çıktı: `[apiFetch] 500 /api/rt/lc-wallet/daily-claim`
      // — bugün eklenen "başarısız istekler sessiz kalmaz" kuralı sayesinde.
      const isPrem = await premium.isPremium(userId, db);

      const last = gunAnahtari(user.lastDailyAt);
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
      // Üst üste gün: dünden devam ediyorsa seri artar, yoksa 1'den başlar.
      const yeniSeri = seriDevamMi(user.lastDailyAt, today)
        ? Number(user.dailyStreak || 0) + 1
        : 1;
      const verilecek = gunlukMiktar(Number(user.balance || 0), isPrem, yeniSeri);

      // ⚠️ 0 LC İÇİN GÜNÜ YAKMA.
      // Eskiden bakiye tabanın üstündeyken de `lastDailyAt` yazılıyordu:
      // kullanıcı butona basıyor, hiçbir şey almıyor, ÜSTÜNE o günkü hakkını
      // kaybediyordu. Artık hiçbir şey yazılmıyor — bakiye düşünce yine alabilir.
      if (verilecek <= 0) {
        return res.status(400).json({
          ok: false,
          error: "BALANCE_ABOVE_FLOOR",
          floor: gunlukTaban(yeniSeri, isPrem),
          balance: Number(user.balance || 0),
          streak: Number(user.dailyStreak || 0),
        });
      }

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
            dailyStreak: yeniSeri,
            updatedAt: nowISO,
          },
        }
      );

      if (!updateResult.matchedCount) {
        const fresh = await col.findOne({ userIdLower: uidLower });
        const freshLast = fresh?.lastDailyAt
          ? gunAnahtari(fresh.lastDailyAt)
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

      const last = gunAnahtari(u.lastDailyAt);
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
router.get("/lc-wallet/ledger", verifyToken, async (req, res) => {
  try {
    // ⚠️ SAHIPLİK: `?userId=` istekten geliyor. Denetim olmadan herkes
    // başkasının cüzdanını okuyabiliyordu (bkz. lib/kimlik-kontrol.cjs).
    const _k = kimlikVeyaHata(req, res, req.query.userId);
    if (!_k) return;
    const userId = _k.uid;
    // ⚠️ TAVAN: eskiden tavansızdı; `?limit=1e9` tüm defteri döküyordu.
    const limit = Math.max(1, Math.min(200, Math.floor(Number(req.query.limit)) || 50));

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
router.get("/lc-wallet/premium/status", verifyToken, async (req, res) => {
  try {
    // ⚠️ SAHIPLİK: `?userId=` istekten geliyor. Denetim olmadan herkes
    // başkasının cüzdanını okuyabiliyordu (bkz. lib/kimlik-kontrol.cjs).
    const _k = kimlikVeyaHata(req, res, req.query.userId);
    if (!_k) return;
    const userId = _k.uid;
    const status = await premium.premiumStatus(userId, getDb(req));
    // ⚠️ Fiyat da gönderiliyor: premium ekranı "maç girişi 3 LC" cümlesini
    // METNE GÖMÜYORDU. Bedel değişirse ekran yalan söylerdi.
    res.json({ ok: true, mode: STORE_MODE, matchEntryCost: MATCH_ENTRY_COST, ...status });
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
        const taban = premium.PERKS.monthlyFloor;

        const u = await ensureWalletUserMongo(db, userId);

        // ⚠️ TABANA TAMAMLAMA — koşulsuz EKLEME DEĞİL.
        // Eski hâli sabit 300 LC ekliyordu; bakiyesi zaten yüksek olan da
        // her ay 300 daha alıyordu ve arz sınırsız birikiyordu. Artık
        // yalnızca tabanın altındaki fark veriliyor (zengine 0).
        const bakiye = Number(u?.balance || 0);
        const amount = bakiye >= taban ? 0 : Math.round((taban - bakiye) * 10) / 10;

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
        } else {
          // Taban zaten aşılmış: LC verilmez ama ay MÜHÜRLENİR, yoksa
          // bakiye düştükçe aynı ay içinde tekrar tamamlama yapılırdı.
          await col.updateOne(
            { userIdLower: uidLower, lastMonthlyAt: { $ne: mk } },
            { $set: { lastMonthlyAt: mk, updatedAt: nowISO } }
          );
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
// Test icin: magaza modunun VARSAYILANI kapali olmali. Varsayilan
// iken degiskeni ayarlamayi unutmak "herkese bedava LC" demekti.
module.exports._STORE_MODE = STORE_MODE;

/* ⚠️ GÜNLÜK HAK FONKSİYONLARI DIŞA AÇILDI — TEST KENDİ KOPYASINI
 * YAZIYORDU. `tests/economy.test.cjs` içinde
 *     const gunluk = (bakiye, taban) => bakiye >= taban ? 0 : taban - bakiye;
 * satırı vardı: üretimdeki `gunlukMiktar` değişse test YİNE YEŞİL kalırdı.
 * Yani ekonominin en kritik anti-enflasyon kuralı ("zengine verme") fiilen
 * denetimsizdi. Artık test gerçek fonksiyonu çağırıyor.
 *
 * Kademe sabitleri de açıldı ki testler değişmezleri VERİYLE doğrulasın:
 * taban, maç giriş bedelinin 3 katından az kalmalı — yoksa her şeyini
 * kaybeden oyuncu ertesi gün tam tamamlanır ve KAYBETMEK BEDAVA olur. */
module.exports._gunlukMiktar = gunlukMiktar;
module.exports._gunlukTaban = gunlukTaban;
module.exports._TABANLAR = {
  DAILY_FLOOR, DAILY_FLOOR_3, DAILY_FLOOR_7, DAILY_FLOOR_PREM,
};
