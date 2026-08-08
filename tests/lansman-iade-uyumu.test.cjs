"use strict";

/**
 * İADE, ÖDENENİ GEÇEMEZ — LANSMAN DÖNEMİ PARA BASMAMALI.
 *
 * ⚠️ KUSUR SINIFININ İKİNCİ MUTASYONU. `giris-bedeli-tek-kaynak.test.cjs`
 * (2026-08-02) "tahsilat ve iade AYNI SABİTİ okusun" diye nöbet tutuyordu ve
 * settle2 gerçekten ekonomi.cjs'i okuyor — nöbetçi yeşil. Ama lansman
 * tahsilatı DİNAMİK yaptı (`macGirisBedeli()`: dönem içinde 1, sonrası 3);
 * iade `MAC_GIRIS_BEDELI` sabitinde (3) kaldı. "Aynı kaynak" artık yetmiyor:
 * aynı kaynaktan İKİ FARKLI DEĞER çıkıyor.
 *
 * SONUÇ (bu test yazılırken ölçüldü, düzeltme öncesi):
 *     normal oyuncu : 1 LC öder, isabetli tahminde 3 LC "iade" alır → +2 net
 *     1987 üyesi    : 0 LC öder, yine 3 LC "iade" alır            → +3 net
 * 29 Temmuz'da 1291 oyuncuyla ölçülüp −0.23 LC/maç'a ayarlanan denge
 * (bkz. settle2 REFUND_MIN_BASE notu) lansmanla birlikte tekrar
 * pozitife dönüyordu — her isabetli tahmin sisteme LC basıyordu.
 *
 * DOĞRU TANIM (settle2'nin kendi notundan): iade "oynadığın bedeli HAK
 * ETTİN" demek. Ödenen neyse o döner: 1 ödeyen 1 alır, 0 ödeyen 0.
 * Bunun için ödenen tutar TAHMİN BELGESİNE yazılır (`lcCharged`) ve
 * settle2 iadeyi oradan okur — "o an geçerli bedel" tahmini değil,
 * gerçekte kesilen tutar.
 */

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const os = require("os");

// ⚠️ Modüller yüklenmeden ÖNCE: ekonomi.cjs sabitleri modül düzeyinde okur.
// Lansman BİLEREK zorlanıyor — test, takvim 30 Eylül'ü geçince de çalışmalı.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "skorlig-iade-"));
process.env.SKORLIG_DATA_DIR = TMP;
process.env.SKORLIG_BG = "0";
process.env.SKORLIG_LANSMAN_BITIS = "2099-01-01T00:00:00Z";
process.env.SKORLIG_LANSMAN_BEDELI = "1";
process.env.SKORLIG_MATCH_COST = "3";
fs.mkdirSync(path.join(TMP, "live"), { recursive: true });

const FID = "IADE-FX-1";
const BASLANGIC = 30;

// Dört senaryo tek maçta. (2026-08-08 30+30 kararıyla 1987 üyesi normal
// maçta artık HERKES GİBİ öder — bkz. tests/1987-ekonomi-3030.test.cjs.)
const ALI = "iade-ali";          // 1 öder → iade 1 olmalı
const CAN = "iade-can1987";      // 1987 üyesi: normal maçta 1 öder → iade 1
const UZE = "iade-uzeyir";       // 1 öder, sonra tahmini DEĞİŞTİRİR → iade yine 1
const PRE = "iade-premium";      // 0 ödemiş (lcCharged:0 belge) → iade 0

let mongod, client, db, server, taban;

const istek = async (yol, secenek = {}) => {
  const r = await fetch(`${taban}${yol}`, secenek);
  return { status: r.status, j: await r.json().catch(() => ({})) };
};

const gonder = (uid, govde) =>
  istek("/api/pred/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-test-uid": uid },
    body: JSON.stringify({ fixtureId: FID, ...govde }),
  });

const bakiye = async (uid) =>
  Number((await db.collection("lc_wallet_users").findOne({ userIdLower: uid }))?.balance || 0);

const iadeKayitlari = (uid) =>
  db.collection("lc_wallet_ledger")
    .find({ userIdLower: uid, reason: "entry_refund" }).toArray();

before(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const { MongoClient } = require("mongodb");
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = "iade";
  client = await MongoClient.connect(mongod.getUri());
  db = client.db("iade");

  const FixturesStore = require("../lib/fixtures-store.cjs");
  const { creditLc } = require("../lib/wallet-credit.cjs");
  const UsersStore = require("../lib/users-store.cjs");

  await FixturesStore.saveAll(
    [{ fixtureId: FID, home: "A", away: "B",
       kickoffISO: new Date(Date.now() + 3600_000).toISOString(),
       status: "NS", country: "Turkey", league: "Süper Lig" }],
    db
  );
  for (const u of [ALI, CAN, UZE]) await creditLc(db, u, BASLANGIC, "initial_default");

  // CAN 1987 üyesi: maç girişi bedava (pred.cjs effMatchCost=0 yolu).
  await UsersStore.updateUser(
    CAN, { is1987: true, since1987: new Date().toISOString(), active: true },
    { mainTeam: null, lc: 0, lcLastDaily: null }, db
  );

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

describe("lansman iade uyumu: iade == gerçekte ödenen", () => {
  test("kurulum sınandı: lansman bedeli normal bedelden FARKLI", () => {
    // Eşit olsalardı bu dosya hiçbir şey ölçmezdi.
    const E = require("../lib/ekonomi.cjs");
    assert.equal(E.macGirisBedeli(), 1, "lansman bedeli zorlanamadi");
    assert.equal(E.MAC_GIRIS_BEDELI_NORMAL, 3, "normal bedel 3 degil");
  });

  test("tahsilat: normal 1 LC, 1987 üyesi de normal maçta 1 LC, değiştirme bedava", async () => {
    for (const [u, g] of [
      [ALI, { type: "score", outcome: "H", home: 2, away: 1 }],
      [CAN, { type: "score", outcome: "H", home: 2, away: 1 }],
      [UZE, { outcome: "H" }],
    ]) {
      const { status, j } = await gonder(u, g);
      assert.equal(status, 200, `${u} tahmini reddedildi: ${JSON.stringify(j)}`);
    }
    // UZE tahminini kesin skora çevirir — ikinci gönderim ücretsiz olmalı.
    const { status } = await gonder(UZE, { type: "score", outcome: "H", home: 2, away: 1 });
    assert.equal(status, 200);

    // PRE: 0 ödemiş sınıf (satın alınmış premium'un ürettiği belge) — akışı
    // taklit etmek yerine belge düzeyinde kurulur; iade sözleşmesini sınar.
    await db.collection("predictions").insertOne({
      fixtureId: FID, userId: PRE, userIdLower: PRE,
      outcome: "H", home: 2, away: 1, lcCharged: 0,
      at: new Date().toISOString(), source: "user",
    });

    assert.equal(await bakiye(ALI), BASLANGIC - 1, "normal oyuncudan lansman bedeli (1) dusmedi");
    assert.equal(await bakiye(CAN), BASLANGIC - 1,
      "1987 uyesi normal macta odemedi — 30+30 karari: baska oyunda diger LC duser");
    assert.equal(await bakiye(UZE), BASLANGIC - 1, "degistirme ikinci kez ucretlendirdi");
  });

  test("İDDİA: isabetli tahminin iadesi ÖDENENE eşit (1 → 1, 0 → 0)", async () => {
    fs.writeFileSync(
      path.join(TMP, "live", `${FID}.json`),
      JSON.stringify({ fixtureId: FID, status: "FT", score: { home: 2, away: 1 },
                       firstGoal: "H", country: "Turkey", home: "A", away: "B" })
    );
    const { status, j } = await istek(`/api/rt/settle2?fixtureId=${FID}`, { method: "POST" });
    assert.equal(status, 200, `settle basarisiz: ${JSON.stringify(j.error)}`);

    // Kurulum sınaması: kesin skor bilenler iade eşiğini (base>=6) geçmeli.
    // İade hiç tetiklenmediyse bu test bir şey ölçmüyor demektir.
    const aliIade = await iadeKayitlari(ALI);
    assert.equal(aliIade.length, 1, "isabetli tahmine iade tetiklenmedi — esik/kurulum bozuk");

    assert.equal(
      aliIade[0].amount, 1,
      `PARA BASILIYOR: 1 LC odeyen oyuncuya ${aliIade[0].amount} LC "iade" yazildi. ` +
      "Iade odenen tutari (tahmin belgesindeki lcCharged) okumali, statik bedeli degil."
    );

    const canIade = await iadeKayitlari(CAN);
    assert.equal(canIade.length, 1, "1987 uyesinin (1 odedi) iadesi tetiklenmedi");
    assert.equal(canIade[0].amount, 1, "1987 uyesine odediginden farkli iade yazildi");

    const preIade = await iadeKayitlari(PRE);
    assert.equal(
      preIade.length, 0,
      `BEDAVAYA IADE: 0 LC odeyen (lcCharged:0) oyuncuya ${preIade[0]?.amount ?? "?"} LC ` +
      '"iade" yazildi. Odenmemis girisin iadesi olmaz — bu odul degil, emisyon.'
    );

    const uzeIade = await iadeKayitlari(UZE);
    assert.equal(uzeIade.length, 1, "degistiren oyuncunun iadesi kayboldu");
    assert.equal(
      uzeIade[0].amount, 1,
      `TASIMA KUSURU: ilk gonderimde 1 LC odendi, tahmin degistirilince iade ${uzeIade[0].amount} oldu. ` +
      "Uzerine yazma odenen tutari (lcCharged) SILMEMELI."
    );
  });

  test("NÖBETÇİ: iade hesabı belgeden okur, güncel bedelden değil", () => {
    /**
     * Davranış testinin tamamlayıcısı. Lansman 30 Eylül'de bitince canlıda
     * şu sınıf tekrar doğar: 1 LC ödenmiş tahmin, dönem bittikten sonra
     * sonuçlanır ve "güncel bedel" 3 LC iade eder. Kaynak taraması bunu
     * kilitler: refund satırı `lcCharged` içermeli.
     */
    const src = fs.readFileSync(path.join(__dirname, "..", "routes", "settle2.cjs"), "utf8")
      .split(/\r?\n/)
      .filter((l) => { const t = l.trim(); return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*"); })
      .join("\n");
    const satir = src.split("\n").find((l) => /const\s+refund\s*=/.test(l)) || "";
    assert.ok(
      /lcCharged|odenen|paid/i.test(satir),
      `settle2 iade satiri odenen tutari okumuyor: "${satir.trim()}"`
    );
  });
});
