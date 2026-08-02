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
const { fixtureHasCountryTeam } = require("./team-country.cjs");
const { normalizeCountry } = require("./countries.cjs");

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

  /* ⚠️ BİR TAKIM KENDİSİYLE OYNAYAMAZ.
   *
   * BULUNDU (kullanıcı deneyimi turu, 2026-08-03): tahmine açık listede
   * `Qingdao - Qingdao` maçı vardı ve kullanıcıya 4. sırada gösteriliyordu.
   * Kaynak (Maçkolik) iki farklı Qingdao kulübünün adını aynı dizeye
   * indirmiş.
   *
   * ÜÇ AYRI ZARARI VAR:
   *   1) Kullanıcı anlamsız bir maç görüyor ve tahmin girebiliyor.
   *   2) ASLA UZLAŞAMAZ: `findLiveMatch` ev/deplasman adlarının ikisini de
   *      eşlemek zorunda; hiçbir canlı kayıt "Qingdao vs Qingdao" olmayacağı
   *      için sonuç hiç gelmez. Para (varsa) 48 saat `bayat-mac` iadesine
   *      kalır.
   *   3) Skor bir şekilde yazılsa bile "hangi Qingdao kazandı" sorusunun
   *      cevabı yok — tahmin puanlanamaz.
   *
   * ÖLÇÜLDÜ: 1907 fikstürün 1'i bu durumda; 40 tahmin almış, hepsi BOT
   * (insan tahmini 0), düello ve sonuç kaydı yok. Yani şu an para riski yok
   * ama bot kotası ve ekran yeri harcanıyordu.
   *
   * Karşılaştırma normalize EDİLMEDEN, yalnızca kırpılmış/harf duyarsız
   * yapılıyor: normalize etmek "Manchester United" ile "Manchester City"yi
   * birleştirmez ama ek atma kuralları değişirse meşru bir maçı eleme riski
   * doğar. Burada aranan şey kaynağın ürettiği BİREBİR aynı ad. */
  const h = String(it.home).trim().toLocaleLowerCase("tr");
  const a = String(it.away).trim().toLocaleLowerCase("tr");
  if (h && h === a) return false;

  if (isExcludedLeague(it.league)) return false;
  return true;
}

const norm = (s) => String(s || "").trim().toLocaleLowerCase("tr");

/**
 * Ülke adlarını gevşek karşılaştır ("Almanya" ↔ "Germany").
 *
 * ⚠️ ELLE YAZILMIŞ TEK İSTİSNA VARDI. Eski sürüm yalnızca Türkiye'yi özel
 * olarak eşliyordu; oysa `lib/countries.cjs` zaten takma ad + ISO2 tablosu
 * tutuyor ve `normalizeCountry` ile kanonik ada çeviriyor.
 *
 * ÖLÇÜLDÜ (tablodaki 103 takma ad, her biri kendi kanonik adına karşı):
 *     önce : 99'u EŞLEŞMİYOR   (yalnızca Türkiye'nin 4 yazımı geçiyordu)
 *     sonra: 0 eşleşmeyen
 * "Almanya" ↔ "Germany", "İspanya" ↔ "Spain", "İngiltere" ↔ "England" hepsi
 * başarısızdı.
 *
 * ⚠️ ETKİSİNİ ABARTMIYORUM: gerçek `data/fixtures.json` verisinde 77 ülkenin
 * 62'si zaten eşleşiyordu (0 başarısız), çünkü hem fikstür hem kullanıcı
 * ülkesi kanonik yazımda tutuluyor. Kusur, kanonik OLMAYAN bir ad geldiğinde
 * ısırıyor — eski kayıtlar, elle girilen fikstür, ya da Türkçe ad yazan bir
 * istemci. Bu oturumun kayıtlarına göre tam o durum bir kez yaşandı: 837
 * kullanıcı Türkçe ad reddi yüzünden ülkesiz kalmıştı.
 *
 * Ülke burada ELEME değil SIRALAMA ölçütü (bkz. dosya başlığı), yani sonuç
 * "maç kaybolur" değil "kendi ülkesinin maçı üste çıkmaz".
 */
function sameCountry(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const ka = normalizeCountry(a), kb = normalizeCountry(b);
  return !!ka && !!kb && norm(ka) === norm(kb);
}

/**
 * Maçın öncelik sınıfı.
 * @param {object} it        fikstür
 * @param {string} userCountry kullanıcının ülkesi (yoksa ülke sınıfı devre dışı)
 */
function priorityOf(it, userCountry) {
  // ÜLKE EŞLEŞMESİ İKİ YOLDAN: turnuvanın ülkesi VEYA takımın ülkesi.
  //
  // Kullanıcıyı ilgilendiren şey turnuvanın etiketi değil, sahadaki takımdır.
  // Ölçüldü (2026-07-29): Fenerbahçe'nin Şampiyonlar Ligi maçı "Avrupa"
  // etiketliydi, Alanyaspor/Konyaspor/Samsunspor maçları "Dünya" — hiçbiri
  // Türk kullanıcının "kendi ülkesi" grubuna girmiyordu.
  //
  // ⚠️ BU KONTROL HAZIRLIK KONTROLÜNDEN ÖNCE: kendi takımının hazırlık maçı
  // dibe düşmemeli. Sezon arasında Türk kullanıcının ilgisini çeken TEK şey
  // Türk takımlarının hazırlık ve Avrupa maçlarıdır; onları "hazırlık" diye
  // en sona atmak ekranı yine boş gösterirdi. Hazırlık indirgemesi YABANCI
  // takımların hazırlık maçları için geçerli — asıl sorun onların listeyi
  // kaplamasıydı (ölçüldü: ilk 12 maçın 7'si).
  if (userCountry) {
    if (sameCountry(it?.country, userCountry)) return P_COUNTRY;
    if (fixtureHasCountryTeam(it, userCountry)) return P_COUNTRY;
  }

  // Yabancı hazırlık maçı en sonda.
  if (isFriendlyLeague(it?.league)) return P_FRIENDLY;

  if (isGlobalLeagueName(it?.league)) return P_GLOBAL;
  if (BIG_LEAGUES.some((rx) => rx.test(String(it?.league || "")))) return P_BIG;
  return P_OTHER;
}

/**
 * Öncelik sınıfının makine-okunur etiketi.
 *
 * Arayüz bunu grup başlığı olarak kullanıyor. Etiketi SUNUCU üretiyor çünkü
 * istemcide yeniden hesaplamak iki ayrı tanım demek — bu projede tam olarak
 * o tuzak defalarca yaşandı (GLOBAL_LEAGUES iki dosyada ayrışmıştı).
 */
const GROUP_LABELS = {
  [P_COUNTRY]: "country",
  [P_GLOBAL]: "global",
  [P_BIG]: "big",
  [P_OTHER]: "other",
  [P_FRIENDLY]: "friendly",
};

function priorityGroupOf(it, userCountry) {
  return GROUP_LABELS[priorityOf(it, userCountry)] || "other";
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
  priorityGroupOf,
  GROUP_LABELS,
  sortByPriority,
  sameCountry,
  BIG_LEAGUES,
  P_COUNTRY, P_GLOBAL, P_BIG, P_OTHER, P_FRIENDLY,
};
