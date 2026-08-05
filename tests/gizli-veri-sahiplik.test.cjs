"use strict";

/**
 * GİZLİ VERİ YALNIZCA SAHİBİNE — havuz bahsi ve cüzdan.
 *
 * ⚠️ `lib/kimlik-kontrol.cjs` bu kusur sınıfı için yazılmış ve notu şöyle:
 * "cüzdan uçlarında YAZMALARIN hepsinde verifyToken vardı, OKUMALARIN
 * hiçbirinde yoktu... Yazmalar bir kez güvenceye alınmış, okumalara
 * dönülmemiş." Düzeltme on rotaya uygulanmış ama ÜÇ okuma ucu atlanmış.
 * Bu dosya ikisini kilitliyor (üçüncüsü: tests/haftalik-secim-sizintisi).
 *
 * DENETİMLİ OLARAK ÜRETİLDİ (kickoff'a 3 saat, maç AÇIK):
 *
 *   GET /api/pool/FX1?userId=KURBAN
 *     SAHİBİ    → myBet {"outcome":"H","stake":5}
 *     SALDIRGAN → AYNI          ← rakibin hangi sonuca ne yatırdığı
 *     KİMLİKSİZ → AYNI
 *
 *   GET /api/stats/user?userId=KURBAN
 *     SAHİBİ    → bakiye 137 · 2 defter kaydı
 *     SALDIRGAN → AYNI          ← herkesin parası ve harcama geçmişi
 *     KİMLİKSİZ → AYNI
 *
 * ⚠️ AYNI DOSYADA DÜZELTME ZATEN VARDI: `/api/pool/:fixtureId/my` ucunda
 * sahiplik denetimi ve tam bu yorum duruyordu; aynı veriyi döndüren ANA uç
 * atlanmıştı. Yarım düzeltmenin ders kitabı örneği.
 *
 * ⚠️ UÇLAR KAPATILMADI. Havuz özeti/dağılımı ve istatistikler herkese açık
 * kalmalı (sıralamadan profil tıklanıyor); gizli olan yalnızca PARA ve
 * KİMİN NE OYNADIĞI. `optionalToken` ile misafir erişimi korunuyor.
 */

const test = require("node:test");
const describe = require("node:test").describe;
const assert = require("node:assert/strict");
const os = require("os");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "skorlig-sahiplik-"));
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

describe("gizli veri sahiplik denetimi", () => {
  let mongod, cli, db, srv, port;

  test("kur", async () => {
    const { MongoMemoryServer } = require("mongodb-memory-server");
    const { MongoClient } = require("mongodb");
    const express = require("express");
    mongod = await MongoMemoryServer.create();
    cli = await MongoClient.connect(mongod.getUri());
    db = cli.db("t");

    const KO = new Date(Date.now() + 3 * 3600 * 1000).toISOString();
    await db.collection("fixtures").insertOne({
      fixtureId: "FX1", home: "A", away: "B", kickoffISO: KO,
      status: "NS", country: "Türkiye", league: "L",
    });
    await db.collection("lc_wallet_users").insertOne({
      userId: "KURBAN", userIdLower: "kurban",
      balance: 137, totalEarned: 200, totalSpent: 63,
    });
    await db.collection("lc_wallet_ledger").insertMany([
      { userId: "KURBAN", userIdLower: "kurban", amount: -3, reason: "match_pred", createdAt: new Date().toISOString() },
      { userId: "KURBAN", userIdLower: "kurban", amount: 10, reason: "match_reward", createdAt: new Date().toISOString() },
    ]);
    await db.collection("pool_bets").insertOne({
      fixtureId: "FX1", userId: "KURBAN", userIdLower: "kurban", outcome: "H", stake: 5,
    });

    const app = express();
    app.use((q, _r, n) => { q.app.locals.db = db; n(); });
    app.use("/api/pool", require(path.join(KOK, "routes", "pool.cjs")));
    app.use("/api/stats", require(path.join(KOK, "routes", "stats.cjs")));
    srv = app.listen(0);
    port = srv.address().port;
  });

  const G = (yol, h) =>
    fetch(`http://127.0.0.1:${port}${yol}`, { headers: h || {} })
      .then(async (r) => ({ s: r.status, j: await r.json().catch(() => null) }));

  const SAHIBI = { "x-user-id": "KURBAN" };
  const SALDIRGAN = { "x-user-id": "SALDIRGAN" };

  /* ── Havuz bahsi ─────────────────────────────────────────────────────── */

  describe("havuz bahsi", () => {
    test("kurulum: sahibi kendi bahsini GÖRÜYOR", async () => {
      const r = await G("/api/pool/FX1?userId=KURBAN", SAHIBI);
      assert.equal(r.j?.myBet?.stake, 5, "sahibi kendi bahsini goremiyor — ekran bozulur");
    });

    test("BAŞKASI göremiyor", async () => {
      const r = await G("/api/pool/FX1?userId=KURBAN", SALDIRGAN);
      assert.equal(r.j?.myBet, null, "rakibin bahsi sizdi — havuzda bilgi paraya donusur");
    });

    test("KİMLİKSİZ göremiyor", async () => {
      const r = await G("/api/pool/FX1?userId=KURBAN", {});
      assert.equal(r.j?.myBet, null);
    });

    test("havuz ÖZETİ ve DAĞILIM herkese açık kalıyor", async () => {
      /* Aşırı kilitlemek de kusur olurdu: ekranın asıl işi bunları göstermek. */
      const r = await G("/api/pool/FX1", {});
      assert.equal(r.s, 200);
      assert.ok(r.j?.pool !== undefined, "havuz ozeti misafire kapanmis");
      assert.ok(r.j?.distribution !== undefined, "dagilim misafire kapanmis");
    });
  });

  /* ── Cüzdan ──────────────────────────────────────────────────────────── */

  describe("cüzdan ve defter", () => {
    test("kurulum: sahibi bakiyesini GÖRÜYOR", async () => {
      const r = await G("/api/stats/user?userId=KURBAN", SAHIBI);
      assert.equal(r.j?.wallet?.balance, 137, "kullanici kendi bakiyesini goremiyor");
      assert.equal((r.j?.walletLedger || []).length, 2);
      assert.equal(r.j?.kendisi, true);
    });

    test("BAŞKASI bakiyeyi göremiyor", async () => {
      const r = await G("/api/stats/user?userId=KURBAN", SALDIRGAN);
      assert.equal(r.j?.wallet, undefined, "baskasinin bakiyesi sizdi");
      assert.equal(r.j?.walletLedger, undefined, "baskasinin islem gecmisi sizdi");
      assert.equal(r.j?.kendisi, false);
    });

    test("KİMLİKSİZ bakiyeyi göremiyor", async () => {
      const r = await G("/api/stats/user?userId=KURBAN", {});
      assert.equal(r.j?.wallet, undefined);
      assert.equal(r.j?.walletLedger, undefined);
    });

    test("İSTATİSTİKLER herkese açık kalıyor", async () => {
      /* Sıralamadan profile tıklanabiliyor; puan/oynanan gizli değil. */
      const r = await G("/api/stats/user?userId=KURBAN", SALDIRGAN);
      assert.equal(r.s, 200);
      assert.ok(r.j?.season !== undefined, "sezon ozeti misafire kapanmis");
      assert.ok(Array.isArray(r.j?.recentMatches), "son maclar kapanmis");
    });

    test("alan NULL değil, HİÇ YOK", async () => {
      /**
       * ⚠️ `wallet: null` göndermek istemcinin "0 LC" göstermesine yol
       * açabilirdi; alanın yokluğu "bilinmiyor" demek.
       */
      const r = await G("/api/stats/user?userId=KURBAN", SALDIRGAN);
      assert.ok(!("wallet" in (r.j || {})), "wallet alani null olarak duruyor");
    });
  });

  test("kapat", async () => {
    srv?.close(); await cli?.close(); await mongod?.stop();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });
});
