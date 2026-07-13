"use strict";

/**
 * LC otomatik birikimi ("token bitince bekle" mekanizması):
 * Bakiye REGEN_CAP altındayken her REGEN_HOURS saatte REGEN_LC token
 * kendiliğinden birikir. Cap'in üzerindeki bakiyeler etkilenmez ve
 * cap doluyken süre "bankada birikmez" (oyunlardaki can yenilenmesi gibi).
 *
 * Tembel hesap: ayrı bir zamanlayıcı yok; cüzdana dokunan her yol
 * (summary, daily-claim, tahmin harcaması) applyRegen'i çağırır.
 * Ledger'a kayıt atılmaz (4 saatte bir +1 satırı defteri boğar);
 * balance/totalEarned/lastRegenAt güncellenir.
 */

const REGEN_CAP = Math.max(0, Number(process.env.SKORLIG_REGEN_CAP || 15));
const REGEN_LC = Math.max(1, Number(process.env.SKORLIG_REGEN_LC || 1));
const REGEN_HOURS = Math.max(0.1, Number(process.env.SKORLIG_REGEN_HOURS || 4));
const REGEN_INTERVAL_MS = REGEN_HOURS * 3600 * 1000;

/**
 * Cüzdan kullanıcı kaydını yerinde günceller.
 * @param {object} [opts] premium override: { cap, hours }
 * @returns {number} bu çağrıda biriken LC (0 olabilir)
 */
function applyRegen(user, nowMs = Date.now(), opts = null) {
  const cap = opts && Number.isFinite(opts.cap) ? opts.cap : REGEN_CAP;
  const intervalMs = opts && Number.isFinite(opts.hours) ? opts.hours * 3600 * 1000 : REGEN_INTERVAL_MS;
  if (!user || cap <= 0) return 0;

  const bal = Number(user.balance || 0);

  // Cap ve üzeri: birikim yok, sayaç şimdiye sabitlenir (süre bankalanmaz)
  if (bal >= cap) {
    user.lastRegenAt = new Date(nowMs).toISOString();
    return 0;
  }

  const lastMs = user.lastRegenAt ? new Date(user.lastRegenAt).getTime() : NaN;
  if (!Number.isFinite(lastMs) || lastMs > nowMs) {
    // İlk kez görülüyor: sayaç başlat, birikim bir sonraki tik'te başlar
    user.lastRegenAt = new Date(nowMs).toISOString();
    return 0;
  }

  const ticks = Math.floor((nowMs - lastMs) / intervalMs);
  if (ticks <= 0) return 0;

  const earned = Math.min(ticks * REGEN_LC, cap - bal);
  if (earned <= 0) return 0;

  user.balance = bal + earned;
  user.totalEarned = Number(user.totalEarned || 0) + earned;
  // Kullanılan tik kadar ilerlet; artan süre bir sonraki tik'e sayılır
  const usedTicks = Math.ceil(earned / REGEN_LC);
  user.lastRegenAt = new Date(lastMs + usedTicks * intervalMs).toISOString();
  user.updatedAt = new Date(nowMs).toISOString();
  return earned;
}

/** UI'nin göstereceği birikim bilgisi (bir sonraki token ne zaman?) */
function regenInfo(user, nowMs = Date.now(), opts = null) {
  const cap = opts && Number.isFinite(opts.cap) ? opts.cap : REGEN_CAP;
  const hours = opts && Number.isFinite(opts.hours) ? opts.hours : REGEN_HOURS;
  const intervalMs = hours * 3600 * 1000;
  const bal = Number(user?.balance || 0);
  const active = bal < cap;
  let nextAt = null;
  if (active && user?.lastRegenAt) {
    const lastMs = new Date(user.lastRegenAt).getTime();
    if (Number.isFinite(lastMs)) nextAt = new Date(lastMs + intervalMs).toISOString();
  }
  return {
    active,
    cap,
    amountPerTick: REGEN_LC,
    intervalHours: hours,
    nextAt,
  };
}

module.exports = { applyRegen, regenInfo, REGEN_CAP, REGEN_LC, REGEN_HOURS };
