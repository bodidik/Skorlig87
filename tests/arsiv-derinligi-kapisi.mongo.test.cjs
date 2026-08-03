"use strict";

/**
 * ARŞİV DERİNLİĞİ KAPISI ÜÇ UÇTA DA UYGULANIR.
 *
 * Geçmiş sezon tabloları premium ayrıcalığı: ücretsiz 1 sezon geriye, premium
 * 12 (lib/premium.cjs seasonArchiveDepth).
 *
 * ⚠️ BULUNAN KUSUR (2026-08-03): kural YALNIZCA `routes/leaderboard.cjs`
 * içinde yazılıydı. `?season=` desteği `stats/me` ve `team-ranks` uçlarına
 * eklenince kapı onlara gelmedi.
 *
 * ÖLÇÜLDÜ (gerçek rotalar, ücretsiz kullanıcı, güncel sezon 2026-08):
 *     sezon      leaderboard          stats/me    team-ranks
 *     2026-07    geçti                2026-07     2026-07
 *     2026-06    KISITLANDI→2026-08   2026-06     2026-06
 *     2026-02    KISITLANDI→2026-08   2026-02     2026-02
 * Ücretsiz kullanıcı ayrıcalığı iki uçtan atlayabiliyordu.
 *
 * ⚠️ DÜRÜSTLÜK: `stats/me` sızıntısını AYNI OTURUMDA BEN AÇTIM — sezon kapsamı
 * kusurunu düzeltirken `?season=` ekledim, premium kapısını taşımadım.
 * `team-ranks` sızıntısı önceden vardı (o uç `req.query.season`'ı zaten
 * alıyordu ve hiç kapı yoktu).
 *
 * ⚠️ KAPI KAPATMAZ, DÜŞÜRÜR: erişilemeyen sezon güncel sezona düşer ve
 * `archiveLimited` ile bildirilir — boş liste "o sezonda kimse yok" gibi
 * görünürdü.
 */

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const KOK = path.join(__dirname, "..");
const VERI_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "skorlig-arsiv-"));
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
const premium = require(path.join(KOK, "lib", "premium.cjs"));
const { arsivSezonu } = require(path.join(KOK, "lib", "sezon-arsiv.cjs"));

const UID = "UCRETSIZ1";
const GUNCEL = Season.seasonKey();
const ONCEKI = Season.previousKey(GUNCEL);
const COK_ESKI = Season.previousKey(Season.previousKey(Season.previousKey(GUNCEL)));

let mongod = null, client = null, db = null, srv = null, port = 0;

before(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const { MongoClient } = require("mongodb");
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  db = client.db("test");

  await db.collection("users").insertOne({
    userId: UID, userIdLower: UID.toLowerCase(), mainTeam: "Galatasaray", country: "Türkiye",
  });
  // ÇOK ESKİ sezonda veri VAR: kapı olmasa okunacağı görülebilsin.
  await db.collection("season_totals").insertMany([
    { season: COK_ESKI, userId: UID, userIdLower: UID.toLowerCase(),
      totalPoints: 99, totalPenalty: 0, matches: 30, lastAt: "2026-04-01T00:00:00.000Z" },
    { season: ONCEKI, userId: UID, userIdLower: UID.toLowerCase(),
      totalPoints: 10, totalPenalty: 0, matches: 6, lastAt: "2026-07-30T00:00:00.000Z" },
  ]);

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

const J = async (u, h) => (await fetch(`http://127.0.0.1:${port}${u}`, { headers: h || {} })).json();
const lb = (s) => J(`/api/leaderboard?season=${s}&limit=5&userId=${UID}`);
const me = (s) => J(`/api/stats/me?userId=${UID}&season=${s}`, { "x-user-id": UID });
const tr = (s) => J(`/api/stats/team-ranks?team=Galatasaray&season=${s}&userId=${UID}`);

describe("arşiv derinliği kapısı", () => {
  test("kurulum sınandı: ücretsiz derinlik 1 ve ÇOK ESKİ sezonda GERÇEKTEN veri var", async () => {
    /**
     * ⚠️ Bu olmadan iddia boş: eski sezonda veri yoksa kapı çalışmasa da
     * sonuç boş görünürdü ve test hiçbir şey ayırt etmezdi.
     */
    assert.equal(premium.seasonArchiveDepth(false), 1, "ucretsiz derinlik 1 degil — senaryo farkli");
    const n = await db.collection("season_totals").countDocuments({ season: COK_ESKI });
    assert.equal(n, 1, "cok eski sezonda tohum yok");
    assert.ok(COK_ESKI && COK_ESKI !== ONCEKI, "sezon anahtarlari hesaplanamadi");
  });

  test("bir önceki sezon ÜCRETSİZ kullanıcıya AÇIK (kapı fazla kısıtlamıyor)", async () => {
    /* ⚠️ TERS RİSK: kapıyı fazla sıkı yazmak ücretsiz kullanıcının hakkı olan
     * tek arşiv sezonunu da kapatırdı — kusurdan daha görünmez bir zarar. */
    for (const [ad, j] of [["leaderboard", await lb(ONCEKI)], ["stats/me", await me(ONCEKI)], ["team-ranks", await tr(ONCEKI)]]) {
      const sezon = j.season ?? j.scope?.season;
      assert.equal(sezon, ONCEKI, `${ad}: onceki sezon kisitlanmis`);
      assert.ok(!j.archiveLimited && !j.scope?.archiveLimited, `${ad}: gereksiz kisit bayragi`);
    }
  });

  test("DERİNLİK DIŞI sezon ÜÇ UÇTA da güncel sezona düşer", async () => {
    for (const [ad, j] of [["leaderboard", await lb(COK_ESKI)], ["stats/me", await me(COK_ESKI)], ["team-ranks", await tr(COK_ESKI)]]) {
      const sezon = j.season ?? j.scope?.season;
      assert.equal(sezon, GUNCEL, `${ad}: derinlik disi sezon okunabildi (${sezon})`);
    }
  });

  test("KISITLAMA BİLDİRİLİR (sessizce boş dönmez)", async () => {
    /* Kullanıcı neden istediği sezonu göremediğini anlamalı; sessiz düşüş
     * "o sezonda kimse yok" gibi görünürdü. */
    for (const [ad, j] of [["leaderboard", await lb(COK_ESKI)], ["stats/me", await me(COK_ESKI)], ["team-ranks", await tr(COK_ESKI)]]) {
      const bayrak = j.archiveLimited ?? j.scope?.archiveLimited;
      assert.equal(bayrak, true, `${ad}: kisitlama bildirilmiyor`);
    }
  });

  test("PREMIUM daha derine bakabilir (ayrıcalık gerçekten işliyor)", async () => {
    /* ⚠️ Kapı "herkesi engelle" olsaydı ücretli özellik ölürdü ve testler
     * yine yeşil kalırdı. Kural fonksiyonu premium ile doğrudan sınanıyor. */
    const ucretsiz = await arsivSezonu(COK_ESKI, { uid: UID, db });
    assert.equal(ucretsiz.sezon, GUNCEL, "ucretsiz kullanici derinlik disina erisebildi");

    /* ⚠️ PREMIUM `users` DEPOSUNDAN OKUNUR, cüzdandan değil — ve `premium:true`
     * ile birlikte GEÇERLİ bir `premiumUntil` şart (lib/premium.cjs fail-closed:
     * süre yoksa premium sayılmaz). İlk yazımda cüzdana yazmıştım ve test
     * kırıldı; kusur kodda değil kurulumumdaydı. */
    await db.collection("users").updateOne(
      { userIdLower: UID.toLowerCase() },
      { $set: { premium: true, premiumUntil: new Date(Date.now() + 30 * 86400000).toISOString() } }
    );
    const prem = await arsivSezonu(COK_ESKI, { uid: UID, db });
    assert.equal(prem.sezon, COK_ESKI, "premium kullanici arsive erisemedi — ayricalik olu");
    assert.equal(prem.kisitli, false);
  });

  test("KİMLİKSİZ istek ücretsiz kademeye düşer", async () => {
    /* Kimlik yoksa premium varsayılamaz; aksi hâlde kapı hiç yokmuş gibi
     * olurdu (istemci userId göndermeyi bırakır). */
    const r = await arsivSezonu(COK_ESKI, { uid: null, db });
    assert.equal(r.sezon, GUNCEL);
    assert.equal(r.kisitli, true);
  });

  test("NÖBETÇİ: kural TEK KAYNAKTAN, her uç oradan geçiyor", () => {
    /**
     * ⚠️ KUSURUN KÖKÜ: kural leaderboard'a gömülüydü, yeni uç eklenince
     * gelmedi. Bir uç kendi kopyasını yazarsa aynı boşluk geri gelir.
     */
    const oku = (rel) => fs.readFileSync(path.join(KOK, rel), "utf8")
      .split(/\r?\n/).map((l) => {
        const t = l.trim();
        return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
      }).join("\n");

    for (const rel of [path.join("routes", "leaderboard.cjs"), path.join("routes", "stats.cjs")]) {
      const s = oku(rel);
      assert.ok(/ArsivKapi\.arsivSezonu\(/.test(s), `${rel} ortak kapiyi kullanmiyor`);
      assert.ok(!/seasonArchiveDepth\(/.test(s),
        `${rel} derinlik kuralinin kendi kopyasini tasiyor`);
    }
  });
});
