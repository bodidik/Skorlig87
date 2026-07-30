"use strict";

/**
 * EKONOMİ SABİTLERİ TEK KAYNAKTAN GELMELİ.
 *
 * ⚠️ NEDEN VAR: açılış bakiyesi DÖRT dosyada, İKİ AYRI ADLA tanımlıydı
 * (`LC_START` ve `INITIAL_DEFAULT`). Değerler uyuşuyordu ama bu tesadüftü:
 * birini değiştiren kişi diğerini ARAMAZ, çünkü adı farklı. Sapma anında
 * kullanıcının açılış bakiyesi cüzdanını HANGİ KOD YOLUNUN oluşturduğuna
 * bağlı hale gelir ve bu hata üretmez — yalnızca sessiz adaletsizlik.
 *
 * Dosyalardaki yorumlar zaten "SENKRON tutulmalı" diyordu; elle senkron
 * gerektiren her sabit, sapmayı bekleyen bir hatadır.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const glob = { dizinler: ["routes", "lib", "services", "models"] };

const KOK = path.join(__dirname, "..");
const Ekonomi = require("../lib/ekonomi.cjs");

function kaynaklar() {
  const out = [];
  for (const d of glob.dizinler) {
    const tam = path.join(KOK, d);
    if (!fs.existsSync(tam)) continue;
    for (const ad of fs.readdirSync(tam)) {
      if (ad.endsWith(".cjs")) out.push([`${d}/${ad}`, fs.readFileSync(path.join(tam, ad), "utf8")]);
    }
  }
  return out;
}

describe("ekonomi sabitleri", () => {
  test("lib/ekonomi.cjs makul değerler veriyor", () => {
    assert.ok(Ekonomi.ACILIS_BAKIYESI > 0);
    assert.ok(Ekonomi.ACILIS_BAKIYESI_1987 >= Ekonomi.ACILIS_BAKIYESI,
      "1987 acilis bakiyesi normalden dusuk — uyelik degeri ters donmus");
    assert.ok(Ekonomi.MAC_GIRIS_BEDELI > 0);
  });

  test("eski adlar aynı değeri gösterir (geçiş kırılmasın)", () => {
    assert.equal(Ekonomi.LC_START, Ekonomi.ACILIS_BAKIYESI);
    assert.equal(Ekonomi.INITIAL_DEFAULT, Ekonomi.ACILIS_BAKIYESI);
    assert.equal(Ekonomi.INITIAL_1987, Ekonomi.ACILIS_BAKIYESI_1987);
    assert.equal(Ekonomi.LC_MATCH_COST, Ekonomi.MAC_GIRIS_BEDELI);
  });

  test("hiçbir dosya bu sabitleri yeniden TANIMLAMIYOR", () => {
    // `const LC_START = 30;` gibi sayısal yeniden tanımlar yasak;
    // `const { LC_START } = require(...)` serbest.
    const yasak = /^const\s+(LC_START|INITIAL_DEFAULT|INITIAL_1987|LC_MATCH_COST)\s*=\s*[0-9]/m;
    const ihlal = [];
    for (const [ad, src] of kaynaklar()) {
      if (ad === "lib/ekonomi.cjs") continue;
      if (yasak.test(src)) ihlal.push(ad);
    }
    assert.deepEqual(ihlal, [],
      "Bu dosyalar ekonomi sabitini yeniden tanimliyor: " + ihlal.join(", ") +
      "\nlib/ekonomi.cjs'ten import et — elle senkron sapmayi bekleyen hatadir.");
  });

  test("veri dizini hiçbir modülde sabit değil (test izolasyonu)", () => {
    // Bir entegrasyon testi GERÇEK data/preds.json'a yazmıştı: modüller
    // SKORLIG_DATA_DIR okumuyordu ve zincirdeki iki modül farklı dizine bakıyordu.
    const sabit = /const\s+DATA_DIR\s*=\s*path\.join\(__dirname/;
    const ihlal = [];
    for (const [ad, src] of kaynaklar()) {
      const m = src.match(sabit);
      if (m && !/SKORLIG_DATA_DIR/.test(src.slice(m.index, m.index + 160))) ihlal.push(ad);
    }
    assert.deepEqual(ihlal, [],
      "Bu dosyalar sabit veri yolu kullaniyor (testler gercek data/ dizinine yazar): " +
      ihlal.join(", "));
  });
});
