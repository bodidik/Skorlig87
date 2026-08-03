"use strict";

/**
 * SEZON MIGRATION'I ÇAKIŞAN KAYDI BİRLEŞTİRİR — GERÇEK ÇALIŞTIRMA.
 *
 * ⚠️ NEDEN DAVRANIŞ TESTİ: bu migration'ın önceki iki hâli de kaynak metni
 * doğru görünürken ÜRETİMDE patladı/yanlış yazdı:
 *
 *   1) Hepsine `Season.seasonKey()` (= şimdi) damgalıyordu → 34 Temmuz kaydı
 *      Ağustos'a yazılacaktı.
 *   2) Sezonu doğru türetince ÇAKIŞMA ortaya çıktı ve script patladı:
 *        E11000 dup key: { season: "2026-07", userIdLower: "marakana49" }
 *      Eski (yanlış) kural çakışmıyordu, çünkü herkesi BOŞ olan aya yazıyordu.
 *
 * İkisi de kaynak-desen testiyle yakalanamazdı. Bu test scripti GERÇEKTEN
 * çalıştırıyor (bellek-içi Mongo) ve sonucu ölçüyor.
 *
 * ⚠️ ÜRETİME DOKUNMAZ: kendi MONGODB_URI'siyle ayrı süreçte koşar.
 */

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { execFile } = require("child_process");

const KOK = path.join(__dirname, "..");
const BETIK = path.join(KOK, "scripts", "migrate-season-field.cjs");
const COLL = "season_totals";

let mongod = null, client = null, db = null, uri = null;

before(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const { MongoClient } = require("mongodb");
  mongod = await MongoMemoryServer.create();
  uri = mongod.getUri();
  client = await MongoClient.connect(uri);
  db = client.db("test");
});

after(async () => {
  await client?.close();
  await mongod?.stop();
});

/** Scripti AYRI SÜREÇTE, bellek-içi Mongo'ya karşı çalıştırır. */
function betigiCalistir(ekArgv = []) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [BETIK, ...ekArgv],
      {
        cwd: KOK,
        env: {
          ...process.env,
          // ⚠️ dotenv MEVCUT env'i EZMEZ — bu yüzden .env'deki üretim URI'si
          // devreye girmez ve test üretime dokunmaz.
          MONGODB_URI: uri,
          MONGODB_DB: "test",
          SKORLIG_PUSH: "0",
        },
        timeout: 120000,
      },
      (err, stdout, stderr) => resolve({ err, stdout: String(stdout), stderr: String(stderr) })
    );
  });
}

async function tohumla() {
  const col = db.collection(COLL);
  await col.deleteMany({});
  try { await col.dropIndexes(); } catch { /* indeks yoksa sorun değil */ }

  // 30 temiz: hedef sezonda kayıtları YOK
  const temizler = [];
  for (let i = 0; i < 30; i++) {
    temizler.push({
      userId: `temiz${i}`, userIdLower: `temiz${i}`,
      totalPoints: 1, totalPenalty: 0, matches: 1,
      lastAt: "2026-07-29T18:00:00.000Z",           // → 2026-07
    });
  }
  // 4 çakışan: hem sezonsuz hem 2026-07 kaydı var
  const cakisanlar = [];
  for (let i = 0; i < 4; i++) {
    cakisanlar.push({
      userId: `cak${i}`, userIdLower: `cak${i}`,
      totalPoints: 10, totalPenalty: 2, matches: 3,
      lastAt: "2026-07-29T18:00:00.000Z",           // sezonsuz öksüz
    });
    cakisanlar.push({
      season: "2026-07",
      userId: `Cak${i}`, userIdLower: `cak${i}`,     // sezonlu belge
      totalPoints: 5, totalPenalty: 1, matches: 2,
      lastAt: "2026-07-31T20:00:00.000Z",
    });
  }
  await col.insertMany([...temizler, ...cakisanlar]);
}

describe("sezon migration — çakışma birleştirme (gerçek çalıştırma)", () => {
  test("kurulum sınandı: tohum GERÇEKTEN çakışma içeriyor", async () => {
    /* ⚠️ Bu olmadan "çakışmayı çözüyor" iddiası boş: veri çakışmıyorsa
     * script zaten patlamazdı ve test hiçbir şey kanıtlamazdı. */
    await tohumla();
    const col = db.collection(COLL);
    assert.equal(await col.countDocuments({ season: { $exists: false } }), 34);
    assert.equal(await col.countDocuments({ season: "2026-07" }), 4);
  });

  test("KURU KOŞU çakışmayı planda gösteriyor ve HİÇBİR ŞEY yazmıyor", async () => {
    await tohumla();
    const col = db.collection(COLL);
    const { stdout } = await betigiCalistir(["--dry"]);

    assert.match(stdout, /2026-07: 34 kayit/, `plan Temmuz demiyor:\n${stdout}`);
    assert.match(stdout, /30 damgalanacak · 4 BIRLESTIRILECEK/,
      `kuru kosu cakismayi gostermiyor — karar gizli kalir:\n${stdout}`);
    // Yazma olmamalı
    assert.equal(await col.countDocuments({ season: { $exists: false } }), 34,
      "kuru kosu YAZMIS");
  });

  test("GERÇEK koşu: 30 damgalanır, 4 birleşir, öksüz kalmaz", async () => {
    await tohumla();
    const col = db.collection(COLL);
    const { err, stdout, stderr } = await betigiCalistir();
    assert.ok(!err, `script patladi:\n${stdout}\n${stderr}`);

    assert.equal(await col.countDocuments({ season: { $exists: false } }), 0,
      "sezonsuz kayit kaldi");
    // 30 temiz + 4 birleşik = 34 Temmuz kaydı (öksüzler silindi)
    assert.equal(await col.countDocuments({ season: "2026-07" }), 34,
      "Temmuz kayit sayisi beklenenden farkli — birlestirme yerine kopya yaratilmis olabilir");
    assert.equal(await col.countDocuments({}), 34, "toplam belge sayisi yanlis");
  });

  test("BİRLEŞTİRME TOPLUYOR: puan/ceza/maç kaybolmuyor", async () => {
    /**
     * ⚠️ ASIL RİSK ÜZERİNE YAZMAK. Öksüzü silip sezonlu belgeyi olduğu gibi
     * bırakmak da "çakışma çözüldü" gibi görünür ama oyuncunun puanı sessizce
     * kaybolur. Toplamlar tek tek sınanıyor.
     */
    await tohumla();
    const col = db.collection(COLL);
    await betigiCalistir();

    for (let i = 0; i < 4; i++) {
      const d = await col.findOne({ season: "2026-07", userIdLower: `cak${i}` });
      assert.ok(d, `cak${i} kaydi yok`);
      assert.equal(d.totalPoints, 15, `puan toplanmamis (10+5 bekleniyordu, ${d.totalPoints})`);
      assert.equal(d.totalPenalty, 3, `ceza toplanmamis (2+1 bekleniyordu, ${d.totalPenalty})`);
      assert.equal(d.matches, 5, `mac toplanmamis (3+2 bekleniyordu, ${d.matches})`);
      assert.equal(d.lastAt, "2026-07-31T20:00:00.000Z", "lastAt en yenisi olmali");
    }
  });

  test("İDEMPOTENT: ikinci koşu hiçbir şeyi bozmuyor", async () => {
    /* ⚠️ Bakım betiği iki kez çalıştırılabilir olmalı; ikinci koşu puanları
     * bir daha toplarsa toplamlar ikiye katlanırdı. */
    await tohumla();
    const col = db.collection(COLL);
    await betigiCalistir();
    const ilk = await col.find({}).sort({ userIdLower: 1 }).toArray();
    await betigiCalistir();
    const ikinci = await col.find({}).sort({ userIdLower: 1 }).toArray();

    assert.equal(ikinci.length, ilk.length, "ikinci kosu belge sayisini degistirdi");
    const puanIlk = ilk.reduce((a, b) => a + Number(b.totalPoints || 0), 0);
    const puanIki = ikinci.reduce((a, b) => a + Number(b.totalPoints || 0), 0);
    assert.equal(puanIki, puanIlk, "ikinci kosu puanlari degistirdi — idempotent degil");
  });

  test("TEK BİR ÇAKIŞMA ÖTEKİLERİ ENGELLEMİYOR", async () => {
    /**
     * ⚠️ ÖNCEKİ HÂLİN ASIL ZARARI BUYDU: tek `updateMany` ilk çakışmada
     * duruyordu ve geri kalan 33 kayıt HİÇ yazılmıyordu (ölçüldü:
     * modifiedCount 0). Belge başına işlem bunu kaldırıyor.
     */
    await tohumla();
    const col = db.collection(COLL);
    await betigiCalistir();
    // Çakışmayanların hepsi damgalanmış olmalı
    const temiz = await col.countDocuments({ season: "2026-07", userIdLower: /^temiz/ });
    assert.equal(temiz, 30,
      `cakismayan kayitlarin hepsi damgalanmamis (${temiz}/30) — bir cakisma otekileri engelliyor`);
  });
});
