"use strict";

/**
 * LC harcama — atomiklik ve eksi bakiye koruması.
 *
 * NEDEN VAR: harcama yolu dosyada "oku → karşılaştır → yaz" idi. İki eşzamanlı
 * istek aynı bakiyeyi okuyup İKİSİ de yeterli görebilir; bakiye eksiye düşer.
 * Ayrıca harcama yalnızca dosyaya yazılıyordu; bakiye ise Mongo'dan okunuyor
 * (SKORLIG_WALLET_FILE_MIRROR=0) → kullanıcı bedava oynuyordu.
 *
 * Bu testler mongodb-memory-server ile GERÇEK Mongo'ya karşı çalışır: dosya
 * modunda geçen ama Mongo modunda patlayan hatalar ($set/$setOnInsert çakışması
 * gibi) yalnızca böyle yakalanıyor.
 *
 * Çalıştırma:  npm test
 */

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { spendLc, creditLc, COLL_USERS, COLL_LEDGER } = require("../lib/wallet-credit.cjs");

let mongod = null;
let client = null;
let db = null;

before(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const { MongoClient } = require("mongodb");
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  db = client.db("test");
});

after(async () => {
  if (client) await client.close();
  if (mongod) await mongod.stop();
});

const bakiye = async (uid) =>
  (await db.collection(COLL_USERS).findOne({ userIdLower: uid.toLowerCase() }))?.balance ?? null;

describe("spendLc", () => {
  test("cüzdanı olmayan oyuncu açılış bakiyesiyle yaratılır ve düşülür", async () => {
    const r = await spendLc(db, "Yeni1", 3, "test", null, 30);
    assert.equal(r.ok, true);
    assert.equal(r.lc, 27);
    assert.equal(await bakiye("Yeni1"), 27);
  });

  test("karışık harfli kimlik aynı cüzdanı bulur", async () => {
    // Firebase UID'leri karışık harfli; tam eşleşme sessizce ikinci cüzdan açardı.
    await spendLc(db, "YENI1", 2, "test");
    assert.equal(await bakiye("yeni1"), 25);
    assert.equal(await db.collection(COLL_USERS).countDocuments({ userIdLower: "yeni1" }), 1);
  });

  test("bakiye yetmezse EKSİYE DÜŞMEZ ve hiçbir şey yazılmaz", async () => {
    await creditLc(db, "Fakir", 5, "test");
    const r = await spendLc(db, "Fakir", 50, "test");
    assert.equal(r.ok, false);
    assert.equal(r.reason, "INSUFFICIENT");
    assert.equal(r.lc, 5, "gerçek bakiye bildirilmeli");
    assert.equal(await bakiye("Fakir"), 5, "bakiye değişmemeli");
  });

  test("tam bakiye kadar harcama geçer, bir fazlası geçmez", async () => {
    await creditLc(db, "Tam", 10, "test");
    assert.equal((await spendLc(db, "Tam", 10, "test")).ok, true);
    assert.equal(await bakiye("Tam"), 0);
    assert.equal((await spendLc(db, "Tam", 1, "test")).reason, "INSUFFICIENT");
    assert.equal(await bakiye("Tam"), 0, "sıfırdan aşağı inmemeli");
  });

  test("EŞZAMANLI harcamalar birbirini ezmez — asıl kusur buydu", async () => {
    // 30 LC, 20 eşzamanlı 3 LC'lik istek. Doğrusu: tam 10 tanesi geçer.
    // "oku → karşılaştır → yaz" deseninde hepsi aynı bakiyeyi okuyup geçerdi.
    await creditLc(db, "Yaris", 30, "test");
    const sonuclar = await Promise.all(
      Array.from({ length: 20 }, () => spendLc(db, "Yaris", 3, "test"))
    );
    const gecen = sonuclar.filter((r) => r.ok).length;
    assert.equal(gecen, 10, "tam 10 harcama geçmeli");
    assert.equal(await bakiye("Yaris"), 0);
    assert.ok((await bakiye("Yaris")) >= 0, "hiçbir koşulda eksi olmamalı");
  });

  test("her geçen harcama defterе bir kayıt düşer", async () => {
    await creditLc(db, "Defter", 9, "test");
    await spendLc(db, "Defter", 3, "mac_girisi", { fixtureId: "f1" });
    const kayitlar = await db
      .collection(COLL_LEDGER)
      .find({ userIdLower: "defter", kind: "spend" })
      .toArray();
    assert.equal(kayitlar.length, 1);
    assert.equal(kayitlar[0].amount, -3, "harcama defterde NEGATİF durmalı");
    assert.equal(kayitlar[0].reason, "mac_girisi");
    assert.deepEqual(kayitlar[0].meta, { fixtureId: "f1" });
  });

  test("başarısız harcama deftere kayıt DÜŞMEZ", async () => {
    await spendLc(db, "Fakir", 999, "olmayacak");
    const n = await db
      .collection(COLL_LEDGER)
      .countDocuments({ userIdLower: "fakir", reason: "olmayacak" });
    assert.equal(n, 0);
  });

  test("totalSpent birikir", async () => {
    await creditLc(db, "Toplam", 20, "test");
    await spendLc(db, "Toplam", 3, "test");
    await spendLc(db, "Toplam", 4, "test");
    const u = await db.collection(COLL_USERS).findOne({ userIdLower: "toplam" });
    assert.equal(u.totalSpent, 7);
  });

  test("geçersiz girdi sessizce reddedilir, patlamaz", async () => {
    assert.equal((await spendLc(null, "x", 3, "t")).reason, "NO_DB");
    assert.equal((await spendLc(db, "", 3, "t")).reason, "NO_DB");
    assert.equal((await spendLc(db, "x", 0, "t")).reason, "NO_DB");
    assert.equal((await spendLc(db, "x", -5, "t")).reason, "NO_DB");
  });
});
