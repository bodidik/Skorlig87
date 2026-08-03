"use strict";

/**
 * ARŞİV KAPISI SORGUDAKİ KİMLİĞE GÜVENMEZ — AYRICALIK İZLEYİCİNİN.
 *
 * ⚠️ BULUNAN KUSUR (2026-08-03): premium arşiv kapısı kimliği
 * `req.query.userId || req.uid` ile çözüyordu. Sıralama tablosu HERKESİN
 * `userId` değerini döndürüyor, yani bir premium kullanıcının kimliğini yazan
 * herkes ayrıcalığı kullanabiliyordu.
 *
 * ÖLÇÜLDÜ (gerçek rotalar, bellek-içi Mongo; ücretsiz BEDAVACI, premium
 * PREMIUMCU, güncel sezon 2026-08, derin arşiv 2026-04):
 *     BEDAVACI kendi kimliğiyle          → 2026-08  (kısıtlandı, doğru)
 *     BEDAVACI + ?userId=PREMIUMCU       → 2026-04  ← KAPI ATLANDI
 *     KİMLİKSİZ + ?userId=PREMIUMCU      → 2026-04  ← KAPI ATLANDI
 *     team-ranks + ?userId=PREMIUMCU     → 2026-04  ← KAPI ATLANDI
 * Yani ücretli özellik, kimlik doğrulaması olmadan bile açılabiliyordu.
 *
 * ⚠️ SIRALAMA UCUNDA KİMLİK ARA KATMANI HİÇ YOKTU: `req.uid` hiç dolmuyordu,
 * bu yüzden kapıyı doğrudan `req.uid`e bağlamak premium kullanıcının hakkını
 * da yok ederdi. `optionalToken` eklendi — token varsa kimlik dolar, yoksa
 * ücretsiz kademe uygulanır.
 *
 * ⚠️ `?userId=` TAMAMEN KALDIRILMADI: ülke çözümü için hâlâ kullanılıyor
 * (o veri zaten herkese açık). Kaldırılan tek şey AYRICALIK kararında ona
 * güvenmek.
 *
 * ⚠️ PROFİL UCUNDA KAPI İZLEYİCİYE BAKAR: `/api/stats/user` başkasının
 * profilini gösteriyor; kapıyı profil sahibine bağlamak, ücretsiz izleyicinin
 * premium birinin profilini açarak derin arşive ulaşması demekti.
 */

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const KOK = path.join(__dirname, "..");
process.env.SKORLIG_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "skorlig-kapi-"));

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

const GUNCEL = Season.seasonKey();
let DERIN = GUNCEL;
for (let i = 0; i < 4; i++) DERIN = Season.previousKey(DERIN);

let mongod = null, client = null, db = null, srv = null, port = 0;

before(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const { MongoClient } = require("mongodb");
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  db = client.db("test");

  await db.collection("users").insertMany([
    { userId: "BEDAVACI", userIdLower: "bedavaci", mainTeam: "Galatasaray" },
    { userId: "PREMIUMCU", userIdLower: "premiumcu", mainTeam: "Galatasaray",
      premium: true, premiumUntil: new Date(Date.now() + 30 * 86400000).toISOString() },
  ]);
  await db.collection("season_totals").insertOne({
    season: DERIN, userId: "PREMIUMCU", userIdLower: "premiumcu",
    totalPoints: 99, totalPenalty: 0, matches: 30, lastAt: "2026-04-01T00:00:00.000Z",
  });

  const app = express();
  app.locals.db = db;
  app.use("/api/leaderboard", require(path.join(KOK, "routes", "leaderboard.cjs")));
  app.use("/api/stats", require(path.join(KOK, "routes", "stats.cjs")));
  await new Promise((r) => { srv = app.listen(0, r); });
  port = srv.address().port;
});

after(async () => {
  srv?.close();
  await client?.close();
  await mongod?.stop();
  try { fs.rmSync(process.env.SKORLIG_DATA_DIR, { recursive: true, force: true }); } catch { /* geçici */ }
});

const g = async (u, kimlik) =>
  (await fetch(`http://127.0.0.1:${port}${u}`,
               { headers: kimlik ? { "x-user-id": kimlik } : {} })).json();

describe("arşiv kapısı — kimlik kaynağı", () => {
  test("kurulum sınandı: PREMIUM kendi hakkını GERÇEKTEN kullanabiliyor", async () => {
    /**
     * ⚠️ Bu olmadan "kapı tuttu" sonucu, kapının HERKESİ engellemesinden de
     * gelebilirdi — ücretli özelliği öldürmek kusurdan daha sinsi olurdu.
     */
    const j = await g(`/api/leaderboard?season=${DERIN}&limit=1`, "PREMIUMCU");
    assert.equal(j.scope.season, DERIN, "premium kendi arsivine erisemiyor — ayricalik olu");
    assert.ok(!j.scope.archiveLimited, "premium istegi kisitlanmis");
    assert.ok(DERIN !== GUNCEL, "sezon anahtarlari hesaplanamadi");
  });

  test("BAŞKASININ kimliği ayrıcalık AÇMAZ (sıralama)", async () => {
    const j = await g(`/api/leaderboard?season=${DERIN}&limit=1&userId=PREMIUMCU`, "BEDAVACI");
    assert.equal(j.scope.season, GUNCEL, "sorgudaki kimlikle derin arsiv acildi");
    assert.equal(j.scope.archiveLimited, true, "kisitlama bildirilmiyor");
  });

  test("KİMLİKSİZ istek + başkasının kimliği de açmaz", async () => {
    /* ⚠️ En kötü hâli buydu: hiç kimlik doğrulaması olmadan ücretli özellik. */
    const j = await g(`/api/leaderboard?season=${DERIN}&limit=1&userId=PREMIUMCU`, null);
    assert.equal(j.scope.season, GUNCEL, "kimliksiz istek derin arsivi acti");
  });

  test("team-ranks de sorgudaki kimliğe güvenmiyor", async () => {
    const j = await g(`/api/stats/team-ranks?team=Galatasaray&season=${DERIN}&userId=PREMIUMCU`, "BEDAVACI");
    assert.equal(j.season, GUNCEL, "team-ranks sorgudaki kimlikle acildi");
  });

  test("PROFİL ucunda kapı İZLEYİCİYE bakar, profil sahibine değil", async () => {
    /**
     * ⚠️ `/api/stats/user` başkasının profilini gösteriyor. Kapıyı profil
     * sahibine bağlamak, ücretsiz izleyicinin premium birinin profilini açarak
     * derin arşive ulaşması demekti.
     */
    const bedava = await g(`/api/stats/user?userId=PREMIUMCU&season=${DERIN}`, "BEDAVACI");
    assert.equal(bedava.season?.key, GUNCEL, "ucretsiz izleyici premium profilinden derin arsive ulasti");

    const kendi = await g(`/api/stats/user?userId=PREMIUMCU&season=${DERIN}`, "PREMIUMCU");
    assert.equal(kendi.season?.key, DERIN, "premium kendi profilinde arsivi goremiyor");
    assert.equal(kendi.season?.total, 99, "arsiv verisi gelmiyor — test bir sey olcmuyor");
  });

  test("stats/me sahiplik denetimi bozulmadı", async () => {
    /* ⚠️ TERS RİSK: kapıyı izleyiciye bağlarken `/me`'nin sahiplik kuralını
     * gevşetmek başkasının cüzdanını açardı. */
    const j = await g(`/api/stats/me?userId=PREMIUMCU&season=${DERIN}`, "BEDAVACI");
    assert.notEqual(j.ok, true, "baskasinin /me verisi donuyor");
  });

  test("NÖBETÇİ: ayrıcalık kapısı sorgudaki kimliği kullanmıyor", () => {
    /**
     * ⚠️ KUSURUN KÖKÜ: `req.query.userId || req.uid` kalıbı. Biri geri
     * koyarsa ücretli özellik yine bedava olur ve HATA VERMEZ.
     */
    const oku = (rel) => fs.readFileSync(path.join(KOK, rel), "utf8")
      .split(/\r?\n/).map((l) => {
        const t = l.trim();
        return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
      }).join("\n");

    for (const rel of [path.join("routes", "leaderboard.cjs"), path.join("routes", "stats.cjs")]) {
      const s = oku(rel);
      const i = s.indexOf("arsivSezonu(");
      assert.ok(i > 0, `${rel}: arsiv kapisi cagrisi bulunamadi`);
      const govde = s.slice(i, i + 260);
      assert.ok(!/req\.query\.userId/.test(govde),
        `${rel}: ayricalik kapisi sorgudaki kimligi kullaniyor`);
      assert.ok(/req\.uid/.test(govde), `${rel}: kapi dogrulanmis kimlige bakmiyor`);
    }
  });

  test("NÖBETÇİ: sıralama ucu kimlik ara katmanı taşıyor", () => {
    /* ⚠️ `optionalToken` olmadan `req.uid` hiç dolmaz ve kapı premium
     * kullanıcının hakkını da yok eder — sessiz gerileme. */
    const s = fs.readFileSync(path.join(KOK, "routes", "leaderboard.cjs"), "utf8");
    assert.ok(/router\.get\("\/", optionalToken/.test(s),
      "siralama ucunda optionalToken yok — premium kimligi hic dolmaz");
  });
});
