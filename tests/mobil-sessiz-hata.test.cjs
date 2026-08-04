"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const MOBIL = path.join(__dirname, "..", "..", "mobile");

describe("mobil sessiz hata nobetcisi", () => {
  test("predict.tsx wallet catch sessiz degil", (t) => {
    const dosya = path.join(MOBIL, "app", "(tabs)", "predict.tsx");
    if (!fs.existsSync(dosya)) return t.skip("mobil depo yok");
    const src = fs.readFileSync(dosya, "utf8");
    const walletCatch = src.slice(
      src.indexOf("async function loadWalletSummary"),
      src.indexOf("async function checkExistingPrediction")
    );
    assert.ok(/console\.error/.test(walletCatch),
      "predict.tsx wallet catch blogu sessiz — console.error yok");
  });

  test("pool/[fixtureId].tsx catch blogu sessiz degil", (t) => {
    const dosya = path.join(MOBIL, "app", "pool", "[fixtureId].tsx");
    if (!fs.existsSync(dosya)) return t.skip("mobil depo yok");
    const src = fs.readFileSync(dosya, "utf8");
    const catchIdx = src.indexOf("pool] load failed");
    assert.ok(catchIdx > 0,
      "pool/[fixtureId].tsx catch blogu sessiz — console.error yok");
    assert.ok(/Alert\.alert/.test(src.slice(catchIdx - 50, catchIdx + 100)),
      "pool ilk yukleme hatasinda Alert gosterilmiyor");
  });

  test("lc-ledger.tsx catch bloklari sessiz degil", (t) => {
    const dosya = path.join(MOBIL, "app", "lc-ledger.tsx");
    if (!fs.existsSync(dosya)) return t.skip("mobil depo yok");
    const src = fs.readFileSync(dosya, "utf8");
    const walletCatch = src.indexOf("lc-ledger] wallet load failed");
    const ledgerCatch = src.indexOf("lc-ledger] ledger load failed");
    assert.ok(walletCatch > 0,
      "lc-ledger.tsx wallet catch sessiz");
    assert.ok(ledgerCatch > 0,
      "lc-ledger.tsx ledger catch sessiz");
  });
});
