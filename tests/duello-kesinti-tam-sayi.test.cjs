"use strict";

/**
 * DÜELLO ÖDÜLLERİ TAM SAYI — ve toplam havuza TAM eşit.
 *
 * ⚠️ KUSUR (2026-08-05 ölçüldü, canlı): kesinti yüzdeydi —
 *
 *     houseCut  = Math.round(pot * 0.05 * 10) / 10;
 *     winAmount = Math.round((pot - houseCut) * 10) / 10;
 *
 * 1..12 bahis aralığında 12 bahsin 11'i KESİRLİ ödül üretiyordu (1 → 1.9,
 * 2 → 3.8, 3 → 5.7). Toplam korunuyordu, yani LC yoktan çıkmıyor/yanmıyordu;
 * sorun `lib/wallet-credit.cjs`teydi: bakiye `$inc: { balance: tutar }` ile
 * büyüyor ve HİÇ yuvarlanmıyor, kesirler IEEE754'te birikiyordu —
 *
 *     1.9 × 20 kredi  → 37.999999999999986
 *     5.7 × 100 kredi → 569.9999999999998
 *
 * Bu test iki şeyi birden tutuyor: ödüllerin tam sayı KALDIĞINI ve kesintinin
 * SIFIRA çökmediğini. İkincisi önemli, çünkü tam sayıya geçmenin en kolay yolu
 * (`Math.floor(pot * 0.05)`) bahis 1-9 arasında kasa payını sıfırlıyor — yani
 * kusuru "düzeltirken" kasa gelirini sessizce silmek mümkün.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const K = require("../lib/duello-kesinti.cjs");

/* ── Kurulum: ölçüm gerçekten üretim yolundan geçiyor mu? ─────────────────── */

describe("kurulum", () => {
  test("üretim rotası hesabı BU modülden alıyor", () => {
    /* ⚠️ Modülü tek başına sınamak yetmez: `routes/duels.cjs` kendi kopyasını
     * tutmaya dönerse bu dosya yeşil kalır ve hiçbir şey ölçmez. */
    const src = fs.readFileSync(path.join(__dirname, "..", "routes", "duels.cjs"), "utf8");
    assert.ok(/require\("\.\.\/lib\/duello-kesinti\.cjs"\)/.test(src),
      "duels.cjs kesinti modulunu kullanmiyor — test bir sey olcmuyor");
    assert.ok(/duelloPaylari\(s\)/.test(src),
      "duello olusturulurken duelloPaylari cagrilmiyor — hesap yeniden kopyalanmis olabilir");
    assert.ok(!/HOUSE_CUT_PCT\s*=/.test(src),
      "duels.cjs hala kendi yuzde sabitini tasiyor — iki kural ayrisir");
  });

  test("bahis aralığı okunabiliyor", () => {
    assert.ok(Number.isInteger(K.MIN_STAKE) && Number.isInteger(K.MAX_STAKE));
    assert.ok(K.MIN_STAKE >= 1 && K.MIN_STAKE < K.MAX_STAKE,
      `mantiksiz aralik: ${K.MIN_STAKE}..${K.MAX_STAKE}`);
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("izinli bahis aralığının TAMAMINDA", () => {
  const satirlar = K.odulTablosu();

  test("tablo aralığın tamamını kapsıyor", () => {
    assert.equal(satirlar.length, K.MAX_STAKE - K.MIN_STAKE + 1);
    assert.equal(satirlar[0].stake, K.MIN_STAKE);
    assert.equal(satirlar[satirlar.length - 1].stake, K.MAX_STAKE);
  });

  test("ödül, kasa payı ve havuz TAM SAYI", () => {
    for (const { stake, pot, houseCut, winAmount } of satirlar) {
      assert.ok(Number.isInteger(winAmount),
        `bahis ${stake}: odul ${winAmount} kesirli — cuzdan $inc'i yuvarlamiyor, hata birikir`);
      assert.ok(Number.isInteger(houseCut), `bahis ${stake}: kasa payi ${houseCut} kesirli`);
      assert.ok(Number.isInteger(pot), `bahis ${stake}: havuz ${pot} kesirli`);
    }
  });

  test("toplam havuza TAM eşit — ne enflasyon ne yakma", () => {
    /* ⚠️ `lib/pay-dagitim.cjs` notundaki ders: yalnızca aşağı yuvarlamak
     * enflasyonu bitirir ama bu kez sürekli LC yakar. İki yön de sınanıyor. */
    for (const { stake, pot, houseCut, winAmount } of satirlar) {
      assert.equal(houseCut + winAmount, pot,
        `bahis ${stake}: kasa ${houseCut} + odul ${winAmount} != havuz ${pot}`);
    }
  });

  test("kazanan yatırdığından FAZLA alıyor", () => {
    for (const { stake, winAmount } of satirlar) {
      assert.ok(winAmount > stake,
        `bahis ${stake}: kazanan ${winAmount} aliyor — duello oynamak anlamsizlasir`);
    }
  });
});

/* ── Kasa payı sıfıra çökmedi ────────────────────────────────────────────── */

describe("kasa geliri korunuyor", () => {
  test("bahislerin ÇOĞUNLUĞUNDA kesinti alınıyor", () => {
    /**
     * ⚠️ ASIL TUZAK. `Math.floor(pot * 0.05)` ödülleri tam sayı yapar ama
     * bahis 1-9 arasında kesintiyi SIFIRLAR — kusur "düzelmiş" görünürken
     * kasa geliri yok olur. Ölçüldü: floor kuralıyla 12 bahsin 9'u kesintisiz.
     */
    const satirlar = K.odulTablosu();
    const kesintili = satirlar.filter((x) => x.houseCut > 0).length;
    assert.ok(kesintili >= Math.ceil(satirlar.length / 2),
      `${satirlar.length} bahsin yalnizca ${kesintili}'inde kesinti var — kasa geliri cokmus`);
  });

  test("efektif oran mantıklı bir bantta kalıyor", () => {
    /**
     * ⚠️ MAX_STAKE YÜKSELİRSE TABLO DA UZAMALI. Uzamazsa son kademe (1 LC)
     * yüksek bahislere de uygulanır: bahis 100'de 1/200 = %0.5, yani kasa payı
     * sessizce buharlaşır. Bu iddia o sessiz kaymayı yakalar.
     */
    for (const { stake, pot, houseCut } of K.odulTablosu()) {
      if (houseCut === 0) continue;              // düşük bahis kademesi — kasıtlı
      const oran = houseCut / pot;
      assert.ok(oran >= 0.02 && oran <= 0.15,
        `bahis ${stake}: efektif kasa orani %${(oran * 100).toFixed(1)} — ` +
        `kademe tablosu bahis araligini artik kapsamiyor olabilir`);
    }
  });

  test("aralık ortalaması eski %5'e yakın kalıyor", () => {
    const satirlar = K.odulTablosu();
    const kasa = satirlar.reduce((a, x) => a + x.houseCut, 0);
    const havuz = satirlar.reduce((a, x) => a + x.pot, 0);
    const oran = kasa / havuz;
    assert.ok(oran >= 0.03 && oran <= 0.08,
      `ortalama kasa orani %${(oran * 100).toFixed(1)} — eski %5'ten ciddi sapma, ` +
      `bu bir EKONOMI degisikligi ve kasitli olmali`);
  });
});

/* ── Ölçümün dayanağı: eski kural gerçekten kusurluydu ───────────────────── */

describe("olumsuz denetim", () => {
  test("ESKİ yüzde kuralı bu iddiaları GEÇEMEZ", () => {
    /**
     * ⚠️ Testin kendisini sınıyor: yeni kural geçtiği için değil, eski kural
     * KALDIĞI için yeşil olsaydı hiçbir şey korunmuyor olurdu.
     */
    const eski = (s) => {
      const pot = s * 2;
      const houseCut = Math.round(pot * 0.05 * 10) / 10;
      return { pot, houseCut, winAmount: Math.round((pot - houseCut) * 10) / 10 };
    };
    let kesirli = 0;
    for (let s = K.MIN_STAKE; s <= K.MAX_STAKE; s++) {
      if (!Number.isInteger(eski(s).winAmount)) kesirli++;
    }
    assert.ok(kesirli > 0,
      "eski kural da tam sayi uretiyor — bu aralikta olculen kusur yok, testin dayanagi yanlis");
  });

  test("kesirli ödüller cüzdanda GERÇEKTEN birikiyordu", () => {
    /* Mongo `$inc` aynı IEEE754 aritmetiğini kullanıyor. */
    let bakiye = 0;
    for (let i = 0; i < 20; i++) bakiye += 1.9;
    assert.notEqual(bakiye, 38, "bu ortamda birikme yok — duzeltmenin gerekcesi degismis");

    /* Yeni kuralla aynı sayıda kredi: artık tam. */
    let yeni = 0;
    const odul = K.duelloPaylari(1).winAmount;
    for (let i = 0; i < 20; i++) yeni += odul;
    assert.equal(yeni, odul * 20, `${odul} x 20 birikti: ${yeni}`);
  });
});
