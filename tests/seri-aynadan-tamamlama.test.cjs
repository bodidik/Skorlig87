"use strict";

/**
 * SERİSİ YALNIZCA AYNADA OLAN KULLANICI TOPLU OKUMADA DÜŞMEZ.
 *
 * ⚠️ BULUNAN: `lib/streak-store.cjs loadMany`, Mongo sorgusu BOŞ DÖNMEDİĞİ
 * sürece sonucu olduğu gibi veriyordu; dosya aynasına düşme yalnızca istenen
 * kullanıcıların HİÇBİRİ Mongo'da yokken çalışıyordu. Yani serisi yalnızca
 * dosyada kalmış bir kullanıcı (Mongo yazımı bir kez başarısız olmuş ya da
 * migration öncesinden kalmış), aynı partide Mongo'da kaydı olan başka biri
 * varsa SESSİZCE DÜŞÜYORDU.
 *
 * ÖLÇÜLDÜ (aynı kullanıcı, aynı veri):
 *     loadMany(["eski"])         → lastTier: 2   bulundu
 *     loadMany(["eski","yeni"])  → KAYIP         dönmedi
 *
 * ⚠️ PARA ETKİSİ — dosya başlığının uyardığı şeyin ta kendisi: kayıp seri
 * `getUserStreak` tarafından sıfırdan açılıyor, `lastTier` -1 oluyor ve 42
 * birikimli seri "Durdurulamıyor" eşiğini YENİDEN geçip 25 LC bonusu TEKRAR
 * ödüyor.
 *
 * ⚠️ NORMAL YOLDA ÇALIŞIYORDU: settle her zaman TOPLU okur (maça bahis giren
 * tüm oyuncular), yani "tek başına sorulma" hâli üretimde nadir.
 *
 * ⚠️ AYNA KAPALIYKEN TAMAMLAMA YAPILMAZ: `SKORLIG_STREAK_FILE_MIRROR=0` ise
 * dosyaya artık yazılmıyor, oradan tamamlamak kapanmış eski serileri
 * diriltirdi.
 */

const os = require("os");
const path = require("path");
const fs = require("fs");

const TMP = path.join(os.tmpdir(), "skorlig-seri-ayna-test");
process.env.SKORLIG_DATA_DIR = TMP;

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const KOK = path.join(__dirname, "..");
const Store = require("../lib/streak-store.cjs");
const { TIERS, currentTier } = require("../services/streak.cjs");

const FILE = path.join(TMP, "streaks.json");
let mongod = null, client = null, db = null;

/** Üç eşiği de geçmiş, olgun bir seri. */
const OLGUN = {
  cumOdds: 42, count: 18, lastTier: 2, history: [],
  activeSeries: true, seriesCumOdds: 42, seriesCount: 18, bestSeries: 42,
};

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
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  await db.collection(Store.COLL).deleteMany({});

  // "eski": serisi YALNIZCA dosyada. "yeni": Mongo'da.
  fs.writeFileSync(FILE, JSON.stringify({ eski: OLGUN }, null, 2));
  await db.collection(Store.COLL).insertOne({
    userIdLower: "yeni", cumOdds: 3, count: 1, lastTier: -1, history: [],
    activeSeries: true, seriesCumOdds: 3, seriesCount: 1, bestSeries: 3,
  });
});

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("tek başına sorulunca zaten bulunuyordu", async () => {
    const m = await Store.loadMany(["eski"], db);
    assert.equal(m.eski?.lastTier, 2, "dosya yolu hic calismiyor — test bir sey olcmuyor");
  });

  test("mongo tarafı da okunuyor", async () => {
    const m = await Store.loadMany(["yeni"], db);
    assert.equal(m.yeni?.seriesCumOdds, 3);
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("toplu okuma", () => {
  test("aynada kalmış kullanıcı, mongo'daki biriyle birlikte sorulunca DÜŞMÜYOR", async () => {
    const m = await Store.loadMany(["eski", "yeni"], db);
    assert.ok(
      m.eski,
      "serisi yalnizca aynada olan kullanici toplu okumada kayboldu — " +
        "lastTier sifirlanir ve esik bonusu TEKRAR odenir"
    );
    assert.equal(m.eski.lastTier, 2, "lastTier korunmadi");
    assert.equal(m.yeni?.seriesCumOdds, 3, "mongo kaydi kayboldu");
  });

  test("kayıp seri 25 LC'lik bonusu yeniden ödettiriyordu", async () => {
    const m = await Store.loadMany(["eski", "yeni"], db);
    const s = m.eski || { lastTier: -1 };
    const tier = currentTier(OLGUN.seriesCumOdds);
    assert.ok(tier, "42 birikim hicbir esigi gecmiyor — senaryo cokmus");
    assert.ok(
      TIERS.indexOf(tier) <= (s.lastTier ?? -1),
      `"${tier.label}" bonusu (${tier.bonus} LC) yeniden odenir durumda`
    );
  });

  test("MONGO kaydı aynayı EZMİYOR (öncelik Mongo'da)", async () => {
    // Aynı kullanıcı iki yerde de varsa Mongo kazanmalı — ayna bayat olabilir.
    fs.writeFileSync(FILE, JSON.stringify({ eski: OLGUN, yeni: { ...OLGUN, cumOdds: 999 } }, null, 2));
    const m = await Store.loadMany(["eski", "yeni"], db);
    assert.equal(m.yeni.cumOdds, 3, "bayat ayna kaydi mongo'yu ezdi");
  });

  test("var olmayan kullanıcı uydurulmuyor", async () => {
    const m = await Store.loadMany(["eski", "yeni", "hicyok"], db);
    assert.equal(m.hicyok, undefined);
  });

  test("hepsi mongo'daysa ayna hiç okunmuyor gibi davranıyor", async () => {
    await db.collection(Store.COLL).insertOne({ userIdLower: "eski", cumOdds: 7, lastTier: 0 });
    const m = await Store.loadMany(["eski", "yeni"], db);
    assert.equal(m.eski.cumOdds, 7, "mongo kaydi varken ayna tercih edilmis");
  });
});

describe("ayna kapalıyken", () => {
  test("SKORLIG_STREAK_FILE_MIRROR=0 iken dosyadan tamamlama YOK", async () => {
    /**
     * ⚠️ Ayna kapalıyken dosyaya yazılmıyor; oradan tamamlamak KAPANMIŞ eski
     * serileri diriltirdi. Bayrak modül yüklenirken okunduğu için ayrı bir
     * süreçte sınanıyor.
     */
    const { execFileSync } = require("child_process");
    const betik = `
      process.env.SKORLIG_DATA_DIR = ${JSON.stringify(TMP)};
      process.env.SKORLIG_STREAK_FILE_MIRROR = "0";
      process.env.MONGODB_URI = "mongodb://kullanilmiyor";
      const S = require(${JSON.stringify(path.join(KOK, "lib", "streak-store.cjs").replace(/\\/g, "/"))});
      const { MongoClient } = require("mongodb");
      (async () => {
        const c = await MongoClient.connect(${JSON.stringify(mongod.getUri())});
        const m = await S.loadMany(["eski", "yeni"], c.db("test"));
        console.log(JSON.stringify({ eski: !!m.eski, yeni: !!m.yeni }));
        await c.close();
      })();
    `;
    const cikti = execFileSync(process.execPath, ["-e", betik], {
      cwd: KOK, encoding: "utf8", timeout: 60000,
    });
    const son = JSON.parse(cikti.trim().split("\n").filter((l) => l.startsWith("{")).pop());
    assert.equal(son.yeni, true, "mongo kaydi okunmadi — alt surec kurulumu bozuk");
    assert.equal(son.eski, false, "ayna kapaliyken bayat dosya kaydi diriltildi");
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

const kaynak = (rel) =>
  fs.readFileSync(path.join(KOK, rel), "utf8")
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");

test("NÖBETÇİ: 'hiç yoksa dosyaya düş' kestirmesi geri gelmemiş", () => {
  const src = kaynak("lib/streak-store.cjs");
  assert.ok(
    !/if\s*\(docs\.length\)\s*\{/.test(src),
    "eski kestirme geri gelmis: docs dolu ise ayna hic okunmuyor"
  );
});

test("NÖBETÇİ: seri yeniden başlarken lastTier iki kopyada da sıfırlanıyor", () => {
  /**
   * `recordCorrect` ve `recordBatch` aynı kuralın iki kopyası. Biri
   * `lastTier`'ı sıfırlamazsa yeni seri hak edilmemiş bir eşikten devam eder.
   */
  const src = kaynak("services/streak.cjs");
  const blok = /if \(!s\.activeSeries\) \{[^}]*s\.lastTier = -1;[^}]*\}/gs;
  const adet = (src.match(blok) || []).length;
  assert.ok(adet >= 2, `yeni seri baslarken lastTier ${adet} yerde sifirlaniyor — iki kopya ayrismis`);
});
