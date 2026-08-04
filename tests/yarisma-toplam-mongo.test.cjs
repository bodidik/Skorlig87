"use strict";

/**
 * KUPA TOPLAMLARI MONGO KOLUNDA GERÇEK OYUNCULARI DÖNDÜRÜR.
 *
 * ⚠️ BULUNAN: `/api/rt/competition-totals` Mongo kolunda `leaderboard`
 * belgelerini DÜZ SATIR sanıyordu:
 *
 *     for (const r of lbDocs) {
 *       const uid = String(r.userId || r.userIdLower || "").trim() || "anon";
 *       const pts = Number(r.points || 0);
 *
 * Oysa o koleksiyonun TEK yazıcısı (`routes/realtime.cjs:345`) fikstür başına
 * BİR belge yazıyor ve kullanıcı satırlarını `items` dizisinde taşıyor:
 *
 *     { fixtureId, items: rows, updatedAt }
 *
 * `users.cjs:954` yorumu da bunu açıkça söylüyor: "belge fikstüre ait, ama
 * `items` dizisi kullanıcı satırları taşıyor."
 *
 * Sonuç: her belgede `r.userId` undefined → uid "anon", `r.points` undefined
 * → 0. Yani üretimde kupa tablosu TEK "anon / 0 puan" satırına çöküyor ve
 * `me` HER kullanıcı için null dönüyor. İki ekran ölü: stats.tsx ve
 * competition-kings.tsx (ikincisi sırf `rank` için `userId` gönderiyor).
 *
 * ⚠️ NEDEN YAKALANMADI: tek davranış testi (`yarisma-bot.test.cjs:84`)
 * `app.locals.db = null` ile DOSYA yoluna zorluyor. Dosyadaki satırlar düz
 * olduğu için o kol doğru çalışıyor ve test yeşil kalıyordu — üretimdeki kol
 * hiç sınanmamıştı. Bu test bilerek GERÇEK Mongo şeklini tohumluyor.
 */

const os = require("os");
const nodePath = require("path");
const fs = require("fs");

const TMP = nodePath.join(os.tmpdir(), "skorlig-yarisma-mongo-test");
process.env.SKORLIG_DATA_DIR = TMP;
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

const KUPA = "KUPA-MONGO-1";
const A = "oyuncu-ali";
const B = "oyuncu-veli";

let mongod = null, client = null, db = null, server = null, taban = "";

before(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const { MongoClient } = require("mongodb");
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  db = client.db("test");

  /* Şekiller KODDAN okundu, tahmin edilmedi:
   *   fixture_competitions → competition-totals.cjs:202-211 ($elemMatch)
   *   leaderboard          → realtime.cjs:345-349 ({fixtureId, items, updatedAt})
   *   satır içi            → realtime.cjs:303-311 */
  await db.collection("fixture_competitions").insertMany([
    { fixtureId: "m1", competitions: [{ competitionId: KUPA, countsForPoints: true }] },
    { fixtureId: "m2", competitions: [{ competitionId: KUPA, countsForPoints: true }] },
    // Bu kupaya SAYILMAYAN maç — toplamlara girmemeli.
    { fixtureId: "m3", competitions: [{ competitionId: KUPA, countsForPoints: false }] },
  ]);

  const satir = (fixtureId, userId, points, penalty = 0) => ({
    fixtureId, userId, points,
    basePoints: points + penalty,
    penalty,
    country: "Türkiye",
    detail: { zeroPenalty: penalty, redSidePenalty: 0, penaltySidePenalty: 0 },
  });

  await db.collection("leaderboard").insertMany([
    {
      fixtureId: "m1",
      items: [satir("m1", A, 10), satir("m1", B, 4, 2)],
      updatedAt: new Date("2026-08-01T10:00:00Z"),
    },
    {
      fixtureId: "m2",
      items: [satir("m2", A, 6), satir("m2", B, 8)],
      updatedAt: new Date("2026-08-02T10:00:00Z"),
    },
    {
      fixtureId: "m3",
      items: [satir("m3", A, 999)],           // sayılmayan maç
      updatedAt: new Date("2026-08-03T10:00:00Z"),
    },
  ]);

  const express = require("express");
  const app = express();
  app.locals.db = db;                          // ⚠️ MONGO kolu — kardeş test null veriyor
  app.use("/api/rt", require("../routes/competition-totals.cjs"));
  app.use("/api/stats", require("../routes/stats.cjs"));
  await new Promise((r) => { server = app.listen(0, r); });
  taban = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) server.close();
  if (client) await client.close();
  if (mongod) await mongod.stop();
});

const al = (q) => fetch(`${taban}/api/rt/competition-totals?${q}`).then((r) => r.json());

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("uç GERÇEKTEN Mongo kolundan yanıt veriyor", async () => {
    /* ⚠️ Bu kontrol olmasa, uç sessizce dosya koluna düşse bile aşağıdaki
     * iddialar "doğru" görünürdü — kardeş testte tam olarak bu oldu. */
    const r = await al(`competitionId=${KUPA}`);
    assert.equal(r.ok, true);
    assert.equal(
      r.source, "mongo_agg",
      `beklenen kol mongo_agg, gelen "${r.source}" — test yanlis kolu olcuyor`
    );
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("mongo kolu: anlık görüntü belgeleri açılıyor", () => {
  test("gerçek oyuncular listeleniyor, 'anon' YOK", async () => {
    const r = await al(`competitionId=${KUPA}`);
    const idler = r.items.map((x) => String(x.userId));

    assert.ok(
      !idler.includes("anon"),
      `liste "anon" satiri iceriyor: ${JSON.stringify(r.items)} — anlik ` +
      `goruntu belgesi duz satir sanildi (items dizisi acilmiyor)`
    );
    assert.deepEqual(
      idler.slice().sort(), [A, B].sort(),
      `beklenen oyuncular gelmedi: ${JSON.stringify(idler)}`
    );
  });

  test("puanlar items dizisinden toplanıyor", async () => {
    const r = await al(`competitionId=${KUPA}`);
    const ali = r.items.find((x) => x.userId === A);
    const veli = r.items.find((x) => x.userId === B);

    assert.ok(ali && veli, "oyuncu satirlari eksik");
    // m1:10 + m2:6 = 16 (m3 countsForPoints:false, girmemeli)
    assert.equal(ali.totalPoints, 16, `ali toplami yanlis: ${ali.totalPoints}`);
    assert.equal(veli.totalPoints, 12, `veli toplami yanlis: ${veli.totalPoints}`);
    assert.equal(ali.matches, 2, `ali mac sayisi yanlis: ${ali.matches}`);
  });

  test("sayılmayan maç (countsForPoints:false) toplamlara GİRMEZ", async () => {
    const r = await al(`competitionId=${KUPA}`);
    const ali = r.items.find((x) => x.userId === A);
    assert.ok(
      ali.totalPoints < 999,
      `sayilmayan mac toplama girmis (${ali.totalPoints}) — countsForPoints suzgeci calismiyor`
    );
  });

  test("ceza toplamı detail'den çıkarılıyor", async () => {
    const r = await al(`competitionId=${KUPA}`);
    const veli = r.items.find((x) => x.userId === B);
    assert.equal(
      veli.totalPenalty, 2,
      `ceza toplami yanlis: ${veli.totalPenalty} — detail satirdan degil belgeden okunuyor olabilir`
    );
  });
});

describe("me / rank", () => {
  test("userId verilince me DOLU döner", async () => {
    const r = await al(`competitionId=${KUPA}&userId=${A}`);
    assert.ok(
      r.me,
      "me null — kullanici listede bulunamadi. competition-kings.tsx sirf " +
      "rank icin userId gonderiyor, bu ekran olu demektir."
    );
    assert.equal(r.me.userId, A);
    assert.equal(r.me.totalPoints, 16);
  });

  test("rank puana göre doğru", async () => {
    const ilk = await al(`competitionId=${KUPA}&userId=${A}`);   // 16 puan
    const ikinci = await al(`competitionId=${KUPA}&userId=${B}`); // 12 puan
    assert.equal(ilk.me.rank, 1, `yuksek puanli oyuncunun sirasi ${ilk.me.rank}`);
    assert.equal(ikinci.me.rank, 2, `dusuk puanli oyuncunun sirasi ${ikinci.me.rank}`);
  });

  test("büyük/küçük harf farkı me'yi kaçırmaz", async () => {
    const r = await al(`competitionId=${KUPA}&userId=${A.toUpperCase()}`);
    assert.ok(r.me, "buyuk harfli userId ile me bulunamadi");
    assert.equal(r.me.totalPoints, 16);
  });
});

describe("bot işareti mongo kolunda da çalışıyor", () => {
  test("her satır isBot alanı taşır", async () => {
    /* İşaretleme çıkışta tek noktada yapılıyor (satır 88-97); Mongo kolu
     * düzeltilince o noktanın hâlâ devrede olduğunu doğruluyoruz. */
    const r = await al(`competitionId=${KUPA}`);
    assert.ok(r.items.length > 0, "liste bos — test bir sey olcmuyor");
    for (const x of r.items) {
      assert.ok("isBot" in x, `satirda isBot yok: ${JSON.stringify(x)}`);
    }
  });
});

describe("aynı yanlış okuma stats.cjs'te de vardı", () => {
  /**
   * `/api/stats/me` de aynı koleksiyonu `find({ userIdLower })` ile okuyordu.
   * Anlık görüntü belgesinde üst düzeyde `userIdLower` YOK — dahası satırların
   * kendisinde de yok (`realtime.cjs:303-311`). Yani `recentMatches` Mongo
   * modunda HER kullanıcı için boş dönüyordu; `form` türetmesi ve mobilde
   * `competition-kings.tsx:184` bu diziden besleniyor.
   *
   * Yarım düzeltme tam olarak bu yüzden tehlikeli: tablo düzelir, kullanıcının
   * form çubuğu ölü kalırdı.
   */
  test("son maçlar DOLU döner", async () => {
    const r = await fetch(`${taban}/api/stats/user?userId=${A}`).then((x) => x.json());
    assert.equal(r.ok, true, `stats/user basarisiz: ${JSON.stringify(r).slice(0, 200)}`);
    assert.ok(
      Array.isArray(r.recentMatches) && r.recentMatches.length > 0,
      `recentMatches bos: ${JSON.stringify(r.recentMatches)} — anlik goruntu ` +
      `belgesinde ust duzey userIdLower yok, sorgu hic eslesmiyor`
    );
  });

  test("son maç satırları gerçek puanı taşır", async () => {
    const r = await fetch(`${taban}/api/stats/user?userId=${A}`).then((x) => x.json());
    const puanlar = r.recentMatches.map((m) => Number(m.points));
    assert.ok(
      puanlar.some((p) => p !== 0),
      `tum puanlar sifir: ${JSON.stringify(puanlar)} — satir ici alanlar ` +
      `okunmuyor (m.points yerine m.items.points olmali)`
    );
    /* m1:10 ve m2:6 tohumlandı; m3 de bu kullanıcıya ait (999). */
    assert.ok(puanlar.includes(10), `10 puanli mac yok: ${JSON.stringify(puanlar)}`);
  });

  test("başka kullanıcının maçları SIZMAZ", async () => {
    const r = await fetch(`${taban}/api/stats/user?userId=${B}`).then((x) => x.json());
    const puanlar = r.recentMatches.map((m) => Number(m.points));
    assert.ok(
      !puanlar.includes(999),
      `baska kullanicinin satiri sizdi: ${JSON.stringify(puanlar)} — $unwind ` +
      `sonrasi eslestirme satir bazinda degil belge bazinda yapiliyor olabilir`
    );
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: leaderboard okuyan her yol items dizisini AÇIYOR", () => {
  /**
   * `leaderboard` koleksiyonunun şekli (fikstür başına bir belge + `items`)
   * yalnızca yazıcıda belgeli. Okuyan taraflar bunu düz satır sanarsa sessizce
   * boş/anon sonuç üretiyor — HTTP 200 ile. Kaynak taraması, davranış
   * testinin kapsamadığı diğer okuyucuları da bağlar.
   */
  const yol = nodePath.join(__dirname, "..", "routes", "competition-totals.cjs");
  const src = fs.readFileSync(yol, "utf8");
  const kod = src.split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");

  const i = kod.indexOf('collection("leaderboard")');
  assert.ok(i >= 0, "leaderboard okumasi bulunamadi — tarama bozuk");

  /* Okumadan sonraki bölgede satırlara `items` uzerinden erisilmeli. */
  const bolge = kod.slice(i, i + 2500);
  assert.ok(
    /\.items\b/.test(bolge) || /\$unwind/.test(bolge),
    "leaderboard belgeleri duz satir gibi okunuyor: `items` dizisi acilmiyor. " +
    "Yazici (realtime.cjs:345) fikstur basina BIR belge yaziyor ve kullanici " +
    "satirlarini `items` icinde tasiyor."
  );
});
