"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");

describe("skor degeri dogrulama", () => {
  test("livescore-sync negatif skoru reddeder", () => {
    const src = fs.readFileSync(path.join(KOK, "services", "livescore-sync.cjs"), "utf8");
    const syncBolge = src.indexOf("homeRaw") > 0 ? src : "";
    assert.ok(syncBolge.length > 0, "homeRaw degiskeni bulunamadi — dogrulama kodu eksik");
    assert.ok(/homeRaw\s*<\s*0/.test(src),
      "livescore-sync negatif skor kontrolu yok");
    assert.ok(/awayRaw\s*<\s*0/.test(src),
      "livescore-sync negatif skor kontrolu yok (away)");
    assert.ok(/homeRaw\s*>\s*99|awayRaw\s*>\s*99/.test(src),
      "livescore-sync ust sinir kontrolu yok");
  });

  test("admin-live-gs negatif skoru reddeder", () => {
    const src = fs.readFileSync(path.join(KOK, "routes", "rt.live-gs.cjs"), "utf8");
    const adminBolge = src.slice(src.indexOf("admin-live-gs") || 0);
    assert.ok(/INVALID_SCORE/.test(adminBolge),
      "admin-live-gs INVALID_SCORE hatasi donmuyor — absurt skor yazilabiLir");
    assert.ok(/v\s*<\s*0/.test(adminBolge),
      "admin-live-gs negatif skor kontrolu yok");
    assert.ok(/v\s*>\s*99/.test(adminBolge),
      "admin-live-gs ust sinir kontrolu yok");
  });

  test("NEGATIF KONTROL: dogrulama kaldirilirsa test kirIlir", () => {
    const src = fs.readFileSync(path.join(KOK, "services", "livescore-sync.cjs"), "utf8");
    assert.ok(!/parseInt\(liveMatch\.homeScore.*\n\s*away:\s*hasScore \? parseInt/.test(src),
      "eski dogrulamasiz parseInt kalIbi hala var — skor dogrulamasi atlanmis");
  });
});
