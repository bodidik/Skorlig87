"use strict";

/**
 * AYNI MAÇ SETİYLE İKİNCİ AÇIK TURNUVA KURULAMAZ.
 *
 * ⚠️ ÖDÜLÜ ÇOĞALTIYORDU. `routes/mini.cjs`'in kendi ilkesi "ÖDÜL BÖLÜŞÜLÜR,
 * ÇOĞALTILMAZ" (bkz. kazananPayi notu) — ama o kural turnuvanın İÇİNDE
 * uygulanıyordu; turnuvalar ARASI delikti.
 *
 * ÖLÇÜLDÜ (2026-08-02, gerçek uca istek, ücretsiz kademe):
 *     T1 [FX1,FX2] -> KURULDU
 *     T2 [FX1,FX2] -> KURULDU        <<< AYNI SET
 *     T3           -> TOO_MANY_OPEN_MINI
 *
 * Yani TEK tahmin seti iki kez ödül alıyordu:
 *     2 maç x 3 LC giriş = 6 LC maliyet  →  2 x 20 = 40 LC ödül
 *     premium (6 açık)                   →  6 x 20 = 120 LC
 *
 * `miniMaxOpen` musluğun HIZINI gerçek fikstüre bağlıyor ama aynı maçları
 * tekrar kullanmayı engellemiyordu — oysa asıl maliyet tahminlerde.
 *
 * ⚠️ YALNIZCA BİREBİR AYNI SET engelleniyor, kısmi örtüşme DEĞİL. "Bugünün
 * maçları" ve "hafta sonu" turnuvaları ortak maç taşıyabilir ve bu meşru;
 * hepsini kapatmak oyunu kırardı. Kısmi örtüşme hâlâ çoğaltabilir — ÜRÜN
 * kararı, bilinçli açık bırakıldı ve aşağıda ayrıca sınanıyor.
 */

const test = require("node:test");
const describe = require("node:test").describe;
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const KOK = path.join(__dirname, "..");
const KUM = fs.mkdtempSync(path.join(os.tmpdir(), "skorlig-mini-set-"));
process.env.SKORLIG_DATA_DIR = KUM;
process.env.SKORLIG_BG = "0";

const KO = new Date(Date.now() + 3 * 3600 * 1000).toISOString();
fs.writeFileSync(path.join(KUM, "fixtures.json"), JSON.stringify([
  { fixtureId: "FX1", home: "A", away: "B", kickoffISO: KO, status: "NS" },
  { fixtureId: "FX2", home: "C", away: "D", kickoffISO: KO, status: "NS" },
  { fixtureId: "FX3", home: "E", away: "F", kickoffISO: KO, status: "NS" },
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

describe("mini: aynı maç seti", () => {
  let srv, port;

  test("kur", async () => {
    const express = require("express");
    const app = express();
    app.use(express.json());
    app.use((q, _r, n) => { q.app.locals.db = null; n(); });
    app.use("/api/mini", require(path.join(KOK, "routes", "mini.cjs")));
    await new Promise((r) => { srv = app.listen(0, r); });
    port = srv.address().port;
  });

  const kur = (uid, ad, fx) =>
    fetch(`http://127.0.0.1:${port}/api/mini/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-user-id": uid },
      body: JSON.stringify({ name: ad, fixtures: fx.map((x) => ({ fixtureId: x })) }),
      signal: AbortSignal.timeout(8000),
    }).then(async (r) => ({ s: r.status, j: await r.json().catch(() => null) }));

  test("kurulum sınandı: ilk turnuva GERÇEKTEN kuruluyor", async () => {
    /* ⚠️ Bu olmadan "ikincisi reddedildi" hiçbir şey kanıtlamaz — uç tümden
     * bozuksa da her istek reddedilir. */
    const r = await kur("CIFTCI", "T1", ["FX1", "FX2"]);
    assert.equal(r.s, 200, `ilk turnuva kurulamadi (${r.j?.error}) — test bir sey olcmuyor`);
  });

  test("AYNI set ikinci kez kurulamaz", async () => {
    const r = await kur("CIFTCI", "T2", ["FX1", "FX2"]);
    assert.equal(r.s, 409, `ayni mac setiyle ikinci turnuva kuruldu — odul cogaliyor (${JSON.stringify(r.j)})`);
    assert.equal(r.j.error, "AYNI_MAC_SETI_ACIK");
  });

  test("SIRA değiştirerek atlatılamaz", async () => {
    /* ⚠️ Kümenin sıralanmadan karşılaştırılması en kolay atlatma yoluydu. */
    const r = await kur("CIFTCI", "T3", ["FX2", "FX1"]);
    assert.equal(r.s, 409, "sirayi degistirerek ayni set tekrar kuruldu");
  });

  test("TEKRAR eden maç yazarak atlatılamaz", async () => {
    /* [FX1,FX2,FX2] setinin benzersizi [FX1,FX2] ile aynı olmalı. */
    const r = await kur("CIFTCI", "T4", ["FX1", "FX2", "FX2"]);
    assert.equal(r.s, 409, "ayni mac tekrar yazilarak set farkli gosterildi");
  });

  test("FARKLI set hâlâ kurulabilir (aşırı kilitleme değil)", async () => {
    /**
     * ⚠️ ASIL RİSK TERS YÖNDE. Fazla sıkı bir kural mini turnuvayı tümden
     * kullanılamaz yapardı; kusuru "LC musluğu"ndan "özellik çalışmıyor"a
     * çevirirdi.
     */
    const r = await kur("CIFTCI", "T5", ["FX1", "FX3"]);
    assert.equal(r.s, 200, `farkli maç setiyle turnuva kurulamadi (${r.j?.error}) — asiri kilitleme`);
  });

  test("BAŞKA kullanıcı aynı seti kurabilir", async () => {
    /* Sınır kullanıcı başına: iki farklı oyuncunun aynı maçlarla turnuva
     * kurması meşru, çoğaltma değil. */
    const r = await kur("BASKASI", "T6", ["FX1", "FX2"]);
    assert.equal(r.s, 200, "baska kullanici ayni seti kuramadi — sinir yanlis kapsamda");
  });

  test("kapat", () => {
    srv?.close();
    try { fs.rmSync(KUM, { recursive: true, force: true }); } catch {}
  });
});
