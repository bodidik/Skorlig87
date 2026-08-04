"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");

describe("dosya kilit zaman asimi", () => {
  test("withFileLock zaman asiminda FILE_LOCK_TIMEOUT firlatir", async () => {
    const { withFileLock } = require(path.join(KOK, "lib", "fileLock.cjs"));
    await assert.rejects(
      () => withFileLock("test-timeout", () => new Promise(() => {}), 50),
      (err) => /FILE_LOCK_TIMEOUT/.test(err.message)
    );
  });

  test("zaman asimi sonraki kilidi bloklamaz", async () => {
    const { withFileLock } = require(path.join(KOK, "lib", "fileLock.cjs"));
    const key = "test-unblock-" + Date.now();
    try {
      await withFileLock(key, () => new Promise(() => {}), 50);
    } catch (_) {}
    const sonuc = await withFileLock(key, () => 42, 200);
    assert.equal(sonuc, 42);
  });

  test("LOCK_TIMEOUT_MS varsayilan degeri makul", () => {
    const { LOCK_TIMEOUT_MS } = require(path.join(KOK, "lib", "fileLock.cjs"));
    assert.ok(LOCK_TIMEOUT_MS >= 10_000 && LOCK_TIMEOUT_MS <= 120_000,
      "LOCK_TIMEOUT_MS makul aralikta degil: " + LOCK_TIMEOUT_MS);
  });

  test("kaynak kodda _zamanAsimli fonksiyonu mevcut", () => {
    const src = fs.readFileSync(path.join(KOK, "lib", "fileLock.cjs"), "utf8");
    assert.ok(/_zamanAsimli/.test(src),
      "fileLock.cjs _zamanAsimli fonksiyonu yok — timeout korunmuyor");
  });
});
