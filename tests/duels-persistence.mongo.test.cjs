"use strict";

/**
 * Düellolar deploy'da kayboluyor muydu?
 *
 * NEDEN VAR (para kaybı, sessiz): `loadDuels()` YALNIZCA dosyadan okuyordu;
 * Mongo salt yazma aynasıydı. Render'da kalıcı disk yok — `data/duels.json`
 * her deploy'da siliniyor. Akış:
 *
 *   kullanıcı LC yatırır (deductLc) → düello dosyaya yazılır → deploy →
 *   dosya silinir → düello yok, yatırılan LC de yok
 *
 * Hata üretilmiyordu. Kullanıcı parasını kaybediyor, kimse fark etmiyordu.
 *
 * Bu testler deploy senaryosunu birebir kuruyor: Mongo'da kayıt var, dosya
 * silinmiş. Düellolar geri gelmeli.
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

const KUM = fs.mkdtempSync(path.join(os.tmpdir(), "skorlig-duel-"));
process.env.SKORLIG_DATA_DIR = KUM;

const duels = require("../routes/duels.cjs");
const DUELS_FILE = path.join(KUM, "duels.json");

let _srv = null, _cli = null, db = null;

before(async () => {
  if (!MongoMemoryServer) return;
  _srv = await MongoMemoryServer.create();
  const { MongoClient } = require("mongodb");
  _cli = await new MongoClient(_srv.getUri()).connect();
  db = _cli.db("skorlig_test");
});

after(async () => {
  try { if (_cli) await _cli.close(); } catch {}
  try { if (_srv) await _srv.stop(); } catch {}
  try { fs.rmSync(KUM, { recursive: true, force: true }); } catch {}
});

const atla = () => !MongoMemoryServer;
const sebep = "mongodb-memory-server kurulu degil";

beforeEach(async () => {
  if (db) await db.collection("duels").deleteMany({});
  try { fs.unlinkSync(DUELS_FILE); } catch {}
});

const duello = (id, over = {}) => ({
  id, fixtureId: "FX1", stake: 5, status: "active",
  creatorId: "ali", acceptorId: "veli", pot: 10,
  createdAt: new Date().toISOString(), ...over,
});

describe("deploy sonrası kalıcılık", () => {
  test("DOSYA SİLİNMİŞSE düellolar Mongo'dan gelir", { skip: atla() && sebep }, async () => {
    // Asıl regresyon: bu çalışmazsa yatırılan LC ile birlikte düello kaybolur.
    await db.collection("duels").insertMany([duello("d1"), duello("d2")]);
    assert.equal(fs.existsSync(DUELS_FILE), false, "dosya yok (deploy senaryosu)");

    const list = await duels._loadDuels(db);
    assert.equal(list.length, 2);
    assert.deepEqual(list.map((d) => d.id).sort(), ["d1", "d2"]);
  });

  test("Mongo kaydı _id sızdırmaz", { skip: atla() && sebep }, async () => {
    await db.collection("duels").insertOne(duello("d1"));
    const [d] = await duels._loadDuels(db);
    assert.equal(d._id, undefined, "Mongo _id'si düello nesnesine karışmamalı");
  });

  test("stake ve durum korunur", { skip: atla() && sebep }, async () => {
    await db.collection("duels").insertOne(duello("d1", { stake: 12, status: "settled", winnerId: "ali" }));
    const [d] = await duels._loadDuels(db);
    assert.equal(d.stake, 12);
    assert.equal(d.status, "settled");
    assert.equal(d.winnerId, "ali");
  });
});

describe("Mongo yokken davranış korunur", () => {
  test("dosyadan okunur (yerel geliştirme)", async () => {
    fs.writeFileSync(DUELS_FILE, JSON.stringify([duello("dosya1")]));
    const list = await duels._loadDuels(null);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, "dosya1");
  });

  test("dosya da yoksa boş dizi — patlamaz", async () => {
    const list = await duels._loadDuels(null);
    assert.deepEqual(list, []);
  });
});

describe("Mongo okunamazsa", () => {
  test("dosyaya düşer, hizmet durmaz", { skip: atla() && sebep }, async () => {
    // Kapalı bağlantı: Mongo çağrısı hata verir.
    const bozukDb = {
      collection: () => ({ find: () => ({ toArray: async () => { throw new Error("baglanti yok"); } }) }),
    };
    fs.writeFileSync(DUELS_FILE, JSON.stringify([duello("yedek")]));

    const list = await duels._loadDuels(bozukDb);
    assert.equal(list.length, 1, "dosya yedeği devreye girmeli");
    assert.equal(list[0].id, "yedek");
  });
});
