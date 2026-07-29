"use strict";

/**
 * Sosyal depolar — gruplar, arkadaşlıklar, mini turnuvalar.
 *
 * NEDEN VAR: üçü de yalnızca dosyadaydı ve Render'da her deploy siliyordu.
 * Fikstür gibi yeniden üretilebilir veri değiller: kullanıcının kurduğu grup,
 * eklediği arkadaş, açtığı turnuva hiçbir kaynaktan geri gelmez.
 *
 * En riskli davranış TAM DEĞİŞTİRME (`saveX` listede olmayanı siler) ve
 * ANAHTAR ÜRETİMİ (yanlış anahtar → aynı kaydın iki kopyası ya da yanlış
 * kaydın silinmesi). İkisi de burada tutuluyor.
 *
 * Çalıştırma:  npm test
 */

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const os = require("os");

// ⚠️ Modül YÜKLENMEDEN önce: social-store yolu modül düzeyinde hesaplıyor.
// Gerçek data/ dizinine yazmamak için şart.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "skorlig-soc-"));
process.env.SKORLIG_DATA_DIR = TMP;

const S = require("../lib/social-store.cjs");

let mongod = null;
let client = null;
let db = null;

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
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

beforeEach(async () => {
  for (const c of [S.COLL_GROUPS, S.COLL_MINI, S.COLL_LINKS, S.COLL_REQUESTS, S.COLL_BLOCKS]) {
    await db.collection(c).deleteMany({});
  }
  for (const f of ["groups.json", "friends.json", "mini-tournaments.json"]) {
    try { fs.unlinkSync(path.join(TMP, f)); } catch {}
  }
});

/* ─────────────────────────────── gruplar ─────────────────────────────── */

describe("gruplar", () => {
  const grup = (ad, sahip, uyeler) => ({ name: ad, ownerId: sahip, members: uyeler, opts: {} });

  test("harita biçimi korunur — { KOD: {...} }", async () => {
    await S.saveGroups({ ABC: grup("Test", "u1", ["u1"]) }, db);
    const m = await S.loadGroups(db);
    assert.deepEqual(Object.keys(m), ["ABC"]);
    assert.equal(m.ABC.name, "Test");
    assert.deepEqual(m.ABC.members, ["u1"]);
  });

  test("kod alanı haritaya geri sızmaz", async () => {
    // Mongo'da `code` ayrı alan; okumada anahtara dönüşmeli, gövdede kalmamalı.
    await S.saveGroups({ ABC: grup("Test", "u1", []) }, db);
    const m = await S.loadGroups(db);
    assert.equal("code" in m.ABC, false);
  });

  test("üye eklemek kopya grup yaratmaz", async () => {
    await S.saveGroups({ ABC: grup("Test", "u1", ["u1"]) }, db);
    const m = await S.loadGroups(db);
    m.ABC.members.push("u2");
    await S.saveGroups(m, db);
    assert.equal(await db.collection(S.COLL_GROUPS).countDocuments(), 1);
    assert.deepEqual((await S.loadGroups(db)).ABC.members, ["u1", "u2"]);
  });

  test("haritadan çıkarılan grup SİLİNİR", async () => {
    await S.saveGroups({ A: grup("a", "u1", []), B: grup("b", "u1", []) }, db);
    await S.saveGroups({ A: grup("a", "u1", []) }, db);
    assert.deepEqual(Object.keys(await S.loadGroups(db)), ["A"]);
  });

  test("BOŞ HARİTA GERÇEKTEN SİLER — fikstür deposunun tersi", async () => {
    // Kasıtlı ayrım: sosyal veride boş liste geçerli bir durumdur (son grubu
    // sildim). Fikstürlerde ise boş liste dış kaynağın cevap vermediğini
    // gösterir ve silme engellenir. bkz. lib/social-store.cjs replaceAll
    await S.saveGroups({ A: grup("a", "u1", []) }, db);
    await S.saveGroups({}, db);
    assert.equal(Object.keys(await S.loadGroups(db)).length, 0);
  });
});

/* ──────────────────────────── mini turnuvalar ────────────────────────── */

describe("mini turnuvalar", () => {
  const t = (id, extra = {}) => ({ id, code: "K" + id, name: "T" + id, ownerId: "u1", members: [], ...extra });

  test("yazılan turnuva okunur", async () => {
    await S.saveMini([t("m1"), t("m2")], db);
    const list = await S.loadMini(db);
    assert.equal(list.length, 2);
    assert.equal("_id" in list[0], false, "_id sızmamalı");
  });

  test("aynı id güncellenir, kopyalanmaz", async () => {
    await S.saveMini([t("m1", { name: "Eski" })], db);
    await S.saveMini([t("m1", { name: "Yeni" })], db);
    const list = await S.loadMini(db);
    assert.equal(list.length, 1);
    assert.equal(list[0].name, "Yeni");
  });

  test("id'siz kayıt atlanır", async () => {
    await S.saveMini([t("m1"), { name: "idsiz" }], db);
    assert.equal((await S.loadMini(db)).length, 1);
  });

  test("BOŞ LİSTE GERÇEKTEN SİLER", async () => {
    await S.saveMini([t("m1")], db);
    await S.saveMini([], db);
    assert.equal((await S.loadMini(db)).length, 0);
  });
});

/* ───────────────────────────── arkadaşlıklar ─────────────────────────── */

describe("arkadaşlıklar", () => {
  test("üç bölüm de korunur", async () => {
    await S.saveFriends({
      links: [{ a: "u1", b: "u2", createdAt: "x" }],
      requests: [{ from: "u3", to: "u4" }],
      blocks: [{ by: "u5", target: "u6" }],
    }, db);
    const m = await S.loadFriends(db);
    assert.equal(m.links.length, 1);
    assert.equal(m.requests.length, 1);
    assert.equal(m.blocks.length, 1);
    assert.equal("pair" in m.links[0], false, "iç anahtar sızmamalı");
  });

  test("bağlantı YÖNSÜZ — (a,b) ile (b,a) aynı kayıt", async () => {
    // Yönlü anahtarlansaydı aynı arkadaşlık iki kez görünürdü.
    assert.equal(S._pairKey("u1", "u2"), S._pairKey("u2", "u1"));
    await S.saveFriends({ links: [{ a: "u1", b: "u2" }, { a: "u2", b: "u1" }] }, db);
    assert.equal(await db.collection(S.COLL_LINKS).countDocuments(), 1);
  });

  test("bağlantı anahtarı büyük/küçük harfe duyarsız", async () => {
    // Firebase UID'leri karışık harfli; duyarlı olsaydı aynı çift iki kayıt olurdu.
    assert.equal(S._pairKey("Ali", "Veli"), S._pairKey("ALI", "veli"));
  });

  test("istek ve engel YÖNLÜ — ters yön ayrı kayıt", async () => {
    // Engel simetrik değildir: u1 u2'yi engellerse, tersi doğru olmaz.
    await S.saveFriends({ blocks: [{ by: "u1", target: "u2" }, { by: "u2", target: "u1" }] }, db);
    assert.equal(await db.collection(S.COLL_BLOCKS).countDocuments(), 2);
  });

  test("listeden çıkarılan bağlantı SİLİNİR", async () => {
    await S.saveFriends({ links: [{ a: "u1", b: "u2" }, { a: "u1", b: "u3" }] }, db);
    await S.saveFriends({ links: [{ a: "u1", b: "u2" }] }, db);
    assert.equal((await S.loadFriends(db)).links.length, 1);
  });

  test("bir bölümü boşaltmak DİĞERLERİNİ etkilemez", async () => {
    // İstekler kabul edilince boşalır; bu, bağlantıları silmemeli.
    await S.saveFriends({
      links: [{ a: "u1", b: "u2" }],
      requests: [{ from: "u1", to: "u2" }],
    }, db);
    await S.saveFriends({ links: [{ a: "u1", b: "u2" }], requests: [] }, db);
    const m = await S.loadFriends(db);
    assert.equal(m.links.length, 1, "bağlantı durmalı");
    assert.equal(m.requests.length, 0);
  });

  test("SON arkadaşı çıkarmak gerçekten çalışır", async () => {
    // Kullanıcı eylemi: tek arkadaşını sil. "Boş liste silmez" koruması
    // buraya kopyalanmışken bu sessizce ÇALIŞMIYORDU — test yakaladı.
    await S.saveFriends({ links: [{ a: "u1", b: "u2" }] }, db);
    await S.saveFriends({ links: [] }, db);
    assert.equal((await S.loadFriends(db)).links.length, 0);
  });

  test("eksik bölümler boş dizi olur, patlamaz", async () => {
    await S.saveFriends({ links: [{ a: "u1", b: "u2" }] }, db);
    const m = await S.loadFriends(db);
    assert.deepEqual(m.requests, []);
    assert.deepEqual(m.blocks, []);
  });
});

/* ─────────────────────────────── dosya modu ──────────────────────────── */

describe("dosya modu", () => {
  test("Mongo yokken üçü de dosyadan çalışır", async () => {
    await S.saveGroups({ A: { name: "a", ownerId: "u1", members: [] } }, null);
    await S.saveMini([{ id: "m1", name: "t" }], null);
    await S.saveFriends({ links: [{ a: "u1", b: "u2" }] }, null);

    assert.equal(Object.keys(await S.loadGroups(null)).length, 1);
    assert.equal((await S.loadMini(null)).length, 1);
    assert.equal((await S.loadFriends(null)).links.length, 1);
  });

  test("Mongo boşsa dosyaya düşülür", async () => {
    await S.saveGroups({ Z: { name: "z", ownerId: "u1", members: [] } }, null);
    assert.equal(await db.collection(S.COLL_GROUPS).countDocuments(), 0);
    const m = await S.loadGroups(db);
    assert.equal(m.Z.name, "z", "Mongo boşken dosya okunmalı");
  });

  test("dosya biçimi eski okuyucularla uyumlu kalır", async () => {
    await S.saveMini([{ id: "m1" }], db);
    const raw = JSON.parse(fs.readFileSync(path.join(TMP, "mini-tournaments.json"), "utf8"));
    assert.ok(Array.isArray(raw.items), "{ items: [...] } sarmalı korunmalı");
    assert.ok(raw.updatedAt, "updatedAt yazılmalı");
  });
});
