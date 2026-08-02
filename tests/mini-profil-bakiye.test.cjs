"use strict";

/**
 * MİNİ PROFİL BAŞKASININ LC BAKİYESİNİ VERMEZ.
 *
 * ⚠️ ÖLÇÜLDÜ (2026-08-02):
 *     GET /api/rt/user-profile?userId=KURBAN   (jetonsuz) -> 200, lc: 1337
 *
 * Uçta HİÇBİR kimlik denetimi yoktu. Dosyanın kendi başlığı bile bunu vaat
 * etmiyordu: "Herkese açık mini profil: puan, maç sayısı, üyelik tarihi,
 * rütbe bilgisi" — BAKİYE o listede yok, sonradan eklenmiş.
 *
 * ⚠️ SIZINTI DEĞİL, ÖZELLİK OLARAK KONMUŞTU: `match-race` ekranı rakibe
 * dokununca "💰 LC bakiye" satırını basıyordu. Ama bir tahmin oyununda
 * rakibin ne kadar parası olduğunu bilmek düello ve havuzda doğrudan
 * avantaj — aynı gün havuzdaki `myBet` sızıntısı tam bu gerekçeyle
 * kapatılmıştı.
 *
 * ⚠️ AYNI SINIFIN SEKİZİNCİ ÖRNEĞİ (kimlik parametreden geliyor, jetondan
 * değil). `lib/kimlik-kontrol.cjs` bu dersi yazmış.
 *
 * ⚠️ AÇIK UÇ TARAMAM BUNU KAÇIRDI ve sebebi not edilmeye değer: sonda yol
 * parametrelerini dolduruyor ama SORGU parametrelerini değil. `?userId=`
 * olmadan uç 400 döndüğü için "kapalı" göründü. Sorgu parametresiyle
 * kimliklenen uçlar ayrıca sınanmalı.
 */

const test = require("node:test");
const describe = require("node:test").describe;
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const KOK = path.join(__dirname, "..");
const KUM = fs.mkdtempSync(path.join(os.tmpdir(), "skorlig-miniprofil-"));
process.env.SKORLIG_DATA_DIR = KUM;

fs.writeFileSync(path.join(KUM, "lc-wallet.json"),
  JSON.stringify({ users: [{ userId: "KURBAN", balance: 1337, createdAt: "2026-01-01" }] }));
fs.writeFileSync(path.join(KUM, "totals.json"),
  JSON.stringify({ items: [{ userId: "KURBAN", totalPoints: 250, matches: 40 }] }));

/* Gerçek `verifyToken` istemci başlığına güvenmiyor; taklit ediliyor —
 * depodaki diğer uç testlerinin kullandığı desenin aynısı. */
const _vt = require.resolve(path.join(KOK, "middleware", "verifyToken.cjs"));
require.cache[_vt] = { id: _vt, filename: _vt, loaded: true, exports: {
  verifyToken: (q, r, n) => {
    if (!q.headers["x-user-id"]) return r.status(401).json({ ok: false, error: "AUTH" });
    q.uid = q.headers["x-user-id"]; n();
  },
  optionalToken: (q, _r, n) => { q.uid = q.headers["x-user-id"] || null; n(); },
  getFirebaseAuth: () => null, kimlikModu: () => "test",
} };

describe("mini profil bakiyesi", () => {
  let srv, port;

  test("kur", async () => {
    const express = require("express");
    const app = express();
    app.use((q, _r, n) => { q.app.locals.db = null; n(); });
    app.use("/api/rt", require(path.join(KOK, "routes", "settle2.cjs")));
    await new Promise((r) => { srv = app.listen(0, r); });
    port = srv.address().port;
  });

  const profil = (uid) =>
    fetch(`http://127.0.0.1:${port}/api/rt/user-profile?userId=KURBAN`,
      { headers: uid ? { "x-user-id": uid } : {}, signal: AbortSignal.timeout(5000) })
      .then(async (r) => ({ s: r.status, j: await r.json() }));

  test("kurulum sınandı: profil GERÇEKTEN dönüyor", async () => {
    /* ⚠️ Bu olmadan "bakiye yok" iddiası hiçbir şey kanıtlamaz — uç tümden
     * bozuksa da bakiye görünmez. */
    const r = await profil("KURBAN");
    assert.equal(r.s, 200, "profil ucu calismiyor — test bir sey olcmuyor");
    assert.equal(r.j.totalPoints, 250, "puan okunamadi — kurulum eksik");
  });

  test("SAHİBİ kendi bakiyesini görür", async () => {
    const r = await profil("KURBAN");
    assert.equal(r.j.lc, 1337, "sahibi kendi bakiyesini goremiyor");
  });

  test("BAŞKASI bakiyeyi GÖRMEZ", async () => {
    const r = await profil("SALDIRGAN");
    assert.equal(r.s, 200, "profil baskasina da acik olmali (puan/rutbe herkese acik)");
    assert.equal(r.j.totalPoints, 250, "acik alanlar gelmeye devam etmeli");
    assert.equal("lc" in r.j, false, `bakiye siziyor: ${r.j.lc}`);
  });

  test("KİMLİKSİZ bakiyeyi GÖRMEZ", async () => {
    const r = await profil(null);
    assert.equal("lc" in r.j, false, `bakiye kimliksiz siziyor: ${r.j.lc}`);
  });

  test("alan 0 olarak DEĞİL, HİÇ gönderilmiyor", async () => {
    /* ⚠️ 0 göndermek "parası yok" diye okunur ve yine bilgi sızdırır.
     * Ayrıca istemci `${profile.lc} LC` bastığı için 0 yanlış bilgi olurdu. */
    const r = await profil("SALDIRGAN");
    assert.equal(r.j.lc, undefined, "bakiye 0 olarak gonderiliyor — yine bilgi sizdirir");
  });

  test("büyük/küçük harf farkı sahibi kilitlemez", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/rt/user-profile?userId=KURBAN`,
      { headers: { "x-user-id": "kurban" }, signal: AbortSignal.timeout(5000) }).then((x) => x.json());
    assert.equal(r.lc, 1337, "sahibi kendi bakiyesinden kilitlendi");
  });

  test("kapat", () => {
    srv?.close();
    try { fs.rmSync(KUM, { recursive: true, force: true }); } catch {}
  });
});
