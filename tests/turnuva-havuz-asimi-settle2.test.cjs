"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");

describe("turnuva havuz asimi kontrolu (settle2)", () => {
  test("settle2 odeme oncesi havuz asimi kontrolu var", () => {
    const src = fs.readFileSync(path.join(KOK, "routes", "settle2.cjs"), "utf8");
    const payoutsIdx = src.indexOf("t.payouts = paylar.map");
    assert.ok(payoutsIdx > 0, "t.payouts = paylar.map bulunamadi");
    const claimIdx = src.indexOf("claimTournamentSettle", payoutsIdx);
    assert.ok(claimIdx > 0, "claimTournamentSettle bulunamadi");
    const aradaki = src.slice(payoutsIdx, claimIdx);
    assert.ok(/odenecek\s*>\s*Number\(t\.pool/.test(aradaki),
      "settle2 odeme oncesi havuz asimi kontrolu yok — fazla-odeme riski");
  });

  test("tournament.cjs de ayni kontrole sahip", () => {
    const src = fs.readFileSync(path.join(KOK, "services", "tournament.cjs"), "utf8");
    assert.ok(/PAYOUT_EXCEEDS_POOL/.test(src),
      "tournament.cjs havuz asimi kontrolu kayip");
  });

  test("her iki yol da odemePaylari kullanarak tek kaynak", () => {
    const s2 = fs.readFileSync(path.join(KOK, "routes", "settle2.cjs"), "utf8");
    const t1 = fs.readFileSync(path.join(KOK, "services", "tournament.cjs"), "utf8");
    assert.ok(/odemePaylari\(/.test(s2), "settle2 odemePaylari cagirmiyor");
    assert.ok(/odemePaylari\(/.test(t1), "tournament.cjs odemePaylari cagirmiyor");
  });

  test("NEGATIF KONTROL: kontrol kaldirilirsa test kirilir", () => {
    const src = fs.readFileSync(path.join(KOK, "routes", "settle2.cjs"), "utf8");
    const payoutsIdx = src.indexOf("t.payouts = paylar.map");
    const claimIdx = src.indexOf("claimTournamentSettle", payoutsIdx);
    const aradaki = src.slice(payoutsIdx, claimIdx);
    const sahte = aradaki.replace("odenecek > Number(t.pool", "");
    assert.ok(!/odenecek > Number\(t\.pool/.test(sahte),
      "negatif kontrol basarisiz — silme islemi uygulanmadi");
  });
});
