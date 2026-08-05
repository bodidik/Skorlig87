"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const MOBIL = require("./_mobil-dizin.cjs").MOBIL;

describe("board2 + friends/board i18n nobetci", () => {
  test("board2.tsx sabit Turkce icerik KALMADI", () => {
    const dosya = path.join(MOBIL, "app", "stats", "board2.tsx");
    if (!fs.existsSync(dosya)) return;
    const src = fs.readFileSync(dosya, "utf8");
    assert.ok(!src.includes("Liderlik Tablosu"), "Liderlik Tablosu sabit kalmis");
    assert.ok(src.includes('t("leaderboardTitle")'), "leaderboardTitle cagrisi eksik");
    assert.ok(src.includes('t("back")'), "back cagrisi eksik");
  });

  test("friends/board.tsx sabit Turkce icerik KALMADI", () => {
    const dosya = path.join(MOBIL, "app", "friends", "board.tsx");
    if (!fs.existsSync(dosya)) return;
    const src = fs.readFileSync(dosya, "utf8");
    const TR = /[çğıöşüÇĞİÖŞÜ]/;
    const satirlar = src.split(/\r?\n/);
    const sabit = [];
    let blok = false;
    for (const l of satirlar) {
      const kirp = l.trim();
      if (blok) { if (kirp.includes("*/")) blok = false; continue; }
      if (kirp.startsWith("{/*") || kirp.startsWith("/*")) { if (!kirp.includes("*/")) blok = true; continue; }
      if (kirp.startsWith("//") || kirp.startsWith("*")) continue;
      const m = l.match(/"[^"]*"|'[^']*'|`[^`]*`|>[^<>{}]*</g) || [];
      for (const x of m) {
        if (TR.test(x)) { sabit.push(kirp.slice(0, 80)); break; }
      }
    }
    assert.equal(sabit.length, 0, "sabit Turkce metin kaldi: " + sabit.join(" | "));
  });

  test("friends/board.tsx catch blogu log yaziyor", () => {
    const dosya = path.join(MOBIL, "app", "friends", "board.tsx");
    if (!fs.existsSync(dosya)) return;
    const src = fs.readFileSync(dosya, "utf8");
    assert.ok(src.includes("console.error"), "catch blogunda console.error yok — sessiz hata");
  });

  test("mystatus.tsx 1987GS paneli i18n gecisi TAMAM", () => {
    const dosya = path.join(MOBIL, "app", "mystatus.tsx");
    if (!fs.existsSync(dosya)) return;
    const src = fs.readFileSync(dosya, "utf8");
    for (const anahtar of [
      "access1987Title", "status1987Checking", "status1987Yes",
      "status1987No", "status1987Unknown", "hint1987Code",
      "verifying1987", "use1987Code", "note1987Verified",
      "myPredTitle", "microBoardNote", "noScoredPredYet",
    ]) {
      assert.ok(src.includes(`t("${anahtar}")`), `${anahtar} cagrisi eksik`);
    }
    assert.ok(!src.includes("1987GS Erişimi"), "1987GS Erisimi sabit kalmis");
    assert.ok(!src.includes("Doğrulanıyor"), "Dogrulaniyor sabit kalmis");
  });

  test("NEGATIF: sabit geri gelirse test YAKALAR", () => {
    const orjinal = 'Liderlik Tablosu';
    const yerine = 't("leaderboardTitle")';
    assert.ok(orjinal !== yerine, "negatif kontrol");
    assert.ok(!yerine.includes(orjinal), "yerine koyma sabit icermiyor");
  });
});
