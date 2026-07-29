"use strict";

/**
 * SEZON — sıralamanın zaman penceresi.
 *
 * NEDEN VAR: kümülatif tek tablo zamanla kopuyor (bkz. docs/ekonomi-tasarim.md
 * §3.2). Sezon anahtarı iki yerde kritik:
 *   • settle2 yazarken bileşik anahtarın parçası
 *   • leaderboard okurken süzgeç
 * İkisi ayrışırsa tablo sessizce boşalır ya da hiç sıfırlanmaz.
 *
 * Çalıştırma:  npm test
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const Season = require("../lib/season.cjs");

describe("sezon anahtarı", () => {
  test("aylık biçim sıfır dolgulu ve SIRALANABİLİR", () => {
    // Arşiv sorguları anahtarları doğrudan karşılaştırıyor; "2026-9" olsaydı
    // "2026-10" < "2026-9" çıkardı.
    const k = Season.seasonKey(new Date("2026-03-15T12:00:00Z"));
    assert.match(k, /^\d{4}-(0[1-9]|1[0-2])$/);
    assert.ok("2026-09" < "2026-10", "sıralama doğru olmalı");
  });

  test("geçerli anahtar biçimleri", () => {
    assert.equal(Season.isValidKey("2026-07"), true);
    assert.equal(Season.isValidKey("2026-Q3"), true);
    assert.equal(Season.isValidKey("2026-13"), false, "13. ay olmaz");
    assert.equal(Season.isValidKey("2026-7"), false, "dolgusuz reddedilmeli");
    assert.equal(Season.isValidKey(""), false);
    assert.equal(Season.isValidKey("'; DROP"), false);
  });

  test("önceki sezon — YIL SINIRINDA da doğru", () => {
    assert.equal(Season.previousKey("2026-07"), "2026-06");
    assert.equal(Season.previousKey("2026-01"), "2025-12", "ocak → önceki yılın aralığı");
    assert.equal(Season.previousKey("2026-Q3"), "2026-Q2");
    assert.equal(Season.previousKey("2026-Q1"), "2025-Q4", "Q1 → önceki yılın Q4'ü");
  });

  test("bozuk anahtar null döner, patlamaz", () => {
    assert.equal(Season.previousKey("sacma"), null);
  });

  test("etiket insan okunur", () => {
    assert.equal(Season.label("2026-07"), "Temmuz 2026");
    assert.equal(Season.label("2026-01"), "Ocak 2026");
    assert.equal(Season.label("2026-Q3"), "2026 3. çeyrek");
  });

  test("ZAMAN DİLİMİ: sınır Europe/Istanbul'a göre", () => {
    // Sunucu UTC çalışıyor (Render). Ayın son gününün 22:00 UTC'si
    // İstanbul'da ERTESİ AY 01:00'dir — `getMonth()` kullanılsaydı sezon
    // 3 saat kayardı. Aynı hata fikstür filtresinde yaşanmıştı.
    const utcSonGun = new Date("2026-07-31T22:00:00Z"); // İstanbul: 1 Ağustos 01:00
    assert.equal(Season.seasonKey(utcSonGun), "2026-08", "İstanbul'a göre ağustos");
    const utcIlkGun = new Date("2026-08-01T00:30:00Z"); // İstanbul: 1 Ağustos 03:30
    assert.equal(Season.seasonKey(utcIlkGun), "2026-08");
  });

  test("ay ortası net", () => {
    assert.equal(Season.seasonKey(new Date("2026-07-15T12:00:00Z")), "2026-07");
  });
});
