"use strict";

/**
 * /api/stats/team-ranks GEÇERSİZ SEZONU YEDEĞE DÜŞÜRÜR ve hangi sezona
 * baktığını SÖYLER.
 *
 * ⚠️ BULUNAN KUSUR (2026-08-03): `takimSiralamasi` sezonu doğrulamıyordu —
 *     const sezon = String(sezonIstek || "").trim() || Season.seasonKey();
 * Geçersiz bir dize (istemci hatası, eski bağlantı, elle yazılan URL) olduğu
 * gibi sorguya giriyordu. O sezonda hiç belge olmadığı için herkes 0 puanla
 * dönüyordu — hata yok, yalnızca yanlış tablo.
 *
 * ÖLÇÜLDÜ (gerçek rotalar, üretim verisi, aynı girdi `?season=SACMA`):
 *     /api/stats/me         → 2026-08'e düştü, yanıtta season alanı VAR
 *     /api/stats/user       → 2026-08'e düştü
 *     /api/stats/team-ranks → "SACMA" sorgulandı, total 0, season alanı YOK
 * Aynı girdiye üç farklı davranış. Üstelik yanıt sezonu söylemediği için ekran
 * "geçersiz sezon" ile "yeni sezon boş" arasını ayırt edemiyordu.
 *
 * ⚠️ DOĞRULAMA ÇAĞIRANDA DEĞİL ORTAK FONKSİYONDA: `/team-ranks` ve
 * `stats/me`'nin takım bloğu ikisi de `takimSiralamasi`'ndan geçiyor; kuralı
 * çağırana koymak, üçüncü bir çağıran eklenince yine unutulurdu.
 *
 * SONRA: season yok / SACMA / 2026-13 → hepsi 2026-08; 2026-07 → arşiv çalışıyor.
 */

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const KOK = path.join(__dirname, "..");
const VERI_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "skorlig-teamranks-"));
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

const UID = "TAKIMCI1";
const TAKIM = "Galatasaray";
const GUNCEL = Season.seasonKey();
const ONCEKI = Season.previousKey(GUNCEL);

let mongod = null, client = null, db = null, srv = null, port = 0;

before(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const { MongoClient } = require("mongodb");
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  db = client.db("test");

  await db.collection("users").insertOne({
    userId: UID, userIdLower: UID.toLowerCase(), mainTeam: TAKIM, country: "Türkiye",
  });
  // Puan YALNIZCA önceki sezonda: güncel sezonla arşiv ayırt edilebilsin.
  await db.collection("season_totals").insertOne({
    season: ONCEKI, userId: UID, userIdLower: UID.toLowerCase(),
    totalPoints: 9.9, totalPenalty: 0, matches: 6, lastAt: "2026-07-30T17:58:19.820Z",
  });

  const app = express();
  app.locals.db = db;
  app.use("/api/stats", require(path.join(KOK, "routes", "stats.cjs")));
  await new Promise((r) => { srv = app.listen(0, r); });
  port = srv.address().port;
});

after(async () => {
  srv?.close();
  await client?.close();
  await mongod?.stop();
  try { fs.rmSync(VERI_DIR, { recursive: true, force: true }); } catch { /* geçici */ }
});

const tr = async (q = "") =>
  (await fetch(`http://127.0.0.1:${port}/api/stats/team-ranks?team=${encodeURIComponent(TAKIM)}${q}`)).json();

describe("/api/stats/team-ranks — sezon doğrulaması", () => {
  test("kurulum sınandı: ARŞİV sezonu GERÇEKTEN veri döndürüyor", async () => {
    /**
     * ⚠️ Bu olmadan "geçersiz sezon 0 döndürüyordu" iddiası boş: uç hiç veri
     * döndürmüyorsa her sezon 0 çıkardı ve test ayırt etmezdi.
     */
    const j = await tr(`&season=${ONCEKI}`);
    assert.equal(j.ok, true);
    assert.equal(j.items.length, 1, "takim uyesi bulunamadi — test bir sey olcmuyor");
    assert.equal(j.items[0].total, 10, "arsiv puani gelmiyor");
  });

  test("GEÇERSİZ sezon güncel sezona düşer (yanlış tablo göstermez)", async () => {
    for (const kotu of ["SACMA", "2026-13", "2026-00", "abc-def", "2026"]) {
      const j = await tr(`&season=${encodeURIComponent(kotu)}`);
      assert.equal(j.season, GUNCEL, `"${kotu}" guncel sezona dusmedi (${j.season})`);
    }
  });

  test("YANIT hangi sezona bakıldığını söylüyor", async () => {
    /* ⚠️ Sezon alanı olmadan ekran "gecersiz sezon" ile "yeni sezon bos"
     * arasini ayirt edemez; ikisi de sifir gorunur. */
    const j = await tr();
    assert.equal(j.season, GUNCEL, "season alani yok/yanlis");
    assert.equal(j.seasonLabel, Season.label(GUNCEL), "seasonLabel yok/yanlis");
    assert.equal(j.isCurrentSeason, true);

    const a = await tr(`&season=${ONCEKI}`);
    assert.equal(a.isCurrentSeason, false, "arsiv guncel sezon gibi isaretlenmis");
  });

  test("ERKEN ÇIKIŞ da sezonu bildirir (takımın üyesi yokken)", async () => {
    /**
     * ⚠️ Sezon hesabı fonksiyonun başına alındı: üyesi olmayan takımda erken
     * dönülüyor ve eski hâlde o dalda `season` hiç bulunmuyordu — ekran o
     * durumda hangi sezona baktığını yazamazdı.
     */
    const j = await (await fetch(
      `http://127.0.0.1:${port}/api/stats/team-ranks?team=HicKimseninTakimi&season=${ONCEKI}`)).json();
    assert.equal(j.ok, true);
    assert.equal(j.items.length, 0, "bos takim senaryosu kurulmadi");
    assert.equal(j.season, ONCEKI, "erken cikista sezon bildirilmiyor");
  });

  test("stats/me ile team-ranks GEÇERSİZ girdide AYNI sezona düşer", async () => {
    /* ⚠️ Kusurun özü buydu: aynı girdiye iki uç iki cevap. İkisi de aynı
     * doğrulamadan geçmeli. */
    const me = await (await fetch(
      `http://127.0.0.1:${port}/api/stats/me?userId=${UID}&season=SACMA`,
      { headers: { "x-user-id": UID } })).json();
    const t = await tr("&season=SACMA");
    assert.equal(me.season, t.season, `stats/me ${me.season} vs team-ranks ${t.season}`);
  });

  test("NÖBETÇİ: doğrulama ORTAK fonksiyonda, çağıranda değil", () => {
    /**
     * ⚠️ Kuralı `/team-ranks` handler'ına koymak, `stats/me`'nin takım bloğu
     * ya da gelecekteki üçüncü bir çağıran için korumasız bırakırdı — bu
     * deponun en sık kusuru tam olarak bu.
     */
    const src = fs.readFileSync(path.join(KOK, "routes", "stats.cjs"), "utf8")
      .split(/\r?\n/)
      .map((l) => {
        const t = l.trim();
        return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
      })
      .join("\n");
    const bas = src.indexOf("async function takimSiralamasi(");
    assert.ok(bas > 0, "takimSiralamasi bulunamadi");
    const govde = src.slice(bas, src.indexOf("router.get(\"/team-ranks\""));
    assert.ok(/Season\.isValidKey\(/.test(govde),
      "sezon dogrulamasi ortak fonksiyonda degil");
    assert.ok(!/String\(sezonIstek \|\| ""\)\.trim\(\) \|\| Season\.seasonKey\(\)/.test(govde),
      "dogrulamasiz eski yedek geri gelmis");
  });
});
