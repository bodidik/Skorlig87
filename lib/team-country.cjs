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
/**
 * ⚠️ İKİ EK LİSTESİ AYRIŞMIŞTI. Aynı iş `services/odds-engine.cjs` içinde de
 * yapılıyor (`AFFIX_RE`) ama orada 37, burada 18 ek vardı. Gerçek fikstür
 * verisinde 48 takım adı, burada OLMAYAN bir ek taşıyor:
 *     "Chapecoense AF", "Clube do Remo", "RC Celta de Vigo",
 *     "Coritiba FBC", "Udinese Calcio", "Parma Calcio 1913" …
 * Bu adların çekirdeği yanlış çıkıyor ve ülkeleri bulunamıyordu.
 *
 * İki liste birleştirildi (her ikisinde olan + yalnız birinde olan).
 */
const EKLER = new Set([
  // her iki listede de vardı
  "fc", "sk", "as", "sc", "cf", "ac", "afc", "spor", "kulubu",
  "if", "bk", "fk", "cd", "ca", "club",
  // yalnız burada vardı
  "jk", "gsk", "the",
  // yalnız odds-engine'de vardı — eksikti
  "ud", "sv", "vfb", "vfl", "nk", "hk", "ks", "cs", "rc", "sd",
  "cr", "ec", "af", "fr", "fbpa", "fbc", "clube", "futebol", "futbol",
  "calcio", "sad", "aa",
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

  /* ⚠️ BELİRSİZ İÇERME EŞLEŞMESİ TAHMİN EDİLMİYOR.
   *
   * BULUNAN: içerme araması İLK eşleşmede duruyordu ve Map'in ekleme sırası
   * hangi ülkenin önce geldiğini belirliyordu — yani sonuç, veri dosyasındaki
   * ülke sırasına bağlıydı.
   *
   * ÖLÇÜLDÜ (gerçek veri, 1944 takım adı; 218 tam + 149 içerme eşleşmesi):
   * içerme eşleşmelerinin 7'sinde BİRDEN ÇOK ülke adayı vardı ve tek biri
   * seçiliyordu:
   *     "Inter"     → Italy      (adaylar: Italy, Switzerland, USA, Brazil)
   *     "Atlético"  → Spain      (adaylar: Spain, Brazil, Mexico)
   *     "Port"      → Spain      (adaylar: Spain, Portugal, Switzerland, USA)
   *     "Union"     → Belgium    (adaylar: Belgium, Germany, USA)
   *     "Lokomotiv" → Russia     (adaylar: Russia, Croatia)
   *     "Aris", "Athletic Club" — benzer
   * Yaklaşık yarısı doğru, yarısı yanlıştı: yazı tura.
   *
   * Dosyanın kendi notu bunu zaten uyarıyor: "yanlış eşleşme, maçı yanlış
   * ülkeye atar ki bu SESSİZ bir hata olur." Aynı karar bu oturumda
   * `services/odds-engine.cjs getRating` için de verildi: belirsiz anahtarda
   * tahmin etmek yerine bilinmiyor demek.
   *
   * ⚠️ BEDELİ VAR, ÖLÇTÜM: doğru tahmin edilen birkaç ad (ör. "Athletic Club"
   * → Spain) artık ülkesiz kalıyor. Ülke burada ELEME değil SIRALAMA ölçütü
   * (bkz. lib/fixture-priority.cjs), yani maç kaybolmuyor — yalnızca "kendi
   * ülkem" grubuna girmiyor. Yanlış ülkeye atamaktansa atamamak yeğdir.
   */
  const adaylar = new Set();
  for (const [bilinen, ulke] of ix) {
    if (bilinen.length < 5) continue; // kısa adla içerme araması riskli
    if (icerir(k, bilinen) || icerir(bilinen, k)) adaylar.add(ulke);
    if (adaylar.size > 1) return null; // belirsiz — tahmin etme
  }
  return adaylar.size === 1 ? [...adaylar][0] : null;
}

/**
 * `uzun` metni `kisa` çekirdeğini bir SÖZCÜĞÜN BAŞINDA içeriyor mu?
 *
 * ⚠️ İKİ ÖLÇÜMLE BULUNAN KURAL — ikisini de yazıyorum çünkü ilk denemem
 * yanlıştı.
 *
 * 1) DÜZ `includes` YETMİYOR. Ek listesini birleştirince ölçüm
 *    "SV Horn → Ukraine" üretti: "SV" atılınca çekirdek "horn" oluyor ve düz
 *    `includes` bunu "cHORNomorets odesa" içinde buluyor. SV Horn AVUSTURYA
 *    kulübü — listeyi zenginleştirmek yeni bir yanlış eşleşme doğurmuştu.
 *
 * 2) TAM SÖZCÜK SINIRI DA YANLIŞ. Önce iki yanlı sınır istedim; ölçüm 37
 *    DOĞRU eşleşmenin kaybolduğunu gösterdi — "Olympique Lyonnais → France",
 *    "Lech Poznan → Poland", "Viktoria Plzen → Czech Republic"… Çünkü tablo
 *    KISA adı tutuyor ("Lyon") ve fikstür UZUN adı gönderiyor ("Lyonnais");
 *    kısa ad, sözcüğün başında ama sonunda değil.
 *
 * DOĞRU KURAL: eşleşme bir sözcüğün BAŞINDA olmalı, sonu serbest.
 *     "lyon"  → "olympique LYONnais"   ✓ (sözcük başı)
 *     "horn"  → "cHORNomorets odesa"   ✗ (sözcük ortası)
 */
function icerir(uzun, kisa) {
  /* ⚠️ TABAN 4, 5 DEĞİL — ÖLÇÜLDÜ. Önce 5 denedim; "Lyon" ve "Nice" gibi
   * DOĞRU kısa adlar kayboldu (tablo kısa adı tutuyor, fikstür de kısa
   * gönderiyor). Sözcük-başı kuralı zaten "horn"/"chornomorets" vakasını
   * kestiği için tabanı yükseltmeye gerek kalmadı. */
  if (kisa.length < 4) return false;
  if (uzun === kisa) return true;
  let i = uzun.indexOf(kisa);
  while (i >= 0) {
    if (i === 0 || uzun[i - 1] === " ") return true;   // sözcük başı
    i = uzun.indexOf(kisa, i + 1);
  }
  return false;
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
