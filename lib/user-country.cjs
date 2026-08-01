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
const { normalizeCountry } = require("./countries.cjs");
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
    const ham = bot ? countryOfSegment(bot.segment) : humans.get(key) || null;
    /* ⚠️ ÜLKE KANONİK HÂLDE DÖNÜYOR — OKUMA TARAFINDA NORMALLEŞTİRME EKSİKTİ.
     *
     * Kullanıcı ülkesi YAZILIRKEN kanonikleştiriliyor (routes/live2.cjs), ama
     * burada depodaki değer HAM okunuyordu. Göç öncesi kayıtlar, elle
     * düzeltilmiş satırlar ya da farklı bir istemci "Turkey"/"Turkiye" yazmış
     * olabilir; o zaman aynı ülke ÇOK PARÇAYA bölünüyor.
     *
     * ÖLÇÜLDÜ (gerçek rota, beş oyuncu; dördü aynı ülkenin üç ayrı yazımında):
     *     GET /leaderboard/countries → "Türkiye 2", "Turkey 1", "Turkiye 1"
     *                                  yani ÜÇ SEKME, sayılar bölünmüş
     *     GET /leaderboard?country=… → her üçünde de 4 satır
     * Yani sekme "1 oyuncu" diyor, tıklayınca 4 kişi çıkıyor.
     *
     * Kaynağı burada düzeltmek, her okuyucuyu (sekme sayacı, süzgeç, gelecek
     * uçlar) tek seferde doğru yapıyor — her okuyucuya ayrı ayrı
     * `normalizeCountry` serpiştirmek bu oturumun defalarca gördüğü
     * "savunma tek yerde eksik" biçimini üretirdi. */
    const country = ham ? normalizeCountry(ham) : null;
    return { ...r, country };
  });
}

/** Tek bir kullanıcının ülkesi (bilinmiyorsa null). */
async function countryOfUser(userId, db) {
  const key = String(userId || "").trim().toLowerCase();
  if (!key) return null;
  const bot = BOT_PROFILE_MAP.get(key);
  // ⚠️ BURADA DA KANONİK: `attachCountries` ile aynı gerekçe. Bu değer
  // `scope=country` çözümlemesinde kullanılıyor (routes/leaderboard.cjs
  // resolveScope); ham dönerse kullanıcı kendi ülkesinin tablosunu bulamaz.
  if (bot) {
    const b = countryOfSegment(bot.segment);
    return b ? normalizeCountry(b) : null;
  }
  const humans = await _cozUlkeler([key], db);
  const ham = humans.get(key) || null;
  return ham ? normalizeCountry(ham) : null;
}

module.exports = { attachCountries, countryOfUser, invalidate };
