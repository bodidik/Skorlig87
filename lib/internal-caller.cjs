"use strict";

/**
 * "Bu istek bizim mi?" — yönetim/iç uçlar için ortak kontrol.
 *
 * Kabul ölçütü:
 *   1) Süreç içi çağrı: proxy başlığı YOK **ve** soket loopback.
 *      (services/bot-filler.cjs, services/af-sync.cjs kendi API'sini böyle çağırır.)
 *   2) Geçerli x-admin-token.
 *
 * routes/settle2.cjs'deki isInternalCaller ile aynı fikir; farkı x-forwarded-for
 * kontrolü: ters proxy loopback üzerinden bağlanıyorsa yalnızca soket adresine
 * bakmak dış trafiği "iç" sayabilir. Başlık varsa istek dışarıdan gelmiştir.
 */
function isInternalCaller(req) {
  if (!req.headers["x-forwarded-for"]) {
    const remote = String(req.socket?.remoteAddress || req.ip || "");
    if (
      remote === "127.0.0.1" ||
      remote === "::1" ||
      remote === "::ffff:127.0.0.1"
    ) {
      return true;
    }
  }

  const expected = String(
    process.env.SKORLIG_ADMIN_TOKEN || process.env.ADMIN_TOKEN || ""
  ).trim();
  const got = String(req.headers["x-admin-token"] || "").trim();
  return !!(expected && got && got === expected);
}

module.exports = { isInternalCaller };
