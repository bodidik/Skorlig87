"use strict";

/**
 * AYNI MAÇ ID'SİNİN BOŞLUKLU HÂLİ İKİNCİ KEZ ÜCRETLENDİRMEZ.
 *
 * ⚠️ BULUNAN: `/api/weekly-picks/predict` `fixtureId`i HİÇ normalize etmiyordu.
 * Yardımcılar ise ediyordu — ve tam olarak bu ayrışma parayı sızdırdı:
 *
 *     FixturesStore.getOne(fixtureId)  → içeride trim  → maç BULUNUR
 *     fiksturKilidi(fixtureId)         → içeride trim  → kilit AÇIK
 *     getUserPred(uid, fixtureId, db)  → trim YOK      → "tahmin yok"  ← burası
 *
 * Yani "FDO-1 " (tek boşluk) gönderen kullanıcı için maç bulunur, kilit geçer,
 * ama "daha önce tahmin var mı" sorusu HAYIR döner → 3 LC daha kesilir.
 * Boşluk sayısı sınırsız olduğundan aynı maç için sınırsız ücret alınabilir.
 *
 * Üstelik para karşılığı da yoktu: `settle2.cjs` tahminleri kanonik id ile
 * (`{ fixtureId: String(fid) }`) arıyor, dolayısıyla boşluklu kayıt HİÇ
 * puanlanmaz. GET / de kanonik id listeler, yani kullanıcı ödediği fazladan
 * tahmini ekranda göremez bile. Para gider, karşılığı gelmez, iz görünmez.
 *
 * `pred.cjs:793` bunu doğru yapıyor: `const fx = String(fixtureId || "").trim();`
 * Aynı deponun iki tahmin ucundan yalnızca biri normalize ediyordu.
 */

const os = require("os");
const nodePath = require("path");
const fs = require("fs");

const TMP = nodePath.join(os.tmpdir(), "skorlig-fixtureid-kanonik-test");
process.env.SKORLIG_DATA_DIR = TMP;
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const FID = "kanonik-fx-1";
const UID = "kanonik-oyuncu";
const BASLANGIC = 100;

let mongod = null, client = null, db = null, server = null, taban = "";
let MAC_BEDELI = 0;

before(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const { MongoClient } = require("mongodb");
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  db = client.db("test");

  await db.collection("fixtures").insertOne({
    fixtureId: FID, home: "Ev", away: "Dep",
    kickoffISO: new Date(Date.now() + 6 * 3600_000).toISOString(),
    status: "NS",
  });

  const vtYol = require.resolve("../middleware/verifyToken.cjs");
  require("../middleware/verifyToken.cjs");
  require.cache[vtYol].exports = {
    ...require.cache[vtYol].exports,
    verifyToken: (req, _res, next) => { req.uid = UID; next(); },
    optionalToken: (req, _res, next) => { req.uid = UID; next(); },
  };

  const express = require("express");
  const app = express();
  app.locals.db = db;
  app.use(express.json());
  app.use("/api/weekly-picks", require("../routes/weekly-picks.cjs"));
  await new Promise((r) => { server = app.listen(0, r); });
  taban = `http://127.0.0.1:${server.address().port}`;

  MAC_BEDELI = require("../lib/ekonomi.cjs").macGirisBedeli();
});

after(async () => {
  if (server) server.close();
  if (client) await client.close();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  await db.collection("predictions").deleteMany({});
  await db.collection("lc_wallet_ledger").deleteMany({});
  await db.collection("lc_wallet_users").deleteMany({});
  await db.collection("lc_wallet_users").insertOne({
    userId: UID, userIdLower: UID, balance: BASLANGIC,
    totalEarned: 0, totalSpent: 0, createdAt: new Date().toISOString(),
  });
  fs.writeFileSync(nodePath.join(TMP, "preds.json"), JSON.stringify({ items: [] }));
});

const gonder = (fixtureId, outcome = "H") =>
  fetch(`${taban}/api/weekly-picks/predict`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fixtureId, outcome }),
  }).then((r) => r.json()).catch((e) => ({ ok: false, error: String(e) }));

const bakiye = async () =>
  Number((await db.collection("lc_wallet_users").findOne({ userIdLower: UID }))?.balance || 0);
const tahminSayisi = async () =>
  db.collection("predictions").countDocuments({ userIdLower: UID });

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("temiz id ile tek gönderim GERÇEKTEN ücret kesiyor", async () => {
    /* ⚠️ Bu kontrol olmasa "hiç ücret kesilmiyor" hâli de testi yeşil
     * gösterirdi — kardeş testte (tahmin-cifte-ucret) tam olarak bu yaşandı. */
    const r = await gonder(FID);
    assert.equal(r.ok, true, `gonderim basarisiz: ${JSON.stringify(r)}`);
    assert.ok(MAC_BEDELI > 0, "mac bedeli sifir — test bir sey olcmuyor");
    assert.equal(BASLANGIC - (await bakiye()), MAC_BEDELI);
  });

  test("temiz id ile İKİNCİ gönderim ücret kesmiyor (üzerine yazar)", async () => {
    await gonder(FID, "H");
    await gonder(FID, "A");
    assert.equal(
      BASLANGIC - (await bakiye()), MAC_BEDELI,
      "ayni id ile ikinci tahmin de ucretlendirildi — uzerine yazma bozuk"
    );
    assert.equal(await tahminSayisi(), 1, "ayni mac icin iki kayit olustu");
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("fixtureId normalizasyonu", () => {
  /* Her biri kanonik `FID`in görsel olarak AYNI maçı gösteren varyantı. */
  const VARYANTLAR = [
    ["sonda bosluk",    `${FID} `],
    ["basta bosluk",    ` ${FID}`],
    ["iki yanda",       ` ${FID} `],
    ["sekme",           `${FID}\t`],
    ["satir sonu",      `${FID}\n`],
  ];

  for (const [ad, varyant] of VARYANTLAR) {
    test(`${ad}: ikinci ücret KESİLMEZ`, async () => {
      const ilk = await gonder(FID);
      assert.equal(ilk.ok, true, "ilk gonderim basarisiz");

      const ikinci = await gonder(varyant, "A");
      assert.equal(ikinci.ok, true, `varyant reddedildi: ${JSON.stringify(ikinci)}`);

      const dusen = BASLANGIC - (await bakiye());
      assert.equal(
        dusen, MAC_BEDELI,
        `"${JSON.stringify(varyant)}" ikinci kez ucretlendirdi: ${dusen} LC dustu ` +
        `(olmasi gereken ${MAC_BEDELI}). fixtureId normalize edilmiyor.`
      );
    });

    test(`${ad}: ikinci KAYIT olusmaz (settle2 yetim tahmini puanlayamaz)`, async () => {
      await gonder(FID);
      await gonder(varyant, "A");

      const adet = await tahminSayisi();
      assert.equal(
        adet, 1,
        `ayni mac icin ${adet} tahmin kaydi var. Boslukulu kayit settle2'nin ` +
        `kanonik sorgusuna (fixtureId: String(fid)) DUSMEZ — odenmis ama ` +
        `hic puanlanmayacak tahmin.`
      );

      /* Kayıtlı id kanonik olmalı: aksi hâlde tek kayıt olsa bile settle2 bulamaz. */
      const doc = await db.collection("predictions").findOne({ userIdLower: UID });
      assert.equal(
        doc.fixtureId, FID,
        `kayitli fixtureId "${doc.fixtureId}" kanonik degil — settle2 bulamaz`
      );
    });
  }

  test("SINIRSIZ ÜCRET: 5 farklı boşluk varyantı tek ücret keser", async () => {
    /**
     * Kusurun asıl ağırlığı burada: boşluk sayısı sınırsız olduğundan
     * saldırgan aynı maça istediği kadar ödeme yaptırabilir (ya da acemi bir
     * istemci, id'yi kırpmadan gönderdiğinde kullanıcı farkında olmadan öder).
     */
    for (const v of [FID, `${FID} `, `${FID}  `, ` ${FID}`, `${FID}\t`]) {
      await gonder(v, "H");
    }
    const dusen = BASLANGIC - (await bakiye());
    assert.equal(
      dusen, MAC_BEDELI,
      `5 varyant ${dusen} LC dusurdu (olmasi gereken ${MAC_BEDELI}) — ` +
      `bosluk ekleyerek sinirsiz ucretlendirme mumkun`
    );
    assert.equal(await tahminSayisi(), 1, "yetim tahmin kayitlari olustu");
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: weekly-picks fixtureId'i kilit ÖNCESİ normalize ediyor", () => {
  /**
   * Kaynak taraması, davranış testinin tamamlayıcısı: normalizasyon
   * `withFileLock`ten ÖNCE olmalı ki kilit içindeki `getUserPred`,
   * `spendLc` ve Mongo yazımı hep kanonik id görsün.
   */
  const src = fs.readFileSync(
    nodePath.join(__dirname, "..", "routes", "weekly-picks.cjs"), "utf8"
  );
  const kod = src.split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");

  /* ⚠️ NÖBETÇİ ÖNCE SESSİZCE ÖLÜYDÜ. İlk hâli "dosyada bir yerde
   * String(fixtureId).trim() var mı" diye soruyordu — `getUserPred` içindeki
   * savunmacı kırpma bu koşulu karşılıyor, dolayısıyla handler'daki
   * kanonikleştirme silinse bile test YEŞİL kalıyordu. Negatif kontrol tam
   * olarak bunu gösterdi: sabotaj 6 davranış iddiasını düşürdü, nöbetçiyi
   * düşürmedi.
   *
   * Doğru ölçüt: handler gövdesinde, ham gövde değerinden türetilen bir
   * kanonik değişken olmalı. */
  const handlerBas = kod.indexOf('router.post("/predict"');
  assert.ok(handlerBas >= 0, "/predict handler bulunamadi — tarama bozuk");
  const kilit = kod.indexOf("withFileLock(PREDS_FILE", handlerBas);
  assert.ok(kilit >= 0, "PREDS_FILE kilidi bulunamadi — tarama bozuk");

  const govde = kod.slice(handlerBas, kilit);
  const norm = govde.search(/const\s+fixtureId\s*=\s*String\([^)]*\)\s*\.trim\(\)/);
  assert.ok(
    norm >= 0,
    "handler gövdesinde fixtureId kanoniklestirilmiyor. Gövdeden gelen ham " +
    "deger dogrudan kullaniliyorsa bosluk ekleyerek ikinci kez ucret " +
    "kesilebilir (yardimcilar trim ediyor, bu uc etmiyordu)."
  );

  /* Ham gövde alanı doğrudan kullanılmamalı — takma adla alınmalı. */
  assert.ok(
    /fixtureId:\s*fixtureIdRaw/.test(govde) || /fixtureIdRaw/.test(govde),
    "ham gövde degeri ayri bir ada alinmamis — kanonik degisken golgelenebilir"
  );
});
