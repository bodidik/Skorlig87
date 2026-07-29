"use strict";

/**
 * TAKIM → ÜLKE eşlemesi.
 *
 * NEDEN VAR: Öncelik sıralaması maçın `country` alanına bakıyordu. Ama bir
 * kullanıcının kendi ülkesiyle ilgisi TURNUVANIN ülkesi değil, TAKIMIN
 * ülkesidir.
 *
 * Gerçek ölçüm (2026-07-29, mackolik cache): Türk takımlı 5 maç vardı ve
 * hiçbiri "Türkiye" etiketli DEĞİLDİ —
 *
 *     Avrupa | Şampiyonlar Ligi        | Gornik Zabrze - Fenerbahçe
 *     Dünya  | Hazırlık Maçları        | Alanyaspor - Pyramids
 *     Dünya  | Hazırlık Maçları        | Konyaspor - Al Dhafra
 *     Dünya  | Hazırlık Maçları        | AEK - Samsunspor
 *
 * Türk kullanıcı bu maçları görüyordu ama "kendi ülkesi" grubuna girmiyorlardı;
 * Fenerbahçe'nin Şampiyonlar Ligi maçı listenin tepesinde olmalıydı.
 *
 * Sezon arasında bu daha da önemli: Süper Lig oynanmazken Türk kullanıcının
 * ilgisini çeken TEK şey Türk takımlarının Avrupa/hazırlık maçlarıdır.
 *
 * Kaynak: data/countries-teams.json (ülke → takım listesi).
 */

const path = require("path");
const { normalizeCountry } = require("./countries.cjs");

const DATA_DIR = process.env.SKORLIG_DATA_DIR || path.join(__dirname, "..", "data");

/** Türkçe duyarlı, aksansız karşılaştırma anahtarı. */
const ASCIILESTIR = { ç: "c", ğ: "g", ı: "i", ö: "o", ş: "s", ü: "u", â: "a", î: "i", û: "u" };
function anahtarla(s) {
  return String(s || "")
    .trim()
    .toLocaleLowerCase("tr")
    .replace(/[çğıöşüâîû]/g, (h) => ASCIILESTIR[h] || h)
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Takım adından "gürültü" kelimeleri atar: FC, SK, AŞ, United gibi ekler
 * kaynağa göre değişiyor ("Fenerbahçe" / "Fenerbahce SK" / "FC Fenerbahce").
 */
const EKLER = new Set([
  "fc", "sk", "as", "sc", "cf", "ac", "afc", "spor", "kulubu", "kulubu",
  "jk", "gsk", "if", "bk", "fk", "cd", "ca", "club", "the",
]);
function cekirdek(s) {
  return anahtarla(s).split(" ").filter((p) => p && !EKLER.has(p)).join(" ");
}

let _indeks = null;

/** takımÇekirdeği → kanonik ülke. Bir kez kurulur. */
function indeks() {
  if (_indeks) return _indeks;
  _indeks = new Map();

  let ham = null;
  try {
    ham = require(path.join(DATA_DIR, "countries-teams.json"));
  } catch (e) {
    console.warn("[team-country] countries-teams.json okunamadi:", e?.message || e);
    return _indeks;
  }

  const liste = Array.isArray(ham?.countries)
    ? ham.countries
    : Object.values(ham?.countries || {});

  for (const u of liste) {
    const ulke = normalizeCountry(u?.name || u?.localName || u?.code);
    if (!ulke) continue;
    for (const t of u?.teams || []) {
      const k = cekirdek(t);
      // Çok kısa çekirdek yanlış eşleşme üretir ("as", "cd" gibi).
      if (k.length < 4) continue;
      if (!_indeks.has(k)) _indeks.set(k, ulke);
    }
  }
  return _indeks;
}

/**
 * Takım adından ülkesini bulur.
 *
 * Eşleşme çekirdek adlar üzerinden: tam eşleşme, sonra "içeriyor" kontrolü
 * (kaynaklar "Fenerbahçe SK", "FC Fenerbahce" gibi varyantlar gönderiyor).
 * İçerme kontrolü YALNIZCA yeterince uzun adlarda yapılır — kısa adlarda
 * yanlış eşleşme, maçı yanlış ülkeye atar ki bu sessiz bir hata olur.
 *
 * @returns {string|null} kanonik ülke adı ya da null
 */
function teamCountry(takimAdi) {
  const k = cekirdek(takimAdi);
  if (!k || k.length < 4) return null;

  const ix = indeks();
  const tam = ix.get(k);
  if (tam) return tam;

  for (const [bilinen, ulke] of ix) {
    if (bilinen.length < 5) continue; // kısa adla içerme araması riskli
    if (k.includes(bilinen) || bilinen.includes(k)) return ulke;
  }
  return null;
}

/** Maçın taraflarından biri bu ülkeye mi ait? */
function fixtureHasCountryTeam(fixture, ulke) {
  const hedef = normalizeCountry(ulke);
  if (!hedef) return false;
  return (
    teamCountry(fixture?.home) === hedef || teamCountry(fixture?.away) === hedef
  );
}

module.exports = { teamCountry, fixtureHasCountryTeam, _cekirdek: cekirdek };
