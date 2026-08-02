"use strict";

/**
 * DİZİN GEZEN TESTLER `statSync` YARIŞINA GİRMEZ.
 *
 * ⚠️ SÜİTİ ARADA BİR KIRAN KUSUR BUYDU — dört tur boyunca kovaladım.
 *
 * Sunucu çalışırken `data/` altına ATOMİK yazılıyor: önce `*.tmp`, sonra
 * rename. `readdirSync` dosyayı görüyor, `statSync`e gelene kadar rename
 * tamamlanıyor ve ENOENT atıyor:
 *
 *     ENOENT: no such file or directory, stat 'data/results.json.tmp'
 *
 * ÖLÇÜLDÜ (2026-08-02): 8-10 tam koşuda 1 kırılma; çıktısı saklanarak
 * yakalandı (`tests/tahmin-indeks-onarimi.test.cjs:152`).
 *
 * ⚠️ SABAH AYNI KÖKÜ BİR DOSYADA DÜZELTMİŞTİM (`guvenli-yol-siniri`) AMA
 * SINIFI TARAMAMIŞTIM — iki dosya daha aynı deseni taşıyordu ve kırılganlık
 * devam etti. Tekil düzeltmenin bedeli bu: kusur adını değiştirip geri gelir.
 *
 * ⚠️ ÇÖZÜM TOLERE ETMEK DEĞİL, YARIŞI KALDIRMAK: `readdirSync(d, {
 * withFileTypes: true })` dizin bilgisini readdir'in KENDİ sonucundan
 * veriyor — ikinci sistem çağrısı ve arada kalan pencere yok.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const T = path.join(__dirname);

/** Yorumları atarak kaynak metni verir (çıpa kendi notuna düşmesin). */
function kodu(dosya) {
  return fs.readFileSync(dosya, "utf8")
    .split(/\r?\n/)
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
    })
    .join("\n");
}

describe("dizin gezme yarışı", () => {
  test("tarama GERÇEKTEN test dosyası buluyor", () => {
    /* Sıfır sonuç kanıt değildir: kalıp bozulursa test sessizce yeşil kalır. */
    const hepsi = fs.readdirSync(T).filter((f) => f.endsWith(".test.cjs"));
    assert.ok(hepsi.length > 100, `yalnizca ${hepsi.length} test bulundu — tarama bozuk`);
    assert.ok(hepsi.some((f) => /readdirSync/.test(kodu(path.join(T, f)))),
      "hicbir test dizin gezmiyor gorunuyor — kalip bozuk");
  });

  test("readdirSync + statSync ikilisi HİÇBİR testte kalmadı", () => {
    /**
     * ⚠️ ASIL KURAL. Aynı dosyada hem `readdirSync` hem `statSync` varsa
     * gezme sırasında TOCTOU penceresi açılır ve canlı `data/` dizini
     * yazılırken test ÜRÜN KUSURU OLMADAN kırılır.
     *
     * `withFileTypes` kullanan dosyalar muaf değil — onlarda zaten `statSync`
     * kalmamalı; kalmışsa yarış hâlâ oradadır.
     */
    const suclu = [];
    for (const ad of fs.readdirSync(T)) {
      if (!ad.endsWith(".test.cjs")) continue;
      const src = kodu(path.join(T, ad));
      if (!/readdirSync/.test(src)) continue;
      if (!/\bl?statSync\s*\(/.test(src)) continue;
      // try/catch ile TOLERE edilmisse kabul: yaris var ama kirilmiyor.
      const tolere = /try\s*\{[^}]*l?statSync/.test(src);
      if (!tolere) suclu.push(`${ad}  (readdirSync + korumasiz statSync)`);
    }
    assert.deepEqual(suclu, [],
      "dizin gezerken statSync kullanan test(ler) — canli data/ yazilirken suit kirilir:\n" +
      suclu.join("\n") + "\n  Cozum: readdirSync(dizin, { withFileTypes: true }) ve girdi.isDirectory()");
  });

  test("düzeltilen iki dosya withFileTypes kullanıyor", () => {
    /* ⚠️ Kuralın sağlanması `statSync`i silmekle de mümkün; asıl istenen
     * yarışsız gezme. Bu iddia çözümün DOĞRU biçimini tutuyor. */
    for (const ad of ["tahmin-indeks-onarimi.test.cjs", "yonetici-basligi-gonderiliyor.test.cjs"]) {
      const p = path.join(T, ad);
      if (!fs.existsSync(p)) continue;
      const src = kodu(p);
      assert.ok(/withFileTypes:\s*true/.test(src), `${ad} withFileTypes kullanmiyor — yaris penceresi acik`);
      assert.ok(/isDirectory\(\)/.test(src), `${ad} dizin bilgisini readdir sonucundan almiyor`);
    }
  });
});
