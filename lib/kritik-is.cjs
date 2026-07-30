"use strict";

/**
 * KRİTİK İŞ SAYACI — kapanış sırasında yarıda kesilmemesi gerekenler.
 *
 * ⚠️ NEDEN VAR: `server.cjs` düzgün kapanışta `activeLockCount()` bekliyor,
 * yani yalnızca DOSYA kilitlerini. Depolar Mongo'ya taşındıktan sonra para
 * dağıtımı artık dosya kilidi tutmuyor — sayaç sıfır görünüyor ve kapanış
 * "her şey bitti" sanıp çıkıyor.
 *
 * HTTP istekleri güvende: `server.close()` açık yanıtları bekler. Sorun ARKA
 * PLAN servislerinde: otomatik settle ve livescore-sync zamanlayıcıyla çalışır,
 * hiçbir isteğe bağlı değildir. Render ücretsiz katmanda SIGTERM her deploy'da
 * ve boşta uyutmada geliyor, yani çakışma kuramsal değil.
 *
 * Yarıda kesilen bir ödeme şu sonucu verir: `claimAward` mührü atılmış ama
 * cüzdanlar yazılmamış — mühür yüzünden tekrar denenmez, ödül kaybolur.
 * (Kaybı görünür kılmak için ayrıca `failed_awards` izi var, ama en iyisi
 * kesintinin hiç olmaması.)
 *
 * KULLANIM:
 *     const { kritikIs } = require("../lib/kritik-is.cjs");
 *     await kritikIs("settle:" + fid, async () => { ...ödeme... });
 *
 * ⚠️ Bu bir KİLİT DEĞİL — eşzamanlılığı engellemez, yalnızca "devam eden iş
 * var" der. Eşzamanlılık korumaları atomik mühürlerde (claimAward vb.).
 */

let _sayac = 0;
const _etiketler = new Map(); // etiket -> adet (teşhis için)

/** Devam eden kritik iş sayısı. */
function aktifKritikIs() {
  return _sayac;
}

/** Hangi işler devam ediyor (kapanış logunda göstermek için). */
function aktifEtiketler() {
  return Array.from(_etiketler.entries()).map(([k, n]) => (n > 1 ? `${k}×${n}` : k));
}

/**
 * İşi sayaca dahil ederek çalıştırır. Hata fırlatsa bile sayaç düşer.
 * @template T
 * @param {string} etiket teşhis için kısa ad
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function kritikIs(etiket, fn) {
  const ad = String(etiket || "isimsiz");
  _sayac++;
  _etiketler.set(ad, (_etiketler.get(ad) || 0) + 1);
  try {
    return await fn();
  } finally {
    _sayac--;
    const n = (_etiketler.get(ad) || 1) - 1;
    if (n <= 0) _etiketler.delete(ad);
    else _etiketler.set(ad, n);
  }
}

module.exports = { kritikIs, aktifKritikIs, aktifEtiketler };
