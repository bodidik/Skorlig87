"use strict";

/**
 * YÖNETİM VE YASAK LİSTESİ — güvenlik düzeltmesi.
 *
 * ⚠️ Bu bir veri kaybı testi değil, GÜVENLİK testi. `verifyToken` her isteği
 * yasak listesinden süzüyordu ve dosya okunamayınca `catch { new Set() }`
 * çalışıyordu: "kimse yasaklı değil". Render'da disk kalıcı olmadığı için o
 * dosya her deploy'da siliniyor, yani TÜM YASAKLAR SESSİZCE KALKIYORDU.
 * Fail-open bir güvenlik kontrolü, hiç olmamasından daha kötüdür: koruduğu
 * sanılır.
 *
 * Çalıştırma:  npm test
 */

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const os = require("os");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "skorlig-mod-"));
process.env.SKORLIG_DATA_DIR = TMP;

const M = require("../lib/moderation-store.cjs");
const Settings = require("../lib/settings-store.cjs");

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
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});
beforeEach(async () => {
  for (const c of [M.COLL_ADMINS, M.COLL_BANNED, Settings.COLL]) {
    await db.collection(c).deleteMany({});
  }
  for (const f of ["admin-users.json", "banned-users.json", "settings.json"]) {
    try { fs.unlinkSync(path.join(TMP, f)); } catch {}
  }
});

describe("yasak listesi", () => {
  test("yasaklanan kullanıcı kümede görünür", async () => {
    await M.ban("Kotu1", { reason: "spam" }, db);
    const set = await M.bannedSet(db);
    assert.equal(set.has("kotu1"), true);
  });

  test("kimlik büyük/küçük harfe duyarsız — kaçış yolu olmamalı", async () => {
    // Firebase UID'leri karışık harfli; duyarlı olsaydı yasaklı kullanıcı
    // farklı harflerle yazıp geçebilirdi.
    await M.ban("AbCdEf", null, db);
    const set = await M.bannedSet(db);
    assert.equal(set.has("abcdef"), true);
    assert.equal((await M.listBanned(db)).length, 1);
  });

  test("aynı kullanıcıyı iki kez yasaklamak kopya üretmez", async () => {
    await M.ban("x", { reason: "ilk" }, db);
    await M.ban("x", { reason: "ikinci" }, db);
    const items = await M.listBanned(db);
    assert.equal(items.length, 1);
    assert.equal(items[0].reason, "ikinci", "sebep güncellenmeli");
  });

  test("yasak kaldırma çalışır", async () => {
    await M.ban("y", null, db);
    await M.unban("Y", db);
    assert.equal((await M.bannedSet(db)).size, 0);
  });

  test("eşzamanlı yasaklamalar kaybolmaz", async () => {
    await Promise.all(Array.from({ length: 10 }, (_, i) => M.ban("u" + i, null, db)));
    assert.equal((await M.bannedSet(db)).size, 10);
  });

  test("Mongo boşsa dosyadan okunur — yasak kaybolmaz", async () => {
    // Asıl kusur buydu: dosya yoksa boş küme dönüyordu. Artık dosya varsa
    // okunuyor ve Mongo'ya tohumlanıyor.
    fs.writeFileSync(
      path.join(TMP, "banned-users.json"),
      JSON.stringify({ items: [{ userId: "dosyada", reason: "eski" }] })
    );
    const set = await M.bannedSet(db);
    assert.equal(set.has("dosyada"), true);
    assert.equal(await db.collection(M.COLL_BANNED).countDocuments(), 1, "Mongo'ya tohumlanmalı");
  });

  test("düz metin (eski biçim) kayıtlar da okunur", async () => {
    fs.writeFileSync(path.join(TMP, "banned-users.json"), JSON.stringify({ items: ["eskiTip"] }));
    assert.equal((await M.bannedSet(db)).has("eskitip"), true);
  });
});

describe("admin listesi", () => {
  test("ekle / listele / sil", async () => {
    await M.addAdmin("Yonetici", db);
    assert.deepEqual(await M.listAdmins(db), ["yonetici"]);
    await M.removeAdmin("YONETICI", db);
    assert.deepEqual(await M.listAdmins(db), []);
  });

  test("aynı admin iki kez eklenemez", async () => {
    await M.addAdmin("a", db);
    await M.addAdmin("a", db);
    assert.equal((await M.listAdmins(db)).length, 1);
  });

  test("dosyadan tohumlanır", async () => {
    fs.writeFileSync(path.join(TMP, "admin-users.json"), JSON.stringify({ items: ["demo1", "uzay2"] }));
    const list = await M.listAdmins(db);
    assert.deepEqual(list.sort(), ["demo1", "uzay2"]);
    assert.equal(await db.collection(M.COLL_ADMINS).countDocuments(), 2);
  });
});

describe("uygulama ayarları", () => {
  test("kaydedilen ayar okunur", async () => {
    await Settings.save({ features: { mode: "GS_ONLY" }, scoring: { startBalance: 500 } }, db);
    const s = await Settings.load(db);
    assert.equal(s.features.mode, "GS_ONLY");
    assert.equal(s.scoring.startBalance, 500);
  });

  test("TEK BELGE — ikinci kayıt kopya oluşturmaz", async () => {
    await Settings.save({ scoring: { K_outcome: 3 } }, db);
    await Settings.save({ scoring: { K_outcome: 9 } }, db);
    assert.equal(await db.collection(Settings.COLL).countDocuments(), 1);
    assert.equal((await Settings.load(db)).scoring.K_outcome, 9);
  });

  test("hiç kaydedilmemişse null — çağıran varsayılanı uygular", async () => {
    assert.equal(await Settings.load(db), null);
  });

  test("dosyadan tohumlanır (puanlama parametreleri sıfırlanmaz)", async () => {
    fs.writeFileSync(
      path.join(TMP, "settings.json"),
      JSON.stringify({ scoring: { startBalance: 777, K_outcome: 5 } })
    );
    const s = await Settings.load(db);
    assert.equal(s.scoring.startBalance, 777);
    assert.equal(await db.collection(Settings.COLL).countDocuments(), 1);
  });
});
