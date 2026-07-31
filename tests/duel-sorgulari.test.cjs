"use strict";

/**
 * HEDEFLİ DÜELLO SORGULARI — eski bellek-içi süzmeyle AYNI sonucu vermeli.
 *
 * ⚠️ NEDEN: `loadDuels()` her çağrıda `find({})` yapıyordu — açık, sonuçlanmış,
 * iptal, geçersiz, HER düello ağdan geçip Node belleğine çözülüyordu. Üç sıcak
 * yol (düello ekranı açılışı, düello kurulumu, arena) buna bağlıydı. Fikstürler
 * budanıyor ama düellolar BİRİKİYOR: bugün etkisi ölçülemez, bir sezon sonra
 * her ekran açılışı megabaytlarca veri çeker.
 *
 * ⚠️ ASIL RİSK HIZ DEĞİL EŞDEĞERLİK. Sorguyu Mongo'ya taşırken süzme mantığı
 * ikiye ayrıldı; iki dal ayrışırsa kimse fark etmez — kullanıcı yalnızca
 * "düellom kayboldu" der. Bu yüzden testlerin çoğu iki dalı KARŞILAŞTIRIYOR.
 *
 * ⚠️ DOSYA YEDEĞİ SEMANTİĞİ: `loadDuels` yalnızca dosyaya düşmüyor, boş
 * Mongo'yu dosyadan TOHUMLUYOR da. Hedefli sorgu bunu atlasaydı ilk
 * çalıştırmada veri Mongo'ya hiç geçmezdi.
 */

const os = require("os");
const nodePath = require("path");
const fs = require("fs");

const TMP = nodePath.join(os.tmpdir(), "skorlig-duel-sorgu-test");
process.env.SKORLIG_DATA_DIR = TMP;
fs.mkdirSync(TMP, { recursive: true });

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const SocialStore = require("../lib/social-store.cjs");

let mongod = null, client = null, db = null;

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

const DOSYA = nodePath.join(TMP, "duels.json");

/** Gerçekçi düello kadrosu: farklı durumlar, farklı maçlar, karışık harf. */
const KADRO = [
  { id: "d1", fixtureId: "m1", status: "open",      creatorId: "Ali",  acceptorId: null,   stake: 10, createdAt: "2026-07-01T00:00:00Z" },
  { id: "d2", fixtureId: "m1", status: "active",    creatorId: "veli", acceptorId: "ALI",  stake: 20, createdAt: "2026-07-02T00:00:00Z" },
  { id: "d3", fixtureId: "m1", status: "settled",   creatorId: "ali",  acceptorId: "Ayse", stake: 30, createdAt: "2026-07-03T00:00:00Z" },
  { id: "d4", fixtureId: "m2", status: "open",      creatorId: "ALI",  acceptorId: null,   stake: 15, createdAt: "2026-07-04T00:00:00Z" },
  { id: "d5", fixtureId: "m2", status: "cancelled", creatorId: "veli", acceptorId: null,   stake: 25, createdAt: "2026-07-05T00:00:00Z" },
  { id: "d6", fixtureId: "m3", status: "voided",    creatorId: "Ayse", acceptorId: "ali",  stake: 40, createdAt: "2026-07-06T00:00:00Z" },
];

async function mongoyaYaz() {
  await db.collection("duels").insertMany(KADRO.map((d) => ({ ...d })));
}

beforeEach(async () => {
  await db.collection("duels").deleteMany({});
  try { fs.unlinkSync(DOSYA); } catch { /* yoktu */ }
});

/* ── Eşdeğerlik ──────────────────────────────────────────────────────────── */

/** Eski bellek-içi süzme — karşılaştırma tabanı. */
const eskiYol = {
  macaGore: (list, fid, status) =>
    list.filter((d) => String(d.fixtureId) === fid && (!status || d.status === status)),
  kullanici: (list, uidL, fid) =>
    list.filter((d) => {
      const benim =
        String(d.creatorId || "").toLowerCase() === uidL ||
        (d.acceptorId && String(d.acceptorId).toLowerCase() === uidL);
      return benim && (!fid || String(d.fixtureId) === fid);
    }),
  acikSayi: (list, uidL) =>
    list.filter((d) => String(d.creatorId || "").toLowerCase() === uidL && d.status === "open").length,
};

const kimlikler = (arr) => arr.map((d) => d.id).sort();

describe("hedefli sorgu = eski bellek-içi süzme", () => {
  beforeEach(mongoyaYaz);

  test("maça göre + duruma göre", async () => {
    const hepsi = await SocialStore.loadDuels(db);
    for (const [fid, status] of [["m1", "open"], ["m1", null], ["m2", "open"], ["m3", null]]) {
      const yeni = await SocialStore.duelsBul({ fixtureId: fid, status }, db);
      assert.deepEqual(
        kimlikler(yeni), kimlikler(eskiYol.macaGore(hepsi, fid, status)),
        `${fid}/${status} icin iki yol ayrisiyor`
      );
    }
  });

  test("yalnızca duruma göre (arena)", async () => {
    const hepsi = await SocialStore.loadDuels(db);
    const yeni = await SocialStore.duelsBul({ status: "open" }, db);
    assert.deepEqual(kimlikler(yeni), kimlikler(hepsi.filter((d) => d.status === "open")));
    assert.deepEqual(kimlikler(yeni), ["d1", "d4"]);
  });

  test("kullanıcıya göre — kurucu VE kabul eden, harf duyarsız", async () => {
    // "Ali"/"ali"/"ALI" karışık yazılmış; hepsi aynı kişi sayılmalı.
    const hepsi = await SocialStore.loadDuels(db);
    const yeni = await SocialStore.duelsKullanici("ali", db);
    assert.deepEqual(kimlikler(yeni), kimlikler(eskiYol.kullanici(hepsi, "ali", null)));
    assert.deepEqual(kimlikler(yeni), ["d1", "d2", "d3", "d4", "d6"]);
  });

  test("kullanıcı + maç birlikte süzülür", async () => {
    const yeni = await SocialStore.duelsKullanici("ALI", db, { fixtureId: "m1" });
    assert.deepEqual(kimlikler(yeni), ["d1", "d2", "d3"]);
  });

  test("açık düello sayısı", async () => {
    const hepsi = await SocialStore.loadDuels(db);
    for (const uid of ["ali", "Veli", "ayse", "kimse"]) {
      const sayi = await SocialStore.acikDuelloSayisi(uid, db);
      assert.equal(sayi, eskiYol.acikSayi(hepsi, uid.toLowerCase()), `${uid} icin sayim ayrisiyor`);
    }
    assert.equal(await SocialStore.acikDuelloSayisi("ali", db), 2);   // d1, d4
    assert.equal(await SocialStore.acikDuelloSayisi("veli", db), 0);  // d5 iptal
  });

  test("sonuçlanmış/iptal/geçersiz düellolar açık sayımına girmez", async () => {
    // Sayim sinirinin anlami: "su an bekleyen duellon". Kapanmislar sayilirsa
    // kullanici bir sure sonra hic duello acamaz hale gelirdi.
    assert.equal(await SocialStore.acikDuelloSayisi("ayse", db), 0);
  });
});

/* ── Dosya yedeği ────────────────────────────────────────────────────────── */

describe("Mongo boşken", () => {
  test("dosyaya düşer ve aynı sonucu verir", async () => {
    fs.writeFileSync(DOSYA, JSON.stringify(KADRO));
    const yeni = await SocialStore.duelsBul({ fixtureId: "m1", status: "open" }, db);
    assert.deepEqual(kimlikler(yeni), ["d1"], "Mongo bosken dosya yolu calismadi");
  });

  test("dosya yolu Mongo'yu TOHUMLAR — semantik korunmalı", async () => {
    /**
     * ⚠️ `loadDuels` yalnızca dosyaya düşmüyor, boş Mongo'yu dosyadan
     * tohumluyor da. Hedefli sorgu bu dalı atlasaydı ilk çalıştırmada veri
     * Mongo'ya hiç geçmez, uygulama kalıcı olarak dosya modunda kalırdı.
     */
    fs.writeFileSync(DOSYA, JSON.stringify(KADRO));
    assert.equal(await db.collection("duels").countDocuments(), 0);

    await SocialStore.duelsBul({ fixtureId: "m1" }, db);

    assert.ok(
      (await db.collection("duels").countDocuments()) > 0,
      "dosya yolundan sonra Mongo tohumlanmamis"
    );
  });

  test("kullanıcı sorgusu da dosyaya düşer", async () => {
    fs.writeFileSync(DOSYA, JSON.stringify(KADRO));
    const yeni = await SocialStore.duelsKullanici("ali", db);
    assert.deepEqual(kimlikler(yeni), ["d1", "d2", "d3", "d4", "d6"]);
  });

  test("sayım da dosyaya düşer", async () => {
    fs.writeFileSync(DOSYA, JSON.stringify(KADRO));
    assert.equal(await SocialStore.acikDuelloSayisi("ali", db), 2);
  });
});

/* ── Bozuk girdi ─────────────────────────────────────────────────────────── */

describe("bozuk girdi", () => {
  beforeEach(mongoyaYaz);

  test("boş kullanıcı kimliği boş sonuç verir, patlamaz", async () => {
    for (const uid of ["", null, undefined, "   "]) {
      assert.deepEqual(await SocialStore.duelsKullanici(uid, db), []);
      assert.equal(await SocialStore.acikDuelloSayisi(uid, db), 0);
    }
  });

  test("olmayan maç boş sonuç verir", async () => {
    assert.deepEqual(await SocialStore.duelsBul({ fixtureId: "boyle-mac-yok" }, db), []);
  });
});
