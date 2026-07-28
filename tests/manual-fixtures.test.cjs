"use strict";

/**
 * Elle eklenen fikstürlerin kalıcılığı.
 *
 * NEDEN TEST EDİLİYOR: Render'da kalıcı disk yok, `fixtures.json` her deploy'da
 * siliniyor. Sağlayıcı maçları (FDO/MK) API'den yeniden gelir; ELLE girilenlerin
 * başka kaynağı yoktur — yazılır, görünür, ilk deploy'da sessizce yok olur.
 * Sezon başlamadığı için Türk kullanıcıya maç göstermenin tek yolu şu an elle
 * giriş, yani bu kayıp doğrudan "ekranda hiç maç yok" demek.
 *
 * mongodb-memory-server kurulu değilse atlanır.
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

const KUM = fs.mkdtempSync(path.join(os.tmpdir(), "skorlig-mfx-"));
process.env.SKORLIG_DATA_DIR = KUM;

const MF = require("../lib/manual-fixtures.cjs");
const Restore = require("../services/manual-fixtures-restore.cjs");
const { readFixtures, writeFixtures } = require("../services/fixture-sync.cjs");

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

const YARIN = () => new Date(Date.now() + 86400000).toISOString();

function mac(id, over = {}) {
  return {
    fixtureId: id, home: "Galatasaray", away: "Fenerbahçe",
    league: "Süper Lig", country: "Turkey", kickoffISO: YARIN(),
    status: "NS", source: "MANUAL", ...over,
  };
}

beforeEach(async () => {
  if (db) await db.collection(MF.COLL).deleteMany({});
  try { fs.unlinkSync(path.join(KUM, "fixtures.json")); } catch {}
});

describe("kalici depo", () => {
  test("yazilan mac geri okunur", { skip: atla() && sebep }, async () => {
    await MF.save(mac("EL-1"), db);
    const list = await MF.list(db);
    assert.equal(list.length, 1);
    assert.equal(list[0].home, "Galatasaray");
  });

  test("ayni kimlikle tekrar yazmak cift kayit olusturmaz", { skip: atla() && sebep }, async () => {
    await MF.save(mac("EL-1"), db);
    await MF.save(mac("EL-1", { league: "Kupa" }), db);
    const list = await MF.list(db);
    assert.equal(list.length, 1);
    assert.equal(list[0].league, "Kupa", "guncelleme yansimali");
  });

  test("silinen mac listede kalmaz", { skip: atla() && sebep }, async () => {
    await MF.save(mac("EL-1"), db);
    assert.equal(await MF.remove("EL-1", db), true);
    assert.equal((await MF.list(db)).length, 0);
  });

  test("cok eski maclar listelenmez", { skip: atla() && sebep }, async () => {
    const eski = new Date(Date.now() - 60 * 86400000).toISOString();
    await MF.save(mac("ESKI", { kickoffISO: eski }), db);
    await MF.save(mac("YENI"), db);
    const list = await MF.list(db, 30);
    assert.deepEqual(list.map((f) => f.fixtureId), ["YENI"]);
  });

  test("Mongo yoksa sessizce devre disi (dosya tek kaynak)", async () => {
    assert.equal(await MF.save(mac("X"), null), false);
    assert.deepEqual(await MF.list(null), []);
    assert.equal(await MF.remove("X", null), false);
  });
});

describe("acilista geri yukleme", () => {
  test("dosya SILINMISSE maclar geri gelir", { skip: atla() && sebep }, async () => {
    // Deploy senaryosu: kalici depoda var, fixtures.json yok.
    await MF.save(mac("EL-1"), db);
    await MF.save(mac("EL-2", { home: "Beşiktaş", away: "Trabzonspor" }), db);

    const r = await Restore.restoreOnce(db);
    assert.equal(r.restored, 2);

    const dosyada = await readFixtures();
    assert.deepEqual(dosyada.map((f) => f.fixtureId).sort(), ["EL-1", "EL-2"]);
  });

  test("zaten varsa TEKRAR eklenmez", { skip: atla() && sebep }, async () => {
    await MF.save(mac("EL-1"), db);
    await Restore.restoreOnce(db);
    const r2 = await Restore.restoreOnce(db);

    assert.equal(r2.restored, 0);
    assert.equal(r2.alreadyThere, 1);
    assert.equal((await readFixtures()).length, 1, "cift kayit olusmamali");
  });

  test("saglayici maclarina DOKUNMAZ", { skip: atla() && sebep }, async () => {
    // FDO kayitlari dosyada duruyor; geri yukleme onlari silmemeli.
    await writeFixtures([
      { fixtureId: "FDO-1", home: "A", away: "B", source: "FDO", kickoffISO: YARIN() },
    ]);
    await MF.save(mac("EL-1"), db);

    await Restore.restoreOnce(db);
    const dosyada = await readFixtures();
    assert.deepEqual(dosyada.map((f) => f.fixtureId).sort(), ["EL-1", "FDO-1"]);
  });

  test("silinen mac geri YUKLENMEZ", { skip: atla() && sebep }, async () => {
    // Admin sildiyse acilista hortlamamali.
    await MF.save(mac("EL-1"), db);
    await MF.remove("EL-1", db);

    const r = await Restore.restoreOnce(db);
    assert.equal(r.restored, 0);
    assert.deepEqual(await readFixtures(), []);
  });

  test("Mongo yokken patlamaz", async () => {
    const r = await Restore.restoreOnce(null);
    assert.equal(r.reason, "MONGO_YOK");
  });
});
