"use strict";

/**
 * HAFTALIK KUPON — oyun kuralları ve EKONOMİ.
 *
 * ⚠️ EN ÖNEMLİ TEST BURADA: `ekonomi` bloğu. Kupon ödülü HAVUZDAN DEĞİL,
 * başarıdan ÜRETİLİYOR — yani LC basıyor. Kademeler ortalama oyuncu için
 * giriş bedelinin ALTINDA kalacak şekilde ölçülerek seçildi. Biri "ödülü
 * artıralım" diye kademeleri yükseltirse bu test uyarır.
 *
 * Bu oturumda ekonominin sessizce şiştiği birkaç yol kapatıldı (koşulsuz
 * günlük hak, mini turnuva musluğu, mağaza mock modu). Kupon bilinçli bir
 * LC kaynağı ama ölçülü olmak zorunda.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const K = require("../lib/kupon.cjs");

describe("kupon — puanlama ve yüzdesel ceza", () => {
  test("doğru sayısıyla puan artar", () => {
    const p4 = K.puanla(4, 8), p6 = K.puanla(6, 8);
    assert.ok(p6.puan > p4.puan);
  });

  test("eşiğin ALTINDA yüzdesel ceza uygulanır", () => {
    const dusuk = K.puanla(2, 8);   // %25 — eşik %40'ın altında
    assert.ok(dusuk.ceza > 0, "ceza uygulanmamis");
    assert.equal(dusuk.puan, dusuk.taban - dusuk.ceza);
    // Ceza ORANSAL olmalı: kupon boyutundan bağımsız aynı caydırıcılık.
    assert.equal(dusuk.ceza, Math.round(dusuk.taban * K.CEZA_ORANI * 10) / 10);
  });

  test("eşiğin ÜSTÜNDE ceza yok", () => {
    assert.equal(K.puanla(4, 8).ceza, 0, "esik ustunde ceza var");
    assert.equal(K.puanla(8, 8).ceza, 0);
  });

  test("hiç doğru yoksa ceza da 0 — eksiye düşülmez", () => {
    const s = K.puanla(0, 8);
    assert.equal(s.ceza, 0);
    assert.equal(s.puan, 0);
  });

  test("tam kupon bonus alır", () => {
    assert.ok(K.puanla(8, 8).bonus > 0);
    assert.equal(K.puanla(7, 8).bonus, 0);
  });
});

describe("kupon — ödül kademeleri", () => {
  test("ödül orana göre, maç sayısına değil (8 ve 6 maçlık kupon uyumlu)", () => {
    assert.equal(K.odul(8, 8, K.TUR.ULKE), K.odul(6, 6, K.TUR.ULKE));
  });

  test("eşik altı ödül vermez", () => {
    assert.equal(K.odul(4, 8, K.TUR.ULKE), 0, "yarisini bilen odul aliyor");
    assert.ok(K.odul(5, 8, K.TUR.ULKE) > 0);
  });

  test("Avrupa kuponu daha yüksek öder (daha zor, girişi de pahalı)", () => {
    assert.ok(K.odul(6, 6, K.TUR.AVRUPA) > K.odul(8, 8, K.TUR.ULKE));
    assert.ok(K.GIRIS_BEDELI[K.TUR.AVRUPA] > K.GIRIS_BEDELI[K.TUR.ULKE]);
  });
});

describe("kupon — EKONOMİ (LC basıyor, ölçülü olmalı)", () => {
  /**
   * Beklenen ödül, isabet olasılığına göre binom dağılımıyla hesaplanır.
   * Ortalama bir oyuncu 1X2'de %45-50 tutturur; bu aralıkta oyun LC YAKMALI.
   */
  test("rastgele oynayan (%33) net KAYBEDER", () => {
    const b = K.beklenenOdul(1 / 3, 8, K.TUR.ULKE);
    assert.ok(b < K.GIRIS_BEDELI[K.TUR.ULKE],
      `rastgele oyuncu kar ediyor (${b} >= ${K.GIRIS_BEDELI[K.TUR.ULKE]}) — LC muslugu`);
  });

  test("ortalama oyuncu (%50) net KAYBEDER", () => {
    const b = K.beklenenOdul(0.5, 8, K.TUR.ULKE);
    assert.ok(b < K.GIRIS_BEDELI[K.TUR.ULKE],
      `ortalama oyuncuda oyun LC basiyor (${b}) — kademeler fazla comert`);
  });

  test("Avrupa kuponu da ortalama oyuncuda kaybettirir", () => {
    const b = K.beklenenOdul(0.5, 6, K.TUR.AVRUPA);
    assert.ok(b < K.GIRIS_BEDELI[K.TUR.AVRUPA], `avrupa kuponu LC basiyor (${b})`);
  });

  test("gerçekten iyi oyuncu (%60) kazanabilmeli — oyun oynanabilir kalsın", () => {
    const b = K.beklenenOdul(0.6, 8, K.TUR.ULKE);
    assert.ok(b > K.GIRIS_BEDELI[K.TUR.ULKE] * 0.9,
      "cok iyi oyuncu bile kaybediyor — odul anlamsiz, kimse oynamaz");
  });

  test("kupon tek tek oynamaktan UCUZ olmalı", () => {
    const { MAC_GIRIS_BEDELI } = require("../lib/ekonomi.cjs");
    const tekTek = MAC_GIRIS_BEDELI * K.MAC_SAYISI[K.TUR.ULKE];
    assert.ok(K.GIRIS_BEDELI[K.TUR.ULKE] < tekTek,
      `kupon (${K.GIRIS_BEDELI[K.TUR.ULKE]}) tek tek oynamaktan (${tekTek}) pahali — anlamsiz`);
  });
});
