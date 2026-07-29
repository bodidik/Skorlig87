"use strict";

/**
 * Fikstür deposu — Mongo birincil, dosya ayna.
 *
 * NEDEN VAR: `data/fixtures.json` Render'da her deploy'da siliniyor. Maçlar
 * dış senkronla yeniden dolana kadar uygulama boş görünüyordu ve dolma
 * hızı/kapsamı kontrol etmediğimiz kaynaklara bağlıydı.
 *
 * En riskli davranış TAM DEĞİŞTİRME: `saveAll` listede olmayan kaydı siler.
 * Bu doğru (dosya yazımı da tam değiştirme yapıyordu) ama bir kere yanlış
 * çağrılırsa tüm fikstürler gider. O yüzden hem silme hem de "boş liste
 * hiçbir şey silmez" savunması testle tutuluyor.
 *
 * Çalıştırma:  npm test
 */

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const os = require("os");

// ⚠️ SKORLIG_DATA_DIR modül YÜKLENMEDEN önce ayarlanmalı: fixtures-store yolu
// modül düzeyinde hesaplıyor. Gerçek data/fixtures.json'a yazmamak için şart —
// bu oturumda bir test tam da böyle gerçek fikstür dosyasını 216 kayıttan
// 2'ye düşürmüştü.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "skorlig-fx-"));
process.env.SKORLIG_DATA_DIR = TMP;

const FixturesStore = require("../lib/fixtures-store.cjs");

let mongod = null;
let client = null;
let db = null;

const fx = (id, extra = {}) => ({
  fixtureId: String(id),
  home: "Ev" + id,
  away: "Dep" + id,
  kickoffISO: "2026-08-01T18:00:00Z",
  league: "Test Ligi",
  country: "Türkiye",
  source: "MK",
  ...extra,
});

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
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

beforeEach(async () => {
  await db.collection(FixturesStore.COLL).deleteMany({});
  try { fs.unlinkSync(path.join(TMP, "fixtures.json")); } catch {}
});

describe("saveAll / loadAll", () => {
  test("yazılan fikstürler Mongo'dan okunur", async () => {
    await FixturesStore.saveAll([fx(1), fx(2)], db);
    const list = await FixturesStore.loadAll(db);
    assert.equal(list.length, 2);
    assert.equal(list.find((f) => f.fixtureId === "1").home, "Ev1");
  });

  test("_id sızmaz — istemciye Mongo iç alanı gitmemeli", async () => {
    await FixturesStore.saveAll([fx(1)], db);
    const list = await FixturesStore.loadAll(db);
    assert.equal("_id" in list[0], false);
  });

  test("aynı fixtureId ikinci kez yazılırsa GÜNCELLENİR, kopyalanmaz", async () => {
    await FixturesStore.saveAll([fx(1, { home: "Eski" })], db);
    await FixturesStore.saveAll([fx(1, { home: "Yeni" })], db);
    const list = await FixturesStore.loadAll(db);
    assert.equal(list.length, 1, "kopya oluşmamalı");
    assert.equal(list[0].home, "Yeni");
  });

  test("listede olmayan kayıt SİLİNİR (tam değiştirme)", async () => {
    await FixturesStore.saveAll([fx(1), fx(2), fx(3)], db);
    const r = await FixturesStore.saveAll([fx(1), fx(3)], db);
    assert.equal(r.deleted, 1);
    const ids = (await FixturesStore.loadAll(db)).map((f) => f.fixtureId).sort();
    assert.deepEqual(ids, ["1", "3"]);
  });

  test("BOŞ LİSTE HİÇBİR ŞEY SİLMEZ — asıl koruma bu", async () => {
    // Geçici bir ağ/kota hatasından sonra gelen boş senkron, gelecekteki tüm
    // maçları silen "başarılı" bir yazma gibi görünürdü.
    await FixturesStore.saveAll([fx(1), fx(2)], db);
    const r = await FixturesStore.saveAll([], db);
    assert.equal(r.deleted, 0);
    assert.equal((await FixturesStore.loadAll(db)).length, 2, "maçlar durmalı");
  });

  test("fixtureId'siz kayıtlar sessizce atlanır", async () => {
    const r = await FixturesStore.saveAll([fx(1), { home: "x" }, null], db);
    assert.equal(r.count, 1);
    assert.equal((await FixturesStore.loadAll(db)).length, 1);
  });
});

describe("dosya aynası", () => {
  const dosya = () => path.join(TMP, "fixtures.json");

  test("Mongo'ya yazarken dosya da yazılır (ayna açık)", async () => {
    await FixturesStore.saveAll([fx(1)], db);
    const raw = JSON.parse(fs.readFileSync(dosya(), "utf8"));
    assert.equal(FixturesStore._unwrap(raw).length, 1);
  });

  test("dosya sarmalı korunur — {fixtures:[...]} biçimi", async () => {
    await FixturesStore.saveAll([fx(1)], db);
    const raw = JSON.parse(fs.readFileSync(dosya(), "utf8"));
    assert.ok(Array.isArray(raw.fixtures), "sarmal {fixtures:[]} olmalı");
  });

  test("Mongo yokken dosya TEK KAYNAK olarak çalışır", async () => {
    await FixturesStore.saveAll([fx(9)], null);
    const list = await FixturesStore.loadAll(null);
    assert.equal(list.length, 1);
    assert.equal(list[0].fixtureId, "9");
  });

  test("Mongo boşsa dosyaya düşülür", async () => {
    // Boş koleksiyon ile "Mongo yok" Mongo tarafında aynı görünüyor; geçiş
    // döneminde dosya hâlâ gerçek yedek olmalı.
    await FixturesStore.saveAll([fx(7)], null); // yalnızca dosya
    assert.equal(await db.collection(FixturesStore.COLL).countDocuments(), 0);
    const list = await FixturesStore.loadAll(db);
    assert.equal(list.length, 1, "Mongo boşken dosya okunmalı");
    assert.equal(list[0].fixtureId, "7");
  });
});

describe("sarmal çözme (_unwrap)", () => {
  test("üç biçimi de kabul eder", () => {
    assert.equal(FixturesStore._unwrap([fx(1)]).length, 1, "düz dizi");
    assert.equal(FixturesStore._unwrap({ fixtures: [fx(1)] }).length, 1, "{fixtures}");
    assert.equal(FixturesStore._unwrap({ items: [fx(1)] }).length, 1, "{items}");
  });

  test("bozuk girdi patlamaz", () => {
    assert.deepEqual(FixturesStore._unwrap(null), []);
    assert.deepEqual(FixturesStore._unwrap({}), []);
    assert.deepEqual(FixturesStore._unwrap("abc"), []);
  });
});
