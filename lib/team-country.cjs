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

/**
 * Türkçe duyarlı, aksansız karşılaştırma anahtarı.
 *
 * ⚠️ YALNIZCA TÜRKÇE AKSANLAR ÇEVRİLİYORDU. Elle yazılmış `ASCIILESTIR`
 * listesi dokuz harf tanıyordu; geri kalan her aksanlı harf
 * `[^a-z0-9] → " "` kuralına takılıp SİLİNİYOR ve sözcüğü ikiye bölüyordu:
 *
 *     "NK Šibenik"      → "ibenik"           (Š silindi)
 *     "Widzew Łódź"     → "widzew d"         (Ł, ó, ź silindi)
 *     "Standard Liège"  → "standard li ge"   (è silindi, sözcük bölündü)
 *     "MŠK Žilina"      → "ilina"
 *
 * ÖLÇÜLDÜ: `data/countries-teams.json` içindeki 65 girdi bu şekilde bozuk
 * anahtar üretiyordu — yani o takımların ülkesi hiç bulunamıyordu.
 *
 * NFD normalleştirmesi `lib/countries.cjs` ve `lib/global-leagues.cjs`
 * içinde ZATEN vardı; aynı yaklaşım buraya taşındı. NFD'nin ayıramadığı
 * çizgili/çengelli harfler (ł, đ, ø, ß …) elle eşleniyor — onların ayrı bir
 * birleşik işareti yok.
 */
const OZEL_HARF = {
  ı: "i", ł: "l", đ: "d", ð: "d", ø: "o", œ: "oe", æ: "ae", ß: "ss", þ: "th",
};
function anahtarla(s) {
  return String(s || "")
    .trim()
    .toLocaleLowerCase("tr")
    .replace(/[ıłđðøœæßþ]/g, (h) => OZEL_HARF[h] || h)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")   // aksan işaretleri
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
let _tamIndeks = null;

/**
 * İKİ İNDEKS KURULUYOR — ve ikincisinin sebebi somut.
 *
 * ⚠️ EK ATMA İKİ FARKLI KULÜBÜ AYNI ÇEKİRDEĞE İNDİREBİLİYOR:
 *     "EC Vitória"  (Brezilya, Salvador)  → "ec" atılır → "vitoria"
 *     "Vitória SC"  (Portekiz, Guimarães) → "sc" atılır → "vitoria"
 * Gerçek fikstür verisinde İKİSİ DE var (5 ve 3 maç). Tek çekirdek indeksinde
 * hangisi önce eklendiyse o kazanıyordu — dosya sırası ülke belirliyordu.
 * Brezilya'yı listeye eklemek tek başına çözmüyor: Portekiz dosyada önce
 * geldiği için Brezilya girdisi sessizce yok sayılıyordu.
 *
 * ÇÖZÜM: ek ATILMADAN önceki TAM ad da indeksleniyor ve önce ona bakılıyor.
 *     "ec vitoria"  → Brazil
 *     "vitoria sc"  → Portugal
 * Çekirdek indeksi gevşek eşleşme için duruyor ama ARTIK BELİRSİZ ÇEKİRDEKLER
 * ATILIYOR: bir çekirdek birden çok ülkeye denk geliyorsa hiçbirine sayılmaz
 * (aynı kural `services/odds-engine.cjs getRating` içinde de var).
 */
function indeks() {
  if (_indeks) return { cekirdekIx: _indeks, tamIx: _tamIndeks };
  const cekirdekIx = new Map();
  const tamIx = new Map();
  const cakisan = new Set();

  let ham = null;
  try {
    ham = require(path.join(DATA_DIR, "countries-teams.json"));
  } catch (e) {
    console.warn("[team-country] countries-teams.json okunamadi:", e?.message || e);
    _indeks = cekirdekIx; _tamIndeks = tamIx;
    return { cekirdekIx, tamIx };
  }

  const liste = Array.isArray(ham?.countries)
    ? ham.countries
    : Object.values(ham?.countries || {});

  for (const u of liste) {
    const ulke = normalizeCountry(u?.name || u?.localName || u?.code);
    if (!ulke) continue;
    for (const t of u?.teams || []) {
      // Tam ad (ek atılmamış) — ayırt edici katman.
      const tam = anahtarla(t);
      if (tam.length >= 4 && !tamIx.has(tam)) tamIx.set(tam, ulke);

      const k = cekirdek(t);
      // Çok kısa çekirdek yanlış eşleşme üretir ("as", "cd" gibi).
      if (k.length < 4) continue;
      if (cekirdekIx.has(k)) {
        // Aynı çekirdek FARKLI ülkeye aitse tahmin edilemez.
        if (cekirdekIx.get(k) !== ulke) cakisan.add(k);
      } else {
        cekirdekIx.set(k, ulke);
      }
    }
  }
  for (const k of cakisan) cekirdekIx.delete(k);

  _indeks = cekirdekIx;
  _tamIndeks = tamIx;
  return { cekirdekIx, tamIx };
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
  const { cekirdekIx, tamIx } = indeks();

  /* ⚠️ ÖNCE TAM AD: ek atma iki farklı kulübü aynı çekirdeğe indirebiliyor
   * ("EC Vitória" ve "Vitória SC" → ikisi de "vitoria"). Ek atılmamış ad
   * ikisini ayırıyor. bkz. indeks() */
  const tamAd = anahtarla(takimAdi);
  if (tamAd.length >= 4 && tamIx.has(tamAd)) return tamIx.get(tamAd);

  const k = cekirdek(takimAdi);
  if (!k || k.length < 4) return null;

  const ix = cekirdekIx;
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

/* ⚠️ `anahtarla`/`cekirdek` DIŞA AÇIK ÇÜNKÜ `lib/takim-katalog.cjs` aynı
 * normalleştirmeyi kullanmak zorunda. İkinci bir kopya yazmak bu oturumda
 * defalarca görülen kusur şeklini doğururdu: aynı savunmanın iki kopyası,
 * biri güncellenir öbürü unutulur (ör. ek listesi odds-engine ile burada
 * ayrı ayrı durup birbirinden sapmıştı). Tek kaynak burası. */
module.exports = {
  teamCountry, fixtureHasCountryTeam,
  _cekirdek: cekirdek, _anahtarla: anahtarla,
};
