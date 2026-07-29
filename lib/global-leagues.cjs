"use strict";

/**
 * KÜRESEL LİGLER — ülke filtresine takılmadan herkese görünen turnuvalar.
 *
 * NEDEN AYRI DOSYA: Bu liste routes/live2.cjs ve routes/fixtures.cjs içinde
 * AYRI AYRI tanımlıydı ve ikisi birbirinden ayrışmıştı:
 *
 *   live2.cjs      : 15 desen + gençlik/kadın eleme
 *   fixtures.cjs   :  4 desen, eleme YOK
 *
 * Sonuç: aynı maç bir rotada küresel sayılıp herkese görünüyor, diğerinde
 * ülke filtresine takılıyordu. Kadın/gençlik Şampiyonlar Ligi ise fixtures
 * tarafında ana listeye sızıyordu. Tek kaynak buraya alındı.
 *
 * KAPSAM KURALI: Kıtasal KULÜP turnuvaları ve millî takım turnuvaları buraya
 * girer — bunları belirli bir ülkeye bağlamak yanlış olur (Libertadores
 * Brezilya ligi değildir). Ülke ligleri ALLOWED tablosuna girer.
 */

const GLOBAL_LEAGUES = [
  // Avrupa kulüp
  /champions\s*league/i,
  /uefa\s*champions/i,
  /europa\s*league/i,
  /conference\s*league/i,
  /şampiyonlar\s*ligi/i,
  /konferans\s*ligi/i,

  // Güney Amerika kulüp — CONMEBOL.
  // Libertadores eksikti: Türk kullanıcı sezon arasında ekranda hiç maç
  // göremiyordu, çünkü o dönemde oynanan tek turnuva buydu ve "World"
  // etiketiyle gelip ülke filtresine takılıyordu.
  /libertadores/i,
  /sudamericana/i,
  /recopa/i,

  // Millî takım / uluslararası
  /world\s*cup/i,
  /dünya\s*kupası/i,
  /euro\s*20\d{2}/i,
  /european\s*championship/i,
  /copa\s*america/i,
  /nations\s*league/i,
  /africa\s*cup/i,
];

/**
 * Hazırlık maçları — AYRI TUTULUYOR, küresel turnuva DEĞİL.
 *
 * Eskiden GLOBAL_LEAGUES içindeydiler; tek sebebi ülke süzgecini atlatmaktı
 * ("lig-öncesi dönemde herkes maç görsün"). Süzgeç kalkınca o gerekçe de
 * kalktı ve yan etkisi ortaya çıktı: hazırlık maçları Şampiyonlar Ligi ile
 * aynı öncelikte sayılıyor ve listenin tepesini kaplıyordu (ölçüldü: ilk 12
 * maçın 7'si hazırlıktı). Artık gerçek turnuvaların ALTINDA sıralanıyorlar.
 */
const FRIENDLY_LEAGUES = [
  /haz[ıi]rl[ıi]k/i,
  /friendl/i,
  /pre[- ]?season/i,
];

function isFriendlyLeague(league) {
  const n = String(league || "");
  return FRIENDLY_LEAGUES.some((rx) => rx.test(n));
}

/**
 * Gençlik / kadın / yedek / alt ligler: ana oyuna girmesin.
 * (örn. "UEFA U19 Championship", "Brasileiro A1 Kadınlar", "MLS Next Pro")
 */
const EXCLUDED_LEAGUES = [
  /\bU-?1\d\b/i,          // U15..U19
  /\bU-?2[0-3]\b/i,       // U20..U23
  /youth/i,
  /\bwomen\b/i,
  /\bw\.?league\b/i,
  /kad[ıi]nlar/i,         // Maçkolik/nesine Türkçe
  /next\s*pro/i,
  /\breserve/i,
  /\bacademy\b/i,
];

function isExcludedLeague(league) {
  const n = String(league || "");
  return EXCLUDED_LEAGUES.some((rx) => rx.test(n));
}

/**
 * Bu lig ülke filtresini atlamalı mı?
 * Eleme listesi ÖNCE bakılır — "UEFA Women's Champions League" küresel değil.
 */
function isGlobalLeagueName(league) {
  const n = String(league || "");
  if (isExcludedLeague(n)) return false;
  return GLOBAL_LEAGUES.some((rx) => rx.test(n));
}

module.exports = {
  GLOBAL_LEAGUES,
  EXCLUDED_LEAGUES,
  FRIENDLY_LEAGUES,
  isGlobalLeagueName,
  isExcludedLeague,
  isFriendlyLeague,
};
