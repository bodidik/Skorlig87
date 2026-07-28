"use strict";

/**
 * TheSportsDB saat → ISO dönüşümü.
 *
 * NEDEN TEST EDİLİYOR: Eski kod `${dateEvent}T${strTime}:00Z` yazıyordu ve
 * TSDB `strTime`'ı bazen saniyeli döndürüyor. O durumda sonuç
 * "2026-07-28T22:00:00:00Z" oluyordu — geçersiz ISO, `Date.parse` NaN.
 *
 * Bozulma SESSİZ: hata fırlatılmıyor, maç yalnızca yanlış sıralanıyor ya da
 * pencere filtresinden eleniyor. Üretimde iki fikstürde görüldü ve ancak
 * veriyi elle ayrıştırınca fark edildi.
 *
 * Çalıştırma:  npm test
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { tsdbKickoffISO } = require("../lib/tsdb-time.cjs");

const gecerli = (iso) => Number.isFinite(Date.parse(iso));

describe("tsdbKickoffISO", () => {
  test("saatsiz biçim (HH:mm) — eski kodun DOĞRU çalıştığı hâl", () => {
    const r = tsdbKickoffISO("2026-07-28", "22:00");
    assert.equal(r, "2026-07-28T22:00:00Z");
    assert.ok(gecerli(r));
  });

  test("SANİYELİ biçim (HH:mm:ss) — asıl hata buradaydı", () => {
    // Eski kod: "2026-07-28T22:00:00" + ":00Z" = "...22:00:00:00Z" → NaN
    const r = tsdbKickoffISO("2026-07-28", "22:00:00");
    assert.equal(r, "2026-07-28T22:00:00Z");
    assert.ok(gecerli(r), "ayristirilabilir olmali");
  });

  test("saat dilimi eki temizlenir", () => {
    assert.equal(tsdbKickoffISO("2026-07-28", "22:00:00+00:00"), "2026-07-28T22:00:00Z");
    assert.equal(tsdbKickoffISO("2026-07-28", "22:00Z"), "2026-07-28T22:00:00Z");
  });

  test("tek haneli saat sıfırla doldurulur", () => {
    assert.equal(tsdbKickoffISO("2026-07-28", "9:05"), "2026-07-28T09:05:00Z");
  });

  test("saat yoksa gün başına sabitlenir", () => {
    const r = tsdbKickoffISO("2026-07-28", "");
    assert.equal(r, "2026-07-28T00:00:00Z");
    assert.ok(gecerli(r));
  });

  test("geçersiz gün null döner", () => {
    assert.equal(tsdbKickoffISO("", "22:00"), null);
    assert.equal(tsdbKickoffISO("28.07.2026", "22:00"), null);
    assert.equal(tsdbKickoffISO(null, "22:00"), null);
  });

  test("bozuk saat null döner (uydurma tarih üretmez)", () => {
    // Sessizce yanlış bir zaman üretmek, null dönmekten kötüdür: maç
    // listede yanlış yerde görünür ve kimse fark etmez.
    assert.equal(tsdbKickoffISO("2026-07-28", "aksam"), null);
    assert.equal(tsdbKickoffISO("2026-07-28", "22"), null);
  });

  test("uretilen her deger AYRISTIRILABILIR", () => {
    const girdiler = ["22:00", "22:00:00", "9:05", "00:00", "23:59:59", ""];
    for (const t of girdiler) {
      const r = tsdbKickoffISO("2026-07-28", t);
      assert.ok(r && gecerli(r), `"${t}" icin gecerli ISO uretilmeli, gelen: ${r}`);
    }
  });
});
