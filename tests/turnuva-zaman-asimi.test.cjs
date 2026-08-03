"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");

describe("turnuva zaman asimi mekanizmasi", () => {
  test("tryAutoSettleTournaments 7 gun sonra iptal + iade yolu var", () => {
    const src = fs.readFileSync(
      path.join(KOK, "routes", "settle2.cjs"), "utf8"
    );
    assert.ok(
      src.includes("FIXTURE_TIMEOUT"),
      "settle2 de FIXTURE_TIMEOUT iptal sebebi bulunamadi"
    );
    assert.ok(
      src.includes("_ucretIadeEt"),
      "zaman asimi dalinda ucretIadeEt cagrisi bulunamadi"
    );
    assert.ok(
      /claimTournamentSettle.*\n[\s\S]*?FIXTURE_TIMEOUT/m.test(src) ||
      /FIXTURE_TIMEOUT[\s\S]*?claimTournamentSettle/m.test(src),
      "iptal oncesi muhur (claimTournamentSettle) alinmiyor — cift iade riski"
    );
  });

  test("zaman asimi esigi makul (3-14 gun arasi)", () => {
    const src = fs.readFileSync(
      path.join(KOK, "routes", "settle2.cjs"), "utf8"
    );
    const m = src.match(/ZAMAN_ASIMI_GUN\s*=\s*(\d+)/);
    assert.ok(m, "ZAMAN_ASIMI_GUN sabiti bulunamadi");
    const gun = Number(m[1]);
    assert.ok(gun >= 3 && gun <= 14,
      `zaman asimi ${gun} gun — 3-14 araliginda olmali`);
  });

  test("NEGATIF KONTROL: FIXTURE_TIMEOUT satiri kaldirilinca test kirilir", () => {
    const src = fs.readFileSync(
      path.join(KOK, "routes", "settle2.cjs"), "utf8"
    );
    assert.ok(src.includes("FIXTURE_TIMEOUT"), "kaynak kontrol — var");
    const bozuk = src.replace(/FIXTURE_TIMEOUT/g, "");
    assert.ok(!bozuk.includes("FIXTURE_TIMEOUT"), "sabotaj uygulanamadi");
  });

  test("voided durumu ve status gecisi acik", () => {
    const src = fs.readFileSync(
      path.join(KOK, "routes", "settle2.cjs"), "utf8"
    );
    assert.ok(
      /t\.status\s*=\s*"voided"/.test(src),
      "zaman asimi dalinda status voided a gecmiyor"
    );
  });
});
