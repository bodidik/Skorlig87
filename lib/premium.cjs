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
const PERKS = {
  // Günlük LC hakkı (ücretsiz: 5)
  dailyLc: Number(process.env.SKORLIG_PREMIUM_DAILY_LC || 15),
  // Maç girişi bedeli (ücretsiz: 3) — premium bedava
  matchCost: Number(process.env.SKORLIG_PREMIUM_MATCH_COST || 0),
  // Doğru tahmin LC ödül çarpanı (ücretsiz: 1x)
  rewardMultiplier: Number(process.env.SKORLIG_PREMIUM_REWARD_MULT || 1.5),
  // Otomatik birikim: daha yüksek tavan + daha sık
  regenCap: Number(process.env.SKORLIG_PREMIUM_REGEN_CAP || 40),
  regenHours: Number(process.env.SKORLIG_PREMIUM_REGEN_HOURS || 2),
  // Mağaza satın alımında bonus LC oranı (0.20 = %20 ekstra)
  storeBonusPct: Number(process.env.SKORLIG_PREMIUM_STORE_BONUS || 0.2),
  // Mini turnuvada aynı anda üye olunabilecek/kurulabilecek üst sınır artışı
  miniMaxFixtures: Number(process.env.SKORLIG_PREMIUM_MINI_MAX_FX || 20),
};

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
const rewardMultiplier = (prem) => (prem ? PERKS.rewardMultiplier : 1);
const regenParams = (prem) =>
  prem ? { cap: PERKS.regenCap, hours: PERKS.regenHours } : null; // null => lc-regen kendi default'unu kullanır

module.exports = {
  PERKS,
  PLANS,
  isPremium,
  premiumStatus,
  isActivePremiumRecord,
  readUsers,
  dailyLc,
  matchCost,
  rewardMultiplier,
  regenParams,
};
