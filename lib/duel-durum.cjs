"use strict";

/**
 * DÜELLO DURUMLARI — tek kaynak.
 *
 * ⚠️ NEDEN VAR: bayat maç temizleyicisi ilk yazıldığında para tutan düelloları
 * `["open", "accepted"]` diye sorguluyordu. Kabul edilmiş düellonun durumu
 * aslında **"active"** — yani temizleyici tam da kurtarmak için yazıldığı
 * parayı HİÇ GÖRMÜYORDU.
 *
 * Testler bunu yakalamadı çünkü test verisi de `"accepted"` diye tohumlanmıştı:
 * test, sistemin davranışını değil yazarın varsayımını doğruladı. Kaynağı
 * okumadan sabit uydurmanın bedeli tam olarak budur.
 *
 * ⚠️ "accepted" kelimesi kod tabanında hâlâ geçiyor ama YALNIZCA YORUMLARDA
 * (routes/duels.cjs, lib/social-store.cjs) — o yorumlar da yanıltıcı. Durum
 * adı arayan biri onlara bakıp yanılabilir; bu dosya yetkili kaynaktır.
 */

/** Düellonun geçebileceği durumlar. */
const DURUM = {
  ACIK: "open",         // kurulmuş, kimse kabul etmemiş — kurucunun bahsi düşülmüş
  AKTIF: "active",      // kabul edilmiş — İKİ tarafın bahsi de düşülmüş
  SONUCLANDI: "settled",
  IPTAL: "cancelled",   // kurucu iptal etti, bahis iade edildi
  GECERSIZ: "voided",   // maçın sonucu hiç gelmedi, bahisler iade edildi
};

/**
 * PARA TUTAN durumlar: bu durumlardaki düelloda oyuncuların LC'si kilitlidir.
 * Bayat maç temizleyicisi tam olarak bunları tarar.
 */
const PARA_TUTAN = [DURUM.ACIK, DURUM.AKTIF];

/** Kapanmış durumlar — para artık kilitli değil. */
const KAPANMIS = [DURUM.SONUCLANDI, DURUM.IPTAL, DURUM.GECERSIZ];

/** Bu durumda kaç tarafın bahsi düşülmüştür? */
function bahisYatiranSayisi(durum) {
  if (durum === DURUM.AKTIF) return 2;
  if (durum === DURUM.ACIK) return 1;
  return 0;
}

module.exports = { DURUM, PARA_TUTAN, KAPANMIS, bahisYatiranSayisi };
