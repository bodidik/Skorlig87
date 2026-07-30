"use strict";

/**
 * ÇEKİRDEK DÖNGÜ — UÇTAN UCA.
 *
 * Oyunun para ve puan zinciri tek testte: tahmin → LC düşümü → maç bitişi →
 * settle → puan/ödül → sezon toplamı → liderlik tablosu.
 *
 * ⚠️ NEDEN VAR: parçaların hepsinin ayrı testi vardı (mühürler, atomik
 * yazmalar, kilitler, sıralama) ama ZİNCİRİN TAMAMINI birlikte koşturan hiçbir
 * şey yoktu. Bir entegrasyon hatası — mesela settle'ın yazdığı alanı
 * liderliğin okumaması — tüm birim testleri yeşilken sessizce geçerdi.
 *
 * Nitekim bu döngüyü ilk kez elle koşturduğumda gerçek bir hata çıktı:
 * sıralama YUVARLANMIŞ rating ile yapılıyordu ve kalabalık havuzda daha düşük
 * puanlı oyuncu üstte çıkabiliyordu (bkz. tests/ranking.test.cjs).
 *
 * ⚠️ İZOLASYON: `SKORLIG_DATA_DIR` geçici dizine, `MONGODB_URI` bellek-içi
 * sunucuya bakar; gerçek `data/` ve üretim veritabanı HİÇ açılmaz. Arka plan
 * servisleri `SKORLIG_BG=0` ile kapalı — açık kalsalardı settle'ı ikinci kez
 * tetikleyip testi belirsizleştirirlerdi.
 */

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const os = require("os");

// ⚠️ Modüller yüklenmeden ÖNCE: yollar modül düzeyinde hesaplanıyor.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "skorlig-e2e-"));
process.env.SKORLIG_DATA_DIR = TMP;
process.env.SKORLIG_BG = "0";
fs.mkdirSync(path.join(TMP, "live"), { recursive: true });

const FIXTURE = "E2E-CEKIRDEK-1";
const BASLANGIC_LC = 30;
const OYUNCULAR = ["ali", "veli", "ayse"];

let mongod;
let client;
let db;
let server;
let taban;

/** Toplam LC arzı — para korunumunu ölçmenin tek yolu. */
async function arz() {
  const d = await db.collection("lc_wallet_users").find({}).toArray();
  return Math.round(d.reduce((a, x) => a + Number(x.balance || 0), 0) * 10) / 10;
}

async function istek(yol, secenek = {}) {
  const r = await fetch(`${taban}${yol}`, secenek);
  const j = await r.json().catch(() => ({}));
  return { status: r.status, j };
}

before(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const { MongoClient } = require("mongodb");
  mongod = await MongoMemoryServer.create();

  // ⚠️ Rotalar yüklenmeden ÖNCE ayarlanmalı: lib/mongo.cjs bağlantıyı
  // önbellekliyor, sonradan değiştirmek etkisiz kalırdı.
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = "e2e";

  client = await MongoClient.connect(mongod.getUri());
  db = client.db("e2e");

  const FixturesStore = require("../lib/fixtures-store.cjs");
  const { creditLc } = require("../lib/wallet-credit.cjs");

  const yakinda = new Date(Date.now() + 3600_000).toISOString();
  await FixturesStore.saveAll(
    [{ fixtureId: FIXTURE, home: "A", away: "B", kickoffISO: yakinda,
       status: "NS", country: "Turkey", league: "Süper Lig" }],
    db
  );
  for (const o of OYUNCULAR) await creditLc(db, o, BASLANGIC_LC, "initial_default");

  // Kimlik katmanını sahtele: amaç Firebase değil, para/puan zinciri.
  const vt = require.resolve("../middleware/verifyToken.cjs");
  require.cache[vt] = {
    id: vt, filename: vt, loaded: true,
    exports: {
      verifyToken: (req, _res, next) => { req.uid = req.headers["x-test-uid"] || "ali"; next(); },
      optionalToken: (req, _res, next) => { req.uid = req.headers["x-test-uid"] || "ali"; next(); },
      isBanned: async () => false,
    },
  };

  const express = require("express");
  const app = express();
  app.use(express.json());
  app.locals.db = db;
  app.use("/api", require("../routes/pred.cjs"));
  app.use("/api/rt", require("../routes/settle2.cjs"));
  app.use("/api/leaderboard", require("../routes/leaderboard.cjs"));
  server = app.listen(0);
  taban = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) server.close();
  if (client) await client.close();

  /* ⚠️ DEPOLARIN KENDİ BAĞLANTISI DA KAPANMALI.
   * Store'lar `getDbSafe()` içinden `lib/mongo.cjs`'in getDb()'sini çağırıyor
   * ve o bağlantıyı MODÜL DÜZEYİNDE önbelleğe alıyor. Yalnızca bu dosyanın
   * kendi istemcisini kapatmak yetmiyordu: testler bitiyor ama açık soket
   * olay döngüsünü ayakta tutuyor, süreç hiç çıkmıyordu (test koşucusu
   * "başarısız" sayıyordu, oysa 7 alt testin hepsi geçmişti). */
  try {
    const { close } = require("../lib/mongo.cjs");
    if (typeof close === "function") await close();
  } catch { /* bağlantı hiç kurulmamış olabilir */ }

  if (mongod) await mongod.stop();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

describe("çekirdek döngü: tahmin → settle → puan → liderlik", () => {
  // Testler SIRAYLA çalışmalı: her biri bir öncekinin durumuna dayanıyor.
  // node:test aynı describe içinde tanım sırasını korur.

  let arzBaslangic;
  let arzTahminSonrasi;
  let arzSettleSonrasi;

  test("başlangıç: her oyuncunun cüzdanı açıldı", async () => {
    arzBaslangic = await arz();
    assert.equal(arzBaslangic, OYUNCULAR.length * BASLANGIC_LC);
  });

  test("tahminler kabul edilir ve LC tam olarak düşer", async () => {
    const secim = {
      ali:  { outcome: "H", home: 2, away: 1 },   // kesin skoru bilecek
      veli: { outcome: "D", home: 1, away: 1 },
      ayse: { outcome: "A", home: 0, away: 3 },
    };
    for (const o of OYUNCULAR) {
      const { status, j } = await istek("/api/pred/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-test-uid": o },
        body: JSON.stringify({ fixtureId: FIXTURE, type: "score", ...secim[o] }),
      });
      assert.equal(status, 200, `${o} tahmini reddedildi: ${j.error}`);
    }

    arzTahminSonrasi = await arz();
    const dusen = arzBaslangic - arzTahminSonrasi;
    // Maç girişi oyuncu başına sabit bedel; toplam düşüş oyuncu sayısıyla orantılı.
    assert.ok(dusen > 0, "tahmin LC dusurmemis — ucretsiz oynaniyor");
    assert.equal(dusen % OYUNCULAR.length, 0,
      `dusen (${dusen}) oyuncu sayisina bolunmuyor — biri ucretsiz gecmis olabilir`);

    const kayit = await db.collection("predictions").countDocuments({ fixtureId: FIXTURE });
    assert.equal(kayit, OYUNCULAR.length, "tahmin sayisi eslesmiyor");
  });

  test("maç bitti: settle puanları dağıtır, kesin skoru bilen en çok alır", async () => {
    fs.writeFileSync(
      path.join(TMP, "live", `${FIXTURE}.json`),
      JSON.stringify({
        fixtureId: FIXTURE, status: "FT", score: { home: 2, away: 1 },
        firstGoal: "H", country: "Turkey", home: "A", away: "B",
      })
    );

    const { status, j } = await istek(`/api/rt/settle2?fixtureId=${FIXTURE}`, { method: "POST" });
    assert.equal(status, 200, `settle basarisiz: ${j.error}`);

    const satirlar = j.leaderboard || [];
    assert.equal(satirlar.length, OYUNCULAR.length, "settle tum oyunculari puanlamamis");

    const puan = Object.fromEntries(satirlar.map((r) => [r.userId, Number(r.points)]));
    assert.ok(puan.ali > 0, "kesin skoru bilen puan almamis");
    assert.ok(puan.ali > puan.veli && puan.ali > puan.ayse,
      "kesin skoru bilen en yuksek puani almamis");

    arzSettleSonrasi = await arz();
    assert.ok(arzSettleSonrasi > arzTahminSonrasi, "settle hic odul dagitmamis");
  });

  test("ikinci settle ÇİFT ÖDEME yapmaz (mühür)", async () => {
    const { status, j } = await istek(`/api/rt/settle2?fixtureId=${FIXTURE}`, { method: "POST" });
    assert.equal(status, 200);
    assert.equal(j.alreadySettled, true, "ikinci settle muhre takilmadi");
    assert.equal(await arz(), arzSettleSonrasi,
      "CIFT ODEME: ikinci settle LC arzini degistirdi");
  });

  test("sezon toplamı doğru sezona yazıldı", async () => {
    const Season = require("../lib/season.cjs");
    const docs = await db.collection("season_totals").find({}).toArray();
    assert.equal(docs.length, OYUNCULAR.length);
    for (const d of docs) {
      assert.equal(d.season, Season.seasonKey(),
        "sezon anahtari yanlis — ay donunce eski kovaya yazilir");
    }
  });

  test("liderlik tablosu settle'ı yansıtır ve doğru sıralar", async () => {
    const { status, j } = await istek("/api/leaderboard/");
    assert.equal(status, 200);
    const satirlar = j.leaderboard || [];
    assert.ok(satirlar.length >= OYUNCULAR.length, "liderlik bos");

    const yer = (u) => satirlar.findIndex((r) => r.userId === u);
    assert.ok(yer("ali") >= 0, "oyuncu liderlikte yok");
    assert.ok(yer("ali") < yer("veli") && yer("ali") < yer("ayse"),
      "en yuksek puanli oyuncu ustte degil");

    // Sıralama alanı yanıta sızmamalı (bkz. ranking.cjs _ratingRaw notu).
    assert.ok(!satirlar.some((r) => "_ratingRaw" in r), "_ratingRaw sizmis");
  });

  test("settle edilmiş maça yeni tahmin girilemez", async () => {
    const { status } = await istek("/api/pred/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-uid": "gecikmis" },
      body: JSON.stringify({ fixtureId: FIXTURE, type: "score", outcome: "H", home: 2, away: 1 }),
    });
    assert.notEqual(status, 200,
      "biten maca tahmin kabul edildi — sonucu bilerek oynanabilir");
  });
});
