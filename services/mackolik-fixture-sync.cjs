"use strict";

/**
 * CACHE FİKSTÜR SENKRONU — livescore-cache.json → fixtures.json
 *
 * NEDEN VAR: FDO 8 ülke veriyor (Brezilya, İngiltere, İspanya, İtalya,
 * Almanya, Fransa, Hollanda, Portekiz). Ülke sıralaması ise Japonya, Meksika,
 * S.Arabistan, ABD, Rusya, Polonya, Yunanistan için de kuruldu — bu ülkelerin
 * botu ve listesi var ama tahmin edecekleri maç yoktu. TÜRKİYE de FDO kapsamı
 * dışında; Türk kullanıcıya maç gösteren tek yol burası.
 *
 * KAYNAK-BAĞIMSIZ: Adı tarihsel ("mackolik"), ama bu dosya cache'i KİMİN
 * ürettiğine bakmaz — livescore-scraper'ın şelalesi hangi kaynakta başarılı
 * olursa onun çıktısını okur. Maçkolik Render'da Puppeteer zaman aşımına
 * uğradığından sıra pratikte nesine'ye düşüyor; nesine'nin çıktısı
 * enrichNesine() ile aynı şekle (Türkçe ülke adı + "YYYY-MM-DD HH:MM")
 * tamamlandığı için buradaki kod değişmeden çalışır.
 *
 * source ETİKETİ "MK" KALIYOR: merge() bu etikete sahip kayıtları "sahiplenir"
 * ve tazelenmeyenleri temizler. Etiketi kaynağa göre değiştirmek, eski MK
 * kayıtlarını sahipsiz bırakıp dosyada sonsuza kadar bırakırdı.
 *
 * PENCERE: Sadece bugün + yarın. 30 gün ilerisi için FDO. İki kaynak
 * birbirini kesmez: farklı `source` etiketi ile aynı dosyada yaşarlar
 * (bkz. fixture-sync.merge — ownedSource parametresi).
 *
 * NEDEN DOĞRUDAN SCRAPER'DAN DEĞİL: Scraper zaten çalışıyor ve cache üretiyor.
 * İki kere Puppeteer başlatmak (biri livescore, biri fikstür) hem yavaş hem
 * gereksiz. Cache dosyasını okumak salt-dosya bir işlem: hızlı, sağlam.
 */

const path = require("path");
const fsp = require("fs").promises;

const { withFileLock } = require("../lib/fileLock.cjs");
const { readFixtures, writeFixtures, merge } = require("./fixture-sync.cjs");

// Testlerde izole dizine yönlendirilebilir (bkz. fixture-sync, livescore-scraper).
const DATA_DIR = process.env.SKORLIG_DATA_DIR || path.join(__dirname, "..", "data");
const CACHE_FILE = path.join(DATA_DIR, "livescore-cache.json");
const FIXTURES_FILE = path.join(DATA_DIR, "fixtures.json");
const SOURCE = "MK";

/**
 * Maçkolik ülke adı → routes/live2.cjs ALLOWED anahtarı.
 *
 * Neden burada, canonicalCountry'de değil: canonicalCountry Türkçe ülke
 * isimlerini çevirmiyor (test edildi — 53 isimden sadece "Türkiye"
 * eşleşiyor). O fonksiyon zaten iki-harf ISO ve İngilizce isim kabul ediyor;
 * Türkçe bir katmanı oraya sokmak istemedim, kapsamı burada tutuyorum.
 *
 * Listede olmayan ülke sessizce ATLANIR — ALLOWED dışı bir ülke adı yazmak
 * ülke sıralamasını ve lig filtresini bozardı (kimse bu maçları göremezdi).
 * Eğer bir gün Estonya sıralaması eklenirse, ALLOWED'a eklendikten sonra
 * buraya da bir satır girer.
 */
const TR_TO_COUNTRY = {
  "Türkiye": "Türkiye",
  "Dünya": "World",
  "Avrupa": "Europe",
  "İngiltere": "England",
  "İspanya": "Spain",
  "Almanya": "Germany",
  "İtalya": "Italy",
  "Fransa": "France",
  "Hollanda": "Netherlands",
  "Portekiz": "Portugal",
  "Brezilya": "Brazil",
  "Arjantin": "Argentina",
  "Meksika": "Mexico",
  "Japonya": "Japan",
  "Güney Kore": "South Korea", // ALLOWED'da yok; countryOfSegment'te de yok — sessiz atlanır (aşağıda süz)
  "Çin": "China",              // aynı
  "ABD": "USA",
  "Suudi Arabistan": "Saudi Arabia",
  "Yunanistan": "Greece",
  "Rusya": "Russia",
  "Ukrayna": "Ukraine",
  "Polonya": "Poland",
  "Avusturya": "Austria",
  "İsviçre": "Switzerland",
  "Belçika": "Belgium",
  "Çekya": "Czech Republic",
  "Sırbistan": "Serbia",
  "Hırvatistan": "Croatia",
  "Slovakya": "Slovakia",
  "Bulgaristan": "Bulgaria",
  "Romanya": "Romania",
  "Macaristan": "Hungary",
};

// ALLOWED anahtarları — TR_TO_COUNTRY'de olsalar bile ALLOWED'da yoksa atlanır.
// Küçük sabit liste, koda gömmek çevrimsel bağımlılıktan güvenli.
const ALLOWED_COUNTRIES = new Set([
  "Türkiye", "England", "Spain", "Germany", "Italy", "France", "Netherlands",
  "Belgium", "Greece", "Portugal", "Brazil", "Argentina", "Japan", "Russia",
  "Ukraine", "USA", "Saudi Arabia", "Austria", "Switzerland", "Poland",
  "Mexico", "Croatia", "Serbia", "Czech Republic", "Romania", "Hungary",
  "Slovakia", "Bulgaria", "World", "Europe",
]);

/**
 * İngilizce ülke adı → kanonik ad. Yalnızca İngilizcesi kanoniğinden FARKLI
 * olanlar; "Brazil" gibi zaten eşit olanlar ALLOWED_COUNTRIES'te yakalanır.
 *
 * NEDEN GEREKLİ: Şelalenin hangi kaynakta durduğu ülke adının DİLİNİ belirliyor.
 * Maçkolik/nesine Türkçe ("Brezilya"), goal/espn İngilizce ("Brazil") üretiyor.
 * Yalnızca Türkçe tablosuna bakmak, goal kazandığında bütün maçların sessizce
 * elenmesi demekti — kaynak sağlıklı görünürken fikstür sıfır kalıyordu.
 */
const EN_TO_COUNTRY = {
  "Turkey": "Türkiye",
  "Turkiye": "Türkiye",
  "International": "World",
  "United States": "USA",
  "Czechia": "Czech Republic",
  "Korea Republic": "South Korea", // ALLOWED'da yok → yine atlanır, kasıtlı
};

const r2 = (s) => String(s || "").trim();

/**
 * Ham ülke adını (Türkçe ya da İngilizce) kanonik ada çevirir.
 * ALLOWED dışındaysa null — o maç atlanır. ALLOWED dışı bir ad yazmak ülke
 * sıralamasını ve lig filtresini bozar, kimse o maçları göremezdi.
 */
function resolveCountry(raw) {
  const s = r2(raw);
  if (!s) return null;

  const tr = TR_TO_COUNTRY[s];
  if (tr) return ALLOWED_COUNTRIES.has(tr) ? tr : null;

  const en = EN_TO_COUNTRY[s] || s;
  return ALLOWED_COUNTRIES.has(en) ? en : null;
}

/**
 * "2026-07-27 21:00" (Maçkolik yerel = Europe/Istanbul, UTC+3) → ISO 8601.
 * Zaman dilimini +03:00 olarak sabitliyoruz — tarayıcının bölgesinden
 * bağımsız olsun. Yanlış saat dilimi 3 saatlik kaymayla maçların "başlamış"
 * görünmesine yol açar (kilitlenir, tahmin girilemez).
 */
function toIso(md) {
  if (!md || md.length < 10) return null;
  const [d, t] = md.split(" ");
  if (!d) return null;
  const time = t && /^\d{1,2}:\d{2}/.test(t) ? t : "00:00";
  const hhmm = time.slice(0, 5).padStart(5, "0");
  return `${d}T${hhmm}:00+03:00`;
}

/**
 * Maçkolik takım adı → istikrarlı, ASCII-safe fixture kimliği parçası.
 * (routes/admin-runtime.cjs → slugPart ile aynı kural, kopyalamak istemedim.)
 */
function slugPart(s) {
  return String(s || "")
    .toLocaleUpperCase("tr-TR")
    .replace(/[İIı]/g, "I").replace(/Ş/g, "S").replace(/Ğ/g, "G")
    .replace(/Ü/g, "U").replace(/Ö/g, "O").replace(/Ç/g, "C")
    .replace(/[^A-Z0-9]+/g, "")
    .slice(0, 6);
}

/**
 * Cache'deki tek bir maç → fixtures.json kaydı. Atlanma sebepleri:
 *   - ülke ALLOWED değil (Kore, Çin, İzlanda, Estonya, Kazakistan…)
 *   - maç bitmiş (isFinished) — bunlar zaten geçmiş, tahmin girilemez
 *   - takım/tarih eksik
 *   - kickoff geçmişte (yayınlanma gecikmesi + timezone tuzağı için toleransla)
 */
/**
 * Eleme sebebini de döndüren sürüm.
 *
 * NEDEN: `normalize()` null döndüğünde sebep kayboluyordu ve syncOnce hepsini
 * "NO_MATCHING_COUNTRIES" diye raporluyordu — oysa maç ülke yüzünden değil,
 * BİTMİŞ olduğu ya da tarihi geçtiği için de elenebiliyor. Üretimde 49 maçın
 * tamamı elendi ve etiket bizi günlerce yanlış yere baktırdı.
 */
function normalizeWithReason(m) {
  const country = resolveCountry(m?.country);
  if (!country) return { fixture: null, reason: "ulke:" + (r2(m?.country) || "(bos)") };

  const home = r2(m?.homeTeam);
  const away = r2(m?.awayTeam);
  if (!home || !away) return { fixture: null, reason: "takim_eksik" };
  if (m?.isFinished) return { fixture: null, reason: "bitmis" };

  const kickoffISO = toIso(r2(m?.matchDate));
  if (!kickoffISO) return { fixture: null, reason: "tarih_yok:" + (r2(m?.matchDate) || "(bos)") };
  const ko = Date.parse(kickoffISO);
  if (!Number.isFinite(ko)) return { fixture: null, reason: "tarih_bozuk:" + kickoffISO };
  if (ko < Date.now() - 30 * 60 * 1000) return { fixture: null, reason: "gecmis" };

  return { fixture: normalize(m), reason: null };
}

function normalize(m) {
  const country = resolveCountry(m?.country);
  if (!country) return null;

  const home = r2(m?.homeTeam);
  const away = r2(m?.awayTeam);
  if (!home || !away) return null;
  if (m?.isFinished) return null;

  const kickoffISO = toIso(r2(m?.matchDate));
  if (!kickoffISO) return null;
  const ko = Date.parse(kickoffISO);
  // 30 dk toleranslı: canlı devam eden veya az önce başlamış maçları atlıyoruz
  if (!Number.isFinite(ko) || ko < Date.now() - 30 * 60 * 1000) return null;

  // Kimlik: MK-<gün>-<home>-<away>. Aynı gün aynı iki takım = aynı maç.
  // Maçkolik'in kendi id'sini kullanmadım — cache'de kararlı bir dış id yok,
  // sadece kazınmış alanlar var; slug bunun yerine geçer.
  const day = kickoffISO.slice(0, 10);
  const fixtureId = `MK-${slugPart(home)}-${day}-${slugPart(away)}`;

  return {
    fixtureId,
    home,
    away,
    league: r2(m?.league) || null,
    country,
    kickoffISO,
    status: m?.isLive ? "LIVE" : "NS",
    source: SOURCE,
  };
}

/** Cache'i oku, tüm liglerin maçlarını düzleştir. */
async function readCache() {
  let raw = null;
  try {
    raw = JSON.parse(await fsp.readFile(CACHE_FILE, "utf8"));
  } catch (e) {
    return { matches: [], leagues: 0, reason: "CACHE_UNREADABLE" };
  }
  const leagues = raw?.leagues || {};
  const matches = [];
  for (const lg of Object.values(leagues)) {
    for (const m of lg?.matches || []) {
      matches.push({ ...m, country: lg.country, league: lg.name });
    }
  }
  return { matches, leagues: Object.keys(leagues).length, updatedAt: raw?.ts || null };
}

/**
 * Tek senkron turu.
 * @param {{ dryRun?: boolean }} opts
 */
async function syncOnce({ dryRun = false } = {}) {
  const t0 = Date.now();
  const { matches, leagues, updatedAt, reason } = await readCache();

  if (!matches.length) {
    return { ok: false, reason: reason || "NO_MATCHES_IN_CACHE", leagues, ms: Date.now() - t0 };
  }

  // Aynı kimlikte birden fazla eşleşme olabilir (Maçkolik'te ligler bazen
  // aynı maçı iki koleksiyonda gösteriyor — hazırlık + turnuva gibi).
  // Son kazanır: turnuva bilgisi hazırlık etiketini geçebilir.
  const byId = new Map();
  const elenme = {}; // sebep → adet (teşhis için)
  for (const m of matches) {
    const { fixture, reason } = normalizeWithReason(m);
    if (fixture) byId.set(fixture.fixtureId, fixture);
    else {
      // Ülke sebeplerinde tek tek ülke adını tutuyoruz; diğerleri sabit.
      const k = reason.startsWith("ulke:") || reason.startsWith("tarih")
        ? reason.split(":")[0] + ":" + reason.split(":").slice(1).join(":").slice(0, 24)
        : reason;
      elenme[k] = (elenme[k] || 0) + 1;
    }
  }
  const items = Array.from(byId.values());

  if (!items.length) {
    // Sebep dökümü olmadan bu durum "ülke eşleşmedi" sanılıyordu; gerçekte
    // maçlar bitmiş/geçmiş de olabilir. Log artık hangisi olduğunu söylüyor.
    return {
      ok: false, reason: "NO_MATCHING_COUNTRIES", elenme,
      cacheMatches: matches.length, leagues, ms: Date.now() - t0,
    };
  }

  const result = await withFileLock(FIXTURES_FILE, async () => {
    const existing = await readFixtures();
    const m = merge(existing, items, SOURCE);
    if (!dryRun) await writeFixtures(m.list);
    return { total: m.list.length, added: m.added, updated: m.updated, other: m.manual };
  });

  return {
    ok: true, ...result,
    fetched: items.length, cacheMatches: matches.length, leagues,
    cacheAt: updatedAt, dryRun, ms: Date.now() - t0,
  };
}

/**
 * Periyodik başlatıcı — server.cjs'den çağrılır.
 * Scraper 2 dakikada bir çalışıyor; her tur öncesi yeni cache'in oluşması için
 * varsayılan 3 dakika. Daha sık çağrı boşuna dosya kilidi tutar.
 */
function start(intervalMs = 3 * 60 * 1000) {
  let ilkBasariOldu = false;

  const run = async () => {
    try {
      const r = await syncOnce();
      if (r.ok) {
        ilkBasariOldu = true;
        console.log(`[mk-fixture-sync] ${r.total} maç (+${r.added} yeni, ~${r.updated} güncel, ${r.other} diğer kaynak) · ${r.ms}ms`);
      } else {
        const detay = r.elenme
          ? ` · cache ${r.cacheMatches} mac · eleme: ${JSON.stringify(r.elenme)}`
          : "";
        console.warn(`[mk-fixture-sync] atlandı: ${r.reason}${detay}`);
        // AÇILIŞ YARIŞI (loglarla doğrulandı): ilk tur 20. saniyede atılıyor
        // ama ilk şelale ~37 saniyede bitiyor — cache o an HENÜZ YOK ve tur
        // CACHE_UNREADABLE ile düşüyordu. Sonraki tur 3 dakika sonra geldiği
        // için her yeniden başlatmada "ilk 3 dakika maç yok" penceresi
        // oluşuyordu; Render ücretsiz katman servisi sık uyutup uyandırdığı
        // için bu pencere sık yaşanıyor. İlk başarıya kadar 30 saniyede bir
        // yeniden dene; başarıdan sonra normal aralık yeter.
        if (!ilkBasariOldu && r.reason === "CACHE_UNREADABLE") {
          const t = setTimeout(run, 30_000);
          if (t.unref) t.unref();
        }
      }
    } catch (e) {
      console.warn("[mk-fixture-sync] hata:", e.message);
    }
  };
  const timer = setInterval(run, intervalMs);
  if (timer.unref) timer.unref();
  // İlk turu 20 sn geciktir: scraper'ın ilk cache'ini yazmasına şans ver.
  setTimeout(run, 20_000);
  return timer;
}

module.exports = {
  syncOnce, normalize, readCache, start,
  TR_TO_COUNTRY, EN_TO_COUNTRY, ALLOWED_COUNTRIES, resolveCountry,
};
