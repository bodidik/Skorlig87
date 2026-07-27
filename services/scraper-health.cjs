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

const DATA_DIR = path.join(__dirname, "..", "data");
const CACHE_FILE = path.join(DATA_DIR, "livescore-cache.json");
const STATS_FILE = path.join(DATA_DIR, "livescore-stats.json");

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
 * Sağlık raporu üretir. Yan etkisizdir — hem zamanlayıcı hem HTTP ucu kullanır.
 */
async function report() {
  const stats = (await readJson(STATS_FILE, {})) || {};
  const ageMs = await cacheAgeMs();

  const sources = Object.entries(stats).map(([name, s]) => {
    const attempts = Number(s?.attempts || 0);
    const success = Number(s?.success || 0);
    const rate = attempts ? success / attempts : 0;
    return {
      name,
      attempts,
      success,
      rate: Math.round(rate * 100),
      lastSuccess: s?.lastSuccess || null,
      healthy: attempts >= MIN_ATTEMPTS && rate >= HEALTHY_RATE,
    };
  });

  const healthy = sources.filter((s) => s.healthy);

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

  if (healthy.length === 0) {
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

function start(intervalMs = 10 * 60 * 1000) {
  if (_timer) return;
  // İlk kontrol hemen değil: scraper'ın ilk turunu tamamlamasına fırsat ver,
  // yoksa açılışta yanlış "cache bayat" alarmı üretilir.
  setTimeout(tick, 2 * 60 * 1000).unref?.();
  _timer = setInterval(tick, intervalMs);
  _timer.unref?.();
  console.log(
    `[scraper-health] basladi · her ${Math.round(intervalMs / 60000)}dk · ` +
      `bayat esigi ${Math.round(STALE_WARN_MS / 60000)}dk`
  );
}

function stop() {
  if (_timer) clearInterval(_timer);
  _timer = null;
}

module.exports = { start, stop, report, tick };
