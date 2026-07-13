"use strict";

/**
 * Premium üyelik — tek kaynak. users.json'daki kullanıcı kaydından okur:
 *   premium: true
 *   premiumUntil: ISO tarih (yoksa/expired ise premium sayılmaz)
 * (Eski "1987" segmenti de premium kabul edilir — geriye uyum.)
 *
 * Ayrıcalıklar tek yerde tanımlı; lc-wallet / pred / settle2 / lc-regen
 * bu getter'ları kullanır. Ücretsiz kademe hiç etkilenmez.
 */

const path = require("path");
const fsp = require("fs").promises;
const USERS_FILE = path.join(__dirname, "..", "data", "users.json");

// ===== Ayrıcalık sabitleri (env ile ayarlanabilir) =====
// ÖNEMLİ: Premium'un maç başı PUAN/ÖDÜL avantajı YOKTUR (rekabet adaleti).
// Avantaj tamamen LC ekonomisinde: aylık büyük kasa + bedava/avantajlı giriş.
const PERKS = {
  // Ay başında verilen büyük LC kasası (her takvim ayı bir kez, otomatik yenilenir)
  monthlyLc: Number(process.env.SKORLIG_PREMIUM_MONTHLY_LC || 300),
  // Günlük LC hakkı (ücretsiz: 5) — küçük ek, asıl güç aylık kasa
  dailyLc: Number(process.env.SKORLIG_PREMIUM_DAILY_LC || 10),
  // Maç girişi bedeli (ücretsiz: 3) — premium bedava (avantajlı giriş)
  matchCost: Number(process.env.SKORLIG_PREMIUM_MATCH_COST || 0),
  // Otomatik birikim: daha yüksek tavan + daha sık
  regenCap: Number(process.env.SKORLIG_PREMIUM_REGEN_CAP || 40),
  regenHours: Number(process.env.SKORLIG_PREMIUM_REGEN_HOURS || 2),
  // Mağaza satın alımında bonus LC oranı (0.20 = %20 ekstra)
  storeBonusPct: Number(process.env.SKORLIG_PREMIUM_STORE_BONUS || 0.2),
  // Mini turnuvada aynı anda üye olunabilecek/kurulabilecek üst sınır artışı
  miniMaxFixtures: Number(process.env.SKORLIG_PREMIUM_MINI_MAX_FX || 20),
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

function isActivePremiumRecord(u, nowMs = Date.now()) {
  if (!u) return false;
  // Geriye uyum: 1987 üyeliği premium sayılır
  const seg = String(u.segment || "").toLowerCase();
  if (u.is1987 === true || seg === "1987") return true;
  if (u.premium !== true) return false;
  if (!u.premiumUntil) return true; // süresiz premium
  const until = new Date(u.premiumUntil).getTime();
  return Number.isFinite(until) && until > nowMs;
}

async function readUsers() {
  try {
    const raw = JSON.parse(await fsp.readFile(USERS_FILE, "utf8"));
    if (Array.isArray(raw)) return { raw, items: raw };
    const items = Array.isArray(raw.items) ? raw.items : Array.isArray(raw.users) ? raw.users : [];
    return { raw, items };
  } catch {
    return { raw: { items: [] }, items: [] };
  }
}

/** userId premium mi? (dosyadan) */
async function isPremium(userId) {
  const uid = String(userId || "").trim().toLowerCase();
  if (!uid) return false;
  const { items } = await readUsers();
  const u = items.find((x) => String(x.userId || "").trim().toLowerCase() === uid);
  return isActivePremiumRecord(u);
}

/** Premium durum + ayrıcalık özeti (UI için) */
async function premiumStatus(userId) {
  const uid = String(userId || "").trim().toLowerCase();
  const { items } = await readUsers();
  const u = items.find((x) => String(x.userId || "").trim().toLowerCase() === uid) || null;
  const active = isActivePremiumRecord(u);
  return {
    active,
    premiumUntil: u?.premiumUntil || null,
    via: u?.is1987 || String(u?.segment || "").toLowerCase() === "1987" ? "1987" : u?.premium ? "premium" : null,
    perks: PERKS,
    plans: PLANS,
  };
}

// ===== Ayrıcalık getter'ları (kademeye göre değer) =====
const dailyLc = (prem) => (prem ? PERKS.dailyLc : 5);
const matchCost = (prem, base) => (prem ? PERKS.matchCost : base);
const regenParams = (prem) =>
  prem ? { cap: PERKS.regenCap, hours: PERKS.regenHours } : null; // null => lc-regen kendi default'unu kullanır

/**
 * Aylık kasa: premium kullanıcıya bu takvim ayı henüz verilmemişse verir.
 * Cüzdan user kaydını (balance/totalEarned/lastMonthlyAt) YERİNDE günceller.
 * @returns {number} bu çağrıda eklenen LC (0 = zaten alınmış / premium değil)
 */
function grantMonthlyIfDue(walletUser, isPrem, nowDate = new Date()) {
  if (!walletUser || !isPrem || PERKS.monthlyLc <= 0) return 0;
  const mk = monthKey(nowDate);
  if (walletUser.lastMonthlyAt === mk) return 0; // bu ay zaten verildi
  walletUser.balance = Number(walletUser.balance || 0) + PERKS.monthlyLc;
  walletUser.totalEarned = Number(walletUser.totalEarned || 0) + PERKS.monthlyLc;
  walletUser.lastMonthlyAt = mk;
  walletUser.updatedAt = nowDate.toISOString();
  return PERKS.monthlyLc;
}

/** UI için aylık kasa bilgisi (bu ay alındı mı, sonraki yenileme) */
function monthlyInfo(walletUser, isPrem, nowDate = new Date()) {
  const mk = monthKey(nowDate);
  const grantedThisMonth = !!walletUser && walletUser.lastMonthlyAt === mk;
  // sonraki ayın 1'i (UTC)
  const next = new Date(Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth() + 1, 1));
  return {
    amount: PERKS.monthlyLc,
    active: isPrem,
    grantedThisMonth,
    nextRenewal: next.toISOString().slice(0, 10),
  };
}

module.exports = {
  PERKS,
  PLANS,
  monthKey,
  isPremium,
  premiumStatus,
  isActivePremiumRecord,
  readUsers,
  dailyLc,
  matchCost,
  regenParams,
  grantMonthlyIfDue,
  monthlyInfo,
};
