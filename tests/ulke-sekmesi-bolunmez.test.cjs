"use strict";

/**
 * AYNI ÜLKE TEK SEKME: OKUMA TARAFINDA DA KANONİKLEŞTİRME.
 *
 * ⚠️ BULUNAN: kullanıcı ülkesi YAZILIRKEN kanonikleştiriliyor
 * (`routes/live2.cjs`), ama `lib/user-country.cjs` okurken depodaki değeri HAM
 * döndürüyordu. Göç öncesi kayıtlar, elle düzeltilmiş satırlar ya da farklı
 * bir istemcinin yazdığı "Turkey"/"Turkiye" varsa aynı ülke PARÇALANIYOR.
 *
 * ÖLÇÜLDÜ (gerçek express rotası; beş oyuncu, dördü aynı ülkenin üç yazımında):
 *     önce  GET /leaderboard/countries → "Türkiye 2", "Turkey 1", "Turkiye 1"
 *           GET /leaderboard?country=… → her üçünde de 4 satır
 *           yani sekme "1 oyuncu" diyor, tıklayınca 4 kişi çıkıyor
 *     sonra GET /leaderboard/countries → "Türkiye 4"   (tek sekme)
 *
 * ⚠️ KAYNAKTA DÜZELTİLDİ, OKUYUCU BAŞINA DEĞİL. Önceki turda ülke SÜZGECİNİ
 * `routes/leaderboard.cjs` içinde normalleştirmiştim; o düzeltme tek başına
 * bu tutarsızlığı ÜRETİYORDU (süzgeç birleştiriyor, sayaç bölüyor). Doğru yer
 * `attachCountries`: her okuyucu (sekme sayacı, süzgeç, gelecek uçlar) tek
 * seferde doğru oluyor. Her okuyucuya ayrı `normalizeCountry` serpiştirmek,
 * bu oturumda defalarca görülen "savunma tek yerde eksik" biçimini üretirdi.
 *
 * ⚠️ CANLI VERİDE ŞU AN BÖLÜNME YOK: `data/users.json` içindeki 840 kaydın
 * ülke değerlerinin tamamı kanonik. Kusur, karışık yazım oluştuğu anda
 * görünür — ve göç öncesi kayıtlarda tam olarak o yaşanmıştı.
 */

const os = require("os");
const path = require("path");
const fs = require("fs");

const TMP = path.join(os.tmpdir(), "skorlig-ulke-sekme-test");
process.env.SKORLIG_DATA_DIR = TMP;
process.env.SKORLIG_BG = "0";

const KOK = path.join(__dirname, "..");
const vt = require.resolve(path.join(KOK, "middleware", "verifyToken.cjs"));
require.cache[vt] = {
  id: vt, filename: vt, loaded: true, exports: {
    verifyToken: (q, _r, n) => { q.uid = q.headers["x-user-id"]; n(); },
    optionalToken: (q, _r, n) => { q.uid = q.headers["x-user-id"] || null; n(); },
    getFirebaseAuth: () => null, kimlikModu: () => "test",
  },
};

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const Season = require("../lib/season.cjs");
const { attachCountries, countryOfUser, invalidate } = require("../lib/user-country.cjs");

let mongod = null, client = null, db = null, srv = null, port = 0;

before(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });

  const { MongoMemoryServer } = require("mongodb-memory-server");
  const { MongoClient } = require("mongodb");
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  db = client.db("test");

  const sezon = Season.seasonKey();
  /* ⚠️ KARIŞIK YAZIM BİLEREK: göç öncesi kayıtlar ham adla kalmış olabilir. */
  const kur = async (uid, ulke, puan) => {
    await db.collection("users").insertOne({ userId: uid, userIdLower: uid, country: ulke });
    await db.collection("season_totals").insertOne({
      season: sezon, userId: uid, userIdLower: uid, totalPoints: puan, totalPenalty: 0, matches: 20,
    });
  };
  await kur("a", "Türkiye", 120);
  await kur("b", "Türkiye", 90);
  await kur("c", "Turkey", 80);      // aynı ülke, İngilizce
  await kur("d", "Turkiye", 70);     // aynı ülke, aksansız
  await kur("e", "Germany", 60);

  fs.writeFileSync(path.join(TMP, "totals.json"), JSON.stringify({
    items: ["a", "b", "c", "d", "e"].map((u) => ({ userId: u })),
  }));

  const app = express();
  app.use((q, _r, n) => { q.app.locals.db = db; n(); });
  app.use("/api/leaderboard", require("../routes/leaderboard.cjs"));
  srv = app.listen(0);
  port = srv.address().port;
});

after(async () => {
  if (srv) srv.close();
  if (client) await client.close();
  if (mongod) await mongod.stop();
});

const al = (p) =>
  fetch(`http://127.0.0.1:${port}${p}`, { headers: { "x-user-id": "a" } }).then((r) => r.json());

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("uç cevap veriyor ve oyuncular görünüyor", async () => {
    const j = await al("/api/leaderboard/countries");
    assert.equal(j.ok, true, `uc cevap vermedi: ${JSON.stringify(j).slice(0, 150)}`);
    const toplam = (j.items || []).reduce((a, i) => a + i.players, 0);
    assert.equal(toplam, 5, `${toplam} oyuncu sayildi, 5 bekleniyordu — test bir sey olcmuyor`);
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("ülke sekmeleri bölünmüyor", () => {
  test("üç yazım TEK sekmede toplanıyor", async () => {
    const j = await al("/api/leaderboard/countries");
    const turkiye = (j.items || []).filter((i) => /türkiye|turkey|turkiye/i.test(i.country));
    assert.equal(
      turkiye.length, 1,
      `Turkiye ${turkiye.length} sekmeye bolunmus: ${turkiye.map((x) => `${x.country}(${x.players})`).join(", ")}`
    );
    assert.equal(turkiye[0].country, "Türkiye", "sekme etiketi kanonik degil");
    assert.equal(turkiye[0].players, 4, "sekme sayaci bolunmus");
  });

  test("sekme sayacı ile tablo satırı UYUŞUYOR", async () => {
    /**
     * Asıl kullanıcı şikâyeti bu olurdu: sekmede "1 oyuncu" yazıp tıklayınca
     * 4 kişi çıkması. İki uç aynı veriyi farklı grupluyordu.
     */
    const c = await al("/api/leaderboard/countries");
    const sekme = (c.items || []).find((i) => i.country === "Türkiye");
    const t = await al("/api/leaderboard/?scope=country&country=T%C3%BCrkiye");
    assert.equal(
      sekme.players, (t.leaderboard || []).length,
      `sekme ${sekme.players} diyor, tablo ${(t.leaderboard || []).length} satir donuyor`
    );
  });

  test("başka ülke etkilenmiyor", async () => {
    const j = await al("/api/leaderboard/countries");
    const de = (j.items || []).find((i) => i.country === "Germany");
    assert.ok(de, "Germany sekmesi kayboldu");
    assert.equal(de.players, 1);
  });
});

describe("kaynak fonksiyonlar kanonik dönüyor", () => {
  test("attachCountries kanonik ad veriyor", async () => {
    invalidate();
    const rows = await attachCountries(
      ["a", "c", "d", "e"].map((u) => ({ userId: u })), db
    );
    const ulkeler = rows.map((r) => r.country);
    assert.deepEqual(
      ulkeler, ["Türkiye", "Türkiye", "Türkiye", "Germany"],
      `ham ad donuyor: ${ulkeler.join(", ")}`
    );
  });

  test("countryOfUser kanonik ad veriyor", async () => {
    invalidate();
    for (const uid of ["a", "c", "d"]) {
      assert.equal(await countryOfUser(uid, db), "Türkiye", `${uid} icin ham ad dondu`);
    }
  });

  test("ülkesi olmayan kullanıcı null kalıyor", async () => {
    await db.collection("users").insertOne({ userId: "z", userIdLower: "z" });
    invalidate();
    assert.equal(await countryOfUser("z", db), null, "ulkesiz kullaniciya ulke uydurulmus");
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: ülke KAYNAKTA kanonikleştiriliyor", () => {
  /**
   * Düzeltme okuyucu başına yapılırsa biri unutulur ve sayaç/süzgeç yine
   * ayrışır — bu turda tam olarak o yaşandı (süzgeç düzeltildi, sayaç
   * bölünmeye devam etti).
   */
  const src = fs.readFileSync(path.join(KOK, "lib", "user-country.cjs"), "utf8")
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");

  assert.ok(/require\("\.\/countries\.cjs"\)/.test(src), "kanonik esleyici kullanilmiyor");
  assert.ok(/const country = ham \? normalizeCountry\(ham\) : null;/.test(src), "attachCountries ham donuyor");
  assert.ok(/return ham \? normalizeCountry\(ham\) : null;/.test(src), "countryOfUser ham donuyor");
});
