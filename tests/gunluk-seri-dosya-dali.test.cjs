"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KAYNAK = path.join(__dirname, "..", "routes", "lc-wallet.cjs");

describe("gunluk LC dosya dali seri bonusu", () => {
  test("dosya dali gunlukMiktar cagrisinda seri argumani var", () => {
    const src = fs.readFileSync(KAYNAK, "utf8");
    const dosyaDali = src.indexOf("// FILE-MODE daily claim");
    const mongoDali = src.indexOf("// MONGO-MODE daily claim");

    const fileSection = dosyaDali > 0
      ? src.slice(dosyaDali)
      : src.slice(src.indexOf("ensureWalletUserFile"));

    const seriKullanimi = /seriDevamMi\(/.test(fileSection);
    assert.ok(seriKullanimi,
      "dosya dalinda seriDevamMi kullanilmiyor — seri hesabi atlanmis");
  });

  test("gunlukMiktar 3. argumansiz seri bonusu vermez", () => {
    const { _gunlukMiktar: gm } = require(KAYNAK);
    const seriSiz = gm(0, false);
    const seriIle3 = gm(0, false, 3);
    const seriIle7 = gm(0, false, 7);

    assert.ok(seriIle3 >= seriSiz,
      "3 gunluk serinin bonusu tabandan kucuk — seri tabanlar bozuk");
    assert.ok(seriIle7 >= seriIle3,
      "7 gunluk serinin bonusu 3 gunden kucuk — seri tabanlar bozuk");
    assert.ok(seriIle7 > seriSiz,
      "7 gunluk seri bonusu seriSiz ile ayni — seri hic fark yaratmiyor");
  });

  test("dosya dali dailyStreak alanini guncelliyor", () => {
    const src = fs.readFileSync(KAYNAK, "utf8");
    const dosyaDaliBas = src.indexOf("ensureWalletUserFile");
    assert.ok(dosyaDaliBas > 0, "dosya dali bulunamadi");
    const dosyaDali = src.slice(dosyaDaliBas);

    assert.ok(/u\.dailyStreak\s*=/.test(dosyaDali),
      "dosya dalinda dailyStreak guncellenmemis — seri sifirlaniyor her seferinde");
  });

  test("NEGATIF: seri argumani kaldirilirsa bonus kaybolur", () => {
    const { _gunlukMiktar: gm } = require(KAYNAK);
    const seriSiz = gm(0, false);
    const seriSiz2 = gm(0, false, undefined);
    assert.equal(seriSiz, seriSiz2,
      "argumansiz ve undefined farkli sonuc veriyor — gunlukTaban tutarsiz");
  });
});
