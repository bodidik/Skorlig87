"use strict";

/**
 * HAVUZ PAYI DAĞITIMI — tek kaynak (en büyük kalan yöntemi).
 *
 * Bir toplamı verilen oranlara göre TAM SAYI olarak böler. Önce her pay aşağı
 * yuvarlanır, artan birim kesirli kısmı en büyük olandan başlayarak birer birer
 * dağıtılır. Toplam, dağıtılacak tutara TAM eşitlenir — hiçbir zaman aşmaz.
 * Eşit kesirde üst sıra önce gelir, yani dağıtım deterministik.
 *
 * ⚠️ NEDEN TEK KAYNAK (2026-08-03): aynı hata İKİ para yolunda ayrı ayrı
 * çıktı. Her ödeme bağımsız yuvarlanıyor ve toplam havuzla hiç
 * karşılaştırılmıyordu:
 *
 *   TURNUVA (services/tournament.cjs) — 1536 senaryo:
 *       %23.4 havuzdan FAZLA ödeme, %6.6 eksik
 *   MAÇ HAVUZU (lib/pool-store.cjs) — 210 senaryo:
 *       %49.0 havuzdan FAZLA dağıtım, %47.6 eksik
 *       en kötü: 20 kazanan × 5 LC + 100 kaybeden → havuz 200,
 *                ödenen 200 + yakılan 10 = 210  (+10 LC YOKTAN)
 *
 * Turnuva tarafı önce düzeltilmişti; kural orada kalsaydı havuz aynı hatayı
 * taşımaya devam ederdi. Bu depoda kopyalanan kural defalarca ayrıştı, o
 * yüzden ikinci kez yazmak yerine buraya taşındı.
 *
 * ⚠️ SADECE AŞAĞI YUVARLAMAK YETMEZ: fazla ödemeyi bitirir ama bu kez sürekli
 * LC yakar (turnuvada ölçüldü: 1440 senaryonun 1199'unda 3 LC'ye kadar).
 * En büyük kalan ikisini birden çözer.
 *
 * @param {number} tutar     dağıtılacak toplam (aşağı yuvarlanır)
 * @param {number[]} oranlar paylar; toplamları 1 olmalı (değilse orantı korunur)
 * @returns {number[]} her orana düşen TAM SAYI pay; toplamı === floor(tutar)
 */
function odemeDagit(tutar, oranlar) {
  const toplam = Math.max(0, Math.floor(Number(tutar) || 0));
  const kalemler = (oranlar || []).map((pct, i) => {
    const tam = toplam * Number(pct || 0);
    return { i, taban: Math.floor(tam), kesir: tam - Math.floor(tam) };
  });
  let artan = toplam - kalemler.reduce((a, k) => a + k.taban, 0);
  const sira = [...kalemler].sort((a, b) => b.kesir - a.kesir || a.i - b.i);
  for (let j = 0; j < sira.length && artan > 0; j++, artan--) sira[j].taban++;
  return kalemler.map((k) => k.taban);
}

module.exports = { odemeDagit };
