"use strict";

/**
 * YÖNETİM ALARMLARI — ortak yazıcı.
 *
 * Daha önce yalnızca routes/live2.cjs içinde gömülü bir yardımcı vardı ve
 * dışa açılmamıştı; servisler alarm üretemiyordu. Ayrıca iki sorunu vardı:
 *
 *   1) SINIRSIZ BÜYÜME — `items.push()` + yaz, hiç kırpma yok. 4 günde 1412
 *      kayıt / 733 KB birikmişti ve her yazma tüm dosyayı okuyup yazıyor.
 *   2) TEKRAR — aynı tür alarm arka arkaya yüzlerce kez yazılıyordu
 *      (provider_missing_schedule tek başına 876 kayıt). Gürültü, gerçek
 *      sorunu görünmez yapar.
 *
 * Burada ikisi de çözülür: kayıt sayısı ve yaşı sınırlanır, aynı alarm
 * soğuma süresi içinde tekrar yazılmaz.
 */

const path = require("path");
const fsp = require("fs").promises;
const { withFileLock, writeJsonAtomic } = require("./fileLock.cjs");

const FILE = path.join(__dirname, "..", "data", "admin-alerts.json");

const MAX_ITEMS = Number(process.env.SKORLIG_ALERT_MAX || 500);
const MAX_AGE_MS = Number(process.env.SKORLIG_ALERT_TTL_DAYS || 14) * 86400000;
// Aynı (kind + scope + message) bu süre içinde tekrar yazılmaz.
const DEDUPE_MS = Number(process.env.SKORLIG_ALERT_DEDUPE_MIN || 30) * 60000;

async function readAll() {
  try {
    const raw = JSON.parse(await fsp.readFile(FILE, "utf8"));
    return Array.isArray(raw?.items) ? raw.items : [];
  } catch {
    return [];
  }
}

/**
 * Alarm ekle.
 * @returns {Promise<boolean>} yazıldıysa true, tekrar olduğu için atlandıysa false
 */
async function appendAlert(kind, scope, message, meta) {
  return withFileLock(FILE, async () => {
    const items = await readAll();
    const now = Date.now();

    // Tekrar bastırma: aynı alarm soğuma penceresi içinde yeniden yazılmaz.
    const dupe = items.some(
      (a) =>
        a.kind === kind &&
        a.scope === scope &&
        a.message === message &&
        now - new Date(a.createdAt || 0).getTime() < DEDUPE_MS
    );
    if (dupe) return false;

    items.push({
      id: "alert_" + now.toString(36) + "_" + Math.random().toString(36).slice(2, 8),
      kind,
      scope,
      message,
      meta: meta || null,
      createdAt: new Date(now).toISOString(),
    });

    // Yaş ve sayı sınırı — dosya sonsuza kadar büyümesin.
    const fresh = items.filter(
      (a) => now - new Date(a.createdAt || 0).getTime() < MAX_AGE_MS
    );
    const capped = fresh.slice(-MAX_ITEMS);

    await writeJsonAtomic(FILE, { items: capped });
    return true;
  });
}

/** Son alarmlar (yeniden eskiye). */
async function listAlerts(limit = 50, kind = null) {
  const items = await readAll();
  const filtered = kind ? items.filter((a) => a.kind === kind) : items;
  return filtered.slice(-limit).reverse();
}

module.exports = { appendAlert, listAlerts, FILE };
