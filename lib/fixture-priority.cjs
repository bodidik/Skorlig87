"use strict";

/**
 * FİKSTÜR KABULÜ VE ÖNCELİKLENDİRME.
 *
 * ESKİ DAVRANIŞ VE NEDEN DEĞİŞTİ: Sistem maçları ÜLKEYE GÖRE ELİYORDU.
 * `ALLOWED` tablosunda olmayan ülkenin maçı hiç havuza girmiyor, giren de
 * kullanıcının ülkesine göre ikinci kez süzülüyordu. Üstüne lig başına tavan
 * vardı. Her katman tek başına makul; üst üste binince ekran boşalıyordu.
 *
 * Ölçülen sonuç (2026-07-28): Süper Lig sezon arasındayken Türk kullanıcının
 * ilk maçı 14 GÜN sonraydı. Aynı anda kaynaklarda o gün oynanan onlarca maç
 * vardı — UCL ön elemeleri, Konferans Ligi elemeleri, Brezilya Série A.
 * Korku "maç kalabalığında oyun kurulamaz" idi; yaşanan tam tersi oldu.
 *
 * YENİ KURAL: Ülke ELEME ölçütü değil, SIRALAMA ölçütüdür.
 *   - Havuza her ülkenin maçı girer (Özbekistan, İzlanda, Faroe dahil).
 *   - Kullanıcının ülkesi yalnızca hangi maçın ÜSTTE görüneceğini belirler.
 *   - Kullanıcının sıralama havuzu kendi ülkesine göre işler; maçın ülkesiyle
 *     ilgisi yoktur. Bu ikisi eskiden karıştırılıyordu.
 *
 * Tek istisna: kadın/gençlik/yedek ligler elenmeye devam eder (ürün kararı).
 */

const {
  isGlobalLeagueName, isExcludedLeague, isFriendlyLeague,
} = require("./global-leagues.cjs");

/**
 * Öncelikli sayılan büyük ligler. Kullanıcının kendi ülkesi ve küresel
 * turnuvalardan sonra gelirler — "bugün ne oynayayım" sorusuna makul cevap.
 */
const BIG_LEAGUES = [
  /premier\s*league/i,
  /la\s*liga/i, /^laliga/i,
  /bundesliga/i,
  /serie\s*a/i,
  /ligue\s*1/i,
  /eredivisie/i,
  /primeira/i,
  /süper\s*lig/i, /super\s*lig/i,
  /brasileiro/i, /brasileirao/i,
];

// Öncelik sınıfları — küçük sayı üstte.
const P_COUNTRY = 0;  // kullanıcının kendi ülkesi
const P_GLOBAL = 1;   // UCL / Avrupa Ligi / Libertadores…
const P_BIG = 2;      // büyük Avrupa ligleri + Brezilya
const P_OTHER = 3;    // diğer ülke ligleri
const P_FRIENDLY = 4; // hazırlık maçları — en sonda

/**
 * Maç havuza girsin mi?
 *
 * Neredeyse her şeye "evet" der — kasıtlı. Yalnızca kadın/gençlik/yedek
 * ligler ve tanımsız maçlar elenir. Ülke bakılmaz.
 */
function isAcceptableFixture(it) {
  if (!it) return false;
  if (!it.home || !it.away) return false;
  if (isExcludedLeague(it.league)) return false;
  return true;
}

const norm = (s) => String(s || "").trim().toLocaleLowerCase("tr");

/** Ülke adlarını gevşek karşılaştır ("Türkiye" ↔ "Turkey"). */
function sameCountry(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const tr = new Set(["türkiye", "turkiye", "turkey"]);
  if (tr.has(x) && tr.has(y)) return true;
  return false;
}

/**
 * Maçın öncelik sınıfı.
 * @param {object} it        fikstür
 * @param {string} userCountry kullanıcının ülkesi (yoksa ülke sınıfı devre dışı)
 */
function priorityOf(it, userCountry) {
  // Hazırlık maçı her durumda sonda — kullanıcının ülkesinden bile olsa
  // gerçek bir müsabakanın önüne geçmemeli.
  if (isFriendlyLeague(it?.league)) return P_FRIENDLY;
  if (userCountry && sameCountry(it?.country, userCountry)) return P_COUNTRY;
  if (isGlobalLeagueName(it?.league)) return P_GLOBAL;
  if (BIG_LEAGUES.some((rx) => rx.test(String(it?.league || "")))) return P_BIG;
  return P_OTHER;
}

const koMs = (it) => {
  const t = Date.parse(it?.kickoffISO || "");
  return Number.isFinite(t) ? t : Number.MAX_SAFE_INTEGER;
};

/**
 * Önceliğe göre sırala: ülke → küresel → büyük lig → diğer.
 * Her grup KENDİ İÇİNDE başlama saatine göre sıralanır.
 *
 * Eleme YOK — sıra değişir, liste kısalmaz. Kullanıcı aşağı kaydırarak
 * her maça ulaşabilir.
 */
function sortByPriority(list, userCountry) {
  return [...(list || [])].sort((a, b) => {
    const pa = priorityOf(a, userCountry);
    const pb = priorityOf(b, userCountry);
    if (pa !== pb) return pa - pb;
    return koMs(a) - koMs(b);
  });
}

module.exports = {
  isAcceptableFixture,
  priorityOf,
  sortByPriority,
  sameCountry,
  BIG_LEAGUES,
  P_COUNTRY, P_GLOBAL, P_BIG, P_OTHER, P_FRIENDLY,
};
