"use strict";

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

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

describe("cuzdan olusturma yaris durumu", () => {
  test("eszamanli ensureWalletUserMongo tek belge olusturur", async () => {
    const { _ensureWalletUserMongo: ensure } =
      require("../routes/lc-wallet.cjs");

    const uid = "race-test-" + Date.now();
    const sonuclar = await Promise.all([
      ensure(db, uid),
      ensure(db, uid),
      ensure(db, uid),
    ]);

    const col = db.collection("lc_wallet_users");
    const belgeler = await col.find({ userIdLower: uid.toLowerCase() }).toArray();

    assert.equal(belgeler.length, 1,
      "eszamanli cagrilar mukerrer belge uretti: " + belgeler.length);

    for (const s of sonuclar) {
      assert.ok(s, "ensureWalletUserMongo null dondu");
      assert.equal(String(s.userId || s.userIdLower).toLowerCase(), uid.toLowerCase());
    }
  });

  test("eszamanli cagrilar yalniz bir init ledger kaydeder", async () => {
    const uid = "ledger-race-" + Date.now();
    const { _ensureWalletUserMongo: ensure } =
      require("../routes/lc-wallet.cjs");

    await Promise.all([ensure(db, uid), ensure(db, uid)]);

    const kayitlar = await db.collection("lc_wallet_ledger")
      .find({ userId: uid, kind: "init" }).toArray();

    assert.equal(kayitlar.length, 1,
      "init ledger kaydi birden fazla: " + kayitlar.length);
  });

  test("NEGATiF KONTROL: duzeltme geri alinirsa mukerrer olusur", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.join(__dirname, "..", "routes", "lc-wallet.cjs"), "utf8"
    );
    const bas = src.indexOf("async function ensureWalletUserMongo");
    assert.ok(bas > 0, "fonksiyon bulunamadi");
    const govde = src.slice(bas, src.indexOf("\n}", bas) + 2);

    assert.ok(
      /\$setOnInsert/.test(govde),
      "ensureWalletUserMongo icinde $setOnInsert yok — yaris durumu korunmuyor"
    );
    assert.ok(
      /upsert:\s*true/.test(govde),
      "ensureWalletUserMongo icinde upsert:true yok — yaris durumu korunmuyor"
    );
    assert.ok(
      !/await col\.insertOne\(doc\)/.test(govde),
      "ensureWalletUserMongo hala ham insertOne kullaniyor — yaris durumu acik"
    );
  });
});
