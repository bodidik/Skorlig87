"use strict";

/**
 * ÖDÜL MÜHRÜ BİR KEZ ATILDIKTAN SONRA SİLİNEMEZ.
 *
 * ⚠️ `awardedAt`, settle2'nin çift-ödeme koruması: bir kez yazıldıktan sonra
 * `claimAward` bir daha mühür vermiyor ve fixture tekrar ödenmiyor.
 *
 * ⚠️ BULUNAN (DOSYA YOLUNDA): `upsertSnapshot` çağıranın verdiği nesneyi
 * dosyaya TAM DEĞİŞTİRME ile yazıyor —
 *
 *     book.items[i] = { ...next, fixtureId: fid };
 *
 * yani `next` içinde `awardedAt` yoksa mühür SİLİNİYOR ve maç yeniden
 * ödenebilir hâle geliyor.
 *
 * ÖLÇÜLDÜ (dosya yolu, koruma kapalıyken):
 *     muhur alindi: true
 *     dikkatsiz yazmadan sonra: SILINDI
 *     muhur TEKRAR alinabildi mi: EVET  → çifte ödeme
 * Korumayla: korundu / hayır.
 *
 * ⚠️ İLK PREMİSİM YANLIŞTI, NEGATİF KONTROL DÜZELTTİ. "Mongo `$set` her şeyi
 * eziyor" diye başlamıştım; korumayı kapatıp ölçünce Mongo yolunda mühür yine
 * durdu — çünkü `$set` KISMİ güncelleme, listelenmeyen alanı silmez. Gerçek
 * açık yalnızca dosya yolunda. Ölçüm olmasaydı bulguyu iki kat geniş
 * anlatacaktım.
 *
 * ⚠️ DOSYA YOLU ULAŞILABİLİR: `needFile = !db || FILE_MIRROR`. Mongo
 * erişilemezken settle dosya modunda çalışıyor — yani koruma tam da her şeyin
 * zaten kırılgan olduğu anda gerekiyor.
 *
 * Bugün tek çağıran (`routes/settle2.cjs`) mührü elle taşıyor. Ama koruma
 * çağıranın hatırlamasına bağlıydı; artık depo mührü kendisi savunuyor.
 */

const os = require("os");
const nodePath = require("path");
const fs = require("fs");

const TMP = nodePath.join(os.tmpdir(), "skorlig-odul-muhru-test");
process.env.SKORLIG_DATA_DIR = TMP;
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const MR = require("../lib/match-results.cjs");

let mongod = null, client = null, db = null;

before(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const { MongoClient } = require("mongodb");
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  db = client.db("test");
});
after(async () => {
  if (client) await client.close();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  await db.collection("match_results").deleteMany({}).catch(() => {});
  for (const ad of fs.readdirSync(TMP)) {
    try { fs.rmSync(nodePath.join(TMP, ad), { recursive: true, force: true }); } catch { /* yok */ }
  }
});

/** Mührü taşımayan dikkatsiz bir yazma. */
const dikkatsizYaz = (fid, conn) =>
  MR.upsertSnapshot(fid, () => ({
    fixtureId: fid,
    finalScore: { home: 2, away: 1 },
    rows: [{ userId: "a", points: 3 }],
    // awardedAt BİLEREK yok
  }), conn);

/* ── Her iki depo için aynı değişmez ──────────────────────────────────────── */

for (const [ad, conn] of [["mongo", () => db], ["dosya", () => null]]) {
  describe(`${ad} yolu`, () => {
    test("dikkatsiz yazma mührü SİLMİYOR", async () => {
      const fid = `muhur-${ad}-1`;
      const alindi = await MR.claimAward(fid, new Date().toISOString(), conn());
      assert.equal(alindi, true, "muhur ilk seferde alinamadi — test bir sey olcmuyor");

      await dikkatsizYaz(fid, conn());

      const s = await MR.getSnapshot(fid, conn());
      assert.ok(s?.awardedAt, "muhur silinmis — mac yeniden odenebilir");
    });

    test("mühür silinmediği için ikinci kez alınamıyor (çifte ödeme yok)", async () => {
      const fid = `muhur-${ad}-2`;
      await MR.claimAward(fid, new Date().toISOString(), conn());
      await dikkatsizYaz(fid, conn());

      const tekrar = await MR.claimAward(fid, new Date().toISOString(), conn());
      assert.equal(tekrar, false, "muhur TEKRAR alinabildi — cifte odeme mumkun");
    });

    test("yazmanın kendi verisi kaydedilmiş (koruma yazmayı engellemiyor)", async () => {
      /**
       * Kapalı tarafa fazla kaçmadığımızın kanıtı: mühür korunurken çağıranın
       * gönderdiği skor/satırlar yine de yazılmalı.
       */
      const fid = `muhur-${ad}-3`;
      await MR.claimAward(fid, new Date().toISOString(), conn());
      await dikkatsizYaz(fid, conn());

      const s = await MR.getSnapshot(fid, conn());
      assert.equal(s.finalScore.home, 2, "yeni skor yazilmamis");
      assert.equal(s.rows.length, 1, "yeni satirlar yazilmamis");
    });

    test("mühür YOKKEN yazma normal ilerliyor", async () => {
      // Koruma yalnızca var olan mührü savunmalı; mühürsüz yazmaya karışmamalı.
      const fid = `muhur-${ad}-4`;
      await dikkatsizYaz(fid, conn());
      const s = await MR.getSnapshot(fid, conn());
      assert.ok(s, "snapshot hic yazilmamis");
      assert.ok(!s.awardedAt, "olmayan muhur uydurulmus");
    });
  });
}

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: koruma deponun İÇİNDE, çağırana bırakılmamış", () => {
  const src = fs.readFileSync(nodePath.join(__dirname, "..", "lib", "match-results.cjs"), "utf8")
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");

  assert.ok(
    /existing\?\.awardedAt && !next\.awardedAt/.test(src),
    "muhur koruma kaldirilmis — cagiranin hatirlamasina bagli kalir"
  );
  // Korumanın YAZMADAN önce olması şart; sonra olursa dosyaya eksik gider.
  const koruma = src.indexOf("existing?.awardedAt && !next.awardedAt");
  const dosyaYazma = src.indexOf("book.items[i] =");
  assert.ok(koruma > 0 && dosyaYazma > 0, "tarama kaliplari bulunamadi");
  assert.ok(koruma < dosyaYazma, "koruma dosya yazmasindan SONRA");
});
