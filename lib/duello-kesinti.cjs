"use strict";

/**
 * DÜELLO KASA PAYI VE ÖDÜL HESABI — TEK KAYNAK.
 *
 * ⚠️ NEDEN YÜZDE DEĞİL TABLO (2026-08-05): kesinti `HOUSE_CUT_PCT = 0.05` idi
 * ve ödül şöyle hesaplanıyordu:
 *
 *     houseCut  = Math.round(pot * 0.05 * 10) / 10;
 *     winAmount = Math.round((pot - houseCut) * 10) / 10;
 *
 * ÖLÇÜLDÜ (1..12 bahis aralığının TAMAMI): 12 bahsin 11'i KESİRLİ ödül
 * üretiyordu — 1 → 1.9, 2 → 3.8, 3 → 5.7. Toplam korunuyordu
 * (houseCut + winAmount === pot, 12/12) yani LC yoktan üretilmiyor ya da
 * yakılmıyordu; sorun AŞAĞI AKIŞTAYDI.
 *
 * `lib/wallet-credit.cjs` bakiyeyi `$inc: { balance: tutar }` ile büyütüyor ve
 * hiç yuvarlamıyor. IEEE754 kesirleri tam tutamadığı için hata BİRİKİYOR:
 *
 *     1.9 × 20 kredi  → 37.999999999999986   (38 değil)
 *     5.7 × 100 kredi → 569.9999999999998    (570 değil)
 *
 * Gösterim tarafı ayrıca düzeltilmişti (`mobile/lib/lcBicim.ts`) ama o yalnızca
 * artığı EKRANDAN saklıyordu; depodaki değer kirli kalmaya devam ediyordu.
 *
 * ⚠️ YÜZDEYİ TAM SAYIYA YUVARLAMAK ÇÖZÜM DEĞİL. MAX_STAKE 12'de havuz 2..24,
 * yani %5 kesinti 0.1..1.2 LC. `Math.floor` bahis 1-9 arası kesintiyi SIFIRA
 * indiriyor (kasa geliri biter), `Math.ceil` ters yöne kaçıyor (bahis 1'de
 * havuzun %50'si kasaya gider). Bu aralıkta %5'i koruyan tam sayı YOK.
 * Turnuvadaki `lib/pay-dagitim.cjs odemeDagit` (en büyük kalan) da kurtarmıyor:
 * [0.95, 0.05] oranlarında artan birim her zaman 0.9 kesirli paya gider, yani
 * havuz 10'un altında kesinti yine 0 çıkar.
 *
 * ÇÖZÜM — KADEMELİ SABİT KESİNTİ. Kesinti artık bahse göre TAM SAYI LC.
 * Kademeler %5'ten türetildi: `round(0.05 * pot)` = `round(0.1 * stake)`, yani
 * 1-4 arası 0 LC, 5-12 arası 1 LC. Aralığın TAMAMINDA efektif oran ortalaması
 * 8 / 156 = %5.1 — eski orana denk, ama ödüller artık tam sayı.
 *
 * ⚠️ Turnuvadaki dersle aynı yön: `lib/pay-dagitim.cjs` notu, hatanın
 * ENFLASYON yönüne (havuzdan fazla ödeme) kaçmasının yanlış olduğunu ölçüyor.
 * Burada da toplam TAM eşitleniyor: houseCut + winAmount === pot, her bahiste.
 *
 * ⚠️ MAX_STAKE YÜKSELİRSE TABLO DA UZAMALI. Aksi hâlde son kademe (1 LC)
 * yüksek bahislere de uygulanır ve kasa payı sessizce %1'in altına düşer.
 * `tests/duello-kesinti-tam-sayi.test.cjs` bunu nöbetle tutuyor.
 */

const MIN_STAKE = 1;
const MAX_STAKE = 12;

/**
 * Kademeler: `altBahis` ve üzeri bahislerde `kesinti` LC alınır.
 * Artan sırada olmalı; son eşleşen kademe geçerlidir.
 */
const KASA_TABLOSU = Object.freeze([
  Object.freeze({ altBahis: 1, kesinti: 0 }),
  Object.freeze({ altBahis: 5, kesinti: 1 }),
]);

/** Bahis için kasa payı (TAM SAYI LC). */
function kasaPayi(bahis) {
  const s = Math.floor(Number(bahis) || 0);
  let kesinti = 0;
  for (const k of KASA_TABLOSU) if (s >= k.altBahis) kesinti = k.kesinti;
  return kesinti;
}

/**
 * Bir bahsin havuz / kasa payı / ödülü. Üçü de TAM SAYI ve
 * `houseCut + winAmount === pot` her zaman doğru.
 */
function duelloPaylari(bahis) {
  const s = Math.max(0, Math.floor(Number(bahis) || 0));
  const pot = s * 2;
  /* Kademe tablosu havuzdan büyük bir kesinti taşırsa ödül eksiye düşerdi;
   * tablo bugün öyle değil ama kısıt hesabın İÇİNDE dursun. */
  const houseCut = Math.min(kasaPayi(s), pot);
  return { pot, houseCut, winAmount: pot - houseCut };
}

/** İzinli her bahis için ödül satırı — istemciye bu gönderilir. */
function odulTablosu() {
  const satirlar = [];
  for (let s = MIN_STAKE; s <= MAX_STAKE; s++) {
    satirlar.push({ stake: s, ...duelloPaylari(s) });
  }
  return satirlar;
}

/**
 * ESKİ İSTEMCİLER İÇİN yüzde — kullanımdan kalkıyor.
 *
 * Sahadaki eski sürümler `houseCutPct` alanını okuyup kazancı KENDİ
 * hesaplıyor. Alan hiç gönderilmezse kendi varsayılanlarına (0.05) düşerler ve
 * bahis 5'te 9.5 LC vaat ederler — gerçek ödül 9. FAZLA vaat, yanlış yön.
 *
 * Bu yüzden aralıktaki EN YÜKSEK efektif oran gönderiliyor: eski ekran her
 * bahiste ödülü olduğundan AZ gösterir, asla fazla. Yeni ekran bu alanı hiç
 * okumuyor, `odulTablosu`yu kullanıyor.
 */
function eskiIstemciKesintiOrani() {
  let enYuksek = 0;
  for (const { pot, houseCut } of odulTablosu()) {
    if (pot > 0) enYuksek = Math.max(enYuksek, houseCut / pot);
  }
  return enYuksek;
}

module.exports = {
  MIN_STAKE, MAX_STAKE, KASA_TABLOSU,
  kasaPayi, duelloPaylari, odulTablosu, eskiIstemciKesintiOrani,
};
