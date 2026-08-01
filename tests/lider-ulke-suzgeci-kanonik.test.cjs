"use strict";

/**
 * ÜLKE SIRALAMASI TAKMA ADLA DA ÇALIŞIR.
 *
 * ⚠️ BULUNAN: `routes/leaderboard.cjs scopedRank` ülke süzgecini HAM eşitlikle
 * yapıyordu (`r.country === wantCountry`). `country` parametresi istemciden
 * geliyor ve ucun kendi belgesi `country=Japan` diyor — yani ad bekleniyor.
 * Takma adı gönderen sessizce BOŞ liste alıyordu.
 *
 * ÖLÇÜLDÜ (gerçek express rotası, üç Türkiyeli oyuncu):
 *     ?country=Türkiye  → 3 satır
 *     ?country=Turkey   → 0 satır    applied:"country", poolSize:0
 *     ?country=Turkiye  → 0 satır
 *     ?country=TÜRKİYE  → 0 satır
 * Hata yok, uyarı yok — yalnızca boş tablo. Yanıt `applied:"country"` diyerek
 * süzgecin çalıştığını bildiriyor, "ülken bulunamadı"ya da düşmüyor.
 *
 * `lib/countries.cjs` tam bu iş için var ve kullanıcı ülkesi YAZILIRKEN
 * (routes/live2.cjs) zaten kullanılıyordu; OKUMA tarafında kullanılmıyordu.
 *
 * ⚠️ İKİ TARAF DA NORMALLEŞTİRİLİYOR: satırdaki ülke eski/ham yazımda kalmış
 * olabilir (göç öncesi kayıtlar, bot segment haritası). Tek tarafı çevirmek
 * aynı bölünmeyi başka yönden üretirdi.
 *
 * ⚠️ CANLI VERİDE ŞU AN BÖLÜNME YOK — abartmıyorum: `data/users.json`
 * içindeki 840 kaydın ülke değerlerinin tamamı kanonik. Kusur API
 * yüzeyinde: takma ad gönderen her istemci boş tablo görüyordu.
 */

const os = require("os");
const path = require("path");
const fs = require("fs");

const TMP = path.join(os.tmpdir(), "skorlig-lider-ulke-test");
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
  const kur = async (uid, ulke, puan) => {
    await db.collection("users").insertOne({ userId: uid, userIdLower: uid, country: ulke, nickname: uid });
    await db.collection("season_totals").insertOne({
      season: sezon, userId: uid, userIdLower: uid, totalPoints: puan, totalPenalty: 0, matches: 20,
    });
  };
  await kur("ali", "Türkiye", 120);
  await kur("veli", "Türkiye", 90);
  await kur("ayse", "Türkiye", 60);
  await kur("hans", "Germany", 100);

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

const sor = (c) =>
  fetch(`http://127.0.0.1:${port}/api/leaderboard/?scope=country&country=${encodeURIComponent(c)}`,
    { headers: { "x-user-id": "ali" } }).then((r) => r.json());

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("kanonik adla üç oyuncu dönüyor", async () => {
    const j = await sor("Türkiye");
    assert.equal(j.ok, true, `uc cevap vermedi: ${JSON.stringify(j).slice(0, 150)}`);
    assert.equal((j.leaderboard || []).length, 3, "kanonik ad bile calismiyor — test bir sey olcmuyor");
  });

  test("başka ülke sızmıyor", async () => {
    const j = await sor("Türkiye");
    assert.ok(!(j.leaderboard || []).some((r) => r.userId === "hans"), "Almanyali oyuncu Turkiye tablosunda");
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("takma adlar aynı tabloyu veriyor", () => {
  for (const ad of ["Turkey", "Turkiye", "TÜRKİYE", "türkiye"]) {
    test(`?country=${ad} → 3 satır`, async () => {
      const j = await sor(ad);
      assert.equal(
        (j.leaderboard || []).length, 3,
        `"${ad}" ile bos tablo dondu — istemci sessizce "kimse yok" goruyor`
      );
    });
  }

  test("yanıttaki ülke etiketi KANONİK", async () => {
    /**
     * İstemci ne gönderirse göndersin aynı etiketi almalı; yoksa arayüz
     * başlıkta "Turkey", listede "Türkiye" gösterip iki ayrı yer sanılır.
     */
    for (const ad of ["Turkey", "Turkiye", "Türkiye"]) {
      const j = await sor(ad);
      assert.equal(j.scope?.country, "Türkiye", `${ad} icin etiket ${j.scope?.country}`);
    }
  });

  test("Almanya için Türkçe ad da çalışıyor", async () => {
    const j = await sor("Almanya");
    assert.equal((j.leaderboard || []).length, 1);
    assert.equal(j.leaderboard[0].userId, "hans");
  });
});

describe("tanınmayan ülke sessizce herkesi göstermiyor", () => {
  test("olmayan ülke BOŞ dönüyor, küresele düşmüyor", async () => {
    /**
     * ⚠️ Ters yöne kaçmadığımızın kanıtı: normalizeCountry tanınmayanı
     * kırpılmış hâliyle döndürüyor, `null` değil. Eğer `null` dönseydi
     * süzgeç kapanır ve kullanıcı "Atlantis" sıralaması diye TÜM havuzu
     * görürdü.
     */
    const j = await sor("Atlantis");
    assert.equal((j.leaderboard || []).length, 0, "taninmayan ulke tum havuzu gosterdi");
    assert.equal(j.scope?.applied, "country");
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: süzgeç kanonik ad kullanıyor", () => {
  const src = fs.readFileSync(path.join(KOK, "routes", "leaderboard.cjs"), "utf8")
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");

  assert.ok(/normalizeCountry\(r\.country\) === wantKanonik/.test(src), "satir tarafi normallestirilmiyor");
  assert.ok(
    !/filter\(\(r\) => r\.country === wantCountry\)/.test(src),
    "ham esitlik geri gelmis — takma ad bos tablo dondurur"
  );
});
