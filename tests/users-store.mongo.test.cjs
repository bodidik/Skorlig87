"use strict";

/**
 * Kullanıcı deposu — MONGO modu.
 *
 * NEDEN AYRI DOSYA: Dosya modu testleri Mongo'ya özgü kısıtları YAKALAYAMAZ.
 * Gerçek örnek (bu testler yazılmadan önce üretime gidiyordu): `updateUser`
 * aynı alanı hem `$set` hem `$setOnInsert` içine koyuyordu. Mongo bunu
 * reddediyor ("would create a conflict at 'mainTeam'") ve TÜM işlem hata
 * veriyor. Çakışma kolay oluşuyordu — set-main-team yaması {mainTeam}
 * gönderiyor, varsayılanlar da {mainTeam: null} içeriyordu. Yani uç Mongo
 * modunda tamamen patlıyordu ve dosya modu testleri yemyeşil geçiyordu.
 *
 * mongodb-memory-server kurulu değilse testler ATLANIR — `npm test` ikili
 * indirmeden de çalışsın diye (CI'da ilk kurulum ~100MB).
 *
 * Çalıştırma:  npm test
 */

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const os = require("os");
const fs = require("fs");

let MongoMemoryServer = null;
try {
  ({ MongoMemoryServer } = require("mongodb-memory-server"));
} catch {
  /* kurulu değil — aşağıda atlanır */
}

const KUM = fs.mkdtempSync(path.join(os.tmpdir(), "skorlig-users-mongo-"));
process.env.SKORLIG_DATA_DIR = KUM;
// Bu dosyanın derdi Mongo yolu; dosya aynası kapalı.
process.env.SKORLIG_USERS_FILE_MIRROR = "0";

const Store = require("../lib/users-store.cjs");
const V = { mainTeam: null, lc: 30, lcLastDaily: null };

let _srv = null;
let _cli = null;
let db = null;

before(async () => {
  if (!MongoMemoryServer) return;
  _srv = await MongoMemoryServer.create();
  const { MongoClient } = require("mongodb");
  _cli = await new MongoClient(_srv.getUri()).connect();
  db = _cli.db("skorlig_test");
});

after(async () => {
  try { if (_cli) await _cli.close(); } catch {}
  try { if (_srv) await _srv.stop(); } catch {}
  try { fs.rmSync(KUM, { recursive: true, force: true }); } catch {}
});

const atla = () => !MongoMemoryServer;
const sebep = "mongodb-memory-server kurulu degil";

async function temizle() {
  await db.collection(Store.COLL).deleteMany({});
}

describe("Mongo modu — yazma", () => {
  test("yama ile varsayilan AYNI alani icerdiginde patlamaz", { skip: atla() && sebep }, async () => {
    await temizle();
    // Bu tam olarak set-main-team'in yaptigi cagri: patch.mainTeam var,
    // defaults.mainTeam de var. Eskiden ConflictingUpdateOperators atiyordu.
    await Store.updateUser("cakisma", { mainTeam: "Galatasaray" }, V, db);

    const u = await Store.getUser("cakisma", db);
    assert.equal(u.mainTeam, "Galatasaray", "acikca verilen deger kazanmali");
    assert.equal(u.lc, 30, "cakismayan varsayilan yine de uygulanmali");
  });

  test("mevcut kullanicida varsayilan mevcut degeri EZMEZ", { skip: atla() && sebep }, async () => {
    await temizle();
    await Store.updateUser("k", { mainTeam: "Besiktas", lc: 999 }, V, db);
    await Store.updateUser("k", { country: "Türkiye" }, V, db);

    const u = await Store.getUser("k", db);
    assert.equal(u.lc, 999, "varsayilan lc:30 mevcut 999'u ezmemeli");
    assert.equal(u.mainTeam, "Besiktas");
    assert.equal(u.country, "Türkiye");
  });

  test("eszamanli farkli alan yazimlari birbirini ezmez", { skip: atla() && sebep }, async () => {
    await temizle();
    await Store.ensureUser("yaris", V, db);
    await Promise.all([
      Store.updateUser("yaris", { country: "Japan" }, V, db),
      Store.updateUser("yaris", { nickname: "Kaan" }, V, db),
      Store.updateUser("yaris", { mainTeam: "Kashima" }, V, db),
    ]);

    const u = await Store.getUser("yaris", db);
    assert.equal(u.country, "Japan");
    assert.equal(u.nickname, "Kaan");
    assert.equal(u.mainTeam, "Kashima");
    assert.equal(await db.collection(Store.COLL).countDocuments({ userId: "yaris" }), 1);
  });

  test("paralel ensureUser cift kayit olusturmaz", { skip: atla() && sebep }, async () => {
    await temizle();
    await Promise.all(Array.from({ length: 10 }, () => Store.ensureUser("tek", V, db)));
    assert.equal(await db.collection(Store.COLL).countDocuments({ userId: "tek" }), 1);
  });

  test("ayna kapaliyken dosya YAZILMAZ", { skip: atla() && sebep }, async () => {
    await temizle();
    try { fs.unlinkSync(Store.FILE); } catch {}
    await Store.updateUser("dosyasiz", { country: "Brazil" }, V, db);
    assert.equal(fs.existsSync(Store.FILE), false, "Mongo varken ayna kapaliysa dosya yazilmamali");
  });
});

describe("Mongo modu — sorgular", () => {
  test("takma ad benzersizligi indeksten calisir", { skip: atla() && sebep }, async () => {
    await temizle();
    await Store.updateUser("u1", { nickname: "Ece", nicknameNorm: "ece" }, V, db);
    assert.equal(await Store.isNicknameTaken("ece", "baskasi", db), true);
    assert.equal(await Store.isNicknameTaken("ece", "u1", db), false, "kendi adi cakisma degil");
  });

  test("kimlikle cakisma da yakalanir", { skip: atla() && sebep }, async () => {
    await temizle();
    await Store.updateUser("admin", {}, { ...V, userIdNorm: "admin" }, db);
    assert.equal(await Store.isNicknameTaken("admin", "baskasi", db), true);
  });

  test("1987 segmenti iki alandan da bulunur", { skip: atla() && sebep }, async () => {
    await temizle();
    await Store.updateUser("bayrakli", { is1987: true }, V, db);
    await Store.updateUser("metinli", { segment: "1987" }, V, db);
    await Store.updateUser("digeri", { country: "Spain" }, V, db);

    const uyeler = await Store.listSegment1987(db);
    const idler = uyeler.map((u) => u.userId).sort();
    // Kayitlar tarihsel olarak iki bicimde yazilmis; birini atlamak uyelerin
    // bir kismini sessizce listeden dusururdu.
    assert.deepEqual(idler, ["bayrakli", "metinli"]);
  });

  test("toplu getirme yalnizca istenenleri doner", { skip: atla() && sebep }, async () => {
    await temizle();
    for (const id of ["a", "b", "c"]) await Store.updateUser(id, {}, V, db);
    const map = await Store.getUsersByIds(["a", "c", "yok"], db);
    assert.deepEqual(Object.keys(map).sort(), ["a", "c"]);
  });

  test("_id disari sizmaz", { skip: atla() && sebep }, async () => {
    await temizle();
    await Store.updateUser("gizli", { country: "France" }, V, db);
    const u = await Store.getUser("gizli", db);
    assert.equal(u._id, undefined, "Mongo _id'si profil yanitina karismamali");
  });

  test("gerekli indeksler kurulur", { skip: atla() && sebep }, async () => {
    await Store.getUser("herhangi", db); // ensureIndexes tetikle
    const anahtarlar = (await db.collection(Store.COLL).indexes()).map((i) => Object.keys(i.key)[0]);
    for (const gerekli of ["userId", "country", "nicknameNorm", "userIdNorm", "is1987", "segment"]) {
      assert.ok(anahtarlar.includes(gerekli), `indeks eksik: ${gerekli}`);
    }
  });
});
