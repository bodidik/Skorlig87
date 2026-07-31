"use strict";

/**
 * AÇILIŞ BAKİYESİ — cüzdanı hangi yol yaratırsa yaratsın verilmeli.
 *
 * ⚠️ BULUNAN: `creditLc` yeni kullanıcı için cüzdanı YALNIZCA kredi tutarıyla
 * yaratıyordu. Açılış bakiyesini veren yollar ise "belge var mı?" diye bakıp
 * atlıyor — kod tabanında hiçbir yerde "açılış verildi" işareti yok, belgenin
 * VARLIĞI bu sorunun yerine geçiyor.
 *
 * Ölçüldü (bellek-içi Mongo, düzeltmeden önce):
 *   creditLc(yeni, +15) → bakiye 15   ← açılış 30 KAYIP
 *   spendLc(yeni,  -3)  → bakiye 27   ← açılış verilmiş, sonra düşülmüş
 *
 * Gerçek senaryo: davet linkiyle gelen kullanıcı. `applyPendingRef` açılışta
 * `/use-invite` çağırıyor ve `invite_welcome` kredisi cüzdanı yaratıyor — yani
 * DAVET ÖZELLİĞİNİN GETİRDİĞİ kullanıcı 45 yerine 15 LC ile başlıyordu.
 * Büyüme yolunun tam ortasında, sessiz.
 *
 * ⚠️ ASİMETRİ KAYNAĞI: `spendLc` cüzdanı açılış bakiyesiyle kuruyordu,
 * `creditLc` kurmuyordu. Aynı işi yapan iki fonksiyondan yalnızca birinde
 * olan davranış — bu oturumun en sık tekrarlanan hata biçimi.
 */

const os = require("os");
const nodePath = require("path");
const fs = require("fs");
process.env.SKORLIG_DATA_DIR = nodePath.join(os.tmpdir(), "skorlig-acilis-test");
fs.mkdirSync(process.env.SKORLIG_DATA_DIR, { recursive: true });

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const { creditLc, spendLc, cuzdanKur, COLL_USERS } = require("../lib/wallet-credit.cjs");
const { ACILIS_BAKIYESI } = require("../lib/ekonomi.cjs");

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
  await db.collection(COLL_USERS).deleteMany({});
});

const bakiye = async (uid) =>
  (await db.collection(COLL_USERS).findOne({ userIdLower: uid.toLowerCase() }))?.balance ?? null;

describe("cüzdanKur ile kurulan cüzdan", () => {
  test("açılış bakiyesi verilir, sonra kredi eklenir", async () => {
    // `/use-invite` tam olarak bu sırayı uyguluyor.
    await cuzdanKur(db, "davetli");
    await creditLc(db, "davetli", 15, "invite_welcome", {});
    assert.equal(
      await bakiye("davetli"),
      ACILIS_BAKIYESI + 15,
      "davet linkiyle gelen kullanici acilis bakiyesini kaybediyor"
    );
  });

  test("cüzdanKur İKİ kez çağrılsa da açılış bir kez verilir", async () => {
    // Aksi hâlde her çağrı 30 LC bonus üretirdi.
    await cuzdanKur(db, "ali");
    await cuzdanKur(db, "ali");
    await creditLc(db, "ali", 10, "duel_win", {});
    assert.equal(await bakiye("ali"), ACILIS_BAKIYESI + 10);
  });

  test("MEVCUT cüzdana cüzdanKur dokunmaz", async () => {
    await spendLc(db, "veli", 5, "match_pred", {});      // bakiye 25
    const oncesi = await bakiye("veli");
    const kuruldu = await cuzdanKur(db, "veli");
    assert.equal(kuruldu, false, "mevcut cuzdan yeniden kurulmus");
    assert.equal(await bakiye("veli"), oncesi);
  });
});

describe("cüzdanı HARCAMA yaratırsa", () => {
  test("açılış bakiyesi verilir (önceden de böyleydi)", async () => {
    const r = await spendLc(db, "oyuncu", 3, "match_pred", {});
    assert.equal(r.ok, true);
    assert.equal(await bakiye("oyuncu"), ACILIS_BAKIYESI - 3);
  });
});

describe("iki yol tutarlı", () => {
  test("cüzdanKur + kredi, harcama yoluyla aynı yeri verir", async () => {
    // ⚠️ ASIL DEĞİŞMEZ: cüzdanı hangi yol kurarsa kursun kullanıcı aynı
    // yerden başlamalı. Asimetri tam da burada gizlenmişti.
    await cuzdanKur(db, "a");
    await creditLc(db, "a", 10, "duel_win", {});
    await spendLc(db, "b", 10, "match_pred", {});
    const fark = (await bakiye("a")) - 10 - ((await bakiye("b")) + 10);
    assert.equal(fark, 0, "iki yol farkli acilis bakiyesi veriyor");
  });

  test("eşzamanlı cüzdanKur açılış bakiyesini ikiye katlamaz", async () => {
    await Promise.all([cuzdanKur(db, "yaris"), cuzdanKur(db, "yaris")]);
    assert.equal(await bakiye("yaris"), ACILIS_BAKIYESI, "eszamanli kurulum cogaltmis");
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

/**
 * ⚠️ BU NÖBETÇİ NEGATİF KONTROLDE DOĞDU. Yukarıdaki testler `cuzdanKur`u
 * YALITILMIŞ sınıyor; `/use-invite` içindeki çağrıyı sildiğimde hepsi yine
 * geçti. Yani asıl hata (davetlinin açılış bakiyesini kaybetmesi) testlerin
 * kör noktasındaydı — düzeltmeyi doğrulamak, düzeltmenin BAĞLI olduğunu
 * doğrulamak değildir.
 */
test("NÖBETÇİ: yeni kullanıcıyı kredi ile karşılayan uçlar cüzdanı kurar", () => {
  const kaynak = fs.readFileSync(
    nodePath.join(__dirname, "..", "routes", "friends.cjs"), "utf8"
  );
  const i = kaynak.indexOf('router.post("/use-invite"');
  assert.ok(i > 0, "/use-invite bulunamadi");
  const sonrakiRota = kaynak.indexOf("router.", i + 10);
  const hamGovde = kaynak.slice(i, sonrakiRota > 0 ? sonrakiRota : undefined);

  /* ⚠️ YORUMLAR AYIKLANIYOR. İlk sürüm bunu yapmıyordu ve KENDİ açıklama
   * metnim testi düşürdü: `cuzdanKur`un üstündeki yorum "creditLc" kelimesini
   * geçiriyor, `indexOf("creditLc")` onu buluyor ve sıra kontrolü ters
   * çıkıyordu. Bu oturumda üçüncü kez bir tarayıcı yorum metnine takıldı. */
  const govde = hamGovde
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith("*") || t.startsWith("//") || t.startsWith("/*"));
    })
    .join("\n");

  assert.ok(
    /cuzdanKur\s*\(/.test(govde),
    "/use-invite cuzdanKur cagirmiyor — davet linkiyle gelen kullanici acilis " +
    "bakiyesini kaybeder (olculdu: 45 yerine 15 LC)"
  );

  const kur = govde.indexOf("cuzdanKur");
  const kredi = govde.indexOf("creditLc");
  assert.ok(
    kur > 0 && kredi > 0 && kur < kredi,
    "cuzdanKur krediden SONRA cagriliyor — cuzdan zaten kredi tutariyla kurulmus olur"
  );
});
