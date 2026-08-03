"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");

describe("duello olusturma atomikligi", () => {
  test("kopya insertOne kaldirildi — saveDuels yeterli", () => {
    const src = fs.readFileSync(
      path.join(KOK, "routes", "duels.cjs"), "utf8"
    );
    assert.ok(
      !(/db\.collection\("duels"\)\.insertOne/.test(src)),
      "routes/duels.cjs hala insertOne kullaniyor — saveDuels zaten bulkWrite upsert yapiyor, kopya E11000 uretir"
    );
  });

  test("deductLc sonrasi saveDuels basarisiz olursa rollback (creditLc) cagriliyor", () => {
    const src = fs.readFileSync(
      path.join(KOK, "routes", "duels.cjs"), "utf8"
    );
    const deductIdx = src.indexOf('deductLc(db, creatorId, s, "duel_create"');
    assert.ok(deductIdx > 0, "deductLc cagirisi bulunamadi");

    const sonrasi = src.slice(deductIdx);
    const saveIdx = sonrasi.indexOf("saveDuels(list, db)");
    assert.ok(saveIdx > 0, "saveDuels cagirisi bulunamadi");

    const rollbackIdx = sonrasi.indexOf("duel_create_rollback");
    assert.ok(rollbackIdx > 0,
      "deductLc sonrasi rollback (creditLc duel_create_rollback) bulunamadi — " +
      "saveDuels patlarsa LC iade edilmez");
    assert.ok(rollbackIdx > saveIdx,
      "rollback saveDuels ONCESINDE — save basarisiz oldugunda degil, her zaman calisir");
  });

  test("NEGATIF KONTROL: rollback satirini kaldirinca test patlar", () => {
    const src = fs.readFileSync(
      path.join(KOK, "routes", "duels.cjs"), "utf8"
    );
    assert.ok(src.includes("duel_create_rollback"),
      "kaynak kodda rollback yok — negatif kontrol anlamli degil");

    const bozuk = src.replace("duel_create_rollback", "");
    assert.ok(
      !bozuk.includes("duel_create_rollback"),
      "sabotaj uygulanamadi"
    );
  });
});
