"use strict";

/**
 * /api/stats/me TEK BİR SEZONU GÖSTERİR (ve sıralamayla aynı sayıyı).
 *
 * ⚠️ İKİ KUSUR (2026-08-03, üretimde gerçek kullanıcıyla ölçüldü):
 *
 * 1) SEZON KAPSAMI YOKTU. Sorgu `seasonCol.findOne({ userIdLower })` idi —
 *    hangi sezon olduğu belirtilmiyordu, kullanıcının HERHANGİ bir sezon
 *    kaydı dönüyordu. Aynı yanıttaki takım bloğu ise güncel sezonu kullanıyor:
 *        totalPoints      : 9.9   ← Temmuz'dan
 *        team.myTeamTotal : 0     ← Ağustos'tan
 *    Tek ekranda "9.9 puanım var" ve "takımımdaki toplamım 0".
 *    Birden fazla sezonu olan kullanıcıda `findOne` hangi belgeyi döndüreceğini
 *    GARANTİ ETMEZ; sezon biriktikçe "puanım" rastgele bir geçmiş sezonu
 *    gösterebilirdi — hata vermeden.
 *
 * 2) ORTALAMA TAM SAYIYA YUVARLANIYORDU. 9.9/6 = 1.65 → "2" görünüyordu,
 *    sıralama ekranı aynı oyuncu için 1.67 diyordu. Aynı metrik, iki ekran,
 *    iki sayı (%21 sapma).
 *
 * SONRA (aynı kullanıcı): güncel sezon 0/0/0 tutarlı; `?season=2026-07`
 * puan 10, maç 6, ort 1.67 — ve `/api/leaderboard` ile BİREBİR aynı.
 */

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const KOK = path.join(__dirname, "..");
const VERI_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "skorlig-statsme-"));
process.env.SKORLIG_DATA_DIR = VERI_DIR;

const vt = require.resolve(path.join(KOK, "middleware", "verifyToken.cjs"));
require.cache[vt] = {
  id: vt, filename: vt, loaded: true, exports: {
    verifyToken: (q, r, n) => {
      if (!q.headers["x-user-id"]) return r.status(401).json({ ok: false, error: "AUTH" });
      q.uid = q.headers["x-user-id"]; n();
    },
    optionalToken: (q, _r, n) => { q.uid = q.headers["x-user-id"] || null; n(); },
  },
};

const express = require("express");
const Season = require(path.join(KOK, "lib", "season.cjs"));

const UID = "OYUNCU1";
const GUNCEL = Season.seasonKey();
const ONCEKI = Season.previousKey(GUNCEL);

let mongod = null, client = null, db = null, srv = null, port = 0;

before(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const { MongoClient } = require("mongodb");
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  db = client.db("test");

  // ⚠️ İKİ SEZON: kusurun ortaya çıktığı senaryo tam olarak bu. Tek sezonu
  // olan kullanıcıda "hangi belge döner" sorusu hiç sorulmaz.
  await db.collection("season_totals").insertMany([
    { season: ONCEKI, userId: UID, userIdLower: UID.toLowerCase(),
      totalPoints: 9.9, totalPenalty: 0, matches: 6, lastAt: "2026-07-30T17:58:19.820Z" },
    { season: GUNCEL, userId: UID, userIdLower: UID.toLowerCase(),
      totalPoints: 4.2, totalPenalty: 0, matches: 3, lastAt: "2026-08-02T10:00:00.000Z" },
  ]);
  await db.collection("users").insertOne({
    userId: UID, userIdLower: UID.toLowerCase(), mainTeam: "Galatasaray", country: "Türkiye",
  });

  const app = express();
  app.locals.db = db;
  app.use("/api/stats", require(path.join(KOK, "routes", "stats.cjs")));
  app.use("/api/leaderboard", require(path.join(KOK, "routes", "leaderboard.cjs")));
  await new Promise((r) => { srv = app.listen(0, r); });
  port = srv.address().port;
});

after(async () => {
  srv?.close();
  await client?.close();
  await mongod?.stop();
  try { fs.rmSync(VERI_DIR, { recursive: true, force: true }); } catch { /* geçici */ }
});

const me = async (q = "") =>
  (await fetch(`http://127.0.0.1:${port}/api/stats/me?userId=${UID}${q}`,
               { headers: { "x-user-id": UID } })).json();

describe("/api/stats/me — sezon kapsamı", () => {
  test("kurulum sınandı: kullanıcının GERÇEKTEN iki sezon kaydı var", async () => {
    /* ⚠️ Bu olmadan "doğru sezonu seçiyor" iddiası boş: tek kayıt varsa
     * kapsamsız sorgu da tesadüfen doğru cevabı verirdi. */
    const n = await db.collection("season_totals").countDocuments({ userIdLower: UID.toLowerCase() });
    assert.equal(n, 2, "iki sezonluk tohum kurulmamis — test bir sey olcmuyor");
    assert.ok(ONCEKI && ONCEKI !== GUNCEL, "onceki sezon anahtari hesaplanamadi");
  });

  test("VARSAYILAN güncel sezonu gösterir (geçmiş sezon sızmaz)", async () => {
    const j = await me();
    assert.equal(j.season, GUNCEL, "varsayilan guncel sezon degil");
    assert.equal(j.totalPoints, 4, "guncel sezon puani yanlis (gecmis sezon sizmis olabilir)");
    assert.equal(j.played, 3);
    assert.equal(j.isCurrentSeason, true);
  });

  test("?season= ile ARŞİV okunur", async () => {
    const j = await me(`&season=${ONCEKI}`);
    assert.equal(j.season, ONCEKI);
    assert.equal(j.totalPoints, 10, "arsiv puani yanlis");
    assert.equal(j.played, 6);
    assert.equal(j.isCurrentSeason, false);
  });

  test("TAKIM BLOĞU puan bloğuyla AYNI sezonu kullanır", async () => {
    /**
     * ⚠️ ASIL KULLANICI ZARARI BUYDU: tek yanıtta iki farklı sezon. Üretimde
     * "9.9 puanım var" ile "takımımdaki toplamım 0" yan yana görünüyordu.
     */
    const guncel = await me();
    assert.equal(guncel.team?.myTeamTotal, guncel.totalPoints,
      `guncel sezonda takim toplami (${guncel.team?.myTeamTotal}) puanla (${guncel.totalPoints}) uyusmuyor`);

    const arsiv = await me(`&season=${ONCEKI}`);
    assert.equal(arsiv.team?.myTeamTotal, arsiv.totalPoints,
      `arsivde takim toplami (${arsiv.team?.myTeamTotal}) puanla (${arsiv.totalPoints}) uyusmuyor`);
  });

  test("GEÇERSİZ sezon: iki blok da AYNI yedeğe düşer", async () => {
    /**
     * ⚠️ İNCE TUZAK: çekirdek doğrulanmış sezonu kullanırken takım bloğu ham
     * `req.query.season` kullansaydı, geçersiz değerde biri güncel sezona
     * düşer öteki ham değeri kullanırdı — düzeltilen kusurun aynısı, başka
     * yoldan geri gelirdi.
     */
    const j = await me("&season=SACMA");
    assert.equal(j.season, GUNCEL, "gecersiz sezon guncel sezona dusmeli");
    assert.equal(j.team?.myTeamTotal, j.totalPoints, "gecersiz sezonda iki blok ayrisiyor");
  });

  test("ORTALAMA sıralama ekranıyla BİREBİR aynı", async () => {
    /**
     * ⚠️ Eskiden `Math.round` ile tam sayıya yuvarlanıyordu: 9.9/6 = 1.65 →
     * "2", sıralama ise 1.67 diyordu. Aynı metrik iki ekranda iki sayı.
     * Kaynak da aynı olmalı: `SeasonTotals.kullaniciToplami` sıralamayla aynı
     * yuvarlama kuralını uyguluyor.
     */
    const j = await me(`&season=${ONCEKI}`);
    const lb = await (await fetch(
      `http://127.0.0.1:${port}/api/leaderboard?season=${ONCEKI}&limit=5000`)).json();
    const satir = (lb.leaderboard || []).find(
      (r) => String(r.userId).toLowerCase() === UID.toLowerCase());
    assert.ok(satir, "kullanici siralamada yok — karsilastirma yapilamiyor");
    assert.equal(j.totalPoints, satir.total, "puan iki ucta farkli");
    assert.equal(j.played, satir.played, "mac sayisi iki ucta farkli");
    assert.equal(j.avg, satir.avg, `ortalama farkli: stats/me ${j.avg} vs leaderboard ${satir.avg}`);
    assert.ok(!Number.isInteger(j.avg * 100) || String(j.avg).includes("."),
      "ortalama tam sayiya yuvarlanmis gorunuyor");
  });

  test("NÖBETÇİ: stats.cjs sezon toplamını KAPSAMSIZ sorgulamıyor", () => {
    /**
     * ⚠️ KUSURUN KÖKÜ kendi sorgusunu yazmasıydı. Biri `findOne({userIdLower})`
     * biçimine dönerse kusur aynen geri gelir ve HATA VERMEZ — yalnızca
     * yanlış sezon gösterir.
     */
    const src = fs.readFileSync(path.join(KOK, "routes", "stats.cjs"), "utf8")
      .split(/\r?\n/)
      .map((l) => {
        const t = l.trim();
        return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
      })
      .join("\n");
    assert.ok(!/seasonCol\.findOne\(/.test(src),
      "sezon toplami dogrudan findOne ile okunuyor — sezon kapsami kaybolur");
    assert.ok(/SeasonTotals\.kullaniciToplami\(/.test(src),
      "ortak okuyucu kullanilmiyor — siralama ile ayrisir");
  });
});
