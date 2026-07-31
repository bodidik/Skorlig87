"use strict";

/**
 * SETTLE SONRASI SKOR DEĞİŞİMİ.
 *
 * ⚠️ BULUNAN: uzlaşma `claimAward` ile mühürlü — aynı maç iki kez ödeme
 * yapmasın diye. Doğru bir koruma ama yan etkisi var: skor uzlaşmadan SONRA
 * değişirse (VAR kararı, kaynak düzeltmesi, yanlış eşleşen maçın düzeltilmesi)
 * yeniden uzlaşma OLMUYOR ve puanlar/LC kalıcı olarak yanlış kalıyor.
 *
 * Daha kötüsü: bunu fark eden hiçbir şey yoktu. Anlık görüntü `finalScore`u
 * saklıyor, canlı akış güncel skoru biliyor — veri vardı, karşılaştırma yoktu.
 *
 * ⚠️ OTOMATİK DÜZELTME BİLEREK YOK. Yeniden uzlaşma dağıtılmış LC'yi geri
 * almayı gerektirir; oyuncu parayı harcamış olabilir ve bakiye eksiye düşerdi.
 * Karar operatörün; bu modül durumu GÖRÜNÜR kılıyor.
 */

const os = require("os");
const nodePath = require("path");
const fs = require("fs");
process.env.SKORLIG_DATA_DIR = nodePath.join(os.tmpdir(), "skorlig-uyusmazlik-test");
fs.mkdirSync(process.env.SKORLIG_DATA_DIR, { recursive: true });

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const SkorUyusmazlik = require("../lib/skor-uyusmazlik.cjs");

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
  await db.collection(SkorUyusmazlik.COLL).deleteMany({});
});

describe("karşılaştırma", () => {
  test("gerçek değişimi yakalar", () => {
    assert.equal(SkorUyusmazlik.farkliMi({ home: 2, away: 1 }, { home: 2, away: 2 }), true);
    assert.equal(SkorUyusmazlik.farkliMi({ home: 0, away: 0 }, { home: 1, away: 0 }), true);
  });

  test("aynı skoru uyuşmazlık saymaz", () => {
    assert.equal(SkorUyusmazlik.farkliMi({ home: 2, away: 1 }, { home: 2, away: 1 }), false);
    // Sayı/metin farkı gerçek bir değişim değil.
    assert.equal(SkorUyusmazlik.farkliMi({ home: "2", away: "1" }, { home: 2, away: 1 }), false);
  });

  test("EKSİK veri uyuşmazlık DEĞİLDİR", () => {
    /**
     * ⚠️ En önemli kural. Skorlardan biri okunamıyorsa "değişti" demek yanlış
     * alarm üretir; yanlış alarm operatörü bu kayda güvenmemeye iter ve kayıt
     * işe yaramaz hâle gelir. (Aynı ders bu oturumda nöbetçilerde de çıktı.)
     */
    for (const [a, b] of [
      [null, { home: 1, away: 0 }],
      [{ home: 1, away: 0 }, null],
      [{ home: null, away: 0 }, { home: 1, away: 0 }],
      [{}, { home: 1, away: 0 }],
      [undefined, undefined],
    ]) {
      assert.equal(SkorUyusmazlik.farkliMi(a, b), false, `eksik veri uyusmazlik sayildi: ${JSON.stringify([a, b])}`);
    }
  });
});

describe("kayıt", () => {
  const kayit = (fid) => ({
    fixtureId: fid,
    mac: "A - B",
    muhurluSkor: { home: 2, away: 1 },
    guncelSkor: { home: 2, away: 2 },
  });

  test("uyuşmazlık kalıcı olarak yazılır", async () => {
    assert.equal(await SkorUyusmazlik.kaydet(db, kayit("m1")), true);
    const d = await db.collection(SkorUyusmazlik.COLL).findOne({ fixtureId: "m1" });
    assert.ok(d, "kayit yok");
    assert.deepEqual(d.muhurluSkor, { home: 2, away: 1 });
    assert.deepEqual(d.guncelSkor, { home: 2, away: 2 });
  });

  test("maç başına TEK kayıt (her turda gürültü üretmez)", async () => {
    await SkorUyusmazlik.kaydet(db, kayit("m1"));
    assert.equal(await SkorUyusmazlik.kaydet(db, kayit("m1")), false, "ikinci kez yazilmis");
    assert.equal(await db.collection(SkorUyusmazlik.COLL).countDocuments({ fixtureId: "m1" }), 1);
  });

  test("db yoksa sessizce false döner", async () => {
    assert.equal(await SkorUyusmazlik.kaydet(null, kayit("m2")), false);
  });

  test("kayıt DOSYAYA değil Mongo'ya gider", async () => {
    // ⚠️ `lib/admin-alerts.cjs` dosya tabanlı ve Render'da `data/` her
    // deploy'da siliniyor. Yanlış uzlaşmanın tek kaydı bir dosya uyarısı
    // olsaydı, deploy'da yok olur ve sorun unutulurdu.
    await SkorUyusmazlik.kaydet(db, kayit("m3"));
    assert.equal(await db.collection(SkorUyusmazlik.COLL).countDocuments({ fixtureId: "m3" }), 1);
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: senkron servisi uyuşmazlığı kontrol ediyor", () => {
  const src = fs.readFileSync(
    nodePath.join(__dirname, "..", "services", "livescore-sync.cjs"), "utf8"
  );
  assert.ok(
    /SkorUyusmazlik\.farkliMi/.test(src),
    "senkron servisi settle sonrasi skor degisimini kontrol etmiyor"
  );
  // Kontrol yalnızca ZATEN uzlaşmış maçlar için anlamlı.
  assert.ok(
    /settledIds\.has\(fid\)\)\s*\{[\s\S]{0,600}?farkliMi/.test(src),
    "kontrol settle edilmis maclarla sinirlandirilmamis"
  );
});

test("NÖBETÇİ: otomatik yeniden uzlaşma YOK", () => {
  /**
   * Uyuşmazlık bulunduğunda kod kendiliğinden yeniden uzlaştırmaya
   * kalkışmamalı: dağıtılmış LC'yi geri almak bakiyeyi eksiye düşürebilir.
   */
  const ham = fs.readFileSync(
    nodePath.join(__dirname, "..", "lib", "skor-uyusmazlik.cjs"), "utf8"
  );
  // ⚠️ YORUMLAR AYIKLANIYOR: modulun kendi aciklamasi "claimAward" kelimesini
  // geciriyor ve ilk surumde testi dusurdu. Bu oturumda ucuncu kez bir metin
  // testi kendi yorumuna takildi.
  const src = ham
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith("*") || t.startsWith("//") || t.startsWith("/*"));
    })
    .join("\n");
  assert.ok(!/creditLc|spendLc|claimAward|settle\(/.test(src),
    "uyusmazlik modulu para/uzlasma islemi yapiyor — karar operatorun olmali");
});
