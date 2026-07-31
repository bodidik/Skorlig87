"use strict";

/**
 * TEK FİKSTÜR OKUMA — indeksli arama, doğru dosya-yedeği semantiği.
 *
 * ⚠️ NEDEN EKLENDİ: tek bir maçı bulmak için her yerde `loadAll()` çağrılıp
 * sonuç bellekte süzülüyordu. Üretimde ölçüldü: 639 fikstür = 169 KB
 * çekiliyor, aranan belge 271 bayt — 639 KAT israf. Üstelik bu sıcak bir yol
 * (düello kurulumu, havuz bahsi, tahmin kilidi, düello ekranının her açılışı)
 * ve maliyet fikstür sayısıyla büyüyor. `fixtureId` üzerinde benzersiz indeks
 * zaten vardı, kullanılmıyordu.
 *
 * ⚠️ ASIL RİSK PERFORMANS DEĞİL, SEMANTİK. `loadAll` "Mongo boşsa dosyaya
 * düş" davranışına sahip. Tekil okuma bunu yanlış taklit ederse iki hata
 * çıkar: (a) her bilinmeyen fixtureId dosya okuması tetikler, (b) Mongo
 * doluyken dosyadaki bayat kayıt döner. Testlerin çoğu bu ayrımı koruyor.
 */

const os = require("os");
const nodePath = require("path");
const fs = require("fs");

const TMP = nodePath.join(os.tmpdir(), "skorlig-getone-test");
process.env.SKORLIG_DATA_DIR = TMP;
fs.mkdirSync(TMP, { recursive: true });

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const FixturesStore = require("../lib/fixtures-store.cjs");

let mongod = null, client = null, db = null;

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
beforeEach(async () => {
  await db.collection(FixturesStore.COLL).deleteMany({});
  try { fs.unlinkSync(FixturesStore.FIXTURES_FILE); } catch { /* yoktu */ }
});

const ekle = (id, ekstra = {}) =>
  db.collection(FixturesStore.COLL).insertOne({
    fixtureId: id, home: "A", away: "B", status: "NS", ...ekstra,
  });

describe("Mongo dolu", () => {
  test("var olan fikstür bulunur", async () => {
    await ekle("f1", { home: "Galatasaray", away: "Fenerbahce" });
    const f = await FixturesStore.getOne("f1", db);
    assert.equal(f.fixtureId, "f1");
    assert.equal(f.home, "Galatasaray");
  });

  test("olmayan fikstür için null döner — dosyaya DÜŞMEZ", async () => {
    // ⚠️ Kritik ayrım: koleksiyon doluysa "yok" GERÇEK cevaptır. Aksi hâlde
    // her bilinmeyen kimlik 169 KB'lik dosya okuması tetiklerdi.
    await ekle("f1");
    fs.writeFileSync(
      FixturesStore.FIXTURES_FILE,
      JSON.stringify([{ fixtureId: "dosyadaki", home: "X", away: "Y" }])
    );
    const f = await FixturesStore.getOne("dosyadaki", db);
    assert.equal(f, null, "Mongo doluyken dosyadaki bayat kayit donmus");
  });

  test("loadAll ile aynı belgeyi döner", async () => {
    await ekle("f1", { league: "Süper Lig" });
    const tekil = await FixturesStore.getOne("f1", db);
    const toplu = (await FixturesStore.loadAll(db)).find((x) => x.fixtureId === "f1");
    assert.deepEqual(tekil, toplu, "tekil ve toplu okuma ayrisiyor");
  });
});

describe("Mongo boş", () => {
  test("dosyaya düşer", async () => {
    fs.writeFileSync(
      FixturesStore.FIXTURES_FILE,
      JSON.stringify([{ fixtureId: "sadece-dosyada", home: "X", away: "Y" }])
    );
    const f = await FixturesStore.getOne("sadece-dosyada", db);
    assert.ok(f, "Mongo bosken dosyaya dusulmemis");
    assert.equal(f.home, "X");
  });

  test("dosyada da yoksa null", async () => {
    fs.writeFileSync(FixturesStore.FIXTURES_FILE, JSON.stringify([]));
    assert.equal(await FixturesStore.getOne("hicyok", db), null);
  });
});

describe("bozuk girdi", () => {
  test("boş kimlik null döner, patlamaz", async () => {
    for (const id of ["", null, undefined, "   "]) {
      assert.equal(await FixturesStore.getOne(id, db), null);
    }
  });
});
