"use strict";

/**
 * TAKIM KATALOĞU — kanonik takım adı ve ülkeye göre takım listesi.
 *
 * NEDEN VAR: `mainTeam` (kullanıcının tuttuğu takım) `set-main-team` ucuna
 * HAM geliyordu. `set-country` yıllardır `canonicalCountry()` ile geçiyor ama
 * takım tarafında o adım hiç yazılmamıştı — yani "Galatasaray", "galatasaray",
 * "Galatasaray SK" ve "GALATASARAY" veritabanında DÖRT AYRI DEĞER.
 *
 * Bu, aynı takımı tutanların sıralamasını sessizce bölerdi: `listByTeam`
 * tam eşleşme (harf duyarsız) yapıyor, dolayısıyla "Galatasaray SK" yazan
 * kullanıcı "Galatasaray" listesinde HİÇ görünmez. Hata mesajı yok, yalnızca
 * eksik liste — bu oturumun tekrar tekrar rastladığı sessiz kırılma sınıfı.
 *
 * KAYNAK: `data/countries-teams.json` (28 ülke, 461 takım). Küratörlü tablo;
 * fikstürlerden türetmek yerine bunu kullanıyorum çünkü onboarding'de
 * gösterilecek liste de aynı yerden gelmeli — seçilen ad zaten kanonik olur.
 *
 * ⚠️ BULANIK EŞLEŞME YOK, VE BU BİLİNÇLİ. `team-country.cjs` içinde ölçülmüştü:
 * "içeriyor" aramasıyla eşleştirmek `Inter`, `Atlético`, `Union` gibi adlarda
 * birden çok aday üretiyor ve yazı turası atıyordu. Orada bedeli maçın yanlış
 * ülkeye düşmesiydi; BURADA bedeli daha ağır olurdu — iki farklı kulübün
 * taraftarı tek sıralamada birleşir. Bu yüzden yalnızca (a) tam ad ve
 * (b) TEK ADAYLI çekirdek eşleşmesi kabul ediliyor; belirsizse null.
 */

const fs = require("fs");
const path = require("path");
const { _anahtarla: anahtarla, _cekirdek: cekirdek } = require("./team-country.cjs");
const { normalizeCountry } = require("./countries.cjs");

const DATA_DIR = process.env.SKORLIG_DATA_DIR || path.join(__dirname, "..", "data");

/* Katalog dosyası her zaman paketle gelir; SKORLIG_DATA_DIR testte geçici bir
 * dizini gösterebildiği için kaynak ağacındaki kopya yedek olarak duruyor. */
const ADAY_YOLLAR = [
  path.join(DATA_DIR, "countries-teams.json"),
  path.join(__dirname, "..", "data", "countries-teams.json"),
];

let _katalog = null;

function yukle() {
  if (_katalog) return _katalog;

  let ham = null;
  for (const y of ADAY_YOLLAR) {
    try { ham = JSON.parse(fs.readFileSync(y, "utf8")); break; } catch { /* sonraki */ }
  }

  const ulkeler = Array.isArray(ham?.countries) ? ham.countries : [];

  const tamIx = new Map();      // anahtar        → kanonik ad
  const cekirdekIx = new Map(); // çekirdek       → kanonik ad
  const cakisan = new Set();    // birden çok kulübe giden çekirdekler
  const takimUlke = new Map();  // kanonik ad     → kanonik ülke
  const ulkeBayrak = new Map(); // kanonik ülke   → bayrak
  const ulkeTakim = new Map();  // kanonik ülke   → [kanonik ad]

  for (const u of ulkeler) {
    const ulke = normalizeCountry(u?.name || u?.country || "") || String(u?.name || "").trim();
    if (!ulke) continue;
    if (u?.flag) ulkeBayrak.set(ulke, u.flag);
    const liste = Array.isArray(u?.teams) ? u.teams : [];
    const kanonikler = [];

    for (const t of liste) {
      const ad = String(t || "").trim();
      if (!ad) continue;
      kanonikler.push(ad);
      if (!takimUlke.has(ad)) takimUlke.set(ad, ulke);

      const a = anahtarla(ad);
      if (a && !tamIx.has(a)) tamIx.set(a, ad);

      const c = cekirdek(ad);
      /* Çok kısa çekirdek yanlış eşleşme üretir — team-country.cjs'teki
       * aynı 4 harf tabanı. */
      if (!c || c.length < 4) continue;
      const varolan = cekirdekIx.get(c);
      if (varolan === undefined) cekirdekIx.set(c, ad);
      else if (anahtarla(varolan) !== anahtarla(ad)) cakisan.add(c);
    }
    if (kanonikler.length) ulkeTakim.set(ulke, kanonikler);
  }

  /* ⚠️ Belirsiz çekirdekler SİLİNİYOR, ilk gelen kazanmıyor. İki farklı
   * kulüp aynı çekirdeğe iniyorsa (ör. ek atılınca) hangisinin kastedildiği
   * bilinemez; tahmin etmek taraftarları birleştirir. */
  for (const c of cakisan) cekirdekIx.delete(c);

  _katalog = { tamIx, cekirdekIx, takimUlke, ulkeBayrak, ulkeTakim };
  return _katalog;
}

/**
 * Serbest yazılmış takım adını katalogdaki kanonik ada çevirir.
 * @returns {string|null} kanonik ad; katalogda yoksa/belirsizse null
 */
function kanonikTakim(ad) {
  const ham = String(ad || "").trim();
  if (!ham) return null;
  const { tamIx, cekirdekIx } = yukle();

  const a = anahtarla(ham);
  if (a && tamIx.has(a)) return tamIx.get(a);

  const c = cekirdek(ham);
  if (c && c.length >= 4 && cekirdekIx.has(c)) return cekirdekIx.get(c);

  return null;
}

/** Bir ülkenin takımları (onboarding seçicisi). Ülke verilmezse hepsi. */
function takimlar(ulke) {
  const { ulkeTakim, takimUlke, ulkeBayrak } = yukle();
  const hedef = ulke ? normalizeCountry(ulke) : null;

  const cikar = (ad) => {
    const u = takimUlke.get(ad) || null;
    return { team: ad, country: u, flag: (u && ulkeBayrak.get(u)) || "" };
  };

  if (hedef) return (ulkeTakim.get(hedef) || []).map(cikar);
  const hepsi = [];
  for (const liste of ulkeTakim.values()) for (const ad of liste) hepsi.push(cikar(ad));
  return hepsi;
}

/** Takımın ülkesi (katalogdan; `team-country.cjs` tahmininden bağımsız). */
function takimUlkesi(ad) {
  const k = kanonikTakim(ad);
  return k ? yukle().takimUlke.get(k) || null : null;
}

/** Ülke bayrağı — sıralama satırlarında kullanıcının yanında gösteriliyor. */
function ulkeBayragi(ulke) {
  const hedef = normalizeCountry(ulke);
  return (hedef && yukle().ulkeBayrak.get(hedef)) || "";
}

module.exports = { kanonikTakim, takimlar, takimUlkesi, ulkeBayragi, _yukle: yukle };
