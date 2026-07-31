"use strict";

/**
 * 1987 ÜYELİĞİ — tek kural, dört yer.
 *
 * ⚠️ NEDEN ÖNEMLİ: 1987 üyeliği SÜRESİZ premium ve 60 LC açılış bakiyesi
 * demek (normal kullanıcı 30). Yani bu üç satırlık kural gerçek bir ayrıcalık
 * kapısı.
 *
 * Kural kod tabanında DÖRT yerde ayrı ayrı yazılmıştı: lib/premium.cjs,
 * routes/lc-wallet.cjs ve lib/users-store.cjs'de iki kez. Denetlediğimde
 * hepsi aynı şeyi söylüyordu — bulgu yoktu. Ama bu oturumun tekrar eden
 * dersi kopyaların ne zaman ayrıştığı (davet ödülü, grup yarışı, bot
 * süzgeci, sahiplik denetimi: hepsi "bir yerde var, ötekinde yok" biçiminde
 * çıktı), o yüzden kural `uyeMi1987` altında toplandı.
 *
 * ⚠️ MONGO SORGUSU PAYLAŞILAMIYOR. `users-store` üyeleri bir SORGUYLA çekmek
 * zorunda (`$or` + regex); aynı JavaScript yüklemini kullanamaz. Bu testin
 * asıl işi o ikisinin AYNI cevabı vermesini doğrulamak.
 */

const os = require("os");
const nodePath = require("path");
const fs = require("fs");
process.env.SKORLIG_DATA_DIR = nodePath.join(os.tmpdir(), "skorlig-1987-test");
fs.mkdirSync(process.env.SKORLIG_DATA_DIR, { recursive: true });

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { uyeMi1987 } = require("../lib/premium.cjs");

/** Kural açısından ilginç tüm biçimler. */
const ORNEKLER = [
  { ad: "is1987 true", u: { is1987: true }, beklenen: true },
  { ad: "segment 1987", u: { segment: "1987" }, beklenen: true },
  { ad: "segment buyuk harf", u: { segment: "1987" }, beklenen: true },
  { ad: "ikisi birden", u: { is1987: true, segment: "1987" }, beklenen: true },
  { ad: "is1987 false", u: { is1987: false }, beklenen: false },
  { ad: "segment baska", u: { segment: "GS" }, beklenen: false },
  { ad: "bos kayit", u: {}, beklenen: false },
  { ad: "null", u: null, beklenen: false },
  // ⚠️ Gercek deger DEGIL: "1987" metni disinda hicbir sey uye yapmamali.
  { ad: "is1987 metin", u: { is1987: "true" }, beklenen: false },
  { ad: "segment 19870", u: { segment: "19870" }, beklenen: false },
];

describe("yüklem", () => {
  for (const { ad, u, beklenen } of ORNEKLER) {
    test(ad, () => assert.equal(uyeMi1987(u), beklenen));
  }
});

describe("Mongo sorgusu yüklemle aynı cevabı verir", () => {
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

  test("aynı kayıtlar için sorgu ve yüklem uyuşur", async () => {
    /**
     * ⚠️ ASIL DEĞİŞMEZ BU. `users-store` üyeleri şu sorguyla çekiyor:
     *     { $or: [{ is1987: true }, { segment: /^1987$/i }] }
     * Bu bir JavaScript yüklemi değil; `uyeMi1987` ile ayrışabilir ve
     * ayrışırsa bir kullanıcı bir yerde üye, başka yerde değil olur —
     * ayrıcalıklarını kısmen alır.
     */
    const col = db.collection("users");
    await col.deleteMany({});
    await col.insertMany(
      ORNEKLER.filter((x) => x.u).map((x, i) => ({ userId: `u${i}`, ...x.u }))
    );

    const sorguSonucu = new Set(
      (await col.find({ $or: [{ is1987: true }, { segment: /^1987$/i }] }).toArray())
        .map((d) => d.userId)
    );

    const kusurlu = [];
    const hepsi = await col.find({}).toArray();
    for (const d of hepsi) {
      const sorgudaVar = sorguSonucu.has(d.userId);
      const yuklemDiyor = uyeMi1987(d);
      if (sorgudaVar !== yuklemDiyor) {
        kusurlu.push(`${d.userId}: sorgu=${sorgudaVar} yuklem=${yuklemDiyor} — ${JSON.stringify(d)}`);
      }
    }

    assert.ok(hepsi.length >= 8, `cok az ornek (${hepsi.length}) — test bir sey olcmuyor`);
    assert.deepStrictEqual(
      kusurlu,
      [],
      "Mongo sorgusu ile yuklem AYRISIYOR; kullanici bir yerde uye, baska\n" +
        "yerde degil olur ve ayricaliklarini kismen alir:\n" + kusurlu.join("\n")
    );
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: kural kopyalanmamış", () => {
  /**
   * Kural tek yerde kalmalı. Yeni bir kopya, ayrışmanın başlangıcıdır.
   * (Mongo sorgusu ayrı sayılır — o bir sorgu, yüklem değil; yukarıdaki
   * test onu eşdeğerlikle bağlıyor.)
   */
  const kok = nodePath.join(__dirname, "..");
  const kusurlu = [];

  for (const alt of ["routes", "lib", "services"]) {
    const d = nodePath.join(kok, alt);
    if (!fs.existsSync(d)) continue;
    for (const dosya of fs.readdirSync(d)) {
      if (!dosya.endsWith(".cjs")) continue;
      if (dosya === "premium.cjs") continue;              // tek kaynağın kendisi
      const satirlar = fs.readFileSync(nodePath.join(d, dosya), "utf8").split("\n");
      satirlar.forEach((satir, i) => {
        const t = satir.trim();
        if (t.startsWith("*") || t.startsWith("//")) return;   // yorum
        // `is1987 === true` VE `"1987"` aynı satırda → kural kopyalanmış
        if (/is1987\s*===\s*true/.test(satir) && /"1987"/.test(satir)) {
          kusurlu.push(`${alt}/${dosya}:${i + 1}`);
        }
      });
    }
  }

  assert.deepStrictEqual(
    kusurlu,
    [],
    "1987 uyelik kurali kopyalanmis — premium.uyeMi1987 kullan:\n" + kusurlu.join("\n")
  );
});
