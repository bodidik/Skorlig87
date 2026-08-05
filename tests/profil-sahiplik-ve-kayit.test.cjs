"use strict";

/**
 * PROFİL UCU: BAKİYE SIZDIRMAZ, OKUMA KAYIT YARATMAZ.
 *
 * ⚠️ İKİ KUSUR, DENETİMLİ OLARAK ÜRETİLDİ:
 *
 * 1) BAŞKASININ BAKİYESİ. `GET /api/users/profile?userId=X` yanıtındaki `lc`
 *    alanı YETKİLİ cüzdan bakiyesi (`lc_wallet_users`) ve kimlik denetimi
 *    yoktu:
 *        SAHİBİ → lc=137 · SALDIRGAN → 137 · KİMLİKSİZ → 137
 *    Aynı sınıf bugün `stats/user`, `pool` ve `weekly-picks` uçlarında da
 *    bulundu; `lib/kimlik-kontrol.cjs` tam bunun için yazılmış ve on rotaya
 *    uygulanmış, bu dördü atlanmıştı.
 *
 * 2) OKUMA UCU KAYIT YARATIYORDU. `ensureUser` bulunamayan kimliği
 *    OLUŞTURUYOR. ÖLÇÜLDÜ: kimliksiz 5 istek → `users` koleksiyonu 1'den
 *    6'ya çıktı. Herhangi biri uydurma kimliklerle sınırsız kayıt
 *    üretebiliyordu — sıralama/istatistik sayımlarını kirletir, depoyu
 *    şişirir. Bir GET veri YARATMAMALI.
 *
 * ⚠️ PROFİL KAPATILMADI: sıralamadan başkasının profiline tıklanıyor;
 * takma ad/takım/ülke herkese açık kalmalı. Gizli olan yalnızca PARA.
 */

const test = require("node:test");
const describe = require("node:test").describe;
const assert = require("node:assert/strict");
const os = require("os");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "skorlig-profil-"));
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

describe("profil ucu", () => {
  let mongod, cli, db, srv, port;

  test("kur", async () => {
    const { MongoMemoryServer } = require("mongodb-memory-server");
    const { MongoClient } = require("mongodb");
    const express = require("express");
    mongod = await MongoMemoryServer.create();
    cli = await MongoClient.connect(mongod.getUri());
    db = cli.db("t");

    await db.collection("users").insertOne({
      userId: "KURBAN", userIdLower: "kurban", nickname: "Kurban", mainTeam: "Galatasaray",
    });
    await db.collection("lc_wallet_users").insertOne({
      userId: "KURBAN", userIdLower: "kurban", balance: 137,
    });

    const app = express();
    app.use((q, _r, n) => { q.app.locals.db = db; n(); });
    app.use("/api/users", require(path.join(KOK, "routes", "users.cjs")));
    srv = app.listen(0);
    port = srv.address().port;
  });

  const G = (y, h) =>
    fetch(`http://127.0.0.1:${port}${y}`, { headers: h || {} })
      .then(async (r) => ({ s: r.status, j: await r.json().catch(() => null) }));

  const SAHIBI = { "x-user-id": "KURBAN" };
  const SALDIRGAN = { "x-user-id": "SALDIRGAN" };

  /* ── 1) Bakiye ───────────────────────────────────────────────────────── */

  test("kurulum: sahibi kendi bakiyesini GÖRÜYOR", async () => {
    const r = await G("/api/users/profile?userId=KURBAN", SAHIBI);
    assert.equal(r.j?.profile?.lc, 137, "kullanici kendi bakiyesini goremiyor — ekran bozulur");
    assert.equal(r.j?.kendisi, true);
  });

  test("BAŞKASI bakiyeyi göremiyor", async () => {
    const r = await G("/api/users/profile?userId=KURBAN", SALDIRGAN);
    assert.equal(r.j?.profile?.lc, undefined, "baskasinin bakiyesi sizdi");
    assert.equal(r.j?.kendisi, false);
  });

  test("KİMLİKSİZ bakiyeyi göremiyor", async () => {
    const r = await G("/api/users/profile?userId=KURBAN", {});
    assert.equal(r.j?.profile?.lc, undefined);
  });

  test("alan NULL değil, HİÇ YOK", async () => {
    /* `lc: null` gören istemci "0 LC" gösterebilirdi; yokluk "bilinmiyor". */
    const r = await G("/api/users/profile?userId=KURBAN", SALDIRGAN);
    assert.ok(!("lc" in (r.j?.profile || {})), "lc alani null olarak duruyor");
  });

  test("herkese açık alanlar KAPANMADI", async () => {
    /* Aşırı kilitlemek de kusur: sıralamadan profile tıklanabiliyor. */
    const r = await G("/api/users/profile?userId=KURBAN", SALDIRGAN);
    assert.equal(r.s, 200);
    assert.equal(r.j?.profile?.nickname, "Kurban");
    assert.equal(r.j?.profile?.mainTeam, "Galatasaray");
  });

  /* ── 2) Okuma kayıt yaratmaz ─────────────────────────────────────────── */

  test("KİMLİKSİZ istek kayıt YARATMIYOR", async () => {
    const once = await db.collection("users").countDocuments();
    for (let i = 0; i < 5; i++) await G(`/api/users/profile?userId=UYDURMA-${i}`, {});
    const sonra = await db.collection("users").countDocuments();
    assert.equal(sonra, once, `okuma ucu ${sonra - once} kayit yaratti — sinirsiz sisirme`);
  });

  test("BAŞKASININ kimliğiyle de kayıt yaratmıyor", async () => {
    const once = await db.collection("users").countDocuments();
    await G("/api/users/profile?userId=BASKA-UYDURMA", SALDIRGAN);
    assert.equal(await db.collection("users").countDocuments(), once);
  });

  test("olmayan kullanıcı 404 dönüyor", async () => {
    const r = await G("/api/users/profile?userId=HIC-YOK", {});
    assert.equal(r.s, 404, "olmayan kullanici icin bos profil uydurulmus");
  });

  test("KENDİ profilini isteyen doğrulanmış kullanıcı için kayıt OLUŞUR", async () => {
    /**
     * ⚠️ Bu yol KORUNMALI: ilk açılışta profil böyle kuruluyor. Tümüyle
     * kapatmak yeni kullanıcıyı profilsiz bırakırdı.
     */
    const once = await db.collection("users").countDocuments();
    const r = await G("/api/users/profile?userId=YENI-KULLANICI", { "x-user-id": "YENI-KULLANICI" });
    assert.equal(r.s, 200, "kendi profilini isteyen kullanici kayit olusturamiyor");
    assert.equal(await db.collection("users").countDocuments(), once + 1);
  });

  test("kapat", async () => {
    srv?.close(); await cli?.close(); await mongod?.stop();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });
});
