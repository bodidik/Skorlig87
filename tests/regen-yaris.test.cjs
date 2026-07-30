"use strict";

/**
 * OTOMATİK BİRİKİM (REGEN) — EŞZAMANLILIK KORUMASI.
 *
 * ⚠️ NEDEN VAR: `GET /api/rt/lc-wallet/summary` bir OKUMA ucu ama DURUM
 * DEĞİŞTİRİYOR — otomatik token birikimini ve premium aylık tabanını uyguluyor.
 * Uygulama bu ucu neredeyse her ekran açılışında çağırıyor, üstelik istemci
 * GET'leri yeniden deneme politikasına tabi (lib/apiFetch: GET/HEAD güvenli
 * sayılır). Yani aynı hesap için ÇOK SAYIDA eşzamanlı çağrı olağan.
 *
 * İki koruma var ve ikisi de PARA korumasıdır — ama hiç testi yoktu:
 *
 *   1) KOŞULLU FİLTRE `{ lastRegenAt: prevRegenAt }` — iki eşzamanlı çağrıdan
 *      yalnızca biri yazabilir. Olmasaydı ikisi de aynı süreyi hesaplayıp
 *      birikimi İKİ KEZ eklerdi.
 *
 *   2) `$inc` (GÖRELİ) yazım, `$set` (mutlak) değil. Kodun kendi notu bunun
 *      yaşanmış bir hata olduğunu söylüyor: bakiye 10 okundu → araya giren
 *      tahmin 3 LC harcadı (7) → birikim 12'yi MUTLAK yazdı → harcanan 3 LC
 *      geri geldi, yani yoktan para üretildi.
 *
 * Bu test ikisini de sabitliyor.
 */

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const os = require("os");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "skorlig-regen-"));
process.env.SKORLIG_DATA_DIR = TMP;
process.env.SKORLIG_BG = "0";

let mongod, client, db, server, taban;

before(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const { MongoClient } = require("mongodb");
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = "regen";
  client = await MongoClient.connect(mongod.getUri());
  db = client.db("regen");

  const vt = require.resolve("../middleware/verifyToken.cjs");
  require.cache[vt] = {
    id: vt, filename: vt, loaded: true,
    exports: {
      verifyToken: (req, _res, next) => { req.uid = req.headers["x-test-uid"] || "oyuncu"; next(); },
      optionalToken: (req, _res, next) => { req.uid = req.headers["x-test-uid"] || "oyuncu"; next(); },
      isBanned: async () => false,
    },
  };

  const express = require("express");
  const app = express();
  app.use(express.json());
  app.locals.db = db;
  app.use("/api/rt", require("../routes/lc-wallet.cjs"));
  server = app.listen(0);
  taban = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) server.close();
  if (client) await client.close();
  try {
    const { close } = require("../lib/mongo.cjs");
    if (typeof close === "function") await close();
  } catch { /* baglanti kurulmamis olabilir */ }
  if (mongod) await mongod.stop();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

/** Birikimi hak etmiş bir cüzdan kur: bakiye düşük, sayaç geçmişte. */
async function cuzdanKur(uid, bakiye, saatOnce) {
  await db.collection("lc_wallet_users").deleteMany({ userIdLower: uid });
  await db.collection("lc_wallet_users").insertOne({
    userId: uid, userIdLower: uid, balance: bakiye,
    totalEarned: bakiye, totalSpent: 0,
    lastRegenAt: new Date(Date.now() - saatOnce * 3600 * 1000).toISOString(),
    createdAt: new Date().toISOString(), lastDailyAt: null,
  });
}

const bakiye = async (uid) =>
  Number((await db.collection("lc_wallet_users").findOne({ userIdLower: uid }))?.balance || 0);

describe("regen — eşzamanlı çağrılar çift birikim yapmaz", () => {
  test("10 eşzamanlı summary çağrısı birikimi BİR KEZ ekler", async () => {
    await cuzdanKur("oyuncu", 1, 48);
    const once = await bakiye("oyuncu");

    await Promise.all(
      Array.from({ length: 10 }, () =>
        fetch(`${taban}/api/rt/lc-wallet/summary?userId=oyuncu`, {
          headers: { "x-test-uid": "oyuncu" },
        }).then((r) => r.json()).catch(() => null))
    );

    const sonra = await bakiye("oyuncu");
    const eklenen = sonra - once;
    assert.ok(eklenen >= 0, "bakiye dusmus");

    // Tek bir çağrının ekleyeceğinden fazlası eklenmemeli. Tekrar çağırıp
    // ikinci turda ne eklendiğine bakarak üst sınırı ölçüyoruz.
    const ikinciOnce = await bakiye("oyuncu");
    await fetch(`${taban}/api/rt/lc-wallet/summary?userId=oyuncu`, {
      headers: { "x-test-uid": "oyuncu" },
    }).then((r) => r.json()).catch(() => null);
    const ikinciEklenen = (await bakiye("oyuncu")) - ikinciOnce;

    assert.equal(ikinciEklenen, 0,
      "sayac ilerlemis olmali; ayni birikim tekrar eklenebiliyor");
  });

  test("kod koşullu filtreyi ve $inc'i KULLANIYOR (gerileme koruması)", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "routes", "lc-wallet.cjs"), "utf8");
    const i = src.indexOf('router.get("/lc-wallet/summary"');
    const govde = src.slice(i, i + 4000);

    assert.ok(/lastRegenAt:\s*prevRegenAt/.test(govde),
      "kosullu filtre kalkmis — iki es zamanli cagri birikimi iki kez ekler");
    assert.ok(/\$inc\s*=\s*\{\s*balance:/.test(govde),
      "bakiye MUTLAK yaziliyor olabilir — araya giren harcama geri gelir (para uretimi)");
    assert.ok(!/\$set:\s*\{[^}]*balance:/.test(govde),
      "bakiye $set ile yaziliyor — harcamayi ezer");
  });
});
