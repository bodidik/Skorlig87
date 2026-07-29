"use strict";

/**
 * Ekonomi denge kuralları.
 *
 * NEDEN VAR (ölçüldü 2026-07-29): LC arzı kontrolsüzdü — giriş 2.182 / çıkış 15,
 * oran 145:1. Sebep iki delikti:
 *
 *   1) İade eşiği `base > 0` idi → "kıl payı bildim" bile kârlıydı.
 *      1291 gerçek oyuncunun performansıyla: oyuncuların **%100'ü** her maçta
 *      kâr ediyordu, ortalama +2.21 LC.
 *   2) Günlük hak koşulsuz ekleniyordu → oynamayan bile biriktiriyordu,
 *      aylık +143 LC.
 *
 * Bu kurallar sessizce geri kayarsa belirti "para hatası" değil, "ekonomi
 * yavaşça şişiyor" olur — aylar sonra fark edilir. O yüzden testle tutuluyor.
 *
 * Çalıştırma:  npm test
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { _dagilim, _akis } = require("../lib/economy-report.cjs");

// settle2'deki kuralın birebir kopyası — orada değişirse burada da değişmeli.
const LC_ENTRY_COST = 3;
const odul = (b) =>
  b >= 30 ? 15 : b >= 20 ? 10 : b >= 12 ? 7 : b >= 6 ? 4 : b >= 3 ? 2 : b > 0 ? 1 : 0;

function netLc(base, esik) {
  const iade = base >= esik ? LC_ENTRY_COST : 0;
  return iade + odul(base) - LC_ENTRY_COST;
}

describe("iade eşiği", () => {
  test("ESKİ kural (base>0) neredeyse her tahmini kârlı yapıyordu", () => {
    // Regresyon kaydı: bu davranışa dönülürse enflasyon geri gelir.
    assert.equal(netLc(1, 1), 1, "kıl payı bilen bile +1 kazanıyordu");
    assert.equal(netLc(3, 1), 2, "medyan oyuncu +2");
    assert.equal(netLc(0, 1), -3, "yalnızca TAMAMEN yanılan kaybediyordu");
  });

  test("YENİ kural (base>=6): zayıf tahmin artık kaybettirir", () => {
    assert.equal(netLc(0, 6), -3);
    assert.equal(netLc(1, 6), -2);
    assert.equal(netLc(3, 6), -1, "medyan oyuncu artık hafif negatif");
  });

  test("gerçek isabet hâlâ kazandırır", () => {
    assert.equal(netLc(6, 6), 4);
    assert.equal(netLc(12, 6), 7);
    assert.equal(netLc(30, 6), 15);
  });

  test("eşik yükseldikçe ortalama düşer (yön kontrolü)", () => {
    const ortalama = (esik) =>
      [0, 1, 3, 6, 12, 20, 30].reduce((a, b) => a + netLc(b, esik), 0) / 7;
    assert.ok(ortalama(1) > ortalama(6), "base>0 en enflasyonist olmalı");
    assert.ok(ortalama(6) > ortalama(12));
  });
});

describe("günlük hak — tabana tamamlama", () => {
  // routes/lc-wallet.cjs gunlukMiktar ile aynı kural.
  // routes/lc-wallet.cjs ile AYNI: taban bir gunluk oyun bedelinden az olmali
  // (taban 15 iken 5 tahmin kaybeden ertesi gun tam tamamlanir = kayip bedava).
  const TABAN = 6;
  const gunluk = (bakiye, taban = TABAN) =>
    bakiye >= taban ? 0 : Math.round((taban - bakiye) * 10) / 10;

  test("parasız oyuncuya tabana kadar verilir", () => {
    assert.equal(gunluk(0), 6);
    assert.equal(gunluk(2), 4, "medyan bakiye 2 LC ölçülmüştü");
  });

  test("ZENGİN oyuncuya HİÇBİR ŞEY verilmez", () => {
    // Asıl düzeltme bu: eskiden 229 LC'si olan da her gün +5 alıyordu.
    assert.equal(gunluk(6), 0);
    assert.equal(gunluk(100), 0);
    assert.equal(gunluk(229), 0);
  });

  test("arz oyuncu sayısıyla SINIRLI kalır", () => {
    // Koşulsuz eklemede toplam arz zamanla sonsuza gider; tabanla sınırlıdır.
    const oyuncular = [0, 2, 5, 15, 50, 229];
    const eklenen = oyuncular.reduce((a, b) => a + gunluk(b), 0);
    const ustSinir = oyuncular.length * TABAN;
    assert.ok(eklenen <= ustSinir, "günlük ekleme oyuncu×taban'ı aşamaz");
    assert.equal(eklenen, 6 + 4 + 1, "yalnızca taban altındakiler alır");
  });

  test("KAYIP BEDAVA OLMAMALI — taban < günlük oyun bedeli", () => {
    // Kendi ilk önerimdeki kusur buydu: taban 15 iken oyuncu 5 tahmin yapıp
    // (5×3=15 LC) hepsini kaybetse ertesi gün tam tamamlanıyordu — zararı
    // sistem karşılıyor, iade eşiği düzeltmesi anlamsızlaşıyordu.
    const GIRIS_BEDELI = 3;
    assert.ok(TABAN < GIRIS_BEDELI * 3, "taban 3 maçlık bedelin altında kalmalı");
    assert.equal(TABAN / GIRIS_BEDELI, 2, "taban = 2 maç");
  });

  test("premium yüksek TABAN alır, koşulsuz para değil", () => {
    assert.equal(gunluk(8, 12), 4, "premium tabanı 12");
    assert.equal(gunluk(12, 12), 0, "tabanı aşan premium da 0 alır");
  });
});

describe("ekonomi raporu", () => {
  test("dağılım ve yoğunlaşma", () => {
    const d = _dagilim([1, 1, 2, 2, 2, 5, 10, 50, 100, 900]);
    assert.equal(d.cuzdan, 10);
    assert.equal(d.toplamArz, 1073);
    assert.equal(d.medyan, 5);
    assert.equal(d.max, 900);
    // Tek oyuncu arzın çoğunu tutuyorsa erken uyarı işareti.
    assert.ok(d.enZenginYuzde10Payi >= 80, "yoğunlaşma yakalanmalı");
  });

  test("akış: giriş/çıkış ayrımı ve oran", () => {
    const a = _akis(
      [
        { amount: 100, reason: "match_reward", createdAt: "2026-07-29T10:00:00Z" },
        { amount: 50, reason: "daily", createdAt: "2026-07-29T10:00:00Z" },
        { amount: -10, reason: "match_pred", createdAt: "2026-07-29T10:00:00Z" },
      ],
      null
    );
    assert.equal(a.toplamGiris, 150);
    assert.equal(a.toplamCikis, 10);
    assert.equal(a.girisCikisOrani, 15);
    assert.equal(a.durum, "ENFLASYONIST");
  });

  test("gider hiç yoksa oran null — sıfıra bölme yok", () => {
    const a = _akis([{ amount: 10, reason: "daily", createdAt: "2026-07-29T10:00:00Z" }], null);
    assert.equal(a.girisCikisOrani, null);
    assert.equal(a.durum, "ENFLASYONIST");
  });

  test("pencere dışındaki kayıtlar sayılmaz", () => {
    const a = _akis(
      [
        { amount: 100, reason: "eski", createdAt: "2020-01-01T00:00:00Z" },
        { amount: 5, reason: "yeni", createdAt: "2026-07-29T10:00:00Z" },
      ],
      "2026-07-01T00:00:00Z"
    );
    assert.equal(a.toplamGiris, 5, "eski kayıt pencereye girmemeli");
    assert.equal(a.islem, 1);
  });

  test("dengeli ekonomi doğru etiketlenir", () => {
    const a = _akis(
      [
        { amount: 50, reason: "odul", createdAt: "2026-07-29T10:00:00Z" },
        { amount: -50, reason: "giris", createdAt: "2026-07-29T10:00:00Z" },
      ],
      null
    );
    assert.equal(a.durum, "dengeli");
    assert.equal(a.girisCikisOrani, 1);
  });

  test("boş veri patlamaz", () => {
    const d = _dagilim([]);
    assert.equal(d.cuzdan, 0);
    assert.equal(d.toplamArz, 0);
    const a = _akis([], null);
    assert.equal(a.toplamGiris, 0);
    assert.equal(a.girisCikisOrani, null);
  });
});
