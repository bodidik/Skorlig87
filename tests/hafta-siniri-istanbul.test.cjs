"use strict";

/**
 * HAFTA SINIRI ISTANBUL YEREL GÜNÜ KULLANMALI.
 *
 * weekRange() `fromISO`/`toISO` alanlarını `.toISOString().slice(0, 10)` ile
 * üretiyordu → UTC. Ama fikstürler Istanbul yerel günüyle toplanıyor. Gece
 * yarısında (21:00–23:59 UTC = 00:00–02:59 Istanbul) UTC'nin hâlâ önceki günü
 * göstermesi, hafta sınırını fikstür koleksiyonundan 1 gün kayırıyordu.
 *
 * Düzeltme: Season.dayKey() kullan — push-scheduler'daki aynı sınıf hata
 * commit 84399c3'te düzeltildi.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");

// weekRange dışa açık değil, doğrudan require edip iç fonksiyonu test edemeyiz.
// Bunun yerine Season.dayKey'in weekRange'in beklenen çıktısıyla uyumunu test ediyoruz.
const Season = require("../lib/season.cjs");

test("Season.dayKey gece yarısı UTC ile Istanbul ayrışır", () => {
  // 2026-08-03 Pazar 23:30 UTC = 2026-08-04 Pazartesi 02:30 Istanbul
  const geceyarisi = new Date("2026-08-03T23:30:00Z");

  const utcGun = geceyarisi.toISOString().slice(0, 10);
  const istGun = Season.dayKey(geceyarisi);

  assert.equal(utcGun, "2026-08-03", "UTC hâlâ Pazar");
  assert.equal(istGun, "2026-08-04", "Istanbul zaten Pazartesi");
  assert.notEqual(utcGun, istGun, "iki yöntem farklı gün döndürmeli");
});

test("Season.dayKey gündüz saatlerinde fark yok", () => {
  // 2026-08-04 Pazartesi 12:00 UTC = 2026-08-04 Pazartesi 15:00 Istanbul
  const ogle = new Date("2026-08-04T12:00:00Z");

  const utcGun = ogle.toISOString().slice(0, 10);
  const istGun = Season.dayKey(ogle);

  assert.equal(utcGun, istGun, "gündüz iki yöntem aynı günü döndürmeli");
});
