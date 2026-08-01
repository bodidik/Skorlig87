"use strict";

/**
 * ENGEL LİSTESİ, ALAKASIZ BİR MONGO KAYDI YÜZÜNDEN KAYBOLMAZ.
 *
 * ⚠️ BULUNAN: `lib/social-store.cjs loadFriends`, aynaya düşme kararını ÜÇ
 * KOLEKSİYON İÇİN BİRDEN veriyordu:
 *     if (links.length || requests.length || blocks.length) → mongo sonucunu dön
 * Yani Mongo'da ALAKASIZ tek bir arkadaşlık bağı bulunması, yalnızca
 * `friends.json`'da kalmış bir ENGELİ görünmez yapıyordu.
 *
 * ÖLÇÜLDÜ (dosyada 1 engel, aynı veri):
 *     mongo tamamen boş            → blocks: 1   engel görünüyor
 *     mongo'da 1 ALAKASIZ bağ var  → blocks: 0   engel KAYBOLDU
 *
 * ⚠️ NEDEN CİDDİ: `routes/friends.cjs` engel denetimini tam bu yüzden ekledi.
 * Kendi notu: "engellenen biri, engelleyenin kodunu kullanarak arkadaş
 * olabiliyordu — engelin tamamını atlayarak. Üstelik ikisine de LC yatıyordu."
 * Engel listesi boş dönünce o denetim SESSİZCE hiçbir şey yapmaz: hata yok,
 * log yok, sadece geçer.
 *
 * ⚠️ AYNI KUSUR BU OTURUMDA `lib/streak-store.cjs`'te de bulundu — "hiçbiri
 * yoksa dosyaya düş" kestirmesi, bağımsız kayıtları tek bir karara bağlıyor.
 * İkinci kez çıktığı için burada kalıcı nöbetçiye bağlanıyor.
 *
 * ⚠️ DÜRÜST SINIR: Mongo DOLU dönen koleksiyona dokunulmuyor. Ayna orada
 * bayat olabilir; birincil kaynak Mongo, ayna yalnızca BOŞLUĞU dolduruyor.
 */

const os = require("os");
const path = require("path");
const fs = require("fs");

const TMP = path.join(os.tmpdir(), "skorlig-engel-ayna-test");
process.env.SKORLIG_DATA_DIR = TMP;
process.env.SKORLIG_BG = "0";

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const KOK = path.join(__dirname, "..");
const S = require("../lib/social-store.cjs");

const DOSYA = path.join(TMP, "friends.json");
let mongod = null, client = null, db = null;

const ENGEL = { by: "ayse", target: "kotu-adam", at: new Date().toISOString() };

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
  for (const c of ["friend_links", "friend_requests", "friend_blocks"]) {
    await db.collection(c).deleteMany({});
  }
  // Ayna: yalnızca engel var (mongo yazımı bir kez başarısız olmuş gibi).
  fs.writeFileSync(DOSYA, JSON.stringify({ links: [], requests: [], blocks: [ENGEL] }, null, 2));
});

const engelGoruluyorMu = (m) =>
  (m.blocks || []).some(
    (x) => String(x.by).toLowerCase() === "ayse" && String(x.target).toLowerCase() === "kotu-adam"
  );

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("mongo tamamen boşken engel zaten görünüyordu", async () => {
    const m = await S.loadFriends(db);
    assert.ok(engelGoruluyorMu(m), "dosya yolu hic calismiyor — test bir sey olcmuyor");
  });

  test("koleksiyon adları doğru (yanlış ad testi boşa çıkarır)", async () => {
    /**
     * ⚠️ İlk ölçümümde `social_links` yazmıştım; koleksiyon aslında
     * `friend_links` ve senaryo hiç kurulmadı, test "kusur yok" dedi. Adı
     * kaynaktan değil DAVRANIŞTAN doğruluyorum: yazdığım bağ okunmalı.
     */
    await db.collection("friend_links").insertOne({ a: "x", b: "y", pair: "x::y" });
    const m = await S.loadFriends(db);
    assert.equal(m.links.length, 1, "yazilan bag okunmadi — koleksiyon adi yanlis");
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("engel kaybolmuyor", () => {
  test("ALAKASIZ bir bağ varken engel HÂLÂ görünüyor", async () => {
    await db.collection("friend_links").insertOne({
      a: "mehmet", b: "zeynep", pair: "mehmet::zeynep",
    });
    const m = await S.loadFriends(db);
    assert.ok(
      engelGoruluyorMu(m),
      "alakasiz bir mongo kaydi engeli gorunmez yapti — engellenen kisi davet koduyla arkadas olabilir"
    );
  });

  test("alakasız bir İSTEK varken de engel görünüyor", async () => {
    await db.collection("friend_requests").insertOne({
      from: "a", to: "b", pair: "a->b",
    });
    assert.ok(engelGoruluyorMu(await S.loadFriends(db)));
  });

  test("mongo'daki bağlar KAYBOLMUYOR (ayna onları ezmiyor)", async () => {
    await db.collection("friend_links").insertOne({
      a: "mehmet", b: "zeynep", pair: "mehmet::zeynep",
    });
    const m = await S.loadFriends(db);
    assert.equal(m.links.length, 1, "mongo bagi kayboldu");
    assert.equal(m.links[0].a, "mehmet");
  });

  test("mongo DOLU olan koleksiyonda ayna kullanılmıyor", async () => {
    /**
     * Ters yöne kaçmadığımızın kanıtı: Mongo birincil kaynak. Aynada bayat
     * bir engel dururken Mongo'da başka bir engel varsa, Mongo kazanmalı.
     */
    await db.collection("friend_blocks").insertOne({
      by: "cem", target: "deniz", pair: "cem->deniz",
    });
    const m = await S.loadFriends(db);
    assert.equal(m.blocks.length, 1, "ayna mongo'nun ustune eklenmis");
    assert.equal(m.blocks[0].by, "cem", "bayat ayna kaydi mongo'yu ezdi");
  });

  test("aynada da yoksa boş dönüyor (kayıt uydurulmuyor)", async () => {
    fs.writeFileSync(DOSYA, JSON.stringify({ links: [], requests: [], blocks: [] }));
    await db.collection("friend_links").insertOne({ a: "p", b: "q", pair: "p::q" });
    const m = await S.loadFriends(db);
    assert.equal(m.blocks.length, 0);
  });
});

/* ── Uçtan uca: engel denetimi gerçekten çalışıyor mu ────────────────────── */

describe("engel denetimi", () => {
  test("kayıp engel, davet kodu denetimini sessizce geçirirdi", async () => {
    /**
     * `routes/friends.cjs isBlockedEither` doğrudan bu haritayı okuyor.
     * Yüklemeyi burada tekrar yazmıyorum — asıl fonksiyonun gördüğü VERİYİ
     * sınıyorum, çünkü kusur veri katmanındaydı.
     */
    await db.collection("friend_links").insertOne({ a: "m", b: "z", pair: "m::z" });
    const m = await S.loadFriends(db);
    const engelli = (m.blocks || []).some(
      (x) =>
        (String(x.by).toLowerCase() === "ayse" && String(x.target).toLowerCase() === "kotu-adam") ||
        (String(x.by).toLowerCase() === "kotu-adam" && String(x.target).toLowerCase() === "ayse")
    );
    assert.equal(engelli, true, "engel denetimi bos liste uzerinde calisir ve HERKESI gecirir");
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: aynaya düşme kararı koleksiyon başına", () => {
  const src = fs.readFileSync(path.join(KOK, "lib", "social-store.cjs"), "utf8")
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");

  assert.ok(
    /const eksik = \["links", "requests", "blocks"\]\.filter/.test(src),
    "koleksiyon basina tamamlama kalkmis — engel yeniden kaybolur"
  );
});
