"use strict";

/**
 * PARA YOLLARI EŞZAMANLI İSTEKTE ÇİFT ÖDEME YAPMAZ.
 *
 * ⚠️ BU TURDA KUSUR BULUNAMADI — ve bunu açıkça yazıyorum. Üç para yolu
 * ampirik olarak yarıştırıldı, üçü de dayandı:
 *
 *     günlük hak   : 8 eşzamanlı istek → 1 başarılı, bakiye 3 (tek hak)
 *     düello kabul : 6 rakip aynı anda → 1 kabul, YALNIZCA 1 kişi ödedi
 *     tahmin gönder: 6 eşzamanlı istek → 1 kayıt, 3 LC (idempotent)
 *
 * Kod tabanı bu işi düzgün yapmış: koşul yazmanın İÇİNDE (`claimAward`,
 * atomik `updateOne` filtreleri). Ama DAVRANIŞ TEST EDİLMİYORDU — yani bir
 * yeniden düzenleme sessizce bozabilirdi. Bu dosya o boşluğu kapatıyor.
 *
 * ⚠️ NEDEN ÖNEMLİ: bu üçü uygulamanın en sık kullanılan para yolları.
 * Çift ödeme burada hem karşılıksız LC üretir hem oyuncular arası
 * adaletsizlik yaratır — ve hata vermeden olur.
 *
 * ⚠️ SONDA KURARKEN İKİ KEZ YANILDIM, ikisi de nota değer:
 *   1) `duels/accept` gövdesini okuyamadı çünkü sondamda `express.json()`
 *      yoktu → 6/6 başarısız oldu ve "yarış güvenli" gibi göründü. Sıfır
 *      sonuç, güvenlik kanıtı DEĞİLDİR; kurulumun sınandığını doğrula.
 *   2) `server.cjs`te `express.json()` ararken argümanlı hâlini
 *      (`express.json({ limit: "64kb" })`) kaçırıp "global ayrıştırıcı yok"
 *      sanmıştım. Grep'in bulamaması, yokluk demek değil.
 */

const test = require("node:test");
const describe = require("node:test").describe;
const assert = require("node:assert/strict");
const os = require("os");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
let MongoMemoryServer = null;
try { ({ MongoMemoryServer } = require("mongodb-memory-server")); } catch { /* yok */ }
const atla = () => !MongoMemoryServer;
const sebep = "mongodb-memory-server kurulu degil";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "skorlig-yaris-"));
fs.mkdirSync(path.join(TMP, "live"), { recursive: true });
process.env.SKORLIG_DATA_DIR = TMP;
process.env.SKORLIG_BG = "0";

const vt = require.resolve(path.join(KOK, "middleware", "verifyToken.cjs"));
require.cache[vt] = { id: vt, filename: vt, loaded: true, exports: {
  verifyToken: (q, r, n) => {
    if (!q.headers["x-user-id"]) return r.status(401).json({ ok: false, error: "AUTH" });
    q.uid = q.headers["x-user-id"]; n();
  },
  optionalToken: (q, _r, n) => { q.uid = q.headers["x-user-id"] || null; n(); },
  getFirebaseAuth: () => null, kimlikModu: () => "test",
}};

describe("para yolları — eşzamanlılık", () => {
  let mongod, cli, db, srv, port;

  test("kur", { skip: atla() && sebep }, async () => {
    const { MongoClient } = require("mongodb");
    const express = require(path.join(KOK, "node_modules", "express"));
    mongod = await MongoMemoryServer.create();
    cli = await MongoClient.connect(mongod.getUri());
    db = cli.db("t");

    const KO = new Date(Date.now() + 3 * 3600 * 1000).toISOString();
    await db.collection("fixtures").insertOne({
      fixtureId: "FX1", home: "A", away: "B", kickoffISO: KO, status: "NS", country: "Türkiye",
    });
    await db.collection("duels").insertOne({
      id: "D1", fixtureId: "FX1", creatorId: "KURUCU", creatorName: "K", stake: 5,
      status: "open", kickoffISO: KO, pot: 10, winAmount: 9.5, home: "A", away: "B", challengedId: null,
    });
    await db.collection("lc_wallet_users").insertMany([
      { userId: "GUNLUK", userIdLower: "gunluk", balance: 0, totalEarned: 0, totalSpent: 0, lastDailyAt: null, dailyStreak: 0 },
      { userId: "TAHMIN", userIdLower: "tahmin", balance: 50, totalEarned: 50, totalSpent: 0 },
      ...["R1", "R2", "R3", "R4", "R5", "R6"].map((u) => ({
        userId: u, userIdLower: u.toLowerCase(), balance: 50, totalEarned: 50, totalSpent: 0,
      })),
    ]);

    const app = express();
    /* ⚠️ server.cjs ile AYNI: global gövde ayrıştırıcı. Sondamda bu eksikken
     * `duels/accept` gövdeyi okuyamıyor ve 6/6 başarısız oluyordu — yani
     * yarış hiç sınanmadan "güvenli" görünüyordu. */
    app.use(express.json({ limit: "64kb" }));
    app.use((q, _r, n) => { q.app.locals.db = db; n(); });
    app.use("/api/rt", require(path.join(KOK, "routes", "lc-wallet.cjs")));
    app.use("/api", require(path.join(KOK, "routes", "duels.cjs")));
    app.use("/api", require(path.join(KOK, "routes", "pred.cjs")));
    srv = app.listen(0);
    port = srv.address().port;
  });

  const POST = (yol, uid, govde) =>
    fetch(`http://127.0.0.1:${port}${yol}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-user-id": uid },
      body: JSON.stringify(govde || {}),
    }).then(async (r) => ({ s: r.status, j: await r.json().catch(() => null) }));

  const bakiye = async (u) =>
    Number((await db.collection("lc_wallet_users").findOne({ userIdLower: u.toLowerCase() }))?.balance || 0);

  test("GÜNLÜK HAK: 8 eşzamanlı istek tek ödeme yapar", { skip: atla() && sebep }, async () => {
    const sonuc = await Promise.all(
      Array.from({ length: 8 }, () => POST("/api/rt/lc-wallet/daily-claim", "GUNLUK"))
    );
    const ok = sonuc.filter((x) => x.s === 200 && x.j?.ok).length;
    assert.equal(ok, 1, `${ok} istek basarili — gunluk hak birden fazla kez verildi`);

    const b = await bakiye("GUNLUK");
    assert.ok(b > 0, "hic odeme yapilmadi — test bir sey olcmuyor");
    assert.ok(b <= 12, `bakiye ${b} — cift odeme (premium tavani 12)`);

    const led = await db.collection("lc_wallet_ledger").countDocuments({ userIdLower: "gunluk" });
    assert.equal(led, 1, `${led} defter kaydi — para birden fazla kez yazildi`);
  });

  test("DÜELLO KABUL: 6 rakip yarışırsa YALNIZCA biri öder", { skip: atla() && sebep }, async () => {
    /**
     * ⚠️ EN PAHALI YARIŞ. Atomik olmasaydı hepsi bahsini yatırır, biri
     * kabul edilirdi; kalanların parası kaybolurdu.
     */
    const RAKIP = ["R1", "R2", "R3", "R4", "R5", "R6"];
    const sonuc = await Promise.all(RAKIP.map((u) => POST("/api/duels/accept", u, { duelId: "D1" })));
    const ok = sonuc.filter((x) => x.s === 200 && x.j?.ok);
    assert.equal(ok.length, 1, `${ok.length} rakip kabul edildi — duello coklu kabul aldi`);

    const d = await db.collection("duels").findOne({ id: "D1" });
    assert.equal(d.status, "active", "duello aktiflesmedi — test bir sey olcmuyor");

    let odeyen = 0;
    for (const u of RAKIP) if ((await bakiye(u)) < 50) odeyen++;
    assert.equal(odeyen, 1, `${odeyen} kisiden para dusuldu — kaybedilen bahis`);
  });

  test("TAHMİN: 6 eşzamanlı gönderim tek kayıt ve tek ücret", { skip: atla() && sebep }, async () => {
    const sonuc = await Promise.all(
      Array.from({ length: 6 }, () => POST("/api/pred/submit", "TAHMIN", {
        fixtureId: "FX1", userId: "TAHMIN", outcome: "H",
      }))
    );
    assert.ok(sonuc.some((x) => x.s === 200 && x.j?.ok), "hicbiri basarili degil — test olcmuyor");

    const kayit = await db.collection("predictions").countDocuments({ fixtureId: "FX1", userIdLower: "tahmin" });
    assert.equal(kayit, 1, `${kayit} tahmin kaydi — mukerrer kayit`);

    const dusen = 50 - (await bakiye("TAHMIN"));
    assert.equal(dusen, 3, `${dusen} LC dusuldu — coklu tahsilat (giris bedeli 3)`);
  });

  test("kapat", { skip: atla() && sebep }, async () => {
    srv?.close(); await cli?.close(); await mongod?.stop();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });
});
