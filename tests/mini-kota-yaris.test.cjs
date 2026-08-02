"use strict";

/**
 * AÇIK MİNİ TURNUVA KOTASI EŞZAMANLI İSTEKTE DE TUTAR.
 *
 * ⚠️ BULUNAN: kota kapısı "kaç açık turnuvan var" OKUYOR, sonra turnuva
 * YAZILIYOR — arada kilit yoktu. Eşzamanlı istekler hepsi aynı sayıyı görüp
 * hepsi geçiyordu.
 *
 * ÖLÇÜLDÜ (bellek-içi Mongo, 8 eşzamanlı istek, 3 deneme, hepsinde aynı):
 *     önce:  kota 2 · kurulan 8   → 4 KAT aşım
 *     sonra: kota 2 · kurulan 2
 *
 * ⚠️ NEDEN ÖNEMLİ: `routes/mini.cjs` içindeki kendi notuna göre bu bir görgü
 * kuralı değil KÖTÜYE KULLANIM ayarı — mini turnuva girişi ÜCRETSİZ ama
 * kazanana MINI_WIN_LC veriliyor, yani karşılığı olmayan LC üretimi. Kotayı
 * delmek muslugu açık bırakmak demek.
 *
 * ⚠️ ÖLÇÜM TUZAĞI (ilk denemede düşüldü): mini turnuva HEM Mongo'ya HEM dosya
 * aynasına yazılıyor. Denemeler arasında yalnızca Mongo'yu silmek, önceki
 * denemenin artıklarını sayıya katıyor ve sonucu okunamaz hâle getiriyordu.
 * Aynı hata düello ölçümünde de yapıldı ve orada "ödeme yapılmadan düello
 * açıldı" gibi YANLIŞ bir bulgu üretti.
 */

const os = require("os");
const nodePath = require("path");
const fs = require("fs");

const TMP = nodePath.join(os.tmpdir(), "skorlig-mini-kota-test");
process.env.SKORLIG_DATA_DIR = TMP;
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const premium = require("../lib/premium.cjs");

const KULLANICI = "kota-kurucu";
const OTEKI = "baska-kurucu";
/* ⚠️ HAVUZ GENİŞ TUTULUYOR: her turnuva AYRI maç seti almalı (aynı setle
 * ikinci açık turnuva artık reddediliyor — bkz. kur yardımcısının notu).
 * 8 eşzamanlı istek için 8 ayrı çift gerekiyor. */
const MACLAR = Array.from({ length: 24 }, (_, i) => `mkfx-${i + 1}`);

let mongod = null, client = null, db = null, server = null, taban = "";
let aktifUid = KULLANICI;

before(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const { MongoClient } = require("mongodb");
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  db = client.db("test");

  await db.collection("fixtures").insertMany(MACLAR.map((f, i) => ({
    fixtureId: f, home: `Ev${i}`, away: `Dep${i}`,
    kickoffISO: new Date(Date.now() + 8 * 3600_000).toISOString(), status: "NS",
  })));

  const vtYol = require.resolve("../middleware/verifyToken.cjs");
  require("../middleware/verifyToken.cjs");
  require.cache[vtYol].exports = {
    ...require.cache[vtYol].exports,
    verifyToken: (req, _res, next) => { req.uid = aktifUid; next(); },
    optionalToken: (req, _res, next) => { req.uid = aktifUid; next(); },
  };

  const express = require("express");
  const app = express();
  app.locals.db = db;
  app.use(express.json());
  app.use("/api/mini", require("../routes/mini.cjs"));
  await new Promise((r) => { server = app.listen(0, r); });
  taban = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) server.close();
  if (client) await client.close();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  aktifUid = KULLANICI;
  await db.collection("mini_tournaments").deleteMany({});
  // ⚠️ İKİ DEPO: dosya aynası da temizlenmeli (bkz. dosya başlığı).
  fs.writeFileSync(nodePath.join(TMP, "mini-tournaments.json"), JSON.stringify({ items: [] }));
});

/**
 * ⚠️ HER TURNUVA FARKLI MAÇ SETİ KULLANIR — testin konusu KOTA, set kuralı değil.
 *
 * 2026-08-02'de `mini/create` aynı maç setiyle ikinci AÇIK turnuvayı
 * reddetmeye başladı (ödül çoğaltmayı kapatan düzeltme; bkz.
 * tests/mini-ayni-mac-seti.test.cjs). Bu yardımcı hepsini AYNI setle
 * kuruyordu, dolayısıyla ikinci istek artık `TOO_MANY_OPEN_MINI` yerine
 * `AYNI_MAC_SETI_ACIK` alıyor ve kota hiç sınanamıyordu.
 *
 * Ad başına iki farklı fikstür üretiliyor; kota sınırı olduğu gibi sınanıyor.
 */
let _setSayac = 0;
const kur = (ad) => {
  const n = _setSayac++;
  const seti = [MACLAR[(n * 2) % MACLAR.length], MACLAR[(n * 2 + 1) % MACLAR.length]];
  return fetch(`${taban}/api/mini/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: ad, fixtures: seti.map((f) => ({ fixtureId: f })) }),
  }).then((r) => r.json()).catch((e) => ({ ok: false, error: String(e) }));
};

const sayi = (sahip) =>
  db.collection("mini_tournaments").countDocuments(
    sahip ? { ownerId: sahip } : {}
  );

const KOTA = () => premium.miniMaxOpen(false);

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("kota sıfırdan büyük ve tek turnuva kurulabiliyor", async () => {
    assert.ok(KOTA() >= 1, `kota ${KOTA()} — test bir sey olcmuyor`);
    const r = await kur("ilk");
    assert.equal(r.ok, true, `turnuva kurulamadi: ${JSON.stringify(r)}`);
    assert.equal(await sayi(), 1);
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("eşzamanlı kurulum", () => {
  const N = 8;

  test(`${N} eşzamanlı istek kotayı AŞMAZ`, async () => {
    const r = await Promise.all(Array.from({ length: N }, (_, i) => kur(`T${i}`)));
    const kurulan = await sayi();

    assert.equal(
      kurulan, KOTA(),
      `${N} eszamanli istek ${kurulan} turnuva kurdu (kota ${KOTA()}) — ` +
      "sayim ile yazma arasi kilitsiz, LC muslugu acik kaliyor"
    );
    const basarili = r.filter((x) => x.ok).length;
    assert.equal(basarili, KOTA(), "basarili yanit sayisi kurulan turnuva sayisiyla uyusmuyor");
    const reddedilen = r.filter((x) => !x.ok);
    assert.ok(
      reddedilen.every((x) => x.error === "TOO_MANY_OPEN_MINI"),
      `beklenmeyen hata kodlari: ${JSON.stringify(reddedilen.map((x) => x.error))}`
    );
  });

  test("kota dolduktan sonra yeni istek reddedilir", async () => {
    for (let i = 0; i < KOTA(); i++) await kur(`sirali-${i}`);
    const r = await kur("fazladan");
    assert.equal(r.ok, false);
    assert.equal(r.error, "TOO_MANY_OPEN_MINI");
    assert.equal(r.max, KOTA());
  });

  test("BİTMİŞ turnuva kotayı doldurmaz", async () => {
    // Kota "aynı anda BİTMEMİŞ" üzerinden; bitmiş turnuva yuvayı bırakmalı.
    for (let i = 0; i < KOTA(); i++) await kur(`bitecek-${i}`);
    await db.collection("mini_tournaments").updateMany(
      {}, { $set: { finishedAt: new Date().toISOString() } }
    );
    const r = await kur("yeni");
    assert.equal(r.ok, true, `bitmis turnuvalar hala yuva tutuyor: ${JSON.stringify(r)}`);
  });

  test("kilit KULLANICI BAŞINA — başkasının turnuvası engellenmez", async () => {
    /**
     * Genel bir kilit tüm kullanıcıların turnuva kurmasını sıraya sokardı.
     * Kota da kullanıcı başına olduğu için kilit de öyle.
     */
    for (let i = 0; i < KOTA(); i++) await kur(`benim-${i}`);
    aktifUid = OTEKI;
    const r = await kur("otekinin");
    assert.equal(r.ok, true, `baska kullanici engellendi: ${JSON.stringify(r)}`);
    assert.equal(await sayi(OTEKI), 1);
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: kota sayımı ile yazma aynı kilitte", () => {
  const ham = fs.readFileSync(nodePath.join(__dirname, "..", "routes", "mini.cjs"), "utf8");
  const src = ham
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");

  const kilit = src.indexOf("await withFileLock(`mini-create:");
  assert.ok(kilit > 0, "kullanici basina kilit yok");

  const yazma = src.indexOf("SocialStore.createMini(");
  const sayim = src.indexOf("acikSon", kilit);
  assert.ok(sayim > kilit, "kota sayimi kilidin disinda");
  assert.ok(yazma > sayim, "yazma sayimdan once");
});
