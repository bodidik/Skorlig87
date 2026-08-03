"use strict";

/**
 * İNDEKS KURULUMU GEÇİCİ ARIZADA KALICI OLARAK ÖLMEZ.
 *
 * ⚠️ BULUNAN KIRILGANLIK (2026-08-03): depolar `ensureIndexes` sözünü
 * önbelleğe alıyor (`_indexPromise`/`_soz`) — doğru, çünkü bayrak kullanmak
 * yarış açardı. Ama 11 depoda hata durumunda önbellek DÜŞÜRÜLMÜYORDU: söz
 * bir kez çözülünce (hata yutulmuş olsa bile) `ensureIndexes` bir daha HİÇ
 * denemez. Tek bir geçici Mongo hatası indeksleri SÜREÇ BOYUNCA kurulmamış
 * bırakıyordu.
 *
 * ⚠️ KAYBOLAN YALNIZCA HIZ DEĞİL — BENZERSİZLİK GARANTİSİ.
 * ÖLÇÜLDÜ (gerçek `pool-store`, ilk `createIndex` çağrısı patlatıldı, sonra
 * arıza geçti):
 *     pool_bets indeksleri : (hiçbiri)
 *     benzersiz indeks     : YOK
 *     aynı kullanıcı aynı maça → 2 BAHİS yazabildi
 * Yani "bir maç bir bahis" kuralı sessizce kalkıyordu. Aynı desen
 * `wallet-credit` (kopya cüzdan), `social-store` (grup kodu çakışması,
 * 7 benzersiz indeks) ve `moderation-store` (yasak listesi) için de geçerli.
 *
 * ⚠️ SAVUNMA 6 DEPODA ZATEN VARDI (preds-index, kupon-store, push-sent-store,
 * davet-odul-store, tr-league-store, skor-uyusmazlik) — 11'inde yoktu.
 * Bu deponun en sık kusuru: aynı savunma bir yerde var, komşusunda yok.
 */

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const KOK = path.join(__dirname, "..");
process.env.SKORLIG_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "skorlig-ix-"));

let mongod = null, client = null, db = null;

before(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const { MongoClient } = require("mongodb");
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  db = client.db("test");
});

after(async () => {
  await client?.close();
  await mongod?.stop();
  try { fs.rmSync(process.env.SKORLIG_DATA_DIR, { recursive: true, force: true }); } catch { /* geçici */ }
});

/** İlk `createIndex` çağrısını patlatan sarmalayıcı. */
function arizaliDb(gercekDb) {
  let patlat = true;
  const orj = gercekDb.collection.bind(gercekDb);
  const sarmal = Object.create(gercekDb);
  sarmal.collection = (ad) => {
    const c = orj(ad);
    const g = c.createIndex.bind(c);
    c.createIndex = async (...a) => {
      if (patlat) { patlat = false; throw new Error("gecici ag hatasi"); }
      return g(...a);
    };
    return c;
  };
  return sarmal;
}

describe("indeks önbelleği — geçici arıza kalıcı olmamalı", () => {
  test("kurulum sınandı: arıza sarmalayıcı GERÇEKTEN ilk çağrıyı patlatıyor", async () => {
    /**
     * ⚠️ Bu olmadan "indeks kuruldu" sonucu, arızanın hiç oluşmamasından da
     * gelebilirdi — sıfır sonuç kanıt değildir.
     */
    const a = arizaliDb(db);
    let hata = null;
    try { await a.collection("sinama_ix").createIndex({ x: 1 }); }
    catch (e) { hata = e; }
    assert.ok(hata, "sarmalayici patlatmadi — test bir sey olcmuyor");
    // ikincisi geçmeli
    await a.collection("sinama_ix").createIndex({ x: 1 });
  });

  test("GEÇİCİ ARIZADAN SONRA indeks yeniden kurulur (pool-store)", async () => {
    /* Modül önbelleği temiz yüklensin: `_indexPromise` süreç ömrü boyunca
     * yaşıyor, aynı süreçte ikinci kez sınamak için yeniden yükleniyor. */
    const p = require.resolve(path.join(KOK, "lib", "pool-store.cjs"));
    delete require.cache[p];
    const Pool = require(p);

    const a = arizaliDb(db);
    await db.collection("pool_bets").drop().catch(() => {});
    await Pool.summary("IX-MAC-1", a);      // 1) indeks kurulumu patlar
    await Pool.summary("IX-MAC-1", a);      // 2) yeniden DENEMELİ

    const ix = await db.collection("pool_bets").indexes().catch(() => []);
    const benzersiz = ix.filter((i) => i.unique).map((i) => i.name);
    assert.ok(benzersiz.length > 0,
      `gecici arizadan sonra benzersiz indeks kurulmamis: ${ix.map((i) => i.name).join(", ") || "(hicbiri)"}`);
  });

  test("BENZERSİZLİK GARANTİSİ geri geliyor (bir maç bir bahis)", async () => {
    /**
     * ⚠️ ASIL ZARAR BU. İndeks yoksa uygulama hata vermez — yalnızca aynı
     * kullanıcı aynı maça birden çok bahis yazabilir hâle gelir.
     */
    const col = db.collection("pool_bets");
    await col.deleteMany({ fixtureId: "IX-MAC-1" });
    await col.insertOne({ fixtureId: "IX-MAC-1", userId: "AYNI", userIdLower: "ayni", side: "H", amount: 5 });
    let ikinci = null;
    try {
      await col.insertOne({ fixtureId: "IX-MAC-1", userId: "AYNI", userIdLower: "ayni", side: "A", amount: 5 });
    } catch (e) { ikinci = e; }
    assert.ok(ikinci, "ikinci bahis yazilabildi — benzersizlik korumasi yok");
    assert.equal(await col.countDocuments({ fixtureId: "IX-MAC-1", userIdLower: "ayni" }), 1);
  });

  test("NÖBETÇİ: indeks kuran HER depo hatada önbelleği düşürüyor", () => {
    /**
     * ⚠️ SINIF TARAMASI. Kusur tek dosyada değil, "yeni depo yazarken
     * sıfırlamayı unutmak" alışkanlığındaydı: 17 depodan 11'i eksikti.
     * Yeni bir depo eklendiğinde bu test onu yakalar.
     */
    const suclu = [];
    for (const ad of fs.readdirSync(path.join(KOK, "lib"))) {
      if (!ad.endsWith(".cjs")) continue;
      const src = fs.readFileSync(path.join(KOK, "lib", ad), "utf8");
      if (!/createIndex\(/.test(src)) continue;
      const onbellek = (src.match(/let\s+(_indexPromise|_soz)\b/) || [])[1];
      if (!onbellek) continue;      // önbelleklemeyen depo bu kuralın dışında
      const sifirlar = new RegExp("^\\s*" + onbellek + "\\s*=\\s*null", "m").test(src);
      if (!sifirlar) suclu.push(`lib/${ad}`);
    }
    assert.deepEqual(suclu, [],
      "gecici arizada onbellegi dusurmeyen depo(lar): " + suclu.join(", ") +
      " — tek bir hata indeksleri surec boyunca kurulmamis birakir");
  });

  test("TERS RİSK: önbellek HÂLÂ var (her çağrıda createIndex yok)", () => {
    /**
     * ⚠️ Düzeltmeyi "önbelleği tamamen kaldır" diye yapmak, her erişimde
     * `createIndex` çağırmak demekti — sıcak yolda gereksiz yük. Önbellek
     * korunuyor, yalnızca HATA durumunda düşüyor.
     */
    for (const ad of ["pool-store.cjs", "wallet-credit.cjs", "social-store.cjs"]) {
      const src = fs.readFileSync(path.join(KOK, "lib", ad), "utf8");
      assert.ok(/if\s*\(_indexPromise\)\s*return\s+_indexPromise/.test(src),
        `lib/${ad}: onbellek kaldirilmis — her cagride createIndex calisir`);
    }
  });
});
