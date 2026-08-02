"use strict";

/**
 * FİKSTÜR SENKRONU — football-data.org (FDO) → data/fixtures.json
 *
 * NEDEN VAR: fixtures.json elle dolduruluyordu (admin-runtime /fixtures/add).
 * 60 maçın tamamı manuel girilmişti ve %28'i Türkiye maçıydı. Ülke sıralaması
 * geldikten sonra Portekizli oyuncunun listesi vardı ama tahmin edeceği maç
 * yoktu — yarım kalan halka burasıydı.
 *
 * NEDEN FDO: Denenen alternatifler ve elenme sebepleri —
 *   TheSportsDB (ücretsiz)  : eventsday.php sorgu başına SADECE 3 sonuç
 *                             döndürüyor (16 Ağustos'ta "dünyada 3 maç").
 *                             Ücretsiz katman fikstür için kullanılamaz.
 *   Bilyoner scraper        : sportsbookv2.bilyoner.com artık çözülmüyor
 *                             (ENOTFOUND). sources.cjs'de "active" yazıyor
 *                             ama fiilen ölü.
 *   API-Football            : hesap askıya alınmış ("account is suspended").
 *   football-data.org       : ✅ çalışıyor — 13 yarışma, gerçek veri.
 *
 * FDO ücretsiz katman kapsamı: Brezilya, İngiltere (PL+Championship),
 * İspanya, İtalya, Almanya, Fransa, Hollanda, Portekiz + UCL, Libertadores,
 * Dünya Kupası, Avrupa Şampiyonası.
 * Kapsam DIŞI: Türkiye, Japonya, ABD, Meksika, S.Arabistan, Yunanistan,
 * Rusya, Polonya, Arjantin — bu ülkeler manuel giriş / Maçkolik yolundan
 * beslenmeye devam eder.
 *
 * MANUEL MAÇLARA DOKUNMAZ: sadece source === "FDO" olan kayıtları günceller.
 * Admin'in elle girdiği maç (source alanı olmayan veya "MANUAL") asla
 * silinmez/üzerine yazılmaz — 60 maçlık mevcut program buna bağlı.
 *
 * KOTA: dakikada 10 istek. Pencere başına 1 istek, pencereler arası bekleme
 * var. Varsayılan 30 gün = 3 istek.
 */

const path = require("path");

const { withFileLock } = require("../lib/fileLock.cjs");

// Testlerde izole dizine yönlendirilebilir. Bu olmadan readFixtures/
// writeFixtures GERÇEK data/fixtures.json'a dokunur — bir test bu yüzden
// üretim-dışı da olsa 216 kayıtlık yerel fikstür dosyasını 2 kayda düşürdü.
const DATA_DIR = process.env.SKORLIG_DATA_DIR || path.join(__dirname, "..", "data");
const FIXTURES_FILE = path.join(DATA_DIR, "fixtures.json");
const FixturesStore = require("../lib/fixtures-store.cjs");

const FDO_BASE = "https://api.football-data.org/v4";
const WINDOW_DAYS = 10;      // FDO sınırı: "period must not exceed 10 days"
const REQ_GAP_MS = 7000;     // 10 istek/dk → güvenli aralık
const SOURCE = "FDO";

/**
 * FDO "area" adı → projenin kanonik ülke adı (routes/live2.cjs ALLOWED
 * anahtarları). Eşleşmeyen alan atlanır: ülke sıralaması ve lig filtreleri
 * ALLOWED anahtarlarına göre çalışıyor, uydurma bir ülke adı sessizce
 * filtrelerin dışında kalırdı.
 */
const AREA_TO_COUNTRY = {
  Brazil: "Brazil",
  England: "England",
  Spain: "Spain",
  Italy: "Italy",
  Germany: "Germany",
  France: "France",
  Netherlands: "Netherlands",
  Portugal: "Portugal",
  Europe: "Europe",
  World: "World",
  "South America": "World", // Libertadores — ALLOWED'da kıta yok, dünya kupaları kovasına
};

const r2 = (s) => String(s || "").trim();

/** FDO maçı → fixtures.json kaydı. Eşlenemeyen ülke/eksik alan → null. */
function normalize(m) {
  const area = r2(m?.area?.name);
  const country = AREA_TO_COUNTRY[area];
  if (!country) return null;

  const home = r2(m?.homeTeam?.name);
  const away = r2(m?.awayTeam?.name);
  const kickoffISO = r2(m?.utcDate);
  if (!home || !away || !kickoffISO) return null;

  return {
    // FDO- öneki manuel kimliklerle (GS-2026-01-05-TS) çakışmayı imkânsız kılar
    fixtureId: `FDO-${m.id}`,
    home,
    away,
    league: r2(m?.competition?.name) || null,
    country,
    kickoffISO,
    status: m?.status === "FINISHED" ? "FT" : m?.status === "IN_PLAY" ? "LIVE" : "NS",
    source: SOURCE,
  };
}

async function fetchWindow(key, fromISO, toISO) {
  const url = `${FDO_BASE}/matches?dateFrom=${fromISO}&dateTo=${toISO}`;
  const r = await fetch(url, {
    headers: { "X-Auth-Token": key },
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`FDO ${r.status}: ${body.slice(0, 160)}`);
  }
  const j = await r.json();
  return Array.isArray(j?.matches) ? j.matches : [];
}

const dayISO = (offset) =>
  new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

/**
 * FDO'dan `days` günlük fikstür çeker.
 * @returns {Promise<{items: object[], windows: number, errors: string[]}>}
 */
async function fetchFixtures({ key, days = 30 } = {}) {
  if (!key) throw new Error("FDO_KEY yok");

  const items = [];
  const errors = [];
  let windows = 0;

  for (let off = 0; off < days; off += WINDOW_DAYS) {
    const from = dayISO(off);
    const to = dayISO(Math.min(off + WINDOW_DAYS - 1, days - 1));
    try {
      const raw = await fetchWindow(key, from, to);
      for (const m of raw) {
        const n = normalize(m);
        if (n) items.push(n);
      }
      windows++;
    } catch (e) {
      errors.push(`${from}..${to}: ${e.message}`);
    }
    if (off + WINDOW_DAYS < days) await new Promise((s) => setTimeout(s, REQ_GAP_MS));
  }

  // Aynı maç iki pencerede görünebilir (sınır günleri) — son kazanır
  const byId = new Map(items.map((x) => [x.fixtureId, x]));
  return { items: Array.from(byId.values()), windows, errors };
}

/**
 * Çekilen maçları fixtures.json'a işler.
 *
 * Birleştirme kuralı (ownedSource parametresi ile çalışır — hangi kaynak bu
 * kayıtları "sahipleniyor"; başka kaynaklara ait maçlara asla dokunmaz):
 *   - source !== ownedSource olan kayıt AYNEN korunur (manuel + diğer kaynaklar)
 *   - Aynı kaynaktan kayıt varsa güncellenir, yoksa eklenir
 *   - Artık gelmeyen eski kayıt silinir (lig programı değişebilir)
 *     ANCAK sadece gelecekteki maçlar: geçmiş maçlar puanlama geçmişi için durur
 *
 * ownedSource ile iki farklı besleyicinin (FDO 30 gün ileri, MK 24 saatlik)
 * aynı fixtures.json'a birbirine dokunmadan yazması mümkün olur. FDO
 * çekince MK kayıtları, MK çekince FDO kayıtları AYNEN durur.
 */
function merge(existing, incoming, ownedSource = SOURCE) {
  const now = Date.now();
  const incomingIds = new Set(incoming.map((x) => x.fixtureId));

  const kept = existing.filter((f) => {
    if (r2(f?.source) !== ownedSource) return true;         // başka kaynak → dokunma
    if (incomingIds.has(r2(f?.fixtureId))) return false;    // güncellenecek
    const ko = Date.parse(f?.kickoffISO || "");
    return !Number.isFinite(ko) || ko < now;                // geçmiş kayıt → koru
  });

  return {
    list: kept.concat(incoming),
    added: incoming.filter((x) => !existing.some((f) => r2(f?.fixtureId) === x.fixtureId)).length,
    updated: incoming.filter((x) => existing.some((f) => r2(f?.fixtureId) === x.fixtureId)).length,
    // "manual" adı geriye dönük — ownedSource olmayan her şey (başka kaynak dahil)
    manual: kept.filter((f) => r2(f?.source) !== ownedSource).length,
  };
}

/**
 * Fikstürleri yazar. Mongo birincil, dosya ayna — bkz. lib/fixtures-store.cjs.
 *
 * Dosya sarmalını koruma ve atomik yazma oraya taşındı; buradaki kopyası
 * silindi ki iki yerde ayrı ayrı değişmesin. mackolik-fixture-sync ve
 * manual-fixtures-restore de bu fonksiyonu kullanıyor — yani üç senkron
 * yolunun tamamı tek depodan geçiyor.
 */
async function writeFixtures(list) {
  return FixturesStore.saveAll(list);
}

/**
 * ⚠️ TAZE OKUMA — ÖNBELLEK ATLANIYOR, BİLİNÇLİ.
 *
 * Bu yardımcı DÖRT oku-değiştir-yaz noktasını besliyor (`syncOnce`,
 * `mackolik-fixture-sync` ×2, `manual-fixtures-restore`) ve hepsi tam
 * değiştirme yapan `writeFixtures`/`saveAll` ile bitiyor — listede olmayan
 * belge SİLİNİYOR. Bayat liste okunup üzerine yazılırsa arada eklenen
 * maçlar sessizce kaybolur.
 *
 * Salt-okuyan sıcak yollar (live2/schedule, mini, team) `loadAll()`
 * önbelleğini kullanmaya devam ediyor; hız kazancı zaten oradan geliyor.
 */
async function readFixtures() {
  return FixturesStore.loadAll(undefined, { taze: true });
}

/**
 * Tek senkron turu.
 * @param {{ key?: string, days?: number, dryRun?: boolean }} opts
 */
async function syncOnce({ key = process.env.FDO_KEY, days = 30, dryRun = false } = {}) {
  const t0 = Date.now();
  const { items, windows, errors } = await fetchFixtures({ key, days });

  // Hiç maç gelmediyse YAZMA: geçici bir ağ/kota hatası, gelecekteki tüm FDO
  // maçlarını silen bir "başarılı" senkron gibi görünürdü.
  if (!items.length) {
    return { ok: false, reason: "NO_FIXTURES", windows, errors, ms: Date.now() - t0 };
  }

  const result = await withFileLock(FIXTURES_FILE, async () => {
    const existing = await readFixtures();
    const m = merge(existing, items);
    if (!dryRun) await writeFixtures(m.list);
    return { total: m.list.length, added: m.added, updated: m.updated, manual: m.manual };
  });

  return { ok: true, ...result, fetched: items.length, windows, errors, dryRun, ms: Date.now() - t0 };
}

/** Periyodik başlatıcı — server.cjs'den çağrılır. */
function start(intervalMs = 6 * 3600 * 1000, opts = {}) {
  const run = async () => {
    try {
      const r = await syncOnce(opts);
      if (r.ok) {
        console.log(`[fixture-sync] ${r.total} maç (+${r.added} yeni, ~${r.updated} güncel, ${r.manual} manuel) · ${r.ms}ms`);
      } else {
        console.warn(`[fixture-sync] atlandı: ${r.reason}`, r.errors?.slice(0, 2) || []);
      }
    } catch (e) {
      console.warn("[fixture-sync] hata:", e.message);
    }
  };
  run();
  const timer = setInterval(run, intervalMs);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = {
  syncOnce, fetchFixtures, normalize, merge, start, AREA_TO_COUNTRY,
  // Diğer besleyicilerin (mackolik-fixture-sync gibi) aynı dosyaya güvenli
  // yazabilmesi için ortak dosya G/Ç.
  readFixtures, writeFixtures,
};
