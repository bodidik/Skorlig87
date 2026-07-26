"use strict";

/**
 * userId → ülke çözümü. Sıralamanın ülkeye göre bölünebilmesi için gerekli.
 *
 * İki ayrı kaynak vardır:
 *   İnsan → data/users.json içindeki `country` alanı (set-country ile yazılır,
 *           canonicalCountry() kanonik yazımı üretir)
 *   Bot   → bot-profiles.json'daki `segment` → lib/bot-countries.cjs haritası
 *
 * Ülkesi bilinmeyen kayıt (henüz ülke seçmemiş kullanıcı, GLB botu) hiçbir
 * ülke listesinde görünmez; küresel listede görünür. Bu bilinçli: kullanıcıyı
 * varsayılan bir ülkeye atmak, o ülkenin sıralamasını kirletir.
 *
 * users.json diskte değişebildiği için kısa ömürlü önbellek kullanılır —
 * sıralama isteği başına dosyayı tekrar tekrar okumamak için.
 */

const path = require("path");
const fsp = require("fs").promises;

const { BOT_PROFILE_MAP } = require("./botIds.cjs");
const { countryOfSegment } = require("./bot-countries.cjs");

const USERS_FILE = path.join(__dirname, "..", "data", "users.json");
const CACHE_MS = 15_000;

let _cache = null;
let _cacheAt = 0;

/** users.json → Map(userIdLower → country). */
async function loadHumanCountries() {
  const now = Date.now();
  if (_cache && now - _cacheAt < CACHE_MS) return _cache;

  const map = new Map();
  try {
    const raw = JSON.parse(await fsp.readFile(USERS_FILE, "utf8"));
    const items = Array.isArray(raw) ? raw : Array.isArray(raw.items) ? raw.items : [];
    for (const u of items) {
      const id = String(u?.userId || "").trim().toLowerCase();
      const c = String(u?.country || "").trim();
      if (id && c) map.set(id, c);
    }
  } catch {
    // users.json yoksa/bozuksa: herkes ülkesiz sayılır, küresel liste çalışmaya devam eder
  }

  _cache = map;
  _cacheAt = now;
  return map;
}

/** Önbelleği düşür (set-country sonrası çağrılabilir). */
function invalidate() {
  _cache = null;
  _cacheAt = 0;
}

/**
 * Satırlara `country` alanı ekler (yerinde değil, yeni dizi döner).
 * rows: [{ userId, ... }]
 */
async function attachCountries(rows) {
  const humans = await loadHumanCountries();
  return (Array.isArray(rows) ? rows : []).map((r) => {
    const key = String(r?.userId || "").trim().toLowerCase();
    const bot = BOT_PROFILE_MAP.get(key);
    const country = bot ? countryOfSegment(bot.segment) : humans.get(key) || null;
    return { ...r, country };
  });
}

/** Tek bir kullanıcının ülkesi (bilinmiyorsa null). */
async function countryOfUser(userId) {
  const key = String(userId || "").trim().toLowerCase();
  if (!key) return null;
  const bot = BOT_PROFILE_MAP.get(key);
  if (bot) return countryOfSegment(bot.segment);
  const humans = await loadHumanCountries();
  return humans.get(key) || null;
}

module.exports = { attachCountries, countryOfUser, invalidate };
