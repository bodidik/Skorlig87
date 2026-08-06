"use strict";

/**
 * ESPN FİKSTÜR SENKRONU — ileri tarihli, HTTP-only.
 *
 * NEDEN VAR: Türkiye'nin fikstürü hiçbir kaynaktan İLERİ TARİHLİ gelmiyordu.
 * Ölçüldü (2026-08-06, `data/fixtures.json` 2253 kayıt / 88 ülke):
 *
 *     country=Türkiye olan kayıt          : 2  (ikisi de "Hazırlık")
 *     Süper Lig maçı                      : 0
 *     kupon kurulabilen hafta (8 maç şart): HİÇBİRİ (W32-W35 hepsi 0/8)
 *
 * Sebep yapısal, geçici değil:
 *   - FDO 30 gün ileri veriyor ama YALNIZCA 8 ülke; Türkiye kapsam dışı
 *     (bkz. services/fixture-sync.cjs başlığı).
 *   - Maçkolik/nesine yolu Türkiye'yi kapsıyor ama SADECE bugün+yarın
 *     (bkz. services/mackolik-fixture-sync.cjs "PENCERE" notu) ve URL'de
 *     tarih parametresi yok — canlı skor sayfası kazınıyor.
 *
 * Yani haftalık kupon (8 maçın HEPSİ gelecekte olmalı) Türk kullanıcı için
 * hiçbir zaman kurulamıyordu — ekranda "maç yok" görünüyordu ve bu hiçbir
 * yerde hata üretmiyordu.
 *
 * ⚠️ NEDEN ESPN: lige özel `scoreboard` ucu (a) düz HTTP — Puppeteer yok,
 * Render'da Chrome zaman aşımı sorunu yaşanmaz (bkz. livescore-scraper
 * PROD_SKIP notu), (b) `dates=YYYYMMDD-YYYYMMDD` aralığı kabul ediyor,
 * (c) lig adını doğru döndürüyor. Ölçüldü: tur.1 → 27 maç / 30 gün.
 *
 * ⚠️ LİGE ÖZEL UÇ KULLANILIYOR, `all` DEĞİL: `soccer/all/scoreboard` ~100
 * maçla sınırlı ve lig ADI dönmüyor (yalnızca sayısal id) — Süper Lig
 * tanınamaz hâle gelirdi.
 *
 * ⚠️ TAKIM ADLARI KANONİKLEŞTİRİLİYOR: ESPN aksansız yazıyor ("Besiktas",
 * "Genclerbirligi"). Ham bırakmak iki zarar verirdi — ekranda bozuk ad, ve
 * Maçkolik aynı maçı "Beşiktaş" diye yazınca İKİZ fikstür. `kanonikTakim`
 * 18/18 çözüyor (bkz. tests/takim-takma-ad.test.cjs).
 *
 * ⚠️ KADEMELİ AÇILIŞ: varsayılan yalnızca Türkiye. Diğer ligler tabloda
 * hazır ama `aktif:false` — ürün kararı, veri kısıtı değil. `SKORLIG_ESPN_LIGLER`
 * ile virgüllü anahtar listesi vererek açılır.
 */

const { withFileLock } = require("../lib/fileLock.cjs");
const { readFixtures, writeFixtures, merge } = require("./fixture-sync.cjs");
const { isExcludedLeague } = require("../lib/global-leagues.cjs");
const { normalizeCountry } = require("../lib/countries.cjs");
const { kanonikTakim } = require("../lib/takim-katalog.cjs");
const path = require("path");

const DATA_DIR = process.env.SKORLIG_DATA_DIR || path.join(__dirname, "..", "data");
const FIXTURES_FILE = path.join(DATA_DIR, "fixtures.json");

const SOURCE = "ESPN";
const TABAN = "https://site.api.espn.com/apis/site/v2/sports/soccer";

/** Kaç gün ileri bakılacak. Kupon 4 hafta ufka bakıyor; 30 gün onu kapsar. */
const GUN_ILERI = Number(process.env.SKORLIG_ESPN_GUN || 30);

/**
 * LİG TABLOSU.
 *
 * `country`/`league` alanları KANONİK yazılıyor çünkü aşağı akıştaki iki
 * süzgeç bunlara bakıyor:
 *   - `routes/tr-league.cjs` isSuperLigTR → country "türkiye" + league "süper lig"
 *   - `routes/kupon.cjs` sameCountry(f.country, kullanıcıÜlkesi)
 * ESPN'in kendi adı ("Turkish Super Lig") ikisini de tutturmazdı.
 *
 * ⚠️ ÖLÇÜLDÜ — bu ligler ESPN'de gerçekten veri döndürüyor (30 gün):
 *   tur.1 27 · jpn.1 51 · mex.1 34 · ksa.1 45 · usa.1 76 · rus.1 35
 *   gre.1 21 · arg.1 61.  (pol.1 → HTTP 400, tabloda YOK.)
 * Hepsi FDO kapsamı dışında kalan, botu ve sıralaması olup maçı olmayan
 * ülkeler — bkz. services/mackolik-fixture-sync.cjs başlığı.
 */
const LIGLER = [
  { key: "tur.1", country: "Türkiye",     league: "Süper Lig",        aktif: true  },
  { key: "jpn.1", country: "Japonya",     league: "J1 Ligi",          aktif: false },
  { key: "mex.1", country: "Meksika",     league: "Liga MX",          aktif: false },
  { key: "ksa.1", country: "Suudi Arabistan", league: "Suudi Pro Lig", aktif: false },
  { key: "usa.1", country: "ABD",         league: "MLS",              aktif: false },
  { key: "rus.1", country: "Rusya",       league: "Premier Lig",      aktif: false },
  { key: "gre.1", country: "Yunanistan",  league: "Super League",     aktif: false },
  { key: "arg.1", country: "Arjantin",    league: "Liga Profesional", aktif: false },
];

/** Etkin ligler: env verilmişse o liste, yoksa tablodaki `aktif` olanlar. */
function etkinLigler() {
  const ham = String(process.env.SKORLIG_ESPN_LIGLER || "").trim();
  if (!ham) return LIGLER.filter((l) => l.aktif);
  const istenen = new Set(ham.split(",").map((s) => s.trim()).filter(Boolean));
  return LIGLER.filter((l) => istenen.has(l.key));
}

const r2 = (s) => String(s || "").trim();

/**
 * Takım adı → istikrarlı, ASCII-safe kimlik parçası.
 * ⚠️ MK ve admin ucuyla AYNI kural — ayrı şema yazmak aynı maça iki farklı
 * kimlik üretir ve ikiz tespitine ek yük bindirirdi.
 */
function slugPart(s) {
  return String(s || "")
    .toLocaleUpperCase("tr-TR")
    .replace(/[İIı]/g, "I").replace(/Ş/g, "S").replace(/Ğ/g, "G")
    .replace(/Ü/g, "U").replace(/Ö/g, "O").replace(/Ç/g, "C")
    .replace(/[^A-Z0-9]+/g, "")
    .slice(0, 6);
}

/** `YYYYMMDD` — ESPN tarih aralığı biçimi. */
function espnGun(ms) {
  return new Date(ms).toISOString().slice(0, 10).replace(/-/g, "");
}

/**
 * ESPN durum kodu → depo durumu.
 * `state`: "pre" | "in" | "post".
 */
function durumCevir(ev) {
  const s = r2(ev?.status?.type?.state).toLowerCase();
  if (s === "in") return "LIVE";
  if (s === "post") return "FT";
  return "NS";
}

/**
 * Tek ESPN olayı → fikstür kaydı. Elenirse `{fixture:null, reason}`.
 *
 * ⚠️ BİTMİŞ/GEÇMİŞ MAÇ KAYIT AÇMAZ — MK ile aynı ürün kararı: geçmiş maça
 * tahmin girilemez, listeye eklemek yalnızca gürültü olur.
 */
function normalizeWithReason(ev, lig) {
  const yarisma = ev?.competitions?.[0];
  const takimlar = Array.isArray(yarisma?.competitors) ? yarisma.competitors : [];
  const evSahibi = takimlar.find((t) => t?.homeAway === "home");
  const deplasman = takimlar.find((t) => t?.homeAway === "away");

  const homeHam = r2(evSahibi?.team?.displayName);
  const awayHam = r2(deplasman?.team?.displayName);
  if (!homeHam || !awayHam) return { fixture: null, reason: "takim_eksik" };

  if (isExcludedLeague(lig.league)) return { fixture: null, reason: "alt_lig" };

  const kickoffISO = r2(ev?.date);
  if (!kickoffISO) return { fixture: null, reason: "tarih_yok" };
  const ko = Date.parse(kickoffISO);
  if (!Number.isFinite(ko)) return { fixture: null, reason: "tarih_bozuk:" + kickoffISO };

  const durum = durumCevir(ev);
  if (durum === "FT") return { fixture: null, reason: "bitmis" };
  // 30 dk tolerans: MK ile aynı — az önce başlamış maçı da atlıyoruz.
  if (ko < Date.now() - 30 * 60 * 1000) return { fixture: null, reason: "gecmis" };

  /* ⚠️ KANONİK AD, HAM AD DEĞİL. Çözülemezse ham ada düşüyoruz — maçı
   * tamamen elemek, çözülemeyen tek bir takım yüzünden o haftanın kuponunu
   * kuramamak demek olurdu (kupon 8 maçın TAMAMINI ister). */
  const home = kanonikTakim(homeHam) || homeHam;
  const away = kanonikTakim(awayHam) || awayHam;

  const country = normalizeCountry(lig.country) || lig.country;
  const day = new Date(ko).toISOString().slice(0, 10);

  return {
    fixture: {
      fixtureId: `${SOURCE}-${slugPart(home)}-${day}-${slugPart(away)}`,
      home,
      away,
      league: lig.league,
      country,
      kickoffISO,
      status: durum,
      source: SOURCE,
    },
    reason: null,
  };
}

/** Bir ligin fikstürlerini çeker. */
async function ligiCek(lig, { fetchFn = fetch } = {}) {
  const bas = espnGun(Date.now());
  const bit = espnGun(Date.now() + GUN_ILERI * 24 * 3600 * 1000);
  const url = `${TABAN}/${lig.key}/scoreboard?dates=${bas}-${bit}`;

  const res = await fetchFn(url);
  if (!res?.ok) {
    return { olaylar: [], hata: `HTTP_${res?.status || "?"}` };
  }
  const j = await res.json();
  return { olaylar: Array.isArray(j?.events) ? j.events : [], hata: null };
}

/**
 * Bir tur. `dryRun` ile yazmadan ölçüm alınabilir.
 */
async function syncOnce({ dryRun = false, fetchFn = fetch } = {}) {
  const t0 = Date.now();
  const ligler = etkinLigler();
  if (!ligler.length) return { ok: false, reason: "LIG_YOK" };

  const byId = new Map();
  const elenme = {};
  const ligHata = {};
  let olayToplam = 0;

  for (const lig of ligler) {
    let sonuc;
    try {
      sonuc = await ligiCek(lig, { fetchFn });
    } catch (e) {
      ligHata[lig.key] = e?.message || String(e);
      continue;
    }
    if (sonuc.hata) { ligHata[lig.key] = sonuc.hata; continue; }

    olayToplam += sonuc.olaylar.length;
    for (const ev of sonuc.olaylar) {
      const { fixture, reason } = normalizeWithReason(ev, lig);
      if (!fixture) { elenme[reason] = (elenme[reason] || 0) + 1; continue; }
      byId.set(fixture.fixtureId, fixture);
    }
  }

  const items = [...byId.values()];

  /* ⚠️ BOŞ SONUÇ YAZILMAZ. `merge` kendi kaynağının GELECEK kayıtlarını
   * silme yetkisine sahip; geçici bir ağ hatasından sonra gelen boş tur,
   * o ana kadar toplanmış tüm ESPN fikstürlerini silen "başarılı" bir
   * yazma gibi görünürdü. Aynı savunma fixture-sync ve mackolik-sync'te de
   * var — bu depoda tekrar eden bir kusur sınıfı. */
  if (!items.length) {
    return {
      ok: false, reason: "MAC_YOK",
      ligler: ligler.map((l) => l.key), olayToplam, elenme, ligHata,
      ms: Date.now() - t0,
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
    fetched: items.length, olayToplam, elenme, ligHata,
    ligler: ligler.map((l) => l.key), dryRun, ms: Date.now() - t0,
  };
}

/**
 * Periyodik başlatıcı.
 *
 * ⚠️ 6 SAAT: fikstür listesi (maç saatleri) günler önceden belli ve nadiren
 * değişir — sık çekmek kotayı ve dosya kilidini boşuna meşgul eder. MK 3
 * dakikada bir çalışıyor çünkü o CANLI skor taşıyor; bu servis taşımıyor.
 */
function start(intervalMs = 6 * 3600 * 1000) {
  const run = async () => {
    try {
      const r = await syncOnce();
      if (r.ok) {
        console.log(
          `[espn-fixture-sync] ${r.fetched} maç (+${r.added} yeni, ~${r.updated} güncel) · ` +
          `${r.ligler.join(",")} · ${r.ms}ms`
        );
      } else {
        console.warn(`[espn-fixture-sync] atlandı: ${r.reason} · ${JSON.stringify(r.ligHata || {})}`);
      }
    } catch (e) {
      console.warn("[espn-fixture-sync] hata:", e?.message || e);
    }
  };
  const timer = setInterval(run, intervalMs);
  if (timer.unref) timer.unref();
  // İlk tur 45 sn sonra: açılışta Mongo bağlantısı ve diğer senkronlar otursun.
  const ilk = setTimeout(run, 45_000);
  if (ilk.unref) ilk.unref();
  return timer;
}

module.exports = {
  syncOnce, start, LIGLER, etkinLigler,
  // Sınama için: saf dönüşüm ve kimlik şeması ağ olmadan ölçülsün.
  _normalizeWithReason: normalizeWithReason,
  _slugPart: slugPart,
  _durumCevir: durumCevir,
};

