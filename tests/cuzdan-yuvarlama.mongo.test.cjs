"use strict";

/**
 * CÜZDAN KAYAN NOKTA ARTIĞI BİRİKTİRMİYOR.
 *
 * ⚠️ KUSUR (2026-08-05 ölçüldü, canlı): `lib/wallet-credit.cjs` bakiyeyi
 * `$inc: { balance: tutar }` ile büyütüyor ve HİÇ yuvarlamıyordu. Kesirli bir
 * ödül tekrar tekrar yatınca IEEE754 artığı birikiyor — ve `$inc` göreli
 * olduğu için artık belgede KALICI hâle geliyor, bir sonraki yatırmanın
 * TABANI oluyordu:
 *
 *     düello ödülü 1.9 × 20 kredi       → 37.999999999999986
 *     mini turnuva payı 6.6 × 50 kredi  → 330.0000000000001
 *
 * Düello ödülleri kaynağında tam sayıya çevrildi (lib/duello-kesinti.cjs) ama
 * bu YETMEZ: mini turnuva payı hâlâ 0.1 adımlarında ve eklenecek her yeni ödül
 * yolu aynı tuzağa yeniden düşebilir. Bu test SINIRI tutuyor — kaynakları
 * değil. Yeni bir ödül yolu kesirli tutar yatırsa bile bakiye temiz kalmalı.
 *
 * ⚠️ GÖSTERİM DÜZELTMESİ BUNUN YERİNE GEÇMEZ. `mobile/lib/lcBicim.ts` artığı
 * ekrandan saklıyordu; depodaki değer kirli kalmaya devam ediyordu. Kirli
 * değer bir sonraki toplamanın tabanı olduğu için hata büyümeye devam ediyor,
 * yalnızca görünmüyordu.
 *
 * ⚠️ GERÇEK MONGO ŞART: yuvarlama SUNUCU TARAFINDA, iş hattı güncellemesiyle
 * yapılıyor. Sahte bir sürücüyle sınamak, sınanan şeyin ta kendisini atlardı.
 */

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

const Wallet = require("../lib/wallet-credit.cjs");

let mongod = null;
let client = null;
let db = null;

before(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const { MongoClient } = require("mongodb");
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db("test_cuzdan_yuvarlama");
});

after(async () => {
  if (client) await client.close();
  if (mongod) await mongod.stop();
});

let sayac = 0;
const yeniUid = (etiket) => `u_${etiket}_${++sayac}`;

async function bakiye(uid) {
  const d = await db.collection(Wallet.COLL_USERS)
    .findOne({ userIdLower: uid.toLowerCase() }, { projection: { balance: 1 } });
  return d ? Number(d.balance) : null;
}

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("ÖLÇÜMÜN DAYANAĞI: saf JS toplaması bu ortamda gerçekten artık üretiyor", () => {
    /* ⚠️ Bu doğrulanmazsa aşağıdaki iddialar bir şey kanıtlamaz: artık hiç
     * oluşmayan bir ortamda "artık yok" demek bedava geçer. */
    let x = 0;
    for (let i = 0; i < 20; i++) x += 1.9;
    assert.notEqual(x, 38, "bu ortamda birikme yok — testin dayanagi degismis");

    let y = 0;
    for (let i = 0; i < 50; i++) y += 6.6;
    assert.notEqual(y, 330, "mini turnuva olcumunun dayanagi degismis");
  });

  test("cüzdan gerçekten yazılıyor", async () => {
    const uid = yeniUid("kur");
    assert.equal(await Wallet.creditLc(db, uid, 5, "test"), true);
    assert.equal(await bakiye(uid), 5);
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("kesirli ödüller bakiyede birikmiyor", () => {
  test("1.9 × 20 kredi TAM 38", async () => {
    const uid = yeniUid("duello");
    for (let i = 0; i < 20; i++) await Wallet.creditLc(db, uid, 1.9, "duel_win");
    assert.equal(await bakiye(uid), 38);
  });

  test("6.6 × 50 kredi TAM 330 (mini turnuva payı — hâlâ kesirli üretiliyor)", async () => {
    const uid = yeniUid("mini");
    for (let i = 0; i < 50; i++) await Wallet.creditLc(db, uid, 6.6, "mini_tournament_win");
    assert.equal(await bakiye(uid), 330);
  });

  test("harcama yolu da temiz bırakıyor", async () => {
    const uid = yeniUid("harcama");
    await Wallet.creditLc(db, uid, 100, "kurulum");
    for (let i = 0; i < 30; i++) await Wallet.spendLc(db, uid, 0.7, "test_harcama");
    assert.equal(await bakiye(uid), 79);
  });

  test("kredi ve harcama KARIŞIK sırada da temiz", async () => {
    const uid = yeniUid("karisik");
    await Wallet.creditLc(db, uid, 50, "kurulum");
    for (let i = 0; i < 25; i++) {
      await Wallet.creditLc(db, uid, 6.6, "mini_tournament_win");
      await Wallet.spendLc(db, uid, 1.9, "duel_create");
    }
    assert.equal(await bakiye(uid), 167.5);
  });

  test("defterde de artık yazılmıyor", async () => {
    /* ⚠️ Bakiye temiz olup defter kirli kalırsa uzlaştırma (`defter-butunluk`)
     * sessizce yanlış toplar. */
    const uid = yeniUid("defter");
    await Wallet.creditLc(db, uid, 0.1 + 0.2, "test_artikli");   // 0.30000000000000004
    const kayit = await db.collection(Wallet.COLL_LEDGER)
      .findOne({ userIdLower: uid.toLowerCase() });
    assert.equal(kayit.amount, 0.3, `deftere ${kayit.amount} yazilmis`);
  });
});

/* ── Kirli bakiye kendiliğinden düzeliyor ────────────────────────────────── */

describe("mevcut kirli bakiyeler", () => {
  test("bir sonraki işlemde temizleniyor", async () => {
    /**
     * ⚠️ Sahada zaten kirlenmiş bakiyeler var; yuvarlama YAZIMDA olduğu için
     * onlar da ilk işlemde düzeliyor. Bu, ayrı bir toplu göç gerektirmemesinin
     * nedeni (elle onarım yine de mümkün: scripts/cuzdan-yuvarla.cjs).
     */
    const uid = yeniUid("kirli");
    await db.collection(Wallet.COLL_USERS).insertOne({
      userId: uid, userIdLower: uid.toLowerCase(),
      balance: 37.999999999999986, totalEarned: 37.999999999999986,
      totalSpent: 0, lastDailyAt: null,
      createdAt: "x", updatedAt: "x",
    });
    await Wallet.creditLc(db, uid, 2, "temizlik");
    assert.equal(await bakiye(uid), 40);
  });
});

/* ── Eşzamanlılık: yuvarlama atomikliği BOZMADI ──────────────────────────── */

describe("yarış koşulu", () => {
  test("40 EŞZAMANLI kredi hiç kaybolmuyor", async () => {
    /**
     * ⚠️ ASIL RİSK. `$inc` yerine "oku → hesapla → yaz" yapılsaydı eşzamanlı
     * ödüller birbirini ezerdi — dosya kodunun tam da bu yüzden terk edilen
     * deseni. İş hattı güncellemesi toplamayı SUNUCUDA tek işlemde yapıyor;
     * bu iddia onu tutuyor.
     */
    const uid = yeniUid("yaris");
    await Promise.all(
      Array.from({ length: 40 }, () => Wallet.creditLc(db, uid, 1.9, "duel_win"))
    );
    assert.equal(await bakiye(uid), 76);
  });

  test("eşzamanlı harcama bakiyeyi EKSİYE düşürmüyor", async () => {
    const uid = yeniUid("yaris2");
    await Wallet.creditLc(db, uid, 10, "kurulum");
    const sonuclar = await Promise.all(
      Array.from({ length: 20 }, () => Wallet.spendLc(db, uid, 1, "test_harcama"))
    );
    const basarili = sonuclar.filter((r) => r.ok).length;
    assert.equal(basarili, 10, `${basarili} harcama gecti — 10 olmaliydi`);
    assert.equal(await bakiye(uid), 0);
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

describe("nöbetçi", () => {
  test("yuvarlamada SIFIRLANAN ödül sessizce yutulmuyor", async () => {
    /* 0.004 LC anlamsız bir ödül ama sessizce yutulması, ödül yolunun kırık
     * olduğunu gizler — kayıp para sınıfının en sinsi hâli. */
    const uid = yeniUid("sifir");
    const ok = await Wallet.creditLc(db, uid, 0.004, "kucuk_odul");
    assert.equal(ok, false, "sifirlanan odul basarili gorunuyor");
    assert.equal(await bakiye(uid), null, "cuzdan bos yere yaratilmis");
  });

  test("normalleştirme kuralı TEK KAYNAKTA", () => {
    assert.equal(Wallet.tutarNormalle(0.1 + 0.2), 0.3);
    assert.equal(Wallet.tutarNormalle(1.005), 1);
    assert.equal(Wallet.tutarNormalle(6.6), 6.6);
    assert.ok(Number.isNaN(Wallet.tutarNormalle("abc")));
  });
});
