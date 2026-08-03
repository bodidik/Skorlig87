"use strict";

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skorlig-stf-"));
process.env.SKORLIG_DATA_DIR = tmpDir;

const KOK = path.join(__dirname, "..");

let mongod, client, db;

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
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe("team-ranks dosya-modu sezon parametresi", () => {
  test("totalsMap sezon parametresini loadTotals e iletiyor", async () => {
    const SeasonTotals = require(path.join(KOK, "lib", "season-totals.cjs"));
    const Season = require(path.join(KOK, "lib", "season.cjs"));

    const guncelSezon = Season.seasonKey();
    const eskiSezon = Season.previousKey(guncelSezon);

    const col = db.collection("season_totals");
    await col.deleteMany({});
    await col.insertOne({
      userId: "AHMET", userIdLower: "ahmet",
      season: guncelSezon, totalPoints: 50, matches: 10,
    });
    await col.insertOne({
      userId: "AHMET", userIdLower: "ahmet",
      season: eskiSezon, totalPoints: 120, matches: 30,
    });

    const guncelMap = await SeasonTotals.totalsMap(db, guncelSezon);
    const eskiMap = await SeasonTotals.totalsMap(db, eskiSezon);

    assert.ok(guncelMap.has("ahmet"), "guncel sezonda ahmet olmali");
    assert.ok(eskiMap.has("ahmet"), "eski sezonda ahmet olmali");

    const guncelPuan = guncelMap.get("ahmet").totalPoints;
    const eskiPuan = eskiMap.get("ahmet").totalPoints;

    assert.equal(guncelPuan, 50, "guncel sezon puani yanlis");
    assert.equal(eskiPuan, 120, "eski sezon puani yanlis");
    assert.notEqual(guncelPuan, eskiPuan,
      "iki sezon ayni puan dondurdu — sezon filtresi calismamis olabilir");
  });

  test("KURULUM SINANDI: sezon olmadan totalsMap guncel sezonu dondurur", async () => {
    const SeasonTotals = require(path.join(KOK, "lib", "season-totals.cjs"));

    const varsayilanMap = await SeasonTotals.totalsMap(db);
    const ahmet = varsayilanMap.get("ahmet");
    assert.ok(ahmet, "varsayilan totalsMap ahmet dondurmeli");
    assert.equal(ahmet.totalPoints, 50,
      "varsayilan totalsMap guncel sezonu dondurmeli");
  });

  test("NEGATIF KONTROL: sezon parametresi olmadan iki sezon ayni sonuc verir", async () => {
    const SeasonTotals = require(path.join(KOK, "lib", "season-totals.cjs"));
    const Season = require(path.join(KOK, "lib", "season.cjs"));
    const eskiSezon = Season.previousKey(Season.seasonKey());

    const src = fs.readFileSync(
      path.join(KOK, "lib", "season-totals.cjs"), "utf8"
    );
    assert.ok(
      /await loadTotals\(db, season\)/.test(src),
      "totalsMap loadTotals e season parametresini gecirmiyor — duzeltme kayip"
    );

    const guncelMap = await SeasonTotals.totalsMap(db, Season.seasonKey());
    const eskiMap = await SeasonTotals.totalsMap(db, eskiSezon);
    const gP = guncelMap.get("ahmet")?.totalPoints;
    const eP = eskiMap.get("ahmet")?.totalPoints;
    assert.notEqual(gP, eP,
      "iki farkli sezon ayni puan dondurdu — sezon filtresi calismamis");
  });
});
