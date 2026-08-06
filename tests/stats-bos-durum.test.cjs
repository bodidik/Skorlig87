"use strict";

/**
 * STATS SIRALAMA BOŞ DURUM NÖBETÇİSİ
 *
 * ⚠️ NEDEN VAR (2026-08-06): genel/fav/cup sıralamaları boşken sahte satır
 * gösteriyordu: "1. -" ve 0 puan. Yeni kullanıcı veya sezon öncesi bunu
 * gördüğünde kafa karışıyordu. Kupon sıralamasındaki doğru kalıp (açıklayıcı
 * kart) diğer üçüne de uygulandı.
 *
 * Bu test sahte satır kalıbının geri gelmesini önlüyor.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");

const { mobilYol, mobilVarMi } = require("./_mobil-dizin.cjs");
const mobilVar = mobilVarMi();

test("stats.tsx sahte satır kullanmıyor (userId: dash kalıbı)", (t) => {
  if (!mobilVar) return t.skip("mobil depo yan klasorde yok");
  const src = fs.readFileSync(mobilYol("app", "(tabs)", "stats.tsx"), "utf8");

  const sahteKalip = /userId:\s*"-"/g;
  const eslesmeler = src.match(sahteKalip) || [];

  assert.strictEqual(
    eslesmeler.length, 0,
    `stats.tsx icinde ${eslesmeler.length} adet sahte satir kaldi (userId: "-").\n` +
    `Bos durum icin aciklayici kart kullanilmali — bkz. noSettledKupon kalıbi.`
  );
});

test("stats.tsx uc bos durum icin i18n anahtari kullaniyor", (t) => {
  if (!mobilVar) return t.skip("mobil depo yan klasorde yok");
  const src = fs.readFileSync(mobilYol("app", "(tabs)", "stats.tsx"), "utf8");

  for (const key of ["emptyLeaderboard", "emptyTeamRank", "emptyCupBoard"]) {
    assert.ok(src.includes(key),
      `stats.tsx icinde ${key} i18n anahtari kullanilmali`);
  }
});

test("bos durum i18n anahtarlari tr ve en dillerinde var", (t) => {
  if (!mobilVar) return t.skip("mobil depo yan klasorde yok");
  const src = fs.readFileSync(mobilYol("lib", "i18n.ts"), "utf8");

  for (const key of [
    "emptyLeaderboard", "emptyLeaderboardDesc",
    "emptyTeamRank", "emptyTeamRankDesc",
    "emptyCupBoard", "emptyCupBoardDesc",
  ]) {
    const re = new RegExp(`${key}:\\s*"`);
    const trMatch = src.indexOf(`  tr: {`);
    const enMatch = src.indexOf(`  en: {`);
    const trBlok = src.slice(trMatch, src.indexOf("\n  },", trMatch + 100));
    const enBlok = src.slice(enMatch, src.indexOf("\n  },", enMatch + 100));
    assert.ok(re.test(trBlok), `tr blogunda ${key} olmali`);
    assert.ok(re.test(enBlok), `en blogunda ${key} olmali`);
  }
});
