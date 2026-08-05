"use strict";

/**
 * ARENA: ÖZEL DÜELLO YALNIZCA DAVETLİYE GÖRÜNÜR.
 *
 * ⚠️ İKİ AYRI DELİK VARDI, DENETİMLİ OLARAK ÜRETİLDİ. Süzgeç şöyleydi:
 *     if (d.challengedId && uid && d.challengedId.toLowerCase() !== uidL) continue;
 *
 * 1) `uid` BOŞKEN FAIL-OPEN: koşul `uid` yoksa hiç çalışmıyor, yani
 *    KİMLİKSİZ istek belirli birine gönderilmiş ÖZEL düelloyu görüyordu.
 * 2) KİMLİK SORGUDAN: uç `req.uid`i hiç kullanmıyordu; `?userId=X` yazan
 *    herkes X'in özel düellolarını okuyabiliyordu.
 *
 * ÖLÇÜM (bir açık + bir özel düello, özel `DAVETLI`ye gönderilmiş):
 *     DAVETLI (jetonlu)              → D-ACIK, D-OZEL   ✓
 *     YABANCI (jetonlu)              → D-ACIK           ✓
 *     KİMLİKSİZ                      → D-ACIK, D-OZEL   ✗ sızıntı
 *     jeton YABANCI, ?userId=DAVETLI → D-ACIK, D-OZEL   ✗ taklit
 *
 * ⚠️ İLK SONDAM YANLIŞTI, ONU DA YAZIYORUM: yanıt anahtarı `matches`,
 * ben `items` okumuştum ve dört rolde de 0 görüp "sızıntı yok" sanmıştım.
 * Yanıt şemasını doğrulamadan sonuç çıkarmak, yokluğu kanıt sanmaktır.
 *
 * ⚠️ FAIL-CLOSED: kimlik yoksa özel düello HİÇ gösterilmiyor. Açık
 * düellolar misafire görünmeye devam ediyor — arenanın işi zaten o.
 */

const test = require("node:test");
const describe = require("node:test").describe;
const assert = require("node:assert/strict");
const os = require("os");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "skorlig-arena-"));
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

describe("arena özel düello", () => {
  let mongod, cli, db, srv, port;

  test("kur", async () => {
    const { MongoMemoryServer } = require("mongodb-memory-server");
    const { MongoClient } = require("mongodb");
    const express = require("express");
    mongod = await MongoMemoryServer.create();
    cli = await MongoClient.connect(mongod.getUri());
    db = cli.db("t");

    const KO = new Date(Date.now() + 3 * 3600 * 1000).toISOString();
    await db.collection("duels").insertMany([
      { id: "D-ACIK", fixtureId: "FX1", creatorId: "KURBAN", creatorName: "Kurban",
        stake: 5, status: "open", kickoffISO: KO, pot: 10, home: "A", away: "B", challengedId: null },
      { id: "D-OZEL", fixtureId: "FX2", creatorId: "KURBAN", creatorName: "Kurban",
        stake: 7, status: "open", kickoffISO: KO, pot: 14, home: "C", away: "D", challengedId: "DAVETLI" },
    ]);

    const app = express();
    app.use((q, _r, n) => { q.app.locals.db = db; n(); });
    app.use("/api", require(path.join(KOK, "routes", "duels.cjs")));
    srv = app.listen(0);
    port = srv.address().port;
  });

  /** Arena yanıtındaki TÜM düello kimlikleri. */
  const duellolar = async (yol, h) => {
    const r = await fetch(`http://127.0.0.1:${port}${yol}`, { headers: h || {} });
    const j = await r.json().catch(() => null);
    /* ⚠️ Anahtar `matches` — `items` DEĞİL. İlk sondamdaki hata buydu. */
    return (j?.matches || []).flatMap((m) => (m.preview || []).map((d) => d.id)).sort();
  };

  test("kurulum: açık düello herkese görünüyor", async () => {
    const d = await duellolar("/api/duels/arena", {});
    assert.ok(d.includes("D-ACIK"), "acik duello misafire gorunmuyor — arena islevsiz olur");
  });

  test("DAVETLİ özel düellosunu GÖRÜYOR", async () => {
    const d = await duellolar("/api/duels/arena?userId=DAVETLI", { "x-user-id": "DAVETLI" });
    assert.deepEqual(d, ["D-ACIK", "D-OZEL"], "davetli kendi ozel duellosunu goremiyor");
  });

  test("YABANCI özel düelloyu göremiyor", async () => {
    const d = await duellolar("/api/duels/arena?userId=YABANCI", { "x-user-id": "YABANCI" });
    assert.deepEqual(d, ["D-ACIK"]);
  });

  test("KİMLİKSİZ özel düelloyu göremiyor (fail-closed)", async () => {
    /* Eski süzgeçteki `&& uid` yüzünden kimliksiz istekte koşul hiç
     * çalışmıyordu — deliğin kendisi buydu. */
    const d = await duellolar("/api/duels/arena", {});
    assert.deepEqual(d, ["D-ACIK"], "kimliksiz istek ozel duelloyu gordu");
  });

  test("KİMLİK TAKLİDİ işe yaramıyor", async () => {
    const d = await duellolar("/api/duels/arena?userId=DAVETLI", { "x-user-id": "YABANCI" });
    assert.deepEqual(d, ["D-ACIK"], "sorgu parametresiyle baskasinin ozel duellosu okundu");
  });

  test("kurucu KENDİ düellosunu görmüyor (mevcut davranış korundu)", async () => {
    const d = await duellolar("/api/duels/arena?userId=KURBAN", { "x-user-id": "KURBAN" });
    assert.deepEqual(d, [], "kurucuya kendi duellosu gosteriliyor");
  });

  test("kapat", async () => {
    srv?.close(); await cli?.close(); await mongod?.stop();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });
});
