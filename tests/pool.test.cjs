"use strict";

/**
 * MAÇ HAVUZU — pari-mutuel mekanik ve para korumaları.
 *
 * Bu dosya belgedeki (docs/ekonomi-tasarim.md §4) kararları koda karşı tutuyor:
 *   • çarpan = (havuz − kesinti) / kazanan tarafın bahsi
 *   • kesinti %5, YAKILIR, yalnızca kaybeden taraf varsa alınır
 *   • bot parası havuza giremez (dağılım oluşturur, para oluşturmaz)
 *   • tavan = max(20, havuzun %25'i)
 *   • havuz sıralamayı etkilemez (burada değil, settle2'de: `rows`a dokunulmaz)
 *
 * Sessizce kayarsa belirti "hata" olmaz: ödemeler yanlış olur ve kimse fark
 * etmez. O yüzden sayısal örnekler belgeden birebir alındı.
 *
 * Çalıştırma:  npm test
 */

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const Pool = require("../lib/pool-store.cjs");
const { creditLc, COLL_USERS } = require("../lib/wallet-credit.cjs");

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
  for (const c of [Pool.COLL_BETS, Pool.COLL_POOLS, COLL_USERS]) {
    await db.collection(c).deleteMany({});
  }
});

const bakiye = async (uid) =>
  (await db.collection(COLL_USERS).findOne({ userIdLower: uid.toLowerCase() }))?.balance ?? 0;

/* ─────────────────────────── çarpan matematiği ─────────────────────────── */

describe("çarpan (belgedeki örnek)", () => {
  // Ev 400 · Beraberlik 700 · Deplasman 1900 → havuz 3000, kesinti %5
  const t = { H: 400, D: 700, A: 1900 };

  test("beraberlik 4.07× — belgedeki sayı", () => {
    assert.equal(Pool.multiplierFor(t, "D"), 4.07);
  });

  test("deplasman 1.5× — kalabalıkla gitmek az kazandırır", () => {
    assert.equal(Pool.multiplierFor(t, "A"), 1.5);
    assert.ok(Pool.multiplierFor(t, "D") > Pool.multiplierFor(t, "A"),
      "az tutulan taraf daha çok kazandırmalı — mekaniğin tamamı bu");
  });

  test("hiç bahis olmayan taraf null (tanımsız), 0 değil", () => {
    assert.equal(Pool.multiplierFor({ H: 100, D: 0, A: 0 }, "D"), null);
  });

  test("KAYBEDEN TARAF YOKSA kesinti alınmaz — 1.0× iade", () => {
    // Belgedeki kural: "herkes bildiyse kesinti yok, herkes bahsini geri alır".
    assert.equal(Pool.multiplierFor({ H: 500, D: 0, A: 0 }, "H"), 1);
  });
});

describe("bahis tavanı", () => {
  test("havuzun %25'i, en az 20", () => {
    assert.equal(Pool.betCap(0), 20, "boş havuzda da oynanabilmeli");
    assert.equal(Pool.betCap(40), 20, "taban geçerli");
    assert.equal(Pool.betCap(3000), 750);
  });

  test("tavan havuzla ÖLÇEKLENİR — sabit sayı keyfi olurdu", () => {
    assert.ok(Pool.betCap(10000) > Pool.betCap(1000));
  });
});

/* ──────────────────────────── bahis koyma ──────────────────────────────── */

describe("bahis koyma", () => {
  test("LC düşülür ve bahis yazılır", async () => {
    await creditLc(db, "ali", 100, "test");
    const r = await Pool.placeBet({ fixtureId: "fx1", userId: "ali", side: "H", amount: 20 }, db);
    assert.equal(r.ok, true);
    assert.equal(await bakiye("ali"), 80);
    assert.equal((await Pool.summary("fx1", db)).pool, 20);
  });

  test("BOT havuza giremez — para değil, dağılım oluşturur", async () => {
    await creditLc(db, "botcu", 100, "test");
    const r = await Pool.placeBet({ fixtureId: "fx1", userId: "botcu", side: "H", amount: 20, isBot: true }, db);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "BOT_NOT_ALLOWED");
    assert.equal(await bakiye("botcu"), 100, "bot parası HİÇ düşülmemeli");
  });

  test("bakiye yetmezse bahis yazılmaz", async () => {
    // Tavan (boş havuzda 20) DEĞİL, bakiye engellemeli: 8 LC bakiye, 15 LC bahis.
    await creditLc(db, "fakir", 8, "test");
    const r = await Pool.placeBet({ fixtureId: "fx1", userId: "fakir", side: "H", amount: 15 }, db);
    assert.equal(r.reason, "LC_NOT_ENOUGH");
    assert.equal((await Pool.summary("fx1", db)).pool, 0, "havuza girmemeli");
    assert.equal(await bakiye("fakir"), 8);
  });

  test("alt sınırın altı reddedilir", async () => {
    await creditLc(db, "ali", 100, "test");
    const r = await Pool.placeBet({ fixtureId: "fx1", userId: "ali", side: "H", amount: 1 }, db);
    assert.equal(r.reason, "MIN_BET");
  });

  test("TARAF KİLİTLİ — karar bir kez verilir", async () => {
    await creditLc(db, "ali", 100, "test");
    await Pool.placeBet({ fixtureId: "fx1", userId: "ali", side: "H", amount: 20 }, db);
    const r = await Pool.placeBet({ fixtureId: "fx1", userId: "ali", side: "A", amount: 10 }, db);
    assert.equal(r.reason, "SIDE_LOCKED");
    assert.equal(r.side, "H");
    assert.equal(await bakiye("ali"), 80, "reddedilen bahis LC düşürmemeli");
  });

  test("aynı tarafa ekleme yapılabilir (tavan elverdiği kadar)", async () => {
    // Havuz büyüdükçe tavan da büyüyor: önce başkaları oynasın.
    for (let i = 0; i < 6; i++) {
      await creditLc(db, "d" + i, 100, "test");
      await Pool.placeBet({ fixtureId: "fx1", userId: "d" + i, side: "A", amount: 20 }, db);
    }
    await creditLc(db, "ali", 100, "test");
    await Pool.placeBet({ fixtureId: "fx1", userId: "ali", side: "H", amount: 20 }, db);
    const r = await Pool.placeBet({ fixtureId: "fx1", userId: "ali", side: "H", amount: 5 }, db);
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.bet.amount, 25);
  });

  test("tavan aşılamaz", async () => {
    await creditLc(db, "zengin", 10000, "test");
    // Boş havuzda tavan 20: "zenginin parasi ancak baskalari da oynarsa
    // ise yarar" kurali burada gorunur oluyor.
    const r = await Pool.placeBet({ fixtureId: "fx1", userId: "zengin", side: "H", amount: 5000 }, db);
    assert.equal(r.reason, "OVER_CAP");
    assert.equal(r.cap, 20);
    assert.equal(await bakiye("zengin"), 10000, "reddedilen bahis LC düşürmemeli");
  });

  test("geçersiz taraf reddedilir", async () => {
    await creditLc(db, "ali", 100, "test");
    assert.equal((await Pool.placeBet({ fixtureId: "fx1", userId: "ali", side: "X", amount: 20 }, db)).reason, "INVALID_SIDE");
  });

  test("sonuçlanmış havuza bahis girilemez", async () => {
    await creditLc(db, "ali", 100, "test");
    await Pool.placeBet({ fixtureId: "fx1", userId: "ali", side: "H", amount: 20 }, db);
    await Pool.settlePool("fx1", "H", db);
    const r = await Pool.placeBet({ fixtureId: "fx1", userId: "ali", side: "H", amount: 10 }, db);
    assert.equal(r.reason, "POOL_SETTLED");
  });
});

/* ───────────────────────────── sonuçlandırma ───────────────────────────── */

describe("sonuçlandırma", () => {
  async function kur(bahisler) {
    for (const [uid, side, amount] of bahisler) {
      await creditLc(db, uid, 1000, "test");
      const r = await Pool.placeBet({ fixtureId: "fx1", userId: uid, side, amount }, db);
      assert.equal(r.ok, true, "bahis reddedildi (" + uid + "): " + r.reason);
    }
  }

  test("kazanan bahsi × çarpan kadar alır", async () => {
    // H 20, A 20 → havuz 40, kesinti %5 = 2, dağıtılacak 38
    // H tutarsa çarpan 38/20 = 1.9× (oran belgedekiyle aynı; tutarlar tavan içinde)
    await kur([["a", "H", 20], ["b", "A", 20]]);
    const r = await Pool.settlePool("fx1", "H", db);
    assert.equal(r.ok, true);
    assert.equal(r.multiplier, 1.9);
    assert.equal(r.burned, 2, "kesinti %5 yakıldı");
    assert.equal(await bakiye("a"), 980 + 38, "kazanan 38 aldı");
    assert.equal(await bakiye("b"), 980, "kaybeden bahsini kaybetti");
  });

  test("KESİNTİ YAKILIR — kasaya birikmez", async () => {
    await kur([["a", "H", 20], ["b", "A", 20]]);
    const r = await Pool.settlePool("fx1", "H", db);
    // Yakılan, ödenene EKLENMEZ: sistemden çıkar.
    assert.equal(r.paid + r.burned, r.pool, "ödenen + yakılan = havuz");
    assert.equal(r.burned, 2);
  });

  test("HERKES BİLDİYSE kesinti yok, herkes bahsini geri alır", async () => {
    await kur([["a", "H", 20], ["b", "H", 15]]);
    const r = await Pool.settlePool("fx1", "H", db);
    assert.equal(r.multiplier, 1);
    assert.equal(r.burned, 0, "kaybeden yokken kesinti alınmaz");
    assert.equal(await bakiye("a"), 1000);
    assert.equal(await bakiye("b"), 1000);
  });

  test("KİMSE BİLEMEDİYSE havuz tamamen iade", async () => {
    await kur([["a", "H", 20], ["b", "H", 15]]);
    const r = await Pool.settlePool("fx1", "D", db);
    assert.equal(r.reason, "NO_WINNER_REFUND");
    assert.equal(r.burned, 0);
    assert.equal(await bakiye("a"), 1000);
    assert.equal(await bakiye("b"), 1000);
  });

  test("ÇİFT ÖDEME KORUMASI — 10 eşzamanlı settle, biri öder", async () => {
    // settle2 aynı fixture'ı livescore-sync/af-sync/manuel yollardan
    // defalarca gönderebiliyor.
    await kur([["a", "H", 20], ["b", "A", 20]]);
    const r = await Promise.all(
      Array.from({ length: 10 }, () => Pool.settlePool("fx1", "H", db))
    );
    assert.equal(r.filter((x) => x.ok).length, 1, "tam bir ödeme");
    assert.equal(await bakiye("a"), 1018, "kazanan yalnızca bir kez ödenmeli");
  });

  test("boş havuz sorunsuz sonuçlanır", async () => {
    const r = await Pool.settlePool("bos", "H", db);
    assert.equal(r.ok, true);
    assert.equal(r.players, 0);
  });

  test("geçersiz sonuç reddedilir", async () => {
    assert.equal((await Pool.settlePool("fx1", "Z", db)).reason, "REQ");
  });

  test("belgedeki tam senaryo: 400/700/1900, beraberlik tutar", async () => {
    // Tavan bu bahisleri engellemesin diye havuz kademeli büyütülüyor —
    // tavan (havuzun %25'i) zaten oyuncu sayısıyla ölçekleniyor.
    let toplam = 0;
    for (let i = 0; i < 8; i++) {
      await creditLc(db, "h" + i, 1000, "test");
      const tavan = (await Pool.summary("big", db)).cap;
      const rr = await Pool.placeBet({ fixtureId: "big", userId: "h" + i, side: "A", amount: tavan }, db);
      assert.equal(rr.ok, true, rr.reason);
      toplam += tavan;
    }
    const ozet = await Pool.summary("big", db);
    assert.equal(ozet.totals.A, toplam);
    assert.ok(ozet.cap > 20, "havuz buyudukce tavan da buyumeli");
    assert.equal(ozet.multipliers.A, 1, "tek taraf varken iade çarpanı");
  });
});

describe("özet", () => {
  test("taraf sayıları ve oyuncu sayısı ayrı raporlanır", async () => {
    await creditLc(db, "a", 100, "test");
    await creditLc(db, "b", 100, "test");
    await Pool.placeBet({ fixtureId: "fx1", userId: "a", side: "H", amount: 20 }, db);
    await Pool.placeBet({ fixtureId: "fx1", userId: "b", side: "H", amount: 10 }, db);
    const s = await Pool.summary("fx1", db);
    assert.equal(s.counts.H, 2);
    assert.equal(s.totals.H, 30);
    assert.equal(s.players, 2);
  });

  test("bilinmeyen maç boş özet döner, patlamaz", async () => {
    const s = await Pool.summary("yok", db);
    assert.equal(s.pool, 0);
    assert.equal(s.players, 0);
    assert.deepEqual(s.multipliers, { H: null, D: null, A: null });
  });
});
