"use strict";

/**
 * SCRAPER SAĞLIK İZLEME
 *
 * NEDEN: Canlı skor şelalesi 10 kaynaklı görünüyor ama gerçekte tek kaynağa
 * dayanıyor — ölçüldüğünde mackolik %97, goal %7, diğer 8 kaynak %0'dı.
 * Yani Maçkolik bloklanır/şema değiştirirse gerçek bir yedek YOK ve canlı
 * skorlar sessizce donar. Eski davranış: `checkAndWarnStats` yalnızca
 * console.warn basıyordu; kimse logu izlemiyorsa saatlerce fark edilmezdi.
 *
 * Bu servis dışarıdan gözlemler (scraper koduna dokunmaz):
 *   • cache ne kadar zamandır tazelenmemiş (asıl sağlık göstergesi)
 *   • hangi kaynaklar çalışıyor, kaç yedek ayakta
 *   • sorun varsa yönetim alarmı üretir (tekrarları bastırılmış)
 *
 * Kapatmak için: SKORLIG_SCRAPER_HEALTH=0
 */

const path = require("path");
const fs = require("fs");
const fsp = fs.promises;
const { appendAlert } = require("../lib/admin-alerts.cjs");

// ⚠️ SKORLIG_DATA_DIR OKUNUYOR. Sabit yol testleri GERÇEK data/ dizinine
// yazdırıyordu: bir entegrasyon testi 7 kaydı canlı preds.json'a düşürdü.
// Ayrıca settle2 bu değişkeni okuyup pred okumayınca aynı zincirdeki iki
// modül maç durum dosyasını FARKLI dizinlerde arıyordu.
const DATA_DIR = process.env.SKORLIG_DATA_DIR || path.join(__dirname, "..", "data");
const CACHE_FILE = path.join(DATA_DIR, "livescore-cache.json");
const STATS_FILE = path.join(DATA_DIR, "livescore-stats.json");
const PROBE_FILE = path.join(DATA_DIR, "scraper-probe.json");

/* ── Neden yoklama (probe) gerekiyor ──────────────────────────────────────
 * Şelale ilk başarılı kaynakta `break` eder. mackolik hemen hemen her turda
 * başardığı için SONRAKİ kaynaklar neredeyse hiç denenmez; livescore-stats
 * içindeki düşük oranları "bozuk" değil "nadiren denendi" anlamına gelir.
 *
 * Bu ayrım kritik: yalnızca istatistiğe bakan ilk sürüm "yedek yok, tek
 * kaynak mackolik" alarmı üretiyordu. Kaynaklar izole çalıştırıldığında
 * goal 89 maç, espn 17 maç döndürdü — yani İKİ gerçek yedek vardı ve alarm
 * yanlıştı. Artık yedek sayımı gerçek yoklama sonucundan gelir.
 */
const PROBE_TTL_MS = Number(process.env.SKORLIG_PROBE_TTL_H || 24) * 3600000;

// Cache bu süredir tazelenmediyse sorun var. Scraper 2dk'da bir çalışıyor;
// eşik ona göre geniş tutuldu ki geçici bir tur hatası alarm üretmesin.
const STALE_WARN_MS = Number(process.env.SKORLIG_SCRAPER_STALE_MIN || 20) * 60000;
const STALE_CRIT_MS = Number(process.env.SKORLIG_SCRAPER_CRIT_MIN || 60) * 60000;

// Bir kaynağı "çalışıyor" saymak için asgari başarı oranı ve deneme sayısı.
const HEALTHY_RATE = 0.5;
const MIN_ATTEMPTS = 5;

// Yedeksiz kalındığında (tek çalışan kaynak) uyar.
const MIN_HEALTHY_SOURCES = Number(process.env.SKORLIG_SCRAPER_MIN_SOURCES || 2);

let _timer = null;
let _probeTimer = null;

async function readJson(file, fb) {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"));
  } catch {
    return fb;
  }
}

/** Cache dosyasının en son ne zaman yazıldığı (ms cinsinden yaş). */
async function cacheAgeMs() {
  try {
    const st = await fsp.stat(CACHE_FILE);
    return Date.now() - st.mtimeMs;
  } catch {
    return Infinity; // dosya hiç yoksa en kötü durum
  }
}

/**
 * Kaynakları TEK TEK, şelaleden bağımsız çalıştırır ve sonucu diske yazar.
 * Pahalıdır (her tarayıcı kaynağı için Chrome açılır) — bu yüzden seyrek
 * çalışır. Yedek sayımının tek güvenilir kaynağı budur.
 */
async function probeSources(names) {
  const scraper = require("./livescore-scraper.cjs");
  const list = names && names.length ? names : scraper.SOURCE_NAMES;

  const results = {};
  for (const name of list) {
    const t0 = Date.now();
    try {
      const r = await scraper.scrapeOne(name);
      results[name] = { ok: r.count > 0, count: r.count, ms: Date.now() - t0, error: null };
    } catch (e) {
      results[name] = {
        ok: false,
        count: 0,
        ms: Date.now() - t0,
        error: String(e?.message || e).slice(0, 200),
      };
    }
  }

  const doc = { checkedAt: new Date().toISOString(), results };
  try {
    await fsp.writeFile(PROBE_FILE, JSON.stringify(doc, null, 2), "utf8");
  } catch (e) {
    console.error("[scraper-health] yoklama yazilamadi:", e.message || e);
  }
  return doc;
}

/**
 * Sağlık raporu üretir. Yan etkisizdir — hem zamanlayıcı hem HTTP ucu kullanır.
 */
async function report() {
  const stats = (await readJson(STATS_FILE, {})) || {};
  const probe = (await readJson(PROBE_FILE, null)) || null;
  const ageMs = await cacheAgeMs();

  const probeAgeMs = probe?.checkedAt
    ? Date.now() - new Date(probe.checkedAt).getTime()
    : Infinity;
  const probeFresh = probeAgeMs < PROBE_TTL_MS;

  // Kaynak listesi İKİ kaynağın birleşimi olmalı: şelalede hiç denenmemiş bir
  // kaynak livescore-stats'ta bulunmaz (espn böyleydi) ve yalnızca istatistiğe
  // bakılırsa yoklamada çalıştığı halde sayılmadan atlanır.
  const names = new Set([
    ...Object.keys(stats),
    ...Object.keys(probe?.results || {}),
  ]);

  const sources = [...names].map((name) => {
    const s = stats[name] || {};
    const attempts = Number(s?.attempts || 0);
    const success = Number(s?.success || 0);
    const rate = attempts ? success / attempts : 0;
    const p = probe?.results?.[name];

    return {
      name,
      attempts,
      success,
      rate: Math.round(rate * 100),
      lastSuccess: s?.lastSuccess || null,
      // Şelale istatistiği: "denendiğinde başardı mı". Nadiren denenen
      // kaynaklarda anlamsızdır, o yüzden tek başına sağlık ölçütü DEĞİL.
      waterfallHealthy: attempts >= MIN_ATTEMPTS && rate >= HEALTHY_RATE,
      probe: p ? { ok: p.ok, count: p.count, error: p.error } : null,
    };
  });

  // Yedek sayımı: taze yoklama varsa ONA güvenilir (şelale istatistiği
  // sonraki kaynakları neredeyse hiç denemediği için yanıltıcıdır).
  const healthy = probeFresh
    ? sources.filter((s) => s.probe?.ok)
    : sources.filter((s) => s.waterfallHealthy);

  let status = "ok";
  const problems = [];

  if (ageMs >= STALE_CRIT_MS) {
    status = "critical";
    problems.push(
      `Canli skor cache ${Math.round(ageMs / 60000)} dakikadir tazelenmedi`
    );
  } else if (ageMs >= STALE_WARN_MS) {
    status = "warn";
    problems.push(
      `Canli skor cache ${Math.round(ageMs / 60000)} dakikadir tazelenmedi`
    );
  }

  // Yoklama hiç yapılmamış/bayatsa yedek sayısı hakkında iddiada bulunma —
  // yanlış "yedek yok" alarmı üretmektense sessiz kalmak doğrudur.
  if (!probeFresh) {
    problems.push(
      "Kaynak yoklamasi bayat/yok — yedek sayisi dogrulanamiyor (POST /api/admin/scraper-probe)"
    );
    if (status === "ok") status = "warn";
  } else if (healthy.length === 0) {
    status = "critical";
    problems.push("Calisan hicbir veri kaynagi yok");
  } else if (healthy.length < MIN_HEALTHY_SOURCES) {
    if (status === "ok") status = "warn";
    problems.push(
      `Yedek yok: yalnizca ${healthy.length} kaynak calisiyor (${healthy
        .map((s) => s.name)
        .join(", ")})`
    );
  }

  return {
    status, // ok | warn | critical
    checkedAt: new Date().toISOString(),
    cache: {
      ageMinutes: Number.isFinite(ageMs) ? Math.round(ageMs / 60000) : null,
      staleWarnMinutes: Math.round(STALE_WARN_MS / 60000),
      staleCriticalMinutes: Math.round(STALE_CRIT_MS / 60000),
    },
    probe: {
      fresh: probeFresh,
      checkedAt: probe?.checkedAt || null,
      ageHours: Number.isFinite(probeAgeMs) ? Math.round(probeAgeMs / 3600000) : null,
    },
    healthySources: healthy.map((s) => s.name),
    sources: sources.sort((a, b) => b.rate - a.rate),
    problems,
  };
}

async function tick() {
  try {
    const r = await report();
    if (r.status === "ok") return;

    // Alarm modülü aynı mesajı soğuma penceresi içinde tekrar yazmaz,
    // yani her turda alarm yağmuru olmaz.
    const written = await appendAlert(
      r.status === "critical" ? "scraper_down" : "scraper_degraded",
      "livescore",
      r.problems.join(" · "),
      {
        cacheAgeMinutes: r.cache.ageMinutes,
        healthySources: r.healthySources,
      }
    );

    if (written) {
      console.warn(`[scraper-health] ${r.status.toUpperCase()}: ${r.problems.join(" · ")}`);
    }
  } catch (e) {
    console.error("[scraper-health] kontrol hatasi:", e.message || e);
  }
}

/** Yoklama bayatladıysa yenile. Pahalı olduğu için TTL'e uyar. */
async function probeIfStale() {
  try {
    const probe = await readJson(PROBE_FILE, null);
    const age = probe?.checkedAt
      ? Date.now() - new Date(probe.checkedAt).getTime()
      : Infinity;
    if (age < PROBE_TTL_MS) return;

    console.log("[scraper-health] kaynak yoklamasi basliyor...");
    const doc = await probeSources();
    const ok = Object.entries(doc.results).filter(([, r]) => r.ok);
    console.log(
      `[scraper-health] yoklama bitti · calisan ${ok.length}/${Object.keys(doc.results).length}: ` +
        ok.map(([n, r]) => `${n}(${r.count})`).join(", ")
    );
  } catch (e) {
    console.error("[scraper-health] yoklama hatasi:", e.message || e);
  }
}

function start(intervalMs = 10 * 60 * 1000) {
  if (_timer) return;
  // İlk kontrol hemen değil: scraper'ın ilk turunu tamamlamasına fırsat ver,
  // yoksa açılışta yanlış "cache bayat" alarmı üretilir.
  setTimeout(tick, 2 * 60 * 1000).unref?.();
  _timer = setInterval(tick, intervalMs);
  _timer.unref?.();

  // Yoklama ayrı ve çok daha seyrek: her kaynak için Chrome açtığından
  // pahalı. TTL dolmadıysa hiçbir şey yapmaz.
  setTimeout(probeIfStale, 5 * 60 * 1000).unref?.();
  _probeTimer = setInterval(probeIfStale, 60 * 60 * 1000);
  _probeTimer.unref?.();

  console.log(
    `[scraper-health] basladi · her ${Math.round(intervalMs / 60000)}dk · ` +
      `bayat esigi ${Math.round(STALE_WARN_MS / 60000)}dk · ` +
      `yoklama TTL ${Math.round(PROBE_TTL_MS / 3600000)}sa`
  );
}

function stop() {
  if (_timer) clearInterval(_timer);
  if (_probeTimer) clearInterval(_probeTimer);
  _timer = null;
  _probeTimer = null;
}

module.exports = { start, stop, report, tick, probeSources, probeIfStale };
