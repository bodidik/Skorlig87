"use strict";

/**
 * "Bu istek bizim mi?" — yönetim/iç uçlar için ortak kontrol.
 *
 * Kabul ölçütü:
 *   1) Süreç içi çağrı: proxy başlığı YOK **ve** soket loopback.
 *      (services/bot-filler.cjs, services/af-sync.cjs kendi API'sini böyle çağırır.)
 *   2) Geçerli x-admin-token.
 *
 * ⚠️ `x-forwarded-for` KONTROLÜ ASIL KORUMA: ters proxy uygulamaya loopback
 * üzerinden bağlanıyorsa yalnızca soket adresine bakmak DIŞ TRAFİĞİ "İÇ"
 * sayar. Başlık varsa istek dışarıdan gelmiştir.
 *
 * ⚠️ BU DOSYA TAM O BOŞLUK İÇİN YAZILDI ama bir süre yalnızca
 * `routes/pred.cjs` kullanıyordu: `routes/settle2.cjs` — yani PARA DAĞITAN uç —
 * başlık kontrolü olmayan kendi kopyasıyla kalmıştı. Fark bu başlıkta yazılıydı;
 * yazmak, geçirmek anlamına gelmiyor. `tests/ic-cagrian.test.cjs` artık ikinci
 * bir kopya yazılmasını engelliyor.
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

  /* ⚠️ KABUL EDİLEN JETON ADLARI TEK YERDEN. Buradaki liste iki ad sayıyordu,
   * `middleware/requireAdmin.cjs` ise ÜÇ (eski kurulumlar için
   * `EXPO_PUBLIC_ADMIN_TOKEN` da kabul ediliyor). Ayrı listeler, aynı jetonun
   * bir uçta çalışıp ötekinde 503 vermesi demek — kopyaların sessizce
   * ayrışmasının bu oturumdaki en sık görülen biçimi. */
  const expected = require("../middleware/requireAdmin.cjs").beklenenToken();
  const got = String(req.headers["x-admin-token"] || "").trim();
  return !!(expected && got && got === expected);
}

module.exports = { isInternalCaller };
