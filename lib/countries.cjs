"use strict";

/**
 * ÜLKE ADI TEK KAYNAĞI — kanonik ad, takma adlar, bayrak.
 *
 * NEDEN VAR: Ülke adı üç ayrı yerde tanımlıydı ve zamanla ayrıştı —
 * `live2.cjs`'te ALLOWED + COUNTRY_FLAGS + ISO2_TO_COUNTRY,
 * `mackolik-fixture-sync.cjs`'te TR_TO_COUNTRY + EN_TO_COUNTRY,
 * `lib/bot-countries.cjs`'te segment haritası.
 *
 * Ülke ELEMESİ kaldırıldıktan sonra (bkz. lib/fixture-priority.cjs) tanınmayan
 * adlar ham hâliyle geçmeye başladı ve sorun görünür oldu — ÖLÇÜLDÜ (2026-07-29,
 * 142 maçlık gerçek havuz):
 *
 *     USA           4 maç
 *     United States 4 maç     ← AYNI ÜLKE, iki isim, sıralama ikiye bölünmüş
 *     İzlanda      10 maç     ← kaynak Türkçeyse Türkçe, İngilizceyse Iceland
 *     Ekvador       4 maç
 *     Kolombiya     3 maç
 *
 * Sonuç: kullanıcının ülkesi maçın ülkesiyle eşleşmiyor, ülke sıralaması
 * bölünüyor, öncelik sıralaması yanlış çalışıyor. Hata üretilmiyor — sadece
 * yanlış gruplama.
 *
 * KURAL: Her ülkenin TEK kanonik adı vardır. Kaynak hangi dilde gönderirse
 * göndersin `normalizeCountry()` onu kanonik ada çevirir.
 */

/**
 * Kanonik ad → { flag, iso2, aliases }
 *
 * `aliases` yalnızca kanonik addan FARKLI yazımları içerir (Türkçe adlar,
 * İngilizce varyantlar). Kanonik adın kendisi otomatik eklenir.
 */
const ULKELER = {
  // — Avrupa —
  "Türkiye":        { flag: "🇹🇷", iso2: "TR", aliases: ["Turkey", "Turkiye"] },
  "England":        { flag: "🏴󠁧󠁢󠁥󠁮󠁧󠁿", iso2: "GB", aliases: ["İngiltere", "Ingiltere", "Great Britain", "United Kingdom"] },
  "Scotland":       { flag: "🏴󠁧󠁢󠁳󠁣󠁴󠁿", iso2: "",   aliases: ["İskoçya", "Iskocya"] },
  "Northern Ireland":{ flag: "🇬🇧", iso2: "",  aliases: ["Kuzey İrlanda", "Kuzey Irlanda"] },
  "Ireland":        { flag: "🇮🇪", iso2: "IE", aliases: ["İrlanda", "Irlanda", "Republic of Ireland", "İrlanda Cumhuriyeti", "Irlanda Cumhuriyeti"] },
  "Spain":          { flag: "🇪🇸", iso2: "ES", aliases: ["İspanya", "Ispanya"] },
  "Germany":        { flag: "🇩🇪", iso2: "DE", aliases: ["Almanya"] },
  "Italy":          { flag: "🇮🇹", iso2: "IT", aliases: ["İtalya", "Italya"] },
  "France":         { flag: "🇫🇷", iso2: "FR", aliases: ["Fransa"] },
  "Netherlands":    { flag: "🇳🇱", iso2: "NL", aliases: ["Hollanda", "Holland"] },
  "Belgium":        { flag: "🇧🇪", iso2: "BE", aliases: ["Belçika", "Belcika"] },
  "Portugal":       { flag: "🇵🇹", iso2: "PT", aliases: ["Portekiz"] },
  "Greece":         { flag: "🇬🇷", iso2: "GR", aliases: ["Yunanistan"] },
  "Austria":        { flag: "🇦🇹", iso2: "AT", aliases: ["Avusturya"] },
  "Switzerland":    { flag: "🇨🇭", iso2: "CH", aliases: ["İsviçre", "Isvicre"] },
  "Poland":         { flag: "🇵🇱", iso2: "PL", aliases: ["Polonya"] },
  "Czech Republic": { flag: "🇨🇿", iso2: "CZ", aliases: ["Çekya", "Cekya", "Czechia"] },
  "Slovakia":       { flag: "🇸🇰", iso2: "SK", aliases: ["Slovakya"] },
  "Hungary":        { flag: "🇭🇺", iso2: "HU", aliases: ["Macaristan"] },
  "Romania":        { flag: "🇷🇴", iso2: "RO", aliases: ["Romanya"] },
  "Bulgaria":       { flag: "🇧🇬", iso2: "BG", aliases: ["Bulgaristan"] },
  "Croatia":        { flag: "🇭🇷", iso2: "HR", aliases: ["Hırvatistan", "Hirvatistan"] },
  "Serbia":         { flag: "🇷🇸", iso2: "RS", aliases: ["Sırbistan", "Sirbistan"] },
  "Russia":         { flag: "🇷🇺", iso2: "RU", aliases: ["Rusya"] },
  "Ukraine":        { flag: "🇺🇦", iso2: "UA", aliases: ["Ukrayna"] },
  "Denmark":        { flag: "🇩🇰", iso2: "DK", aliases: ["Danimarka"] },
  "Sweden":         { flag: "🇸🇪", iso2: "SE", aliases: ["İsveç", "Isvec"] },
  "Norway":         { flag: "🇳🇴", iso2: "NO", aliases: ["Norveç", "Norvec"] },
  "Finland":        { flag: "🇫🇮", iso2: "FI", aliases: ["Finlandiya"] },
  "Iceland":        { flag: "🇮🇸", iso2: "IS", aliases: ["İzlanda", "Izlanda"] },
  "Estonia":        { flag: "🇪🇪", iso2: "EE", aliases: ["Estonya"] },
  "Latvia":         { flag: "🇱🇻", iso2: "LV", aliases: ["Letonya"] },
  "Lithuania":      { flag: "🇱🇹", iso2: "LT", aliases: ["Litvanya"] },
  "Faroe Islands":  { flag: "🇫🇴", iso2: "",   aliases: ["Faroe Adaları", "Faroe Adalari"] },
  "Slovenia":       { flag: "🇸🇮", iso2: "SI", aliases: ["Slovenya"] },
  "Albania":        { flag: "🇦🇱", iso2: "AL", aliases: ["Arnavutluk"] },
  "Cyprus":         { flag: "🇨🇾", iso2: "CY", aliases: ["Kıbrıs", "Kibris"] },
  "Kosovo":         { flag: "🇽🇰", iso2: "",   aliases: ["Kosova"] },
  "Malta":          { flag: "🇲🇹", iso2: "MT", aliases: [] },

  // — Amerika —
  "Brazil":         { flag: "🇧🇷", iso2: "BR", aliases: ["Brezilya"] },
  "Argentina":      { flag: "🇦🇷", iso2: "AR", aliases: ["Arjantin"] },
  "USA":            { flag: "🇺🇸", iso2: "US", aliases: ["ABD", "United States", "United States of America", "America"] },
  "Canada":         { flag: "🇨🇦", iso2: "CA", aliases: ["Kanada"] },
  "Mexico":         { flag: "🇲🇽", iso2: "MX", aliases: ["Meksika"] },
  "Chile":          { flag: "🇨🇱", iso2: "CL", aliases: ["Şili", "Sili"] },
  "Colombia":       { flag: "🇨🇴", iso2: "CO", aliases: ["Kolombiya"] },
  "Ecuador":        { flag: "🇪🇨", iso2: "EC", aliases: ["Ekvador"] },
  "Peru":           { flag: "🇵🇪", iso2: "PE", aliases: ["Peru"] },
  "Uruguay":        { flag: "🇺🇾", iso2: "UY", aliases: ["Uruguay"] },
  "Paraguay":       { flag: "🇵🇾", iso2: "PY", aliases: [] },
  "Bolivia":        { flag: "🇧🇴", iso2: "BO", aliases: ["Bolivya"] },
  "Venezuela":      { flag: "🇻🇪", iso2: "VE", aliases: [] },
  "El Salvador":    { flag: "🇸🇻", iso2: "SV", aliases: [] },
  "Costa Rica":     { flag: "🇨🇷", iso2: "CR", aliases: ["Kosta Rika"] },
  "Panama":         { flag: "🇵🇦", iso2: "PA", aliases: [] },
  "Nicaragua":      { flag: "🇳🇮", iso2: "NI", aliases: ["Nikaragua"] },
  "Honduras":       { flag: "🇭🇳", iso2: "HN", aliases: [] },
  "Guatemala":      { flag: "🇬🇹", iso2: "GT", aliases: [] },

  // — Asya / Okyanusya / Afrika —
  "Japan":          { flag: "🇯🇵", iso2: "JP", aliases: ["Japonya"] },
  "South Korea":    { flag: "🇰🇷", iso2: "KR", aliases: ["Güney Kore", "Guney Kore", "Korea Republic"] },
  "China":          { flag: "🇨🇳", iso2: "CN", aliases: ["Çin", "Cin"] },
  "Saudi Arabia":   { flag: "🇸🇦", iso2: "SA", aliases: ["Suudi Arabistan"] },
  "Israel":         { flag: "🇮🇱", iso2: "IL", aliases: ["İsrail", "Israil"] },
  "Kuwait":         { flag: "🇰🇼", iso2: "KW", aliases: ["Kuveyt"] },
  "Lebanon":        { flag: "🇱🇧", iso2: "LB", aliases: ["Lübnan", "Lubnan"] },
  "Kazakhstan":     { flag: "🇰🇿", iso2: "KZ", aliases: ["Kazakistan"] },
  "Uzbekistan":     { flag: "🇺🇿", iso2: "UZ", aliases: ["Özbekistan", "Ozbekistan"] },
  "Indonesia":      { flag: "🇮🇩", iso2: "ID", aliases: ["Endonezya"] },
  "Vietnam":        { flag: "🇻🇳", iso2: "VN", aliases: [] },
  "Australia":      { flag: "🇦🇺", iso2: "AU", aliases: ["Avustralya"] },
  "New Zealand":    { flag: "🇳🇿", iso2: "NZ", aliases: ["Yeni Zelanda"] },
  "Egypt":          { flag: "🇪🇬", iso2: "EG", aliases: ["Mısır", "Misir"] },
  "Morocco":        { flag: "🇲🇦", iso2: "MA", aliases: ["Fas"] },
  "Mozambique":     { flag: "🇲🇿", iso2: "MZ", aliases: ["Mozambik"] },
  "Qatar":          { flag: "🇶🇦", iso2: "QA", aliases: ["Katar"] },
  "UAE":            { flag: "🇦🇪", iso2: "AE", aliases: ["Birleşik Arap Emirlikleri", "United Arab Emirates"] },
  "India":          { flag: "🇮🇳", iso2: "IN", aliases: ["Hindistan"] },

  /* ⚠️ GERÇEK FİKSTÜR VERİSİNDE GÖRÜLÜP TABLODA OLMAYANLAR.
   *
   * ÖLÇÜLDÜ (data/fixtures.json, 75 tekil ülke adı): 15'i tanınmıyordu ve
   * bunların çoğu TÜRKÇE/İNGİLİZCE ÇİFTLERDİ — yani aynı ülke iki AYRI ülke
   * sayılıyordu:
   *     "Beyaz Rusya" (9 maç) ile "Belarus" (6 maç)
   *     "Galler" (4) ile "Wales" (6)
   *     "Güney Afrika" (1) ile "South Africa" (5)
   *     "Ermenistan" (1) ile "Armenia" (3)
   * Tanınmayan ad `normalizeCountry`'den KIRPILMIŞ HÂLİYLE geri döner
   * (eleme yapmıyoruz kararı), yani iki yazım hiç birleşmiyor: kullanıcı
   * birini seçtiğinde ötekinin maçları "kendi ülkem" grubuna girmiyor.
   *
   * ⚠️ SADECE VERİDE GÖRÜLENLER EKLENDİ. Dünyanın tüm ülkelerini eklemek
   * `selectableCountries()` listesini oyunda karşılığı olmayan seçeneklerle
   * şişirirdi. */
  "Belarus":        { flag: "🇧🇾", iso2: "BY", aliases: ["Beyaz Rusya"] },
  "Wales":          { flag: "🏴󠁧󠁢󠁷󠁬󠁳󠁿", iso2: "", aliases: ["Galler"] },
  "South Africa":   { flag: "🇿🇦", iso2: "ZA", aliases: ["Güney Afrika", "Guney Afrika"] },
  "Armenia":        { flag: "🇦🇲", iso2: "AM", aliases: ["Ermenistan"] },
  "Zimbabwe":       { flag: "🇿🇼", iso2: "ZW", aliases: ["Zimbabve"] },
  "Luxembourg":     { flag: "🇱🇺", iso2: "LU", aliases: ["Lüksemburg", "Luksemburg"] },
  "Kyrgyzstan":     { flag: "🇰🇬", iso2: "KG", aliases: ["Kırgızistan", "Kirgizistan"] },
  "Uganda":         { flag: "🇺🇬", iso2: "UG", aliases: [] },
  "Moldova":        { flag: "🇲🇩", iso2: "MD", aliases: ["Moldovya"] },
  "Montenegro":     { flag: "🇲🇪", iso2: "ME", aliases: ["Karadağ", "Karadag"] },
  /* ⚠️ "Gürcistan" testi yazdıktan SONRA veriye girdi (fikstür dosyası canlı;
   * tekil ülke sayısı 75'ten 79'a çıktı) ve `tests/ulke-tablosu-kapsami`
   * onu hemen yakaladı. Testin kırılması burada doğru davranış: yeni ad
   * tabloya eklenir. */
  "Georgia":        { flag: "🇬🇪", iso2: "GE", aliases: ["Gürcistan", "Gurcistan"] },
};

/**
 * Kıta/dünya kovaları — ülke DEĞİL, turnuva grubudur.
 * Sağlayıcılar kıtasal turnuvaları böyle etiketliyor; hepsi "World" kovasına
 * girer ki küresel lig önceliğiyle tutarlı olsun (bkz. fixture-priority).
 */
const KITA_KOVALARI = {
  "World": ["Dünya", "Dunya", "International", "Intl"],
  "Europe": ["Avrupa", "UEFA"],
};

// Kıtalar da "World" kovasına düşer — ayrı sıralama havuzu değiller.
const KITA_TAKMA_ADLARI = [
  "Güney Amerika", "Guney Amerika", "South America", "CONMEBOL",
  "Kuzey / Orta Amerika", "Kuzey Amerika", "North America", "CONCACAF",
  "Afrika", "Africa", "CAF",
  "Asya", "Asia", "AFC",
  "Okyanusya", "Oceania", "OFC",
];

// ── Arama tablosu ───────────────────────────────────────────────────────────

/** Karşılaştırma için: Türkçe küçük harf + aksan sadeleştirme. */
const ASCIILESTIR = { ç: "c", ğ: "g", ı: "i", ö: "o", ş: "s", ü: "u", â: "a", î: "i", û: "u" };
function anahtarla(s) {
  return String(s || "")
    .trim()
    .toLocaleLowerCase("tr")
    .replace(/[çğıöşüâîû]/g, (h) => ASCIILESTIR[h] || h)
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const _tablo = new Map();
function ekle(anahtar, kanonik) {
  const k = anahtarla(anahtar);
  if (k && !_tablo.has(k)) _tablo.set(k, kanonik);
}

for (const [kanonik, bilgi] of Object.entries(ULKELER)) {
  ekle(kanonik, kanonik);
  for (const a of bilgi.aliases || []) ekle(a, kanonik);
  if (bilgi.iso2) ekle(bilgi.iso2, kanonik);
}
for (const [kova, adlar] of Object.entries(KITA_KOVALARI)) {
  ekle(kova, kova);
  for (const a of adlar) ekle(a, kova);
}
for (const a of KITA_TAKMA_ADLARI) ekle(a, "World");

// ── Genel API ───────────────────────────────────────────────────────────────

/**
 * Herhangi bir yazımı kanonik ülke adına çevirir.
 * Tanınmayan ad `null` DEĞİL, kırpılmış hâliyle döner — eleme yapmıyoruz
 * (bkz. lib/fixture-priority.cjs); yalnızca bilinenleri birleştiriyoruz.
 */
function normalizeCountry(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  return _tablo.get(anahtarla(s)) || s;
}

/** Bu ad tanınıyor mu (kanonik listede karşılığı var mı)? */
function isKnownCountry(raw) {
  const s = String(raw || "").trim();
  if (!s) return false;
  return _tablo.has(anahtarla(s));
}

/** Kanonik ad → bayrak emojisi (yoksa boş). */
function flagOf(kanonik) {
  const c = normalizeCountry(kanonik);
  if (c === "World") return "🌍";
  if (c === "Europe") return "🇪🇺";
  return ULKELER[c]?.flag || "";
}

/**
 * Kullanıcının SEÇEBİLECEĞİ ülkeler (sıralama havuzu).
 * Kıta/dünya kovaları burada YOK — onlar turnuva grubu, kullanıcı ülkesi değil.
 */
function selectableCountries() {
  return Object.keys(ULKELER).sort((a, b) => a.localeCompare(b, "tr"));
}

module.exports = {
  ULKELER,
  normalizeCountry,
  isKnownCountry,
  flagOf,
  selectableCountries,
};
