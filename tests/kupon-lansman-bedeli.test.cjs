"use strict";

/**
 * KUPON BEDELİ HER DÖNEMDE TEK TEK OYNAMAKTAN UCUZ.
 *
 * ⚠️ BULUNAN (2026-08-08): kupon bedeli sabitti (ülke 10, Avrupa 15) ve
 * gerekçesi dosyada yazılıydı: "tek tek 8×3=24'ten ucuz olmalı". Lansman
 * tekli bedeli 1'e indirince 8 maç tek tek 8 LC oldu, kupon 10'da kaldı —
 * ana ekranın BİRİNCİL oyunu kendi değişmezini kırıp pahalı yola dönüştü
 * (30 LC ile başlayan yeni kullanıcı için bakiyenin üçte biri). Bedel artık
 * tekli bedel oranıyla ölçekleniyor; bu dosya değişmezi İKİ DÖNEMDE de
 * kilitler — sabit sayı taşımaz, ekonomiden türetir.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const KOK = path.join(__dirname, "..");

/** ekonomi+kupon modüllerini verilen lansman ortamıyla TAZE yükler. */
function tazeYukle(env) {
  const eski = {};
  for (const [k, v] of Object.entries(env)) {
    eski[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const yollar = [
    require.resolve(path.join(KOK, "lib", "ekonomi.cjs")),
    require.resolve(path.join(KOK, "lib", "kupon.cjs")),
  ];
  for (const y of yollar) delete require.cache[y];
  const E = require(path.join(KOK, "lib", "ekonomi.cjs"));
  const K = require(path.join(KOK, "lib", "kupon.cjs"));
  const geriAl = () => {
    for (const [k, v] of Object.entries(eski)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const y of yollar) delete require.cache[y];
    require(path.join(KOK, "lib", "ekonomi.cjs"));
    require(path.join(KOK, "lib", "kupon.cjs"));
  };
  return { E, K, geriAl };
}

describe("kupon bedeli dönemsel", () => {
  test("LANSMAN: kupon tek tek toplamından ucuz (10→3, 15→5)", () => {
    const { E, K, geriAl } = tazeYukle({
      SKORLIG_LANSMAN_BITIS: "2099-01-01T00:00:00Z",
      SKORLIG_LANSMAN_BEDELI: "1",
      SKORLIG_MATCH_COST: "3",
    });
    try {
      assert.equal(E.macGirisBedeli(), 1, "kurulum: lansman zorlanamadi");
      for (const tur of Object.values(K.TUR)) {
        const kupon = K.girisBedeli(tur);
        const tekTek = K.MAC_SAYISI[tur] * E.macGirisBedeli();
        assert.ok(kupon > 0, `${tur} kupon bedeli sifira dustu`);
        assert.ok(
          kupon < tekTek,
          `${tur}: kupon ${kupon} LC, tek tek ${tekTek} LC — birincil oyun pahali yol olmus`
        );
      }
      assert.equal(K.girisBedeli(K.TUR.ULKE), 3);
      assert.equal(K.girisBedeli(K.TUR.AVRUPA), 5);
    } finally { geriAl(); }
  });

  test("LANSMAN SONRASI: bedeller 10/15'e döner, değişmez yine tutar", () => {
    const { E, K, geriAl } = tazeYukle({
      SKORLIG_LANSMAN_BITIS: "2000-01-01T00:00:00Z", // geçmiş → lansman kapalı
      SKORLIG_MATCH_COST: "3",
    });
    try {
      assert.equal(E.macGirisBedeli(), 3, "kurulum: lansman kapatilamadi");
      assert.equal(K.girisBedeli(K.TUR.ULKE), 10, "donem sonrasi bedel eski degerine donmedi");
      assert.equal(K.girisBedeli(K.TUR.AVRUPA), 15);
      for (const tur of Object.values(K.TUR)) {
        assert.ok(
          K.girisBedeli(tur) < K.MAC_SAYISI[tur] * E.macGirisBedeli(),
          `${tur}: normal donemde de kupon tek tekten ucuz olmali`
        );
      }
    } finally { geriAl(); }
  });

  test("NÖBETÇİ: kupon oluşturma dinamik bedeli kullanıyor", () => {
    /* Sabit tabloya (GIRIS_BEDELI[tur]) dönen bir yeniden düzenleme,
     * lansmanda yine 10 LC yazardı — belge bir kez yazıldığı için hata
     * kupon ömrü boyunca kalıcı olurdu. */
    const fs = require("fs");
    const src = fs.readFileSync(path.join(KOK, "routes", "kupon.cjs"), "utf8")
      .split(/\r?\n/)
      .filter((l) => { const t = l.trim(); return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*"); })
      .join("\n");
    assert.ok(
      /girisBedeli:\s*Kupon\.girisBedeli\(/.test(src),
      "kupon olusturma Kupon.girisBedeli(tur) cagirmiyor — bedel donemi gormez"
    );
    assert.ok(
      !/girisBedeli:\s*Kupon\.GIRIS_BEDELI\[/.test(src),
      "kupon olusturma sabit tabloyu okuyor — lansmanda 10 LC yazar"
    );
  });
});
