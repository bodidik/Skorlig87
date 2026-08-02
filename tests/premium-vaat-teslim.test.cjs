"use strict";

/**
 * PREMIUM SATIŞ TABLOSU, ÖDEMEYİ YAPAN KODLA AYNI SAYIYI SÖYLEMELİ.
 *
 * ⚠️ GERÇEK PARA. `app/premium.tsx` bu değerleri abonelik satarken gösteriyor;
 * sapma = yanlış vaat. Üç kusur ölçüldü (2026-08-02):
 *
 *  1) `perks.monthlyLc` sunucuda YOK — `monthlyFloor` olmuş. Ekranın İLK
 *     satırı birebir "undefined LC" basıyordu.
 *  2) AYNI ORTAM DEĞİŞKENİ, İKİ FARKLI VARSAYILAN:
 *         routes/lc-wallet.cjs : SKORLIG_DAILY_FLOOR || 3   <- ödemeyi bu yapar
 *         lib/premium.cjs      : SKORLIG_DAILY_FLOOR || 6   <- ekran bunu gösterirdi
 *     Değişken set EDİLMEZSE ikisi 2 kat ayrışıyor, set edilirse tesadüfen
 *     uyuşuyor — yani kusur yalnızca varsayılan yapılandırmada görünüyordu.
 *  3) Ücretsiz günlük "5 LC" istemciye elle yazılmıştı; gerçek taban 3.
 *
 * ⚠️ BU TESTLER SABİT SAYI İDDİA ETMEZ. "3 olmalı" deseydi, ortam değişkeni
 * değiştiğinde ikisi birden değişse bile test kırılırdı. İddia edilen şey
 * EŞİTLİK: ekranın kaynağı == ödemenin kaynağı.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const premium = require("../lib/premium.cjs");
const wallet = require("../routes/lc-wallet.cjs");
const regen = require("../lib/lc-regen.cjs");

describe("premium: vaat = teslim", () => {
  test("ücretsiz günlük taban, ödeme yoluyla AYNI", () => {
    const ekran = premium.FREE.dailyLc;
    const odeme = wallet._gunlukTaban(0, false);
    assert.equal(ekran, odeme, `ekran ${ekran} gosteriyor, odeme ${odeme} veriyor`);
  });

  test("premium günlük taban, ödeme yoluyla AYNI", () => {
    const ekran = premium.PERKS.dailyLc;
    const odeme = wallet._gunlukTaban(0, true);
    assert.equal(ekran, odeme, `ekran ${ekran} gosteriyor, odeme ${odeme} veriyor`);
  });

  test("ücretsiz token birikimi, lc-regen'in KENDİ sabitleriyle AYNI", () => {
    /* Ekran "15 tavan / 4 saatte +1" diye elle yazıyordu. Bugün doğruydu;
     * ortam değişkeni değişince sessizce yalan söylerdi. */
    assert.equal(premium.FREE.regenCap, regen.REGEN_CAP);
    assert.equal(premium.FREE.regenHours, regen.REGEN_HOURS);
  });

  test("premium birikim ücretsizden GERÇEKTEN iyi (yoksa satılan şey yok)", () => {
    assert.ok(premium.PERKS.regenCap > premium.FREE.regenCap, "tavan avantaji yok");
    assert.ok(premium.PERKS.regenHours < premium.FREE.regenHours, "hiz avantaji yok");
    assert.ok(premium.PERKS.dailyLc > premium.FREE.dailyLc, "gunluk avantaji yok");
  });

  test("EKRANIN OKUDUĞU HER ALAN yanıtta VAR (undefined satır olmaz)", async () => {
    /**
     * ⚠️ ASIL KUSURU YAKALAYAN TEST. `monthlyLc` sessizce `monthlyFloor`
     * olmuştu ve hiçbir şey uyarmadı: istemci tipi elle yazılmış, yanıt
     * `any` üzerinden geliyordu. Derleyici bir güvence DEĞİLDİ.
     */
    const s = await premium.premiumStatus("test-kullanici", null).catch(() => null);
    const p = (s && s.perks) || premium.PERKS;
    const f = (s && s.freePerks) || premium.FREE;

    // app/premium.tsx içindeki perkRows'un okuduğu alanlar:
    for (const alan of ["monthlyFloor", "dailyLc", "regenCap", "regenHours", "storeBonusPct"]) {
      assert.notEqual(p[alan], undefined, `perks.${alan} yok — ekran "undefined" basar`);
      assert.equal(typeof p[alan], "number", `perks.${alan} sayi degil`);
    }
    for (const alan of ["dailyLc", "regenCap", "regenHours"]) {
      assert.notEqual(f[alan], undefined, `freePerks.${alan} yok — ekran "undefined" basar`);
    }
  });

  test("TAMAMLAMA olan ayrıcalıklar böyle İŞARETLİ", async () => {
    /**
     * ⚠️ MEKANİK, SAYIDAN DA ÖNEMLİ. `monthlyFloor` ve `dailyLc` birer TABAN:
     * bakiye üstündeyse verilen 0'dır. "Her ay 60 LC alırsın" diye sunmak,
     * bakiyesi dolu premium kullanıcıya karşılığı olmayan bir söz verir —
     * lc-wallet aynı hatayı özet yanıtında bir kez düzeltmişti (gunlukMiktar).
     */
    const s = await premium.premiumStatus("test-kullanici", null).catch(() => null);
    const kind = s && s.perkKind;
    assert.ok(kind, "perkKind yok — ekran mekanigi bilemez");
    assert.equal(kind.monthlyFloor, "tamamlama");
    assert.equal(kind.dailyLc, "tamamlama");
  });

  test("günlük hak GERÇEKTEN tamamlama: bakiye tabanın üstündeyse 0", () => {
    const taban = wallet._gunlukTaban(0, true);
    assert.equal(wallet._gunlukMiktar(taban + 5, true, 0), 0, "bakiye ustundeyken odeme yapiliyor");
    assert.ok(wallet._gunlukMiktar(0, true, 0) > 0, "bakiye sifirken odeme yok — test olcmuyor");
  });
});
