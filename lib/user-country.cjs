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
 * ⚠️ KAYNAK ARTIK users.json DEĞİL. Profil verisi lib/users-store.cjs
 * üzerinden geliyor (Mongo varsa Mongo). Bu dosya bir süre users.json'u
 * DOĞRUDAN okuyordu; SKORLIG_USERS_FILE_MIRROR=0 yapıldığı anda dosya
 * yazılmayı bırakacağı için her insan kullanıcı SESSİZCE ülkesiz görünürdü —
 * hata yok, yalnızca boş ülke sıralamaları.
 *
 * Kısa ömürlü önbellek korunuyor: sıralama isteği başına aynı kullanıcı
 * kümesini tekrar tekrar sorgulamamak için.
 */

const { BOT_PROFILE_MAP } = require("./botIds.cjs");
const { countryOfSegment } = require("./bot-countries.cjs");
const UsersStore = require("./users-store.cjs");

const CACHE_MS = 15_000;

// userIdLower → country. Yalnızca sorulan kimlikler girer; tüm kullanıcı
// kümesi hiç yüklenmez.
const _cache = new Map();
let _cacheAt = 0;

function _tazele() {
  if (Date.now() - _cacheAt >= CACHE_MS) {
    _cache.clear();
    _cacheAt = Date.now();
  }
}

/**
 * Verilen kimliklerin ülkelerini çözer (önbellekten + eksikleri depodan).
 * @returns {Promise<Map<string,string>>} userIdLower → country
 */
async function _cozUlkeler(idsLower, db) {
  _tazele();

  const eksik = idsLower.filter((id) => id && !_cache.has(id));
  if (eksik.length) {
    // KÜÇÜK HARFLİ sorgu şart: kimlikler karışık harfli (Firebase UID) ve
    // tam eşleşen sorgu buradaki anahtarlarla hiçbir şey bulamazdı.
    const map = await UsersStore.getUsersByIdsLower(eksik, db);
    for (const u of Object.values(map)) {
      const id = String(u?.userId || "").trim().toLowerCase();
      const c = String(u?.country || "").trim();
      if (id) _cache.set(id, c || null);
    }
    // Bulunamayanları da işaretle ki her istekte tekrar sorulmasınlar.
    for (const id of eksik) if (!_cache.has(id)) _cache.set(id, null);
  }

  return _cache;
}

/** Önbelleği düşür (set-country sonrası çağrılır). */
function invalidate() {
  _cache.clear();
  _cacheAt = 0;
}

/**
 * Satırlara `country` alanı ekler (yerinde değil, yeni dizi döner).
 * rows: [{ userId, ... }]
 *
 * Botlar bellekteki haritadan çözülür; yalnızca İNSAN kimlikleri depoya
 * sorulur. Sıralamalar ağırlıklı botla dolduğu için bu fark büyük.
 */
async function attachCountries(rows, db) {
  const liste = Array.isArray(rows) ? rows : [];

  const insanIds = [];
  for (const r of liste) {
    const key = String(r?.userId || "").trim().toLowerCase();
    if (key && !BOT_PROFILE_MAP.has(key)) insanIds.push(key);
  }

  const humans = insanIds.length ? await _cozUlkeler(insanIds, db) : _cache;

  return liste.map((r) => {
    const key = String(r?.userId || "").trim().toLowerCase();
    const bot = BOT_PROFILE_MAP.get(key);
    const country = bot ? countryOfSegment(bot.segment) : humans.get(key) || null;
    return { ...r, country };
  });
}

/** Tek bir kullanıcının ülkesi (bilinmiyorsa null). */
async function countryOfUser(userId, db) {
  const key = String(userId || "").trim().toLowerCase();
  if (!key) return null;
  const bot = BOT_PROFILE_MAP.get(key);
  if (bot) return countryOfSegment(bot.segment);
  const humans = await _cozUlkeler([key], db);
  return humans.get(key) || null;
}

module.exports = { attachCountries, countryOfUser, invalidate };
