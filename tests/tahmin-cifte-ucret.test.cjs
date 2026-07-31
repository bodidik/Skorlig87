"use strict";

/**
 * AYNI MAÇA EŞZAMANLI TAHMİN İKİ KEZ ÜCRETLENDİRMEZ.
 *
 * ⚠️ BULUNAN: `/api/weekly-picks/predict` şu sırayı kilitsiz yapıyordu —
 *
 *     const existing = await getUserPred(uid, fixtureId, db);   // OKU
 *     if (!free && !existing) await spendLc(db, uid, COST);     // ÜCRETLENDİR
 *
 * Eşzamanlı istekler hepsi `existing = null` görüp HER BİRİ ayrı ücret
 * kesiyordu. Çift dokunuş ya da ağ yeniden denemesi yeterliydi.
 *
 * ÖLÇÜLDÜ (bellek-içi Mongo, 8 eşzamanlı istek, 6 deneme, hepsinde aynı):
 *     /api/pred/submit          →  3 LC düştü, defterde 1 kayıt   (doğru)
 *     /api/weekly-picks/predict → 24 LC düştü, defterde 8 kayıt   (8 KAT)
 *
 * ⚠️ KORUMA DOSYADA VARDI, YANLIŞ ŞEYİ SARIYORDU. `weekly-picks` zaten
 * `withFileLock(PREDS_FILE)` kullanıyordu — ama yalnızca dosya yazımının
 * etrafında. `pred.cjs` aynı kilidi TÜM kontrol→harcama→yazma bütününe
 * uyguluyor ve yorumu bunu açıkça söylüyor. Doğru araç, yanlış kapsam.
 *
 * ⚠️ AYNI KİLİT ANAHTARI BİLEREK: iki uç da aynı `predictions` koleksiyonuna
 * yazıyor. Ayrı anahtarla kullanıcı iki uca aynı anda gönderip yine iki kez
 * ödeyebilirdi — bu test onu da sınıyor.
 */

const os = require("os");
const nodePath = require("path");
const fs = require("fs");

const TMP = nodePath.join(os.tmpdir(), "skorlig-cifte-ucret-test");
process.env.SKORLIG_DATA_DIR = TMP;
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const FID = "cu-fx-1";
const UID = "cifte-ucret-oyuncu";
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
  app.use("/api", require("../routes/pred.cjs"));                       // /api/pred/submit
  app.use("/api/weekly-picks", require("../routes/weekly-picks.cjs"));  // /predict
  await new Promise((r) => { server = app.listen(0, r); });
  taban = `http://127.0.0.1:${server.address().port}`;

  MAC_BEDELI = require("../lib/ekonomi.cjs").MAC_GIRIS_BEDELI ?? 3;
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
  /* ⚠️ DOSYA AYNASI DA TEMİZLENMELİ. `getUserPred` dosyadan da okuyor;
   * ölçüm sırasında yalnızca Mongo'yu silmek testi SESSİZCE ÖLÜ yaptı —
   * her istek "zaten tahmin var" görüp hiç ücret kesmiyordu ve 0 LC
   * düşmesi "hata yok" gibi okunuyordu. */
  fs.writeFileSync(nodePath.join(TMP, "preds.json"), JSON.stringify({ items: [] }));
});

const gonder = (yol) => fetch(`${taban}${yol}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ fixtureId: FID, outcome: "H" }),
}).then((r) => r.json()).catch((e) => ({ ok: false, error: String(e) }));

const KLASIK = "/api/pred/submit";
const HAFTALIK = "/api/weekly-picks/predict";

const bakiye = async () =>
  Number((await db.collection("lc_wallet_users").findOne({ userIdLower: UID }))?.balance || 0);
const defterSayisi = async () =>
  db.collection("lc_wallet_ledger").countDocuments({ userIdLower: UID, kind: "spend" });

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("tek gönderim gerçekten ücret kesiyor", async () => {
    // Bu kontrol olmasaydı "hiç ücret kesilmedi" durumu da testi yeşil
    // gösterirdi — ölçüm sırasında tam olarak bu oldu.
    const r = await gonder(HAFTALIK);
    assert.equal(r.ok, true, `gonderim basarisiz: ${JSON.stringify(r)}`);
    assert.ok(MAC_BEDELI > 0, "mac bedeli sifir — test bir sey olcmuyor");
    assert.equal(BASLANGIC - (await bakiye()), MAC_BEDELI);
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("eşzamanlı gönderim", () => {
  const N = 8;

  for (const [ad, yol] of [["klasik tahmin", KLASIK], ["haftalık tahmin", HAFTALIK]]) {
    test(`${ad}: ${N} eşzamanlı istek TEK ücret keser`, async () => {
      await Promise.all(Array.from({ length: N }, () => gonder(yol)));

      const dusen = BASLANGIC - (await bakiye());
      assert.equal(
        dusen, MAC_BEDELI,
        `${N} eszamanli istek ${dusen} LC dusurdu (olmasi gereken ${MAC_BEDELI}) — kontrol ve ucret arasi kilitsiz`
      );
      assert.equal(await defterSayisi(), 1, "defterde birden fazla harcama kaydi");
    });
  }

  test("İKİ UÇ birden: karışık eşzamanlı istekler de tek ücret", async () => {
    /**
     * ⚠️ İkisi de aynı `predictions` koleksiyonuna yazıyor. Ayrı kilit
     * anahtarları kullansaydık kullanıcı iki uca aynı anda gönderip yine iki
     * kez öderdi — bu yüzden anahtar bilerek ortak.
     */
    const istekler = Array.from({ length: N }, (_, i) => gonder(i % 2 ? KLASIK : HAFTALIK));
    await Promise.all(istekler);

    const dusen = BASLANGIC - (await bakiye());
    assert.equal(
      dusen, MAC_BEDELI,
      `iki uca karisik ${N} istek ${dusen} LC dusurdu — uclar ayri kilitlerde`
    );
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: ücret kesen her tahmin ucu kontrolü kilit İÇİNDE yapıyor", () => {
  /**
   * Kilidin VARLIĞI yetmiyor — `weekly-picks` zaten kilit kullanıyordu ama
   * yalnızca dosya yazımını sarıyordu. Aranan şey: `spendLc` çağrısının
   * `withFileLock(PREDS_FILE` bloğunun İÇİNDE kalması.
   */
  const hedefler = [
    ["routes/pred.cjs", "spendLcMatchIfNeeded"],
    ["routes/weekly-picks.cjs", "spendLc("],
  ];
  const kusurlu = [];

  for (const [yol, harcama] of hedefler) {
    const ham = fs.readFileSync(nodePath.join(__dirname, "..", yol), "utf8");
    const src = ham
      .split("\n")
      .map((l) => {
        const t = l.trim();
        return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
      })
      .join("\n");

    const kilit = src.indexOf("withFileLock(PREDS_FILE");
    const kesim = src.indexOf(`await ${harcama}`);
    if (kilit < 0) { kusurlu.push(`${yol}: PREDS_FILE kilidi yok`); continue; }
    if (kesim < 0) { kusurlu.push(`${yol}: "${harcama}" bulunamadi — tarama bozuk`); continue; }
    if (kesim < kilit) kusurlu.push(`${yol}: ucret kesimi kilitten ONCE (satir ~${src.slice(0, kesim).split("\n").length})`);
  }

  assert.deepStrictEqual(
    kusurlu,
    [],
    "Ucret kesimi PREDS_FILE kilidinin disinda. Eszamanli istekler hepsi\n" +
      '"daha once tahmin yok" gorup ayri ayri ucret keser:\n' + kusurlu.join("\n")
  );
});

test("NÖBETÇİ: aynı anahtar iç içe alınmıyor (withFileLock reentrant değil)", () => {
  /* İç içe aynı anahtar süreci kilitler; düzeltme sırasında içteki kilit
   * bilerek kaldırıldı.
   *
   * ⚠️ İKİ AYRI YANLIŞ SAYIM OLDU:
   *  1) Ham metinde sayıyordu ve bu düzeltmenin KENDİ açıklama notundaki
   *     geçişi ikinci bir kilit sandı. (Yorum/kod ayrımı — bu oturumda altıncı.)
   *  2) Yorumları satır bazında boşaltmak da yetmedi: kapanış işaretçisi
   *     `}); // withFileLock(PREDS_FILE)` bir KOD satırının SONUNDAKİ yorum,
   *     yani satır `});` ile başlıyor ve ayıklamadan geçiyor.
   *
   * Doğru ölçüt zaten sayım değil EDİNİM: `await withFileLock(...)`. Kapanış
   * işaretçisi bir edinim değil. */
  const src = fs.readFileSync(nodePath.join(__dirname, "..", "routes", "weekly-picks.cjs"), "utf8");
  const adet = (src.match(/await\s+withFileLock\(PREDS_FILE/g) || []).length;
  assert.equal(adet, 1, `PREDS_FILE kilidi ${adet} kez aliniyor — ic ice alinirsa surec kilitlenir`);
});
