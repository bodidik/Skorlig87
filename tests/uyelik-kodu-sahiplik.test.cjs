"use strict";

/**
 * 1987 ÜYELİĞİ YALNIZCA KENDİ HESABINA YAZILIR — ve kimlik yoksa KOD YANMAZ.
 *
 * ⚠️ KUSUR: `POST /api/auth1987gs/verify` kimlik denetimi olmadan çalışıyor
 * ve `userId`i GÖVDEDEN alıyordu. Yani geçerli bir kod bilen kişi üyeliği
 * kendi hesabı yerine BAŞKASINA yazdırabiliyordu.
 *
 * ⚠️ ÜYELİK BEDAVA DEĞİL — dosyanın kendi notu sayıyor: açılış bakiyesi
 * 60 LC (normalde 30) ve haftalık seçimler ücretsiz. Kod kotası da o hesap
 * için harcanıyordu.
 *
 * ⚠️ SIRA HATASI, İLK YAZIMIMDA VARDI: kimlik denetimini `redeem`den SONRA
 * koymuştum. Sonuç: eşleşmeyen istek üyelik almadan KOTAYI YAKIYORDU
 * (ölçüldü: `used` artıyor, üyelik yok). Saldırgan başkasının kodunu boşa
 * harcayabilir, jetonu düşmüş meşru kullanıcı hakkını kaybederdi. Denetim
 * artık `redeem`den ÖNCE.
 *
 * ⚠️ TARAMA SONUCU, BAĞLAM İÇİN: yazma uçları tarandı — gövdeden `userId`
 * alıp sahiplik denetlemeyen TEK uç buydu. Kod tabanının "yazmalar
 * güvenceye alınmış" iddiası büyük ölçüde doğruymuş; okuma tarafında ise
 * bugün BEŞ sızıntı bulundu.
 *
 * Kaba kuvvet ayrı katmanda: `server.cjs` global `rateLimit` uyguluyor,
 * kodlar 11 karakter.
 */

const test = require("node:test");
const describe = require("node:test").describe;
const assert = require("node:assert/strict");
const os = require("os");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "skorlig-1987-"));
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

describe("1987 üyelik kodu", () => {
  let mongod, cli, db, srv, port;

  test("kur", async () => {
    const { MongoMemoryServer } = require("mongodb-memory-server");
    const { MongoClient } = require("mongodb");
    const express = require("express");
    mongod = await MongoMemoryServer.create();
    cli = await MongoClient.connect(mongod.getUri());
    db = cli.db("t");
    await db.collection("invite_codes_1987").insertMany([
      { code: "KOD-A", codeNorm: "KOD-A", maxUses: 100, used: 0, label: "t" },
      { code: "KOD-B", codeNorm: "KOD-B", maxUses: 100, used: 0, label: "t" },
      { code: "KOD-C", codeNorm: "KOD-C", maxUses: 100, used: 0, label: "t" },
    ]);

    const app = express();
    app.use((q, _r, n) => { q.app.locals.db = db; n(); });
    app.use("/api/auth1987gs", require(path.join(KOK, "routes", "auth-1987gs.cjs")));
    srv = app.listen(0);
    port = srv.address().port;
  });

  const dogrula = (govde, h) =>
    fetch(`http://127.0.0.1:${port}/api/auth1987gs/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(h || {}) },
      body: JSON.stringify(govde),
    }).then(async (r) => ({ s: r.status, j: await r.json().catch(() => null) }));

  const uyeMi = async (u) => {
    const d = await db.collection("users").findOne({ userIdLower: String(u).toLowerCase() });
    return !!(d && (d.is1987 || String(d.segment || "").toLowerCase() === "1987"));
  };
  const kullanim = async (k) => (await db.collection("invite_codes_1987").findOne({ codeNorm: k }))?.used;

  test("kurulum: SAHİBİ kendi hesabına üyelik alabiliyor", async () => {
    const r = await dogrula({ code: "KOD-A", userId: "DOGRU" }, { "x-user-id": "DOGRU" });
    assert.equal(r.s, 200, `mesru kullanim reddedildi: ${JSON.stringify(r.j)}`);
    assert.equal(await uyeMi("DOGRU"), true, "uyelik yazilmadi — ekran bozulur");
    assert.equal(await kullanim("KOD-A"), 1, "mesru kullanimda kota harcanmadi");
  });

  test("BAŞKASININ hesabına üyelik YAZILMIYOR", async () => {
    const r = await dogrula({ code: "KOD-B", userId: "KURBAN" }, { "x-user-id": "SALDIRGAN" });
    assert.equal(r.s, 401, "kimlik uyusmazligi kabul edildi");
    assert.equal(await uyeMi("KURBAN"), false, "baskasina uyelik yazildi");
    assert.equal(await uyeMi("SALDIRGAN"), false, "sessizce kendi hesabina yazildi");
  });

  test("KİMLİKSİZ istek reddediliyor", async () => {
    const r = await dogrula({ code: "KOD-B", userId: "KURBAN2" }, {});
    assert.equal(r.s, 401);
    assert.equal(await uyeMi("KURBAN2"), false);
  });

  test("yetkisiz istek KOTAYI YAKMIYOR", async () => {
    /**
     * ⚠️ ASIL İNCE NOKTA. Denetim `redeem`den SONRA olsaydı kod tüketilir,
     * üyelik yazılmazdı: saldırgan başkasının kodunu boşa harcayabilirdi.
     */
    assert.equal(await kullanim("KOD-B"), 0,
      "yetkisiz istekler kotayi harcadi — kod bosa yakilabiliyor");
  });

  test("gövdedeki userId BOŞ olsa da jetondan yazılıyor", async () => {
    /* İstemcinin `userId` göndermesi zorunlu değil; kimlik jetonda. */
    const r = await dogrula({ code: "KOD-C" }, { "x-user-id": "SADECE-JETON" });
    assert.equal(r.s, 200);
    assert.equal(await uyeMi("SADECE-JETON"), true);
  });

  test("kapat", async () => {
    srv?.close(); await cli?.close(); await mongod?.stop();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });
});

/* ── Nöbetçi ─────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: kimlik denetimi redeem'den ÖNCE", () => {
  const src = fs.readFileSync(path.join(KOK, "routes", "auth-1987gs.cjs"), "utf8")
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");
  const denetim = src.indexOf('return res.status(401).json({ ok: false, error: "AUTH_REQUIRED" })');
  const redeem = src.indexOf("InviteStore.redeem(");
  assert.ok(denetim > 0 && redeem > 0, "beklenen satirlar bulunamadi");
  assert.ok(denetim < redeem,
    "kimlik denetimi redeem'den SONRA — yetkisiz istek kotayi yakar");
});
