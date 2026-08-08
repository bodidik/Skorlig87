"use strict";

/**
 * TAM YOLCULUK ZİNCİRİ — 1987 ÜYESİNİN İLK GÜNÜ, HTTP ÜZERİNDEN TEK ZİNCİR.
 *
 * Parçaların ayrı testleri var (cüzdan doğumu, kod kotası, 30+30 harcama,
 * iade=ödenen, aylık sayaç) ama WhatsApp grubundaki gerçek kullanıcının
 * yaşayacağı SIRAYLA hiçbiri koşmuyordu: uygulamayı aç → cüzdan doğar →
 * kodu gir → bonus kurulur → haftalık oyna (bonus erir) → normal maç oyna
 * (bakiye erir) → maç biter → iade ödenen kadar → ertesi gün günlük hak.
 * Entegrasyon hatası tam bu dikişlerde çıkar (bkz. e2e-cekirdek-dongu'nun
 * kendi bulgusu) — bu dosya lansman yolculuğunun dikişlerini kilitler.
 *
 * İZOLASYON: bellek-içi Mongo, SKORLIG_BG=0, geçici veri dizini.
 * Lansman env ile ZORLANIYOR (takvim 30 Eylül'ü geçince de çalışsın).
 */

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const os = require("os");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "skorlig-yolculuk-"));
process.env.SKORLIG_DATA_DIR = TMP;
process.env.SKORLIG_BG = "0";
process.env.SKORLIG_LANSMAN_BITIS = "2099-01-01T00:00:00Z";
process.env.SKORLIG_LANSMAN_BEDELI = "1";
fs.mkdirSync(path.join(TMP, "live"), { recursive: true });

const KOD = "YOLCULUK987";
const UID = "yolcu-1987";
const FX_HAFTALIK = "YOL-W1";
const FX_NORMAL   = "YOL-N1";

let mongod, client, db, server, taban;

/* ⚠️ SPREAD SIRASI: `...secenek` başlıklardan SONRA gelseydi
 * `secenek.headers` birleşik nesneyi komple ezer, Content-Type düşer ve
 * gövde hiç ayrıştırılmazdı — 7. adım tam bu yüzden CODE_REQUIRED yiyip
 * "kota erken kapandı" gibi göründü. Sonda da sınanır. */
const istek = (yol, secenek = {}) =>
  fetch(`${taban}${yol}`, {
    ...secenek,
    headers: { "Content-Type": "application/json", "x-test-uid": UID, ...(secenek.headers || {}) },
  }).then(async (r) => ({ status: r.status, j: await r.json().catch(() => ({})) }));

const cuzdan = () => db.collection("lc_wallet_users").findOne({ userIdLower: UID });

before(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const { MongoClient } = require("mongodb");
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = "yolculuk";
  client = await MongoClient.connect(mongod.getUri());
  db = client.db("yolculuk");

  const FixturesStore = require("../lib/fixtures-store.cjs");
  const yakin = (saat) => new Date(Date.now() + saat * 3600_000).toISOString();
  await FixturesStore.saveAll([
    { fixtureId: FX_HAFTALIK, home: "A", away: "B", kickoffISO: yakin(2), status: "NS", country: "Turkey" },
    { fixtureId: FX_NORMAL,   home: "C", away: "D", kickoffISO: yakin(3), status: "NS", country: "Turkey" },
  ], db);

  // Davet kodu: üretimdeki 50 kodun birebir şekli (bkz. gs1987-kodlar-uret.cjs)
  await db.collection("invite_codes_1987").insertOne({
    code: KOD, codeNorm: KOD, label: "yolculuk-test",
    maxUses: 2, used: 0, createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), lastUsedAt: null,
  });

  const vt = require.resolve("../middleware/verifyToken.cjs");
  require.cache[vt] = {
    id: vt, filename: vt, loaded: true,
    exports: {
      verifyToken: (req, _res, next) => { req.uid = req.headers["x-test-uid"]; next(); },
      optionalToken: (req, _res, next) => { req.uid = req.headers["x-test-uid"] || null; next(); },
      isBanned: async () => false,
    },
  };

  const express = require("express");
  const app = express();
  app.use(express.json());
  app.locals.db = db;
  app.use("/api/rt", require("../routes/lc-wallet.cjs"));
  app.use("/api/auth1987gs", require("../routes/auth-1987gs.cjs"));
  app.use("/api/weekly-picks", require("../routes/weekly-picks.cjs"));
  app.use("/api", require("../routes/pred.cjs"));
  app.use("/api/rt", require("../routes/settle2.cjs"));
  server = app.listen(0);
  if (!server.listening) await new Promise((r) => server.once("listening", r));
  taban = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) server.close();
  if (client) await client.close();
  try {
    const { close } = require("../lib/mongo.cjs");
    if (typeof close === "function") await close();
  } catch {}
  if (mongod) await mongod.stop();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

describe("yolculuk: ilk açılıştan ilk ödüle", () => {
  // Adımlar SIRAYLA — her biri öncekinin durumuna dayanır.

  test("1. açılış: cüzdan 30 LC ile doğar, lansman fiyatı görünür", async () => {
    const { status, j } = await istek(`/api/rt/lc-wallet/summary?userId=${UID}`);
    assert.equal(status, 200, `summary dusdu: ${JSON.stringify(j.error)}`);
    assert.equal(Number(j.user?.balance), 30, "acilis bakiyesi 30 degil");
    assert.equal(j.user?.is1987, false, "kod girmeden 1987 sayildi");
    assert.ok(j.lansman?.aktif, "lansman bilgisi yok — kullanici indirimli bedeli goremez");
    assert.equal(Number(j.lansman?.bedel), 1, "lansman bedeli 1 degil");
    assert.equal(Number(j.pricing?.matchEntryCost), 1,
      "matchEntryCost lansman bedelini yansitmiyor — ekran 3 gosterir, kasa 1 keser");
  });

  test("2. kod doğrulama: is1987 + bonus1987 30 kurulur, kota düşer", async () => {
    const { status, j } = await istek("/api/auth1987gs/verify", {
      method: "POST", body: JSON.stringify({ code: KOD }),
    });
    assert.equal(status, 200, `verify dusdu: ${JSON.stringify(j)}`);
    assert.equal(j.is1987, true, "verify uyelik yazmadi");
    assert.equal(j.code?.remaining, 1, "kota dusmedi — kod sinirsiz kullanilir");

    const c = await cuzdan();
    assert.equal(Number(c.bonus1987), 30,
      "bonus1987 kurulmadi — uye 30+30 vaadinin bonus yarisini hic almadi");
    assert.equal(Number(c.balance), 30, "kod dogrulama normal bakiyeyi degistirmemeli");

    /* Mobil sözleşmesi: cüzdan ekranı bonusu summary.user.bonus1987'den
     * okur (me.tsx). Depoda durup yanıtta dönmemesi, üyenin GÖREMEDİĞİ
     * cepten ödemesi demek. */
    const { j: ozet } = await istek(`/api/rt/lc-wallet/summary?userId=${UID}`);
    assert.equal(Number(ozet.user?.bonus1987), 30, "summary bonus1987 donmuyor — ekran cebi gosteremez");
    assert.equal(ozet.user?.is1987, true, "summary is1987 donmuyor — rozet kosulu calismaz");
  });

  test("3. haftalık oyun: bedel bonustan erir, bakiye el değmez", async () => {
    const { status, j } = await istek("/api/weekly-picks/predict", {
      method: "POST", body: JSON.stringify({ fixtureId: FX_HAFTALIK, outcome: "H" }),
    });
    assert.equal(status, 200, `haftalik reddedildi: ${JSON.stringify(j)}`);
    const c = await cuzdan();
    assert.equal(Number(c.bonus1987), 29, "haftalik bedel bonustan dusmedi");
    assert.equal(Number(c.balance), 30, "haftalik bedel yanlis cepten dustu");
  });

  test("4. normal maç: bedel bakiyeden, bonus el değmez", async () => {
    const { status, j } = await istek("/api/pred/submit", {
      method: "POST",
      body: JSON.stringify({ fixtureId: FX_NORMAL, type: "score", outcome: "H", home: 2, away: 1 }),
    });
    assert.equal(status, 200, `normal tahmin reddedildi: ${JSON.stringify(j)}`);
    const c = await cuzdan();
    assert.equal(Number(c.balance), 29, "normal mac bedeli bakiyeden dusmedi");
    assert.equal(Number(c.bonus1987), 29, "normal mac BONUSTAN dustu");
  });

  test("5. maç biter: ödül + iade tam ödenen kadar (1)", async () => {
    fs.writeFileSync(path.join(TMP, "live", `${FX_NORMAL}.json`), JSON.stringify({
      fixtureId: FX_NORMAL, status: "FT", score: { home: 2, away: 1 },
      firstGoal: "H", country: "Turkey", home: "C", away: "D",
    }));
    const { status, j } = await istek(`/api/rt/settle2?fixtureId=${FX_NORMAL}`, { method: "POST" });
    assert.equal(status, 200, `settle dusdu: ${JSON.stringify(j.error)}`);

    const iade = await db.collection("lc_wallet_ledger")
      .find({ userIdLower: UID, reason: "entry_refund" }).toArray();
    assert.equal(iade.length, 1, "kesin skor bildi ama iade tetiklenmedi");
    assert.equal(iade[0].amount, 1, `iade ${iade[0].amount} — odenen 1 idi`);

    const odul = await db.collection("lc_wallet_ledger")
      .findOne({ userIdLower: UID, reason: "match_reward" });
    assert.ok(odul && odul.amount > 0, "isabetli tahmine odul yazilmadi");
  });

  test("6. ertesi gün: günlük hak + aylık sayaç işler", async () => {
    /* Bakiye tabanın üstünde — gerçek kullanıcı gibi önce harcamış olmalı.
     * Doğrudan düşürüyoruz: modellenen durum "LC'si erimiş oyuncu". */
    await db.collection("lc_wallet_users").updateOne(
      { userIdLower: UID }, { $set: { balance: 1 } });

    const { status, j } = await istek("/api/rt/lc-wallet/daily-claim", {
      method: "POST", body: JSON.stringify({ userId: UID }),
    });
    assert.equal(status, 200, `daily-claim dusdu: ${JSON.stringify(j)}`);
    assert.ok(Number(j.daily?.amount) > 0, "gunluk hak 0 — taban tamamlama calismiyor");
    assert.equal(j.monthly?.daysThisMonth, 1, "aylik sayac ilk gunu saymadi");
    assert.ok(j.monthly?.next?.at === 10, "sonraki esik (10 gun) bildirilmiyor");
  });

  test("7. kota: ikinci kullanıcı da girer, üçüncü giremez", async () => {
    for (const [kimlik, beklenen] of [["yolcu-2", 200], ["yolcu-3", 400]]) {
      const { status, j } = await istek("/api/auth1987gs/verify", {
        method: "POST",
        headers: { "x-test-uid": kimlik },
        body: JSON.stringify({ code: KOD }),
      });
      assert.equal(status, beklenen,
        `${kimlik} icin beklenen ${beklenen} degil (yanit: ${JSON.stringify(j)}) — ` +
        `kota ${beklenen === 400 ? "asildi" : "erken kapandi"}`);
    }
  });
});
