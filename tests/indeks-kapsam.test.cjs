"use strict";

/**
 * İNDEKS KAPSAMI — sık sorgulanan alanlar indeksli olmalı.
 *
 * ⚠️ BULUNAN: `predictions` kod tabanının EN BÜYÜK koleksiyonu (yerel ölçümde
 * 36.331 kayıt) ama indeksleri YALNIZCA `scripts/ensure-indexes.cjs` içinde
 * kuruluyordu — yani birinin o betiği elle çalıştırmasına bağlıydı.
 *
 * Diğer BÜTÜN depolar (cüzdan, kupon, düello, havuz, seri, bildirim, davet)
 * ilk erişimde `ensureIndexes()` çağırıp kendini onarıyor. En çok sorgulanan
 * koleksiyon bu davranıştan yoksundu: yeni bir ortamda ya da koleksiyon
 * yeniden oluşturulduğunda indeksler sessizce kaybolur ve HER settle tüm
 * koleksiyonu tarar. Belirti hata değil, yalnızca yavaşlık — kimse bakmaz.
 *
 * (Aynı sınıf daha önce ölçülmüştü: tahmin sorgusu indekssizken 1679 kat
 * daha fazla belge tarıyordu.)
 */

const os = require("os");
const nodePath = require("path");
const fs = require("fs");
process.env.SKORLIG_DATA_DIR = nodePath.join(os.tmpdir(), "skorlig-indeks-test");
fs.mkdirSync(process.env.SKORLIG_DATA_DIR, { recursive: true });

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const { ensurePredIndexes, _sifirla } = require("../lib/preds-index.cjs");

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
beforeEach(async () => {
  await db.collection("predictions").drop().catch(() => {});
  // Modul sozu onbellekliyor (uretimde dogru); test yalitimi icin sifirla.
  _sifirla();
});

const anahtarlar = async () =>
  (await db.collection("predictions").indexes()).map((i) => JSON.stringify(i.key));

describe("tahmin indeksleri", () => {
  test("çalışma zamanında kuruluyor (betik gerekmeden)", async () => {
    await db.collection("predictions").insertOne({ fixtureId: "m1", userIdLower: "ali" });
    assert.equal((await anahtarlar()).length, 1, "baslangicta yalnizca _id olmali");

    await ensurePredIndexes(db);
    const k = await anahtarlar();
    assert.ok(k.includes('{"fixtureId":1}'), "settle sorgusu icin fixtureId indeksi yok");
    assert.ok(k.includes('{"userIdLower":1}'), "gecmis sorgusu icin userIdLower indeksi yok");
    assert.ok(k.includes('{"fixtureId":1,"userIdLower":1}'), "tekil okuma icin bilesik indeks yok");
  });

  test("ikinci çağrı yeniden kurmaz", async () => {
    await ensurePredIndexes(db);
    const once = (await anahtarlar()).length;
    await ensurePredIndexes(db);
    assert.equal((await anahtarlar()).length, once);
  });

  test("db yoksa sessizce geçer", async () => {
    await ensurePredIndexes(null);   // patlamamalı
  });

  test("BENZERSİZLİK iddia etmez", async () => {
    /**
     * ⚠️ Geçiş betiği `{fixtureId, userIdLower}` üzerinde UNIQUE kuruyor.
     * Aynısını çalışma zamanında kurmak, mevcut veride kopya varsa HER
     * açılışta hata verirdi. İndeks kurulumu bir onarım yolu, veri doğrulama
     * aracı değil — benzersizlik kararı geçiş betiğinde kalıyor.
     */
    await db.collection("predictions").insertMany([
      { fixtureId: "m1", userIdLower: "ali" },
      { fixtureId: "m1", userIdLower: "ali" },   // kopya
    ]);
    await ensurePredIndexes(db);                  // patlamamalı
    const idx = await db.collection("predictions").indexes();
    const bilesik = idx.find((i) => i.key.fixtureId === 1 && i.key.userIdLower === 1);
    assert.ok(bilesik, "bilesik indeks kurulmamis");
    assert.ok(!bilesik.unique, "calisma zamaninda unique kurmak mevcut kopyalarda patlar");
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: tahmin erişim noktaları indeksleri garanti ediyor", () => {
  const src = fs.readFileSync(nodePath.join(__dirname, "..", "models", "preds.cjs"), "utf8");

  // `collection("predictions")` kullanan her Mongo erişiminden önce çağrı olmalı.
  const erisimler = [...src.matchAll(/collection\("predictions"\)/g)].length;
  const garantiler = [...src.matchAll(/ensurePredIndexes\s*\(/g)].length;

  assert.ok(erisimler >= 3, `beklenenden az erisim (${erisimler}) — tarama bozulmus olabilir`);
  assert.ok(
    garantiler >= erisimler,
    `${erisimler} tahmin erisimi var ama ${garantiler} indeks garantisi — ` +
      "biri betige bagli kaldi, yeni ortamda COLLSCAN olur"
  );
});
