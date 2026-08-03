"use strict";

/**
 * ARŞİV SEZONU KAPISI — tek kaynak.
 *
 * Geçmiş sezon tabloları bir premium ayrıcalığı: ücretsiz kullanıcı 1 sezon
 * geriye bakabilir, premium 12 (bkz. lib/premium.cjs seasonArchiveDepth).
 *
 * ⚠️ NEDEN ÇIKARILDI (2026-08-03): kural YALNIZCA `routes/leaderboard.cjs`
 * içinde yazılıydı. Aynı gün `?season=` desteği `stats/me` ve `team-ranks`
 * uçlarına eklenince kapı onlara gelmedi.
 *
 * ÖLÇÜLDÜ (gerçek rotalar, ücretsiz kullanıcı, güncel sezon 2026-08):
 *     sezon      leaderboard        stats/me    team-ranks
 *     2026-07    geçti              2026-07     2026-07
 *     2026-06    KISITLANDI→2026-08 2026-06     2026-06
 *     2026-02    KISITLANDI→2026-08 2026-02     2026-02
 * Yani ücretsiz kullanıcı ayrıcalığı iki uçtan atlayabiliyordu.
 *
 * ⚠️ DÜRÜSTLÜK: `stats/me` sızıntısını AYNI OTURUMDA BEN AÇTIM — sezon
 * kapsamı kusurunu düzeltirken `?season=` desteği ekledim ama premium
 * kapısını taşımadım. `team-ranks` sızıntısı ise önceden vardı (o uç
 * `req.query.season`'ı zaten alıyordu).
 *
 * ⚠️ KAPI KAPATMIYOR, DÜŞÜRÜYOR: erişilemeyen sezon isteği güncel sezona
 * düşer ve `kisitli: true` ile bildirilir. Boş liste döndürmek "o sezonda
 * kimse yok" gibi görünürdü — leaderboard'ın kendi notu bunu anlatıyor.
 */

const Season = require("./season.cjs");
const premium = require("./premium.cjs");

/**
 * @param {string} istenenHam  ?season= ham değeri (geçersizse güncel sezon)
 * @param {{uid?: string|null, db?: object|null}} ctx
 * @returns {Promise<{sezon: string, kisitli: boolean}>}
 */
async function arsivSezonu(istenenHam, ctx = {}) {
  const istenen = String(istenenHam || "").trim();
  const guncel = Season.seasonKey();
  let sezon = Season.isValidKey(istenen) ? istenen : guncel;
  let kisitli = false;

  if (sezon !== guncel) {
    const uid = String(ctx.uid || "").trim();
    /* Kimlik yoksa ÜCRETSİZ kademe uygulanır: kimliksiz istekle arşiv
     * okunabilseydi kapı hiç yokmuş gibi olurdu. */
    const isPrem = uid ? await premium.isPremium(uid, ctx.db || null) : false;
    const derinlik = premium.seasonArchiveDepth(isPrem);

    let k = guncel;
    let bulundu = false;
    for (let i = 0; i < derinlik; i++) {
      k = Season.previousKey(k);
      if (!k) break;
      if (k === sezon) { bulundu = true; break; }
    }
    if (!bulundu) { sezon = guncel; kisitli = true; }
  }

  return { sezon, kisitli };
}

module.exports = { arsivSezonu };
