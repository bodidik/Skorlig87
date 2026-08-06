"use strict";

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

let MongoMemoryServer;
try { ({ MongoMemoryServer } = require("mongodb-memory-server")); } catch {}
const atla = () => !MongoMemoryServer;
const sebep = "mongodb-memory-server kurulu degil";

const UID = "aylik-test-user";
let mongod, client, db, server, port;

before(async () => {
  if (atla()) return;
  const { MongoClient } = require("mongodb");
  const express = require("express");

  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  db = client.db("test");

  const vtYol = require.resolve("../middleware/verifyToken.cjs");
  require("../middleware/verifyToken.cjs");
  require.cache[vtYol].exports = {
    ...require.cache[vtYol].exports,
    verifyToken: (req, _res, next) => { req.uid = UID; next(); },
    optionalToken: (req, _res, next) => { req.uid = UID; next(); },
  };

  const app = express();
  app.locals.db = db;
  app.use(express.json());
  app.use("/api/rt", require("../routes/lc-wallet.cjs"));
  await new Promise((r) => { server = app.listen(0, r); });
  port = server.address().port;
});

after(async () => {
  if (server) server.close();
  if (client) await client.close();
  if (mongod) await mongod.stop();
});

const claim = () =>
  fetch(`http://127.0.0.1:${port}/api/rt/lc-wallet/daily-claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  }).then((r) => r.json());

const bakiye = async () =>
  Number((await db.collection("lc_wallet_users").findOne({ userIdLower: UID.toLowerCase() }))?.balance || 0);

const setMonthlyDays = async (gun) => {
  const buAy = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}`;
  await db.collection("lc_wallet_users").updateOne(
    { userIdLower: UID.toLowerCase() },
    { $set: { monthlyMonth: buAy, monthlyDays: gun, lastDailyAt: null, dailyStreak: 0 } }
  );
};

describe("aylik bonus", () => {
  const { AYLIK_ODUL_10, AYLIK_ODUL_20 } = require("../lib/ekonomi.cjs");

  beforeEach(async () => {
    if (atla()) return;
    await db.collection("lc_wallet_users").deleteMany({});
    await db.collection("lc_wallet_ledger").deleteMany({});
    await db.collection("lc_wallet_users").insertOne({
      userId: UID, userIdLower: UID.toLowerCase(), balance: 0,
      totalEarned: 0, totalSpent: 0, lastDailyAt: null, dailyStreak: 0,
      monthlyMonth: null, monthlyDays: 0,
    });
  });

  test("10. gun esiginde bonus verilir", { skip: atla() && sebep }, async () => {
    await setMonthlyDays(9);
    const res = await claim();
    assert.equal(res.ok, true, `claim basarisiz: ${JSON.stringify(res)}`);
    assert.equal(res.monthly.daysThisMonth, 10);
    assert.equal(res.monthly.bonus, AYLIK_ODUL_10);

    const ledger = await db.collection("lc_wallet_ledger")
      .find({ userIdLower: UID.toLowerCase(), reason: "aylik_10" }).toArray();
    assert.equal(ledger.length, 1, "defterde aylik_10 kaydi yok");
    assert.equal(ledger[0].amount, AYLIK_ODUL_10);
  });

  test("20. gun esiginde bonus verilir", { skip: atla() && sebep }, async () => {
    await setMonthlyDays(19);
    const res = await claim();
    assert.equal(res.ok, true);
    assert.equal(res.monthly.daysThisMonth, 20);
    assert.equal(res.monthly.bonus, AYLIK_ODUL_20);

    const ledger = await db.collection("lc_wallet_ledger")
      .find({ userIdLower: UID.toLowerCase(), reason: "aylik_20" }).toArray();
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].amount, AYLIK_ODUL_20);
  });

  test("esik arasinda bonus verilmez", { skip: atla() && sebep }, async () => {
    await setMonthlyDays(5);
    const res = await claim();
    assert.equal(res.ok, true);
    assert.equal(res.monthly.bonus, 0);

    const ledger = await db.collection("lc_wallet_ledger")
      .find({ userIdLower: UID.toLowerCase(), reason: /^aylik_/ }).toArray();
    assert.equal(ledger.length, 0, "esik disinda bonus deftere yazilmis");
  });

  test("summary monthly bilgisi doner", { skip: atla() && sebep }, async () => {
    await setMonthlyDays(7);
    const res = await fetch(`http://127.0.0.1:${port}/api/rt/lc-wallet/summary`, {
      headers: { "content-type": "application/json" },
    }).then((r) => r.json());
    assert.equal(res.ok, true);
    assert.ok(res.monthly, "summary'de monthly alani yok");
    assert.equal(res.monthly.daysThisMonth, 7);
    assert.ok(res.monthly.next, "sonraki esik bilgisi yok");
    assert.equal(res.monthly.next.at, 10);
  });
});
