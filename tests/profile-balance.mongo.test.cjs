"use strict";

/**
 * /api/users/profile → LC bakiyesi hangi kaynaktan geliyor?
 *
 * NEDEN VAR: Profil ucu bakiyeyi `users.lc` alanından okuyordu. O alan ESKİ
 * USUL bir aynadır ve yalnızca cüzdan dosya aynası (SKORLIG_WALLET_FILE_MIRROR)
 * açıkken güncellenir. Üretimde ayna KAPALI — yani alan, kullanıcı
 * yaratılırken yazılan başlangıç değerinde donup kalıyordu.
 *
 * Etkisi kullanıcıya doğrudan yansıyordu: yarış ekranı (match-race) bu alanı
 * "LC bakiye" diye gösteriyor. Kullanıcı 500 LC kazansa da ekranda 30 görüyordu.
 *
 * Yetkili kaynak `lc_wallet_users` koleksiyonudur. Bu testler sıranın
 * bozulmadığını tutuyor — bozulursa belirti "yanlış para" olur, hata değil.
 *
 * Çalıştırma:  npm test
 */

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const os = require("os");
const fs = require("fs");

let MongoMemoryServer = null;
try {
  ({ MongoMemoryServer } = require("mongodb-memory-server"));
} catch {}

const KUM = fs.mkdtempSync(path.join(os.tmpdir(), "skorlig-profil-"));
process.env.SKORLIG_DATA_DIR = KUM;
process.env.SKORLIG_USERS_FILE_MIRROR = "0";

let _srv = null, _cli = null, db = null, app = null, sunucu = null, port = 0;

before(async () => {
  if (!MongoMemoryServer) return;
  _srv = await MongoMemoryServer.create();
  const { MongoClient } = require("mongodb");
  _cli = await new MongoClient(_srv.getUri()).connect();
  db = _cli.db("skorlig_test");

  const express = require("express");
  app = express();
  app.locals.db = db;
  app.use("/api/users", require("../routes/users.cjs"));
  await new Promise((r) => { sunucu = app.listen(0, r); });
  port = sunucu.address().port;
});

after(async () => {
  try { if (sunucu) sunucu.close(); } catch {}
  try { if (_cli) await _cli.close(); } catch {}
  try { if (_srv) await _srv.stop(); } catch {}
  try { fs.rmSync(KUM, { recursive: true, force: true }); } catch {}
});

const atla = () => !MongoMemoryServer;
const sebep = "mongodb-memory-server kurulu degil";

beforeEach(async () => {
  if (!db) return;
  await db.collection("users").deleteMany({});
  await db.collection("lc_wallet_users").deleteMany({});
  try { fs.unlinkSync(path.join(KUM, "lc-wallet.json")); } catch {}
});

async function profil(userId) {
  const r = await fetch(`http://127.0.0.1:${port}/api/users/profile?userId=${encodeURIComponent(userId)}`);
  return (await r.json()).profile;
}

describe("bakiye kaynağı", () => {
  test("CÜZDANDAKİ bakiye döner, profildeki eski alan değil", { skip: atla() && sebep }, async () => {
    // Asıl regresyon: kullanıcı yaratılırken users.lc = 30 yazılır ve orada
    // donar; gerçek bakiye cüzdanda 500'e çıkmıştır.
    await profil("kazanan"); // kullanıcıyı yarat (users.lc = 30)
    await db.collection("lc_wallet_users").insertOne({
      userId: "kazanan", userIdLower: "kazanan", balance: 500,
    });

    const p = await profil("kazanan");
    assert.equal(p.lc, 500, "cüzdandaki gerçek bakiye dönmeli");
  });

  test("bakiye 0 ise 0 döner (başlangıç değerine düşmez)", { skip: atla() && sebep }, async () => {
    // Parasını harcamış kullanıcıya "30 LC'n var" demek yanlış bilgi.
    await profil("bos");
    await db.collection("lc_wallet_users").insertOne({
      userId: "bos", userIdLower: "bos", balance: 0,
    });

    const p = await profil("bos");
    assert.equal(p.lc, 0);
  });

  test("büyük/küçük harf farkı bakiyeyi kaybettirmez", { skip: atla() && sebep }, async () => {
    // Firebase kimlikleri karışık harfli; cüzdan userIdLower ile indeksli.
    await profil("KaRiSik");
    await db.collection("lc_wallet_users").insertOne({
      userId: "KaRiSik", userIdLower: "karisik", balance: 77,
    });

    const p = await profil("KaRiSik");
    assert.equal(p.lc, 77);
  });

  test("cüzdan kaydı YOKSA profildeki değere düşer", { skip: atla() && sebep }, async () => {
    // Yeni kullanıcı: henüz cüzdan kaydı açılmamış olabilir.
    const p = await profil("yepyeni");
    assert.equal(p.lc, 30, "başlangıç değeri makul yedek");
  });

  test("profildeki eski alan bakiyeyi EZMEZ", { skip: atla() && sebep }, async () => {
    // users.lc bir şekilde güncellenmiş olsa bile cüzdan yetkili kaynaktır.
    await profil("celiskili");
    await db.collection("users").updateOne(
      { userId: "celiskili" }, { $set: { lc: 9999 } }
    );
    await db.collection("lc_wallet_users").insertOne({
      userId: "celiskili", userIdLower: "celiskili", balance: 42,
    });

    const p = await profil("celiskili");
    assert.equal(p.lc, 42, "cüzdan kazanmalı");
  });
});
