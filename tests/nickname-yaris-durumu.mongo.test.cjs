"use strict";

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const KOK = path.join(__dirname, "..");
let mongod = null, client = null, db = null;

before(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const { MongoClient } = require("mongodb");
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  db = client.db("test");
});

after(async () => {
  await client?.close();
  await mongod?.stop();
});

describe("nickname benzersizlik yarisi", () => {
  test("nicknameNorm indeksi unique olmali", () => {
    const fs = require("fs");
    const src = fs.readFileSync(path.join(KOK, "lib", "users-store.cjs"), "utf8");
    const idx = src.indexOf("nicknameNorm: 1");
    assert.ok(idx > 0, "nicknameNorm indeksi bulunamadi");
    const blokSonu = src.indexOf(");", idx);
    const blok = src.slice(idx, blokSonu);
    assert.ok(/unique:\s*true/.test(blok),
      "nicknameNorm indeksi unique degil — yaris durumu korunmuyor");
  });

  test("eszamanli ayni nickname istegi yalniz birinde basarili olur", async () => {
    const col = db.collection("users");
    await col.createIndex({ nicknameNorm: 1 }, {
      unique: true,
      partialFilterExpression: { nicknameNorm: { $type: "string" } },
    });
    await col.insertMany([
      { userId: "usr-a", userIdLower: "usr-a" },
      { userId: "usr-b", userIdLower: "usr-b" },
    ]);

    const norm = "testkullanici";
    const sonuclar = await Promise.allSettled([
      col.updateOne({ userId: "usr-a" }, { $set: { nickname: "TestKullanici", nicknameNorm: norm } }),
      col.updateOne({ userId: "usr-b" }, { $set: { nickname: "TestKullanici", nicknameNorm: norm } }),
    ]);

    const basarili = sonuclar.filter((s) => s.status === "fulfilled" && s.value.modifiedCount > 0);
    const basarisiz = sonuclar.filter((s) => s.status === "rejected");

    assert.ok(basarili.length + basarisiz.length <= 2, "beklenmeyen durum");
    assert.ok(basarisiz.length >= 1 || basarili.length <= 1,
      "her iki kullanici da ayni nickname'i alabildi — unique indeks calismadi");

    const ayniNick = await col.find({ nicknameNorm: norm }).toArray();
    assert.equal(ayniNick.length, 1,
      "ayni nicknameNorm degerine sahip " + ayniNick.length + " belge var — mukerrer");
  });

  test("E11000 yakalanip NICKNAME_TAKEN donuyor", () => {
    const fs = require("fs");
    const src = fs.readFileSync(path.join(KOK, "routes", "users.cjs"), "utf8");
    const setNick = src.indexOf('"/set-nickname"');
    assert.ok(setNick > 0, "set-nickname ucu bulunamadi");
    const govde = src.slice(setNick, src.indexOf("router.", setNick + 50));
    assert.ok(/11000|E11000/.test(govde),
      "set-nickname ucunda E11000 yakalanmiyor — duplicate hata 500 donuyor");
  });
});
