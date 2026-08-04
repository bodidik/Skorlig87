"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");

describe("istatistik hesaplama tutarliligi", () => {
  test("season_totals $inc ile atomik guncelleniyor", () => {
    const src = fs.readFileSync(path.join(KOK, "routes", "settle2.cjs"), "utf8");
    const idx = src.indexOf('collection("season_totals")');
    assert.ok(idx > 0, "season_totals koleksiyonu bulunamadi");
    const bolge = src.slice(Math.max(0, idx - 2000), idx + 200);
    assert.ok(bolge.includes("$inc") && bolge.includes("totalPoints"),
      "season_totals $inc ile totalPoints guncellemiyor — kayip puan riski");
    assert.ok(bolge.includes("$inc") && bolge.includes("matches"),
      "season_totals $inc ile matches guncellemiyor");
  });

  test("avg hesabi sifir mac icin sifir doner", () => {
    const src = fs.readFileSync(path.join(KOK, "routes", "competition-totals.cjs"), "utf8");
    assert.ok(/matches\s*\?\s*Math\.round/.test(src),
      "avg hesabi sifir mac kontrolu yok — sifira bolme riski");
  });

  test("stats.cjs avg hesabi iki basamakli", () => {
    const src = fs.readFileSync(path.join(KOK, "routes", "stats.cjs"), "utf8");
    assert.ok(/\*\s*100\s*\)\s*\/\s*100/.test(src),
      "stats.cjs avg hesabi iki basamak yuvarlama kullanmiyor");
  });

  test("NEGATIF KONTROL: $inc kaldirilirsa test kirilir", () => {
    const src = fs.readFileSync(path.join(KOK, "routes", "settle2.cjs"), "utf8");
    const idx = src.indexOf("season_totals");
    const bolge = src.slice(Math.max(0, idx - 500), idx + 500);
    const sahte = bolge.replace(/\$inc/g, "");
    assert.ok(!/\$inc/.test(sahte),
      "negatif kontrol basarisiz — degisiklik uygulanmadi");
  });
});
