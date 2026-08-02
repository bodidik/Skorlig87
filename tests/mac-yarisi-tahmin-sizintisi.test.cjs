"use strict";

/**
 * MAÇ BAŞLAMADAN BAŞKASININ TAHMİNİ GÖRÜNMEZ.
 *
 * ⚠️ ÖLÇÜLDÜ (2026-08-02, kickoff'a 3 saat kalan NS maç, ilgisiz kimlikle):
 *     GET /api/rt/match-race?fixtureId=FX1 -> 200, phase: "pre"
 *        RAKIP1  predScore={"home":3,"away":1}
 *        RAKIP2  predScore={"home":0,"away":2}
 *        BEN     predScore={"home":1,"away":1}
 *
 * Uçta HİÇBİR kimlik denetimi yoktu. Rakiplerin tam skorunu görüp ona göre
 * tahmin girmek doğrudan avantaj; düelloda ve havuzda paraya dönüşür.
 *
 * ⚠️ AYNI SINIFIN DOKUZUNCU ÖRNEĞİ (kimlik parametreden geliyor, jetondan
 * değil). Aynı gün `pool.myBet`, `weekly-picks`, `stats/user`, profil,
 * 1987 üyeliği, `friends/list`, `friends/board` ve mini profil bakiyesinde
 * bulundu. `lib/kimlik-kontrol.cjs` dersi yazmış; eksik olan onu ÇAĞIRMAKTI.
 *
 * ⚠️ YALNIZCA MAÇ ÖNCESİ KISITLANIYOR — bu bir denge, aşırı kilitleme değil.
 * Maç başladıktan sonra tahminler KİLİTLİ; o noktada kimin ne dediğini görmek
 * yarışın kendisi. `phase: "race"` yolundaki predScore olduğu gibi duruyor.
 *
 * ⚠️ KATILIMCI LİSTESİ GİZLENMİYOR: "kim yarışta" ekranın işi; gizli olan
 * yalnızca NE tahmin ettiği.
 */

const test = require("node:test");
const describe = require("node:test").describe;
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const KOK = path.join(__dirname, "..");
const KUM = fs.mkdtempSync(path.join(os.tmpdir(), "skorlig-yaris-sizinti-"));
process.env.SKORLIG_DATA_DIR = KUM;
fs.mkdirSync(path.join(KUM, "live"), { recursive: true });

const KO = new Date(Date.now() + 3 * 3600 * 1000).toISOString();
fs.writeFileSync(path.join(KUM, "fixtures.json"),
  JSON.stringify([{ fixtureId: "FX1", home: "A", away: "B", kickoffISO: KO, status: "NS" }]));
fs.writeFileSync(path.join(KUM, "preds.json"), JSON.stringify([
  { fixtureId: "FX1", userId: "RAKIP1", home: 3, away: 1 },
  { fixtureId: "FX1", userId: "BEN", home: 1, away: 1 },
]));

const _vt = require.resolve(path.join(KOK, "middleware", "verifyToken.cjs"));
require.cache[_vt] = { id: _vt, filename: _vt, loaded: true, exports: {
  verifyToken: (q, r, n) => {
    if (!q.headers["x-user-id"]) return r.status(401).json({ ok: false, error: "AUTH" });
    q.uid = q.headers["x-user-id"]; n();
  },
  optionalToken: (q, _r, n) => { q.uid = q.headers["x-user-id"] || null; n(); },
  getFirebaseAuth: () => null, kimlikModu: () => "test",
} };

describe("maç yarışı tahmin sızıntısı", () => {
  let srv, port;

  test("kur", async () => {
    const express = require("express");
    const app = express();
    app.use((q, _r, n) => { q.app.locals.db = null; n(); });
    app.use("/api/rt", require(path.join(KOK, "routes", "settle2.cjs")));
    await new Promise((r) => { srv = app.listen(0, r); });
    port = srv.address().port;
  });

  const yaris = (uid) =>
    fetch(`http://127.0.0.1:${port}/api/rt/match-race?fixtureId=FX1&userId=BEN&top=50`,
      { headers: uid ? { "x-user-id": uid } : {}, signal: AbortSignal.timeout(6000) })
      .then(async (r) => ({ s: r.status, j: await r.json() }));

  const bul = (j, uid) => (j.participants || []).find((x) => x.userId === uid);

  test("kurulum sınandı: maç ÖNCESİ fazda ve katılımcılar dönüyor", async () => {
    /* ⚠️ Bu olmadan "tahmin görünmüyor" iddiası hiçbir şey kanıtlamaz:
     * uç bozuksa da liste boş gelir. */
    const r = await yaris("BEN");
    assert.equal(r.s, 200);
    assert.equal(r.j.phase, "pre", "mac oncesi faz degil — senaryo yanlis");
    assert.equal((r.j.participants || []).length, 2, "katilimcilar donmuyor — test olcmuyor");
  });

  test("SAHİBİ kendi tahminini görür", async () => {
    const r = await yaris("BEN");
    assert.deepEqual(bul(r.j, "BEN")?.predScore, { home: 1, away: 1 },
      "kullanici KENDI tahminini goremiyor — asiri kilitleme");
  });

  test("BAŞKASININ tahmini GÖRÜNMEZ", async () => {
    const r = await yaris("BEN");
    assert.equal("predScore" in (bul(r.j, "RAKIP1") || {}), false,
      `rakibin tahmini siziyor: ${JSON.stringify(bul(r.j, "RAKIP1")?.predScore)}`);
  });

  test("İLGİSİZ kimlik hiçbirini göremez", async () => {
    const r = await yaris("SALDIRGAN");
    for (const uid of ["BEN", "RAKIP1"]) {
      assert.equal("predScore" in (bul(r.j, uid) || {}), false,
        `${uid} tahmini saldirgana siziyor`);
    }
  });

  test("KİMLİKSİZ hiçbirini göremez", async () => {
    const r = await yaris(null);
    assert.equal(r.s, 200, "misafir yaris listesini gorebilmeli");
    for (const uid of ["BEN", "RAKIP1"]) {
      assert.equal("predScore" in (bul(r.j, uid) || {}), false, `${uid} tahmini kimliksiz siziyor`);
    }
  });

  test("KATILIMCI LİSTESİ hâlâ görünüyor (aşırı kilitleme değil)", async () => {
    const r = await yaris(null);
    const p = bul(r.j, "RAKIP1");
    assert.ok(p, "katilimci listesi gizlenmis — kim yarisiyor bilgisi ekranin isi");
    assert.ok(p.displayName, "goruntulenen ad kaybolmus");
  });

  test("kapat", () => {
    srv?.close();
    try { fs.rmSync(KUM, { recursive: true, force: true }); } catch {}
  });
});
