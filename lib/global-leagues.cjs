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

  /* ⚠️ KADIN LİGLERİ YALNIZCA İNGİLİZCE/TÜRKÇE ADLA ELENİYORDU.
   *
   * ÖLÇÜLDÜ (gerçek veri: data/fixtures.json + data/livescore-cache.json,
   * 199 tekil lig adı): üç kadın ligi süzgeçten kaçıyordu —
   *     Damallsvenskan        (İsveç)   8 maç
   *     Liga MX Femenil       (Meksika) 1 maç
   *     1. Division Kvinner   (Norveç)  2 maç
   * Toplam 11 maç, ürün kararına aykırı biçimde havuza giriyordu.
   *
   * ⚠️ SÖZCÜK SINIRLARI ÖNEMLİ: `damer` sınırsız yazılsaydı "SUDAMERICANA"
   * elenirdi (gerçek veride 3 maç). Aynı şekilde `\bii\b` gibi bir kalıp
   * "Liga II", "NB II" gibi ERKEK ikinci liglerini elerdi — onlar kalmalı.
   * Her kalıp 199 gerçek lig adına karşı denendi: tam olarak yukarıdaki üçü
   * eleniyor, başka hiçbir lig etkilenmiyor. */
  /femen/i,               // Femenil, Femenina (İspanyolca)
  /femin/i,               // Féminine, Feminile, Feminina
  /frauen/i,              // Almanca
  /\bkvinn/i,             // Kvinner / Kvinnor (Norveç, İsveç)
  /damallsvenskan/i,      // İsveç kadınlar 1. lig — özel ad
  /\bdamer\b/i,           // Norveç/Danimarka; SINIRSIZ YAZILAMAZ (Sudamericana)
  /\bnaisten\b/i,         // Fince

  /* Gençlik ligleri de yalnızca "U19" biçiminde eleniyordu; İspanyolca/
   * Portekizce "Sub-20" ve İtalyanca "Primavera" kaçıyordu. Bu iki kalıp
   * ölçüm anındaki veride hiçbir lige denk gelmedi — ileriye dönük. */
  /\bsub-?\d\d\b/i,
  /primavera/i,
];

/**
 * ⚠️ AKSANLAR SÖZÜLÜYOR — kalıp listesi büyütmek yerine girdi sadeleştiriliyor.
 *
 * "Division 1 Féminine" ve "Serie A Femminile" `/femin/` kalıbına TAKILMIYORDU:
 * biri aksanlı `é`, öteki çift `m` taşıyor. Her yazım için ayrı kalıp eklemek
 * listeyi şişirir ve bir sonraki dili yine kaçırır. NFD ile aksanı ayırıp
 * atmak ve çift harfi tek harfe indirmek, kalıpları sade tutuyor.
 */
function sadelestir(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")   // aksan isaretleri (Feminine)
    .replace(/(.)\1+/g, "$1");          // tekrarli harf (Femminile -> Feminile)
}

function isExcludedLeague(league) {
  const ham = String(league || "");
  const sade = sadelestir(ham);
  return EXCLUDED_LEAGUES.some((rx) => rx.test(ham) || rx.test(sade));
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
