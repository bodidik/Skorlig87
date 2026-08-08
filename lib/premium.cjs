"use strict";

/**
 * Premium üyelik — tek kaynak. Kullanıcı kaydından okur:
 *   premium: true
 *   premiumUntil: ISO tarih (yoksa/expired ise premium sayılmaz)
 * (Eski "1987" segmenti de premium kabul edilir — geriye uyum.)
 *
 * Ayrıcalıklar tek yerde tanımlı; lc-wallet / pred / settle2 / lc-regen
 * bu getter'ları kullanır. Ücretsiz kademe hiç etkilenmez.
 *
 * ⚠️ KAYNAK users.json DEĞİL, lib/users-store.cjs. Bu dosya bir süre users.json'u
 * DOĞRUDAN okuyordu; profil verisi Mongo'ya taşındıktan sonra bu yol
 * SKORLIG_USERS_FILE_MIRROR=0 ile birlikte sessizce boşalırdı: isPremium()
 * herkese false döner, yani ödeme yapmış kullanıcılar aylık 300 LC kasasını,
 * günlük hakkı, birikim tavanını ve mağaza bonusunu kaybederdi — hata da
 * üretmeden. Para ilgilendiren en sinsi arıza biçimi.
 */

const UsersStore = require("./users-store.cjs");
const Season = require("./season.cjs");

// ===== Ayrıcalık sabitleri (env ile ayarlanabilir) =====
// ÖNEMLİ: Premium'un maç başı PUAN/ÖDÜL avantajı YOKTUR (rekabet adaleti).
// Maç girişi bedeli de HERKES İÇİN EŞİTTİR (premium dahil ödeme yapar) —
// avantaj tamamen LC ekonomisinde: aylık büyük kasa + daha hızlı birikim.
/**
 * PREMIUM AYRICALIKLARI — iki gruba AYRILMIŞTIR ve ayrım kasıtlıdır.
 *
 * ⚠️ ÖNCEKİ MODEL PARA BASIYORDU. Ay başında koşulsuz 300 LC ekleniyordu:
 * medyan bakiyenin 150 katı, 100 maçlık giriş bedeli, ücretsiz oyuncunun
 * aylık hakkının 1.7 katı. Günlük tabanla birlikte premium tavanı 660 LC'ye
 * çıkıyordu (ücretsiz 180 → 3.7 kat). Koşulsuz ekleme birikir; bakiyesi zaten
 * yüksek olan da her ay 300 daha alıyordu.
 *
 * YENİ İLKE: **para basmak yerine erişim satmak.**
 *   • LC veren ayrıcalıklar TABANA TAMAMLAMA ile sınırlı (birikmez)
 *   • Geri kalan ayrıcalıklar LC akışına HİÇ dokunmaz
 *
 * ⚠️ GİRİŞ BEDELİ İNDİRİMİ BİLEREK YOK. Ölçüldü: giriş 3→2 LC premium'un
 * maç başına ortalamasını −0.66'dan +0.15'e çeviriyor, yani premium net LC
 * ÜRETİCİSİ oluyor — arka kapıdan enflasyon. Kasayı küçültüp indirimle geri
 * vermek, sorunu adı değişmiş hâlde geri getirirdi.
 */
const PERKS = {
  // ── LC VEREN (hepsi TAVANLI / birikmez) ────────────────────────────────
  //
  // Aylık TABAN. Ay başında bakiye bunun altındaysa buraya tamamlanır;
  // üstündeyse HİÇBİR ŞEY verilmez. Eski 300 LC'lik koşulsuz kasanın yerine
  // geçti (bkz. yukarıdaki not). 60 LC = 20 maç.
  monthlyFloor: Number(process.env.SKORLIG_PREMIUM_MONTHLY_FLOOR || 60),
  // Günlük taban (ücretsiz 6). Zaten tamamlama mantığında — bkz. lc-wallet.
  dailyLc: Number(process.env.SKORLIG_PREMIUM_DAILY_LC || 12),
  // Otomatik birikim: daha yüksek TAVAN + daha sık. Tavanlı olduğu için
  // birikmez, yalnızca daha hızlı dolar.
  regenCap: Number(process.env.SKORLIG_PREMIUM_REGEN_CAP || 40),
  regenHours: Number(process.env.SKORLIG_PREMIUM_REGEN_HOURS || 2),
  // Mağaza bonusu: kullanıcı GERÇEK PARA ödedi, bu LC karşılığı satın alındı.
  // Enflasyon değil, satış. (0.20 = %20 ekstra)
  storeBonusPct: Number(process.env.SKORLIG_PREMIUM_STORE_BONUS || 0.2),

  // ── ERİŞİM / KAPASİTE (LC akışına DOKUNMAZ) ────────────────────────────
  //
  // Bu grup büyütülebilir; LC üretmediği için ekonomiyi bozmaz. Premium'un
  // asıl değeri buraya kaymalı.
  miniMaxFixtures: Number(process.env.SKORLIG_PREMIUM_MINI_MAX_FX || 20),
  // Aynı anda açık tutulabilecek düello sayısı (ücretsiz: 3)
  maxOpenDuels: Number(process.env.SKORLIG_PREMIUM_MAX_OPEN_DUELS || 10),
  // Aynı anda BİTMEMİŞ tutulabilecek mini turnuva sayısı (ücretsiz: 2).
  // ⚠️ Bu bir ayrıcalık değil, KÖTÜYE KULLANIM SINIRI: mini turnuva
  // ücretsiz ve kazananlara LC veriyor, yani karşılıksız bir LC musluğu.
  // Sınır "aynı anda açık" üzerinden, çünkü her turnuvanın bitmesi için
  // maçların oynanması gerekir — musluğun hızı gerçek fikstüre bağlanır.
  miniMaxOpen: Number(process.env.SKORLIG_PREMIUM_MINI_MAX_OPEN || 6),
  // Geçmiş sezon arşivinde kaç sezon geriye gidilebilir (ücretsiz: 1)
  seasonArchiveDepth: Number(process.env.SKORLIG_PREMIUM_ARCHIVE_DEPTH || 12),
  // Profilde rozet
  badge: String(process.env.SKORLIG_PREMIUM_BADGE || "premium"),
};

/** Ücretsiz kademe karşılıkları — tek yerde, ayrıcalık farkı görünür olsun. */
const FREE = {
  /* ⚠️ BURADA `|| 6` YAZIYORDU — odeme yolu ayni degiskeni `|| 3` ile
   * okuyor. Satis ekrani ucretsiz kademeyi 2 KAT abartiyordu. Tek kaynak. */
  dailyLc: require("./ekonomi.cjs").GUNLUK_TABAN,
  /* ⚠️ EKRAN BUNLARI ELLE YAZIYORDU ("15 tavan / 4 saatte +1"). Bugun dogru,
   * ama ortam degiskeni degisince sessizce yalan soylerdi. Degerler
   * lc-regen'in KENDI sabitlerinden geliyor — yeniden yazilmiyor. */
  regenCap: require("./lc-regen.cjs").REGEN_CAP,
  regenHours: require("./lc-regen.cjs").REGEN_HOURS,
  monthlyFloor: 0,
  storeBonusPct: 0,
  miniMaxFixtures: Number(process.env.SKORLIG_FREE_MINI_MAX_FX || 5),
  maxOpenDuels: Number(process.env.SKORLIG_FREE_MAX_OPEN_DUELS || 3),
  miniMaxOpen: Number(process.env.SKORLIG_FREE_MINI_MAX_OPEN || 2),
  seasonArchiveDepth: Number(process.env.SKORLIG_FREE_ARCHIVE_DEPTH || 1),
};

// Takvim ayı anahtarı: "2026-07"
function monthKey(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// Abonelik paketleri (mock mağaza — store ile aynı mantık)
const PLANS = [
  { id: "premium_month", days: 30, priceTRY: 59.99, label: "Premium — 1 Ay" },
  { id: "premium_season", days: 120, priceTRY: 179.99, label: "Premium — Sezon (4 Ay)", popular: true },
];

/**
 * "Bu kullanıcı 1987 üyesi mi?" — TEK KAYNAK.
 *
 * ⚠️ NEDEN TOPLANDI: aynı üç satırlık kural kod tabanında DÖRT yerde ayrı ayrı
 * yazılmıştı (lib/premium.cjs, routes/lc-wallet.cjs, lib/users-store.cjs'de
 * iki kez). Şu an hepsi aynı şeyi söylüyor — ama bu oturumun tekrar eden
 * dersi, kopyaların ne zaman ayrıştığı: davet ödülü, grup yarışı, bot
 * süzgeci, sahiplik denetimi... hepsi "bir yerde var, ötekinde yok" biçiminde
 * çıktı.
 *
 * Kural taşıdığı ayrıcalık yüzünden önemli: 1987 üyeliği SÜRESİZ premium
 * (bkz. isActivePremiumRecord) ve 60 LC açılış bakiyesi demek.
 *
 * ⚠️ MONGO SORGUSU AYRI KALIYOR: lib/users-store.cjs bunu bir sorgu olarak
 * yazmak zorunda (`$or` + regex). Aynı yüklemi paylaşamıyor; eşdeğerliği
 * tests/1987-uyelik.test.cjs doğruluyor.
 */
function uyeMi1987(u) {
  if (!u) return false;
  if (u.is1987 === true) return true;
  return String(u.segment || "").toLowerCase() === "1987";
}

function isActivePremiumRecord(u, nowMs = Date.now()) {
  if (!u) return false;
  /* ⚠️ 1987 = PREMIUM EŞİTLİĞİ KALDIRILDI (2026-08-08, kullanıcı kararı).
   * Eski dal: `if (uyeMi1987(u)) return true;` — üyeyi SÜRESİZ premium
   * yapıyordu ve 30+30 kararını üç koldan deliyordu (ölçüldü, yolculuk
   * testi): cüzdan ekranını açmak aylık kasayla bakiyeyi 60'a tamamlıyor,
   * günlük taban 12'ye çıkıyor, maç bedeli muafiyeti arka kapıdan dönüyordu.
   * Üyelik artık premium DEĞİL: ayrıcalığı bonus1987 (30 + aylık tamamlama)
   * ve kendine tanımlı oyunlar. Premium yalnızca satın almayla. */
  if (u.premium !== true) return false;

  /* ⚠️ SÜRE YOKSA PREMIUM DEĞİL (fail-closed).
   *
   * Eskiden burada `if (!u.premiumUntil) return true; // süresiz premium`
   * vardı — ve bu dosyanın KENDİ BAŞLIĞIYLA ÇELİŞİYORDU:
   *   "premiumUntil: ISO tarih (yoksa/expired ise premium sayılmaz)"
   * Belge "yoksa premium değil" derken kod "yoksa sonsuza kadar premium"
   * diyordu.
   *
   * Çelişki tehlikeli çünkü sözleşmeden akıl yürüten biri — bir yönetici
   * aracı, bir taşıma betiği — `premium: true` yazıp süreyi boş bırakınca
   * KALICI premium vermiş olurdu.
   *
   * Kodda premium veren TEK yol var (routes/lc-wallet.cjs premium/subscribe)
   * ve o her zaman `premiumUntil` yazıyor; 1987 üyeliği ise yukarıdaki dalda
   * zaten dönüyor. Yani bu dalı kapatmak mevcut hiçbir kullanıcıyı
   * etkilemiyor, yalnızca gelecekteki bir yanlış yazımı sessiz bir kalıcı
   * ayrıcalığa çevirmesini engelliyor.
   *
   * Süresiz premium gerçekten istenirse açık bir alan (`premiumForever`)
   * eklenmeli — "alan yok" bir niyet beyanı değildir. */
  if (!u.premiumUntil) return false;

  const until = new Date(u.premiumUntil).getTime();
  return Number.isFinite(until) && until > nowMs;
}

/**
 * Kullanıcı kaydını getirir.
 *
 * Küçük harfli sorgu kullanılıyor: kimlikler karışık harfli (Firebase UID) ve
 * eski kod da küçük harfe indirgeyip karşılaştırıyordu. Tam eşleşen sorguya
 * geçmek, harf farkı olan her kullanıcıyı sessizce "premium değil" yapardı.
 */
async function _kullanici(userId, db) {
  const uid = String(userId || "").trim().toLowerCase();
  if (!uid) return null;
  const map = await UsersStore.getUsersByIdsLower([uid], db);
  return map[uid] || null;
}

/** userId premium mi? */
async function isPremium(userId, db) {
  const u = await _kullanici(userId, db);
  return isActivePremiumRecord(u);
}

/**
 * PARAYLA ALINMIŞ premium mu? — 1987 kestirmesini YOK SAYAR.
 *
 * ⚠️ NEDEN VAR (2026-08-08, 30+30 kararı): `isPremium` 1987 üyesini süresiz
 * premium sayar (geriye uyum). Maç giriş bedeli bu kapıdan geçince üye HER
 * maçı bedava oynuyor, bonus1987 hiç erimiyordu — kullanıcının "başka tip
 * oyunlara girerlerse diğer LC düşsün" kararı sessizce iptal oluyordu.
 * Bedel muafiyeti artık yalnızca satın alınmış premium'a bakar; 1987'nin
 * öteki ayrıcalıkları (günlük taban, regen) bilinçli olarak DOKUNULMADI.
 */
async function isPaidPremium(userId, db) {
  const u = await _kullanici(userId, db);
  if (!u || u.premium !== true) return false;
  if (!u.premiumUntil) return false;
  const until = new Date(u.premiumUntil).getTime();
  return Number.isFinite(until) && until > Date.now();
}

/** Premium durum + ayrıcalık özeti (UI için) */
async function premiumStatus(userId, db) {
  const u = await _kullanici(userId, db);
  const active = isActivePremiumRecord(u);
  return {
    active,
    premiumUntil: u?.premiumUntil || null,
    /* via yalnızca AKTİF kanalı söyler. 1987 artık premium kanalı değil
     * (2026-08-08 ayrıştırma) — pasifken "1987" bildirmek ekrana premium
     * rozeti çizdirirdi. */
    via: active ? "premium" : null,
    perks: PERKS,
    /* ⚠️ EKRAN "ucretsiz" SUTUNUNU ELLE YAZIYORDU ve gunluk LC'de 5 diyordu;
     * gercek taban 3'tu. Artik sunucudan geliyor, istemcide sayi kalmadi. */
    freePerks: FREE,
    /* ⚠️ HANGI AYRICALIK "TAMAMLAMA", HANGISI "HIBE" — ekranin bilmesi sart.
     * `monthlyFloor` ve `dailyLc` birer TABAN: bakiye ustundeyse verilen 0.
     * Bunu "her ay 60 LC alirsin" diye sunmak yanlis vaat olur; lc-wallet
     * ayni hatayi ozet yanitinda bir kez duzeltmisti (bkz. gunlukMiktar). */
    perkKind: { monthlyFloor: "tamamlama", dailyLc: "tamamlama",
                regenCap: "kapasite", regenHours: "kapasite", storeBonusPct: "satin-alma" },
    plans: PLANS,
  };
}

// ===== Ayrıcalık getter'ları (kademeye göre değer) =====
const dailyLc = (prem) => (prem ? PERKS.dailyLc : FREE.dailyLc);

/**
 * Maç girişi bedeli premium'dan ETKİLENMEZ — herkes aynı ücreti öder.
 *
 * ⚠️ Bu bir "unutulmuş özellik" değil, ölçülmüş bir karar. Giriş 3→2 LC
 * indirimi premium'un maç başına ortalamasını −0.66'dan +0.15'e çeviriyor:
 * premium net LC ÜRETİCİSİ olurdu. Aylık kasayı küçültüp indirimle geri
 * vermek, enflasyonu adı değişmiş hâlde geri getirirdi.
 */
const matchCost = (prem, base) => base;

/** Erişim/kapasite ayrıcalıkları — LC akışına dokunmaz. */
const miniMaxFixtures = (prem) => (prem ? PERKS.miniMaxFixtures : FREE.miniMaxFixtures);
const maxOpenDuels = (prem) => (prem ? PERKS.maxOpenDuels : FREE.maxOpenDuels);
const miniMaxOpen = (prem) => (prem ? PERKS.miniMaxOpen : FREE.miniMaxOpen);
const seasonArchiveDepth = (prem) => (prem ? PERKS.seasonArchiveDepth : FREE.seasonArchiveDepth);
const regenParams = (prem) =>
  prem ? { cap: PERKS.regenCap, hours: PERKS.regenHours } : null; // null => lc-regen kendi default'unu kullanır

/**
 * Aylık kasa: premium kullanıcıya bu takvim ayı henüz verilmemişse verir.
 * Cüzdan user kaydını (balance/totalEarned/lastMonthlyAt) YERİNDE günceller.
 * @returns {number} bu çağrıda eklenen LC (0 = zaten alınmış / premium değil)
 */
function grantMonthlyIfDue(walletUser, isPrem, nowDate = new Date()) {
  if (!walletUser || !isPrem || PERKS.monthlyFloor <= 0) return 0;
  const mk = monthKey(nowDate);
  if (walletUser.lastMonthlyAt === mk) return 0; // bu ay zaten bakıldı

  // ⚠️ TABANA TAMAMLAMA — koşulsuz EKLEME DEĞİL.
  // Eski hâli `balance += 300` idi: bakiyesi 500 olan da her ay 300 daha
  // alıyordu, yani arz sınırsız birikiyordu. Tamamlamada zengin oyuncuya
  // HİÇ verilmez; sadece parasız kalan tabana çekilir. Günlük hakta aynı
  // düzeltme yapılmıştı (bkz. routes/lc-wallet.cjs gunlukMiktar).
  const bakiye = Number(walletUser.balance || 0);
  const verilecek = bakiye >= PERKS.monthlyFloor
    ? 0
    : Math.round((PERKS.monthlyFloor - bakiye) * 10) / 10;

  // Mühür her hâlükârda basılır: 0 verilse de "bu ay bakıldı" sayılır,
  // yoksa gün içinde bakiye düştükçe defalarca tamamlama yapılırdı.
  walletUser.lastMonthlyAt = mk;
  walletUser.updatedAt = nowDate.toISOString();
  if (verilecek <= 0) return 0;

  walletUser.balance = bakiye + verilecek;
  walletUser.totalEarned = Number(walletUser.totalEarned || 0) + verilecek;
  return verilecek;
}

/** UI için aylık kasa bilgisi (bu ay alındı mı, sonraki yenileme) */
function monthlyInfo(walletUser, isPrem, nowDate = new Date()) {
  const mk = monthKey(nowDate);
  const grantedThisMonth = !!walletUser && walletUser.lastMonthlyAt === mk;
  // sonraki ayın 1'i (UTC)
  const next = new Date(Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth() + 1, 1));
  return {
    amount: PERKS.monthlyFloor,
    kind: "floor", // tamamlama — koşulsuz ekleme değil
    active: isPrem,
    grantedThisMonth,
    nextRenewal: Season.dayKey(next),
  };
}

module.exports = {
  uyeMi1987,
  PERKS,
  PLANS,
  monthKey,
  isPremium,
  isPaidPremium,
  premiumStatus,
  isActivePremiumRecord,
  dailyLc,
  matchCost,
  regenParams,
  miniMaxFixtures,
  miniMaxOpen,
  maxOpenDuels,
  seasonArchiveDepth,
  FREE,
  grantMonthlyIfDue,
  monthlyInfo,
};
