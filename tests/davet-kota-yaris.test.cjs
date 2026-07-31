"use strict";

/**
 * DAVET ÖDÜLÜ KOTASI EŞZAMANLI KULLANIMDA DA TUTAR.
 *
 * ⚠️ BULUNAN: "bu davet eden kaç ödül almış" SAYILIYOR, sonra ödeme
 * YAPILIYOR — arada kilit yoktu.
 *
 * ⚠️ MEVCUT MÜHÜR YANLIŞ ŞEYİ BAĞLIYORDU. `DavetOdul.odulMuhurle` atomik ama
 * mühür DAVET EDİLEN başına: aynı davetlinin iki kez ödül almasını engelliyor,
 * davet EDENİN toplamını hiç bağlamıyor. Farklı davetliler aynı anda kodu
 * kullanınca hepsi `oncekiler = 0` görüp hepsi ödeme alıyordu.
 *
 * ÖLÇÜLDÜ (bellek-içi Mongo, 20 davetli, kota 10, ödül 15 LC):
 *     sıralı    → 10 ödül  (150 LC — tavan)
 *     eşzamanlı → 20 ödül  (300 LC — üç denemede de aynı)
 *     düzeltme sonrası eşzamanlı → 10 ödül
 *
 * Yani kota fiilen yoktu: N eşzamanlı davetli = N ödül. Bu karşılığı olmayan
 * LC üretimi ve kotanın varlık sebebi tam olarak o.
 */

const os = require("os");
const nodePath = require("path");
const fs = require("fs");

const TMP = nodePath.join(os.tmpdir(), "skorlig-davet-kota-test");
process.env.SKORLIG_DATA_DIR = TMP;
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const SAHIP = "davet-eden-1";
const SAHIP2 = "davet-eden-2";
const KOD = "KOTATEST";
const KOD2 = "KOTATEST2";

let mongod = null, client = null, db = null, server = null, taban = "";
let KOTA = 0, ODUL = 0;

before(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const { MongoClient } = require("mongodb");
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  db = client.db("test");

  await db.collection("users").insertMany([
    { userId: SAHIP,  userIdLower: SAHIP,  inviteCode: KOD,  createdAt: new Date().toISOString() },
    { userId: SAHIP2, userIdLower: SAHIP2, inviteCode: KOD2, createdAt: new Date().toISOString() },
  ]);

  /* Kimlik BAŞLIKTAN: her istek farklı bir davetli olacak. */
  const vtYol = require.resolve("../middleware/verifyToken.cjs");
  require("../middleware/verifyToken.cjs");
  require.cache[vtYol].exports = {
    ...require.cache[vtYol].exports,
    verifyToken: (req, _res, next) => { req.uid = req.headers["x-test-uid"]; next(); },
    optionalToken: (req, _res, next) => { req.uid = req.headers["x-test-uid"]; next(); },
  };

  const express = require("express");
  const app = express();
  app.locals.db = db;
  app.use(express.json());
  app.use("/api/friends", require("../routes/friends.cjs"));
  await new Promise((r) => { server = app.listen(0, r); });
  taban = `http://127.0.0.1:${server.address().port}`;

  /* Sabitler KAYNAKTAN okunuyor — uydurmak yeşil-ama-ölü test üretir
   * (bu oturumda bir kez yapıldı: düello durumu "accepted" sanılmıştı). */
  const src = fs.readFileSync(nodePath.join(__dirname, "..", "routes", "friends.cjs"), "utf8");
  ODUL = Number(/const INVITE_REWARD = (\d+)/.exec(src)?.[1]);
  KOTA = Number(process.env.SKORLIG_INVITE_ODUL_LIMIT || /INVITE_ODUL_LIMIT \|\| (\d+)/.exec(src)?.[1]);
  assert.ok(ODUL > 0 && KOTA > 0, `sabitler okunamadi: odul=${ODUL} kota=${KOTA}`);
});

after(async () => {
  if (server) server.close();
  if (client) await client.close();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  for (const c of ["lc_wallet_users", "lc_wallet_ledger", "invite_redeems",
                   "friend_links", "friend_requests"]) {
    await db.collection(c).deleteMany({});
  }
  // ⚠️ Dosya aynaları da temizlenmeli; bu oturumda üç kez ölçüm bozdu.
  for (const f of ["friends.json", "lc-wallet.json", "users.json"]) {
    try { fs.rmSync(nodePath.join(TMP, f)); } catch { /* yok */ }
  }
});

const kullan = (uid, kod = KOD) => fetch(`${taban}/api/friends/use-invite`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-test-uid": uid },
  body: JSON.stringify({ code: kod }),
}).then((r) => r.json()).catch((e) => ({ ok: false, error: String(e) }));

const odulSayisi = (sahip = SAHIP) =>
  db.collection("lc_wallet_ledger")
    .countDocuments({ userIdLower: sahip, reason: "invite_referral" });

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("tek davetli gerçekten ödül üretiyor", async () => {
    const r = await kullan("tek-davetli");
    assert.equal(r.ok, true, `davet kullanilamadi: ${JSON.stringify(r)}`);
    assert.equal(r.odulVerildi, true, "odul verilmedi — test bir sey olcmuyor");
    assert.equal(await odulSayisi(), 1);
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("kota", () => {
  test("SIRALI kullanımda kota tutar (temel davranış)", async () => {
    const N = KOTA * 2;
    for (let i = 0; i < N; i++) await kullan(`sirali-${i}`);
    assert.equal(await odulSayisi(), KOTA);
  });

  test("EŞZAMANLI kullanımda da kota tutar", async () => {
    const N = KOTA * 2;
    await Promise.all(Array.from({ length: N }, (_, i) => kullan(`eszamanli-${i}`)));
    const sayim = await odulSayisi();
    assert.equal(
      sayim, KOTA,
      `${N} eszamanli davetli ${sayim} odul uretti (kota ${KOTA}) — ` +
      `fazladan ${(sayim - KOTA) * ODUL} LC karsiliksiz basildi`
    );
  });

  test("aynı davetli iki kez ödül almaz (mevcut mühür korunuyor)", async () => {
    // `odulMuhurle` davet EDİLEN başına; yeni kilit onun yerini almamalı.
    await Promise.all([kullan("ayni-davetli"), kullan("ayni-davetli")]);
    assert.equal(await odulSayisi(), 1);
  });

  test("kilit DAVET EDEN başına — başka davet eden engellenmez", async () => {
    /**
     * Genel bir kilit tüm davet kullanımlarını sıraya sokardı. İki farklı
     * davet edenin kotaları birbirinden bağımsız.
     */
    const N = KOTA * 2;
    await Promise.all([
      ...Array.from({ length: N }, (_, i) => kullan(`a-${i}`, KOD)),
      ...Array.from({ length: N }, (_, i) => kullan(`b-${i}`, KOD2)),
    ]);
    assert.equal(await odulSayisi(SAHIP), KOTA);
    assert.equal(await odulSayisi(SAHIP2), KOTA, "ikinci davet edenin kotasi etkilenmis");
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: kota sayımı ile ödeme aynı kilitte", () => {
  const ham = fs.readFileSync(nodePath.join(__dirname, "..", "routes", "friends.cjs"), "utf8");
  const src = ham
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");

  const kilit = src.indexOf("await withFileLock(`davet-odul:");
  assert.ok(kilit > 0, "davet eden basina kilit yok");

  /* ⚠️ İŞARETÇİ ÖDEMEYE ÖZGÜ OLMALI. İlk sürüm `"invite_referral"` arıyordu
   * ama o metin SAYIM SORGUSUNDA da geçiyor (`reason: "invite_referral"`) ve
   * ilk eşleşme sayımdan ÖNCE düşüyordu — nöbetçi doğru kodda yanlış alarm
   * verdi. Ödemenin kendisi `creditLc(dbW, ownerId, INVITE_REWARD` çağrısı. */
  const sayim = src.indexOf("INVITE_ODUL_LIMIT", kilit);
  const odeme = src.indexOf("creditLc(dbW, ownerId, INVITE_REWARD", kilit);
  assert.ok(sayim > kilit, "kota sayimi kilidin disinda");
  assert.ok(odeme > 0, "odeme cagrisi bulunamadi — tarama bozuk");
  assert.ok(odeme > sayim, "odeme sayimdan once");
});
