"use strict";

/**
 * /api/rt/totals/board MONGO'DAN OKUR + GÖLGELENEN ÖLÜ UÇ KALDIRILDI.
 *
 * ⚠️ BULUNAN İKİ KUSUR (2026-08-03, routes/totals.cjs):
 *
 * 1) `/totals/board` YALNIZCA leaderboard.json'a bakıyordu. O dosya git'te
 *    izlenmiyor (.gitignore `data/*`) ve Render'ın diski geçici — her
 *    deploy'dan sonra dosya YOK, tablo boş dönüyordu.
 *    ÖLÇÜLDÜ (Render koşulu, üretim Mongo'su): 0 satır → düzeltmeden sonra
 *    1758 satır, ve komşu uç `/api/rt/totals` ile AYNI havuz.
 *
 * 2) Aynı dosyadaki `GET /totals` işleyicisi ÖLÜ KODDU: aynı yolu
 *    `routes/totals-read.cjs` de tanımlıyor ve server.cjs'te DAHA ÖNCE
 *    bağlanıyor (341 vs 378), yani istek hep ona gidiyordu.
 *    ÖLÇÜLDÜ (iki dosya gerçek sırayla bağlanıp istek atıldı):
 *        GET /api/rt/totals?userId=demo1 → alanlar ok, items, updatedAt, …
 *        buradaki işleyicinin söz verdiği last10 / avgPerMatch: YOK
 *    Tehlike okuyandaydı: dosya, sunucunun asla döndürmediği bir yanıt
 *    şeklini belgeliyordu.
 *
 * ⚠️ ÜRETİME DOKUNMAZ: bellek-içi Mongo + geçici veri dizini.
 */

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const KOK = path.join(__dirname, "..");

// ⚠️ VERİ DİZİNİ ROTA YÜKLENMEDEN ÖNCE: dosya yolları modül düzeyinde
// hesaplanıyor, sonradan değiştirmek GERÇEK data/ dizinine bakardı.
const VERI_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "skorlig-board-"));
process.env.SKORLIG_DATA_DIR = VERI_DIR;

const express = require("express");
const Season = require(path.join(KOK, "lib", "season.cjs"));

let mongod = null, client = null, db = null, srv = null, port = 0;

const TOHUM = [
  { userId: "oyuncuA", totalPoints: 30, totalPenalty: 2, matches: 6 },
  { userId: "oyuncuB", totalPoints: 20, totalPenalty: 1, matches: 5 },
  { userId: "oyuncuC", totalPoints: 50, totalPenalty: 0, matches: 9 },
];

before(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const { MongoClient } = require("mongodb");
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  db = client.db("test");

  const sezon = Season.seasonKey();
  await db.collection("season_totals").insertMany(
    TOHUM.map((x) => ({
      ...x, season: sezon, userIdLower: x.userId.toLowerCase(),
      lastAt: new Date().toISOString(),
    }))
  );

  const app = express();
  app.locals.db = db;
  // ⚠️ server.cjs'teki GERÇEK SIRA: totals-read (341) önce, totals (378) sonra.
  // Sıra testin konusu — değiştirmek 2. kusuru görünmez kılardı.
  app.use("/api/rt", require(path.join(KOK, "routes", "totals-read.cjs")));
  app.use("/api/rt", require(path.join(KOK, "routes", "totals.cjs")));
  await new Promise((r) => { srv = app.listen(0, r); });
  port = srv.address().port;
});

after(async () => {
  srv?.close();
  await client?.close();
  await mongod?.stop();
  try { fs.rmSync(VERI_DIR, { recursive: true, force: true }); } catch { /* geçici */ }
});

const g = async (u) => (await fetch(`http://127.0.0.1:${port}${u}`)).json();

describe("/api/rt/totals/board — Mongo öncelikli", () => {
  test("kurulum sınandı: dosyalar GERÇEKTEN yok, tohum GERÇEKTEN var", async () => {
    /* ⚠️ Bu olmadan iddia boş: dosya varsa eski kod da çalışırdı. */
    assert.equal(fs.existsSync(path.join(VERI_DIR, "leaderboard.json")), false,
      "leaderboard.json var — senaryo Render'i temsil etmiyor");
    assert.equal(fs.existsSync(path.join(VERI_DIR, "totals.json")), false,
      "totals.json var — senaryo Render'i temsil etmiyor");
    assert.equal(await db.collection("season_totals").countDocuments(), TOHUM.length);
  });

  test("dosya YOKKEN tablo Mongo'dan DOLU gelir", async () => {
    const j = await g("/api/rt/totals/board");
    assert.equal(j.ok, true);
    assert.equal(j.leaderboard.length, TOHUM.length,
      "tablo bos/eksik — dosya yoksa Mongo'dan okunmuyor");
    assert.equal(j.leaderboard[0].userId, "oyuncuC", "puana gore azalan siralanmamis");
    assert.equal(j.leaderboard[0].total, 50);
    assert.equal(j.leaderboard[0].played, 9,
      "played MAC SAYISI olmali — eski kod satir sayiyordu");
    assert.equal(j.leaderboard[0].penalties, 0);
  });

  test("KOMŞU UÇLA AYNI HAVUZ (iki tablo ayrışmasın)", async () => {
    /**
     * ⚠️ ASIL KULLANICI ZARARI bu sinifta hep ayni: ayni veriyi gosteren iki
     * uctan biri Mongo'yu goruyor obüru gormuyor, sayilar tutmuyor.
     */
    const b = await g("/api/rt/totals/board");
    const t = await g("/api/rt/totals?limit=5000");
    assert.equal(b.leaderboard.length, t.items.length,
      `board ${b.leaderboard.length}, totals ${t.items.length} — ayni kaynaktan okumuyorlar`);
    assert.equal(b.season, t.season, "iki uc farkli sezon bildiriyor");
  });

  test("?humans=1 botları süzer, varsayılan İŞARETLER", async () => {
    /* ⚠️ Kardeş uçların kararı: botu SİLME, İŞARETLE, isteğe bağlı süz.
     * Tohumun tamamı insan, yani süzgeç hiçbir şey atmamalı — ama alan
     * bulunmalı. */
    const j = await g("/api/rt/totals/board");
    assert.ok(j.leaderboard.every((r) => "isBot" in r), "isBot isareti yok");
    const h = await g("/api/rt/totals/board?humans=1");
    assert.equal(h.humansOnly, true, "humansOnly bildirilmiyor");
    assert.equal(h.leaderboard.length, TOHUM.length, "insan kayitlari suzulmus");
  });

  test("GÖLGELENEN ÖLÜ UÇ GERİ GELMEDİ", () => {
    /**
     * ⚠️ ASIL KIRILGANLIK. Biri `/totals`i buraya geri koyarsa yine ölü kod
     * olur (totals-read daha önce bağlı) ama dosya, sunucunun döndürmediği
     * bir yanıt şeklini belgelemeye devam eder — sessiz yanlış belge.
     */
    const src = fs.readFileSync(path.join(KOK, "routes", "totals.cjs"), "utf8");
    assert.ok(!/router\.get\(\s*["']\/totals["']\s*,/.test(src),
      "golgelenen /totals isleyicisi geri gelmis — totals-read daha once bagli, olu kod");
    assert.ok(/SeasonTotals\.loadTotals\(/.test(src),
      "ortak okuyucu (lib/season-totals.cjs) kullanilmiyor");
  });

  test("davranış: /api/rt/totals'ı GERÇEKTEN totals-read karşılıyor", async () => {
    /* Kaynak taraması yetmez, yolun kime gittiğini ölç. */
    const j = await g("/api/rt/totals?userId=oyuncuA");
    assert.ok("items" in j, "totals-read yanit sekli degil");
    assert.ok(!("last10" in j), "olu isleyici hala cevap veriyor");
  });

  test("TERS RİSK: Mongo da dosya da yoksa ÇÖKMEZ", async () => {
    const app2 = express();
    app2.locals.db = null;
    app2.use("/api/rt", require(path.join(KOK, "routes", "totals.cjs")));
    const s2 = app2.listen(0);
    const r = await (await fetch(`http://127.0.0.1:${s2.address().port}/api/rt/totals/board`)).json();
    s2.close();
    assert.equal(r.ok, true, "db yokken uc hata donuyor");
    assert.deepEqual(r.leaderboard, [], "bos olmali");
  });
});
