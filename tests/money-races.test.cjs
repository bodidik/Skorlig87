"use strict";

/**
 * PARA YOLLARI — çift ödeme / eksi bakiye korumaları.
 *
 * Hepsi aynı kusurun örnekleriydi: koşul okunuyor, karar veriliyor, PARA
 * dağıtılıyor, mühür en sonda yazılıyordu. Kontrol ile mühür arasındaki
 * pencerede ikinci bir çağrı da kontrolü geçip ödemeyi tekrar yapıyordu.
 *
 * settle2 aynı fixture için livescore-sync (30sn), af-sync ve manuel
 * çağrılardan tetiklenebiliyor — yani bu pencere kuramsal değil.
 *
 * Bu testler geri kayarsa belirti "hata" olmaz: ekonomi sessizce şişer.
 *
 * Çalıştırma:  npm test
 */

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const os = require("os");

// ⚠️ Modüller yüklenmeden ÖNCE: yollar modül düzeyinde hesaplanıyor.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "skorlig-para-"));
process.env.SKORLIG_DATA_DIR = TMP;

const S = require("../lib/social-store.cjs");
const MatchResults = require("../lib/match-results.cjs");
const { spendLc, creditLc, COLL_USERS } = require("../lib/wallet-credit.cjs");

let mongod = null;
let client = null;
let db = null;

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
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

beforeEach(async () => {
  for (const c of [S.COLL_TOURNAMENTS, S.COLL_DUELS, COLL_USERS, MatchResults.COLL]) {
    await db.collection(c).deleteMany({});
  }
});

describe("maç ödülü mührü (settle2)", () => {
  test("20 eşzamanlı settle, mührü yalnızca BİRİ alır", async () => {
    // Eski akış: getSnapshot ile oku → ~90 satır ödül dağıt → EN SONDA
    // awardedAt yaz. Pencere dağıtımın tamamı kadar genişti.
    const r = await Promise.all(
      Array.from({ length: 20 }, () => MatchResults.claimAward("fx-1", "2026-07-29T12:00:00Z", db))
    );
    assert.equal(r.filter(Boolean).length, 1, "tam bir çağrı ödül dağıtmalı");
  });

  test("mühür kalıcı — sonraki çağrılar da alamaz", async () => {
    assert.equal(await MatchResults.claimAward("fx-2", null, db), true);
    assert.equal(await MatchResults.claimAward("fx-2", null, db), false);
    assert.equal(await MatchResults.claimAward("fx-2", null, db), false);
  });

  test("snapshot henüz yokken de mühür alınabilir (upsert)", async () => {
    // Mühür ödül dağıtımından ÖNCE alınıyor; snapshot ise sonra yazılıyor.
    assert.equal(await db.collection(MatchResults.COLL).countDocuments({ fixtureId: "fx-3" }), 0);
    assert.equal(await MatchResults.claimAward("fx-3", null, db), true);
    const doc = await db.collection(MatchResults.COLL).findOne({ fixtureId: "fx-3" });
    assert.ok(doc.awardedAt, "mühür yazılmalı");
  });

  test("farklı maçlar birbirini engellemez", async () => {
    const r = await Promise.all([
      MatchResults.claimAward("a", null, db),
      MatchResults.claimAward("b", null, db),
      MatchResults.claimAward("c", null, db),
    ]);
    assert.deepEqual(r, [true, true, true]);
  });

  test("geçersiz fixtureId sessizce false — çağıran ödül dağıtmaz", async () => {
    assert.equal(await MatchResults.claimAward("", null, db), false);
    assert.equal(await MatchResults.claimAward(null, null, db), false);
  });
});

describe("turnuva ödemesi mührü", () => {
  const turnuva = (id) => ({ id, code: "K" + id, status: "open", pool: 100, participants: [] });

  test("10 eşzamanlı ödeme, yalnızca BİRİ üstlenir", async () => {
    await S.saveTournaments([turnuva("t1")], db);
    const r = await Promise.all(
      Array.from({ length: 10 }, () => S.claimTournamentSettle("t1", "2026-07-29T12:00:00Z", db))
    );
    assert.equal(r.filter(Boolean).length, 1, "havuz bir kez dağıtılmalı");
  });

  test("mühür durumu gerçekten yazar", async () => {
    await S.saveTournaments([turnuva("t2")], db);
    await S.claimTournamentSettle("t2", "2026-07-29T12:00:00Z", db);
    const t = (await S.loadTournaments(db)).find((x) => x.id === "t2");
    assert.equal(t.status, "settled");
    assert.equal(t.settledAt, "2026-07-29T12:00:00Z");
  });

  test("zaten ödenmiş turnuva ikinci kez üstlenilmez", async () => {
    await S.saveTournaments([{ ...turnuva("t3"), status: "settled" }], db);
    assert.equal(await S.claimTournamentSettle("t3", null, db), false);
  });

  test("olmayan turnuva false döner", async () => {
    assert.equal(await S.claimTournamentSettle("yok", null, db), false);
  });
});

describe("bakiye — eksiye düşmez", () => {
  test("tahmin ücreti: 20 eşzamanlı kesme, bakiye 0'ın altına inmez", async () => {
    // pred.cjs'teki el yazması iyimser kilit kaldırıldı: yarışı tespit edip
    // ardından KORUMASIZ kesiyordu (taze okuma ile yazma arasına giren istek
    // bakiyeyi boşaltırsa eksiye düşüyordu).
    await creditLc(db, "oyuncu", 30, "test");
    const r = await Promise.all(
      Array.from({ length: 20 }, () => spendLc(db, "oyuncu", 3, "match_pred"))
    );
    const u = await db.collection(COLL_USERS).findOne({ userIdLower: "oyuncu" });
    assert.equal(r.filter((x) => x.ok).length, 10, "tam 10 tahmin ücretlenmeli");
    assert.equal(u.balance, 0);
    assert.ok(u.balance >= 0, "hiçbir koşulda eksi olmamalı");
  });

  test("kazanç ve harcama eşzamanlı: toplam doğru kalır", async () => {
    // $inc göreli çalıştığı için okunan değere dayanmaz; iki yön karışmaz.
    await creditLc(db, "karma", 50, "test");
    await Promise.all([
      ...Array.from({ length: 10 }, () => spendLc(db, "karma", 2, "harcama")),
      ...Array.from({ length: 10 }, () => creditLc(db, "karma", 3, "kazanc")),
    ]);
    const u = await db.collection(COLL_USERS).findOne({ userIdLower: "karma" });
    assert.equal(u.balance, 50 - 20 + 30, "50 - (10×2) + (10×3) = 60");
  });
});

describe("göreli yazma kuralı (regen)", () => {
  test("MUTLAK yazma araya giren harcamayı geri getirir — düzeltilen kusur", async () => {
    // lc-wallet birikim yolu `$set: { balance: user.balance }` kullanıyordu.
    // Kusurun kendisi burada belgeleniyor: aynı sırayı iki şekilde işletip
    // farkı ölçüyoruz.
    await creditLc(db, "mutlak", 10, "test");
    const okunan = 10;                                   // birikim bakiyeyi okur
    await spendLc(db, "mutlak", 3, "arada_harcama");      // araya tahmin girer → 7
    // MUTLAK yazma (eski davranış):
    await db.collection(COLL_USERS).updateOne(
      { userIdLower: "mutlak" },
      { $set: { balance: okunan + 2 } }                   // birikim +2 → 12 yazar
    );
    const kotu = await db.collection(COLL_USERS).findOne({ userIdLower: "mutlak" });
    assert.equal(kotu.balance, 12, "harcanan 3 LC geri geldi — yoktan para");

    // GÖRELİ yazma (yeni davranış): aynı sıra, doğru sonuç.
    await db.collection(COLL_USERS).deleteMany({ userIdLower: "goreli" });
    await creditLc(db, "goreli", 10, "test");
    await spendLc(db, "goreli", 3, "arada_harcama");      // → 7
    await db.collection(COLL_USERS).updateOne(
      { userIdLower: "goreli" },
      { $inc: { balance: 2 } }                            // birikim +2 → 9
    );
    const iyi = await db.collection(COLL_USERS).findOne({ userIdLower: "goreli" });
    assert.equal(iyi.balance, 9, "10 - 3 + 2 = 9");
  });
});

describe("düello ödemesi mührü", () => {
  const duello = (id, st = "accepted") => ({
    id, status: st, fixtureId: "fx", stake: 10, pot: 20,
    creatorId: "u1", acceptorId: "u2",
  });

  test("10 eşzamanlı sonuçlandırma, yalnızca BİRİ öder", async () => {
    // Eski koruma `withFileLock` idi: yalnızca TEK süreci korur. Depo Mongo'ya
    // taşındığı için çok instance'ta hiçbir şey yapmıyordu; ödeme de kilidin
    // dışındaydı ve Mongo'ya durum yazımı ödemeden SONRA yapılıyordu.
    await S.saveDuels([duello("d1")], db);
    const r = await Promise.all(
      Array.from({ length: 10 }, () => S.claimDuelSettle("d1", { winnerId: "u1" }, db))
    );
    assert.equal(r.filter(Boolean).length, 1, "ödül bir kez yatmalı");
  });

  test("mühür durumu ve alanları yazar", async () => {
    await S.saveDuels([duello("d2")], db);
    await S.claimDuelSettle("d2", { winnerId: "u2", settledAt: "2026-07-29T12:00:00Z" }, db);
    const d = (await S.loadDuels(db)).find((x) => x.id === "d2");
    assert.equal(d.status, "settled");
    assert.equal(d.winnerId, "u2");
  });

  test("zaten ödenmiş düello ikinci kez üstlenilmez", async () => {
    await S.saveDuels([duello("d3", "settled")], db);
    assert.equal(await S.claimDuelSettle("d3", { winnerId: "x" }, db), false);
  });
});

describe("düello deposu — yarım taşımanın açtığı delik", () => {
  test("KAYDEDİLEN düello OKUNABİLİR (Mongo'da başka kayıt varken bile)", async () => {
    // Kusur buydu: loadDuels Mongo'dan okuyor, saveDuels yalnızca dosyaya
    // yazıyordu. Mongo'da bir kayıt varken yeni düello görünmez oluyordu —
    // oyuncu bahsini yatırıp düellosunu kaybediyordu.
    await S.saveDuels([{ id: "eski", status: "settled" }], db);
    const list = await S.loadDuels(db);
    list.push({ id: "yeni", status: "open", stake: 10 });
    await S.saveDuels(list, db);

    const sonra = await S.loadDuels(db);
    assert.equal(sonra.length, 2);
    assert.ok(sonra.find((d) => d.id === "yeni"), "yeni düello görünmeli");
  });

  test("Mongo boşsa dosyaya düşülür (eski kayıtlar kaybolmaz)", async () => {
    // Eski loadDuels `docs.length` kontrolü yapmıyordu: boş koleksiyon
    // doğrudan [] dönüyor, dosya hiç okunmuyordu.
    await db.collection(S.COLL_DUELS).deleteMany({});
    await S.saveDuels([{ id: "dosyada", status: "open" }], null);
    const list = await S.loadDuels(db);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, "dosyada");
  });
});

describe("seri deposu (streak) — bonus tekrarını önler", () => {
  const StreakStore = require("../lib/streak-store.cjs");

  test("FARKLI kullanıcıların eşzamanlı güncellemeleri birbirini silmez", async () => {
    // Eski kod tüm haritayı okuyup tümünü geri yazıyordu (kilitsiz): iki maç
    // aynı anda sonuçlandığında biri diğerinin serisini siliyordu.
    await db.collection(StreakStore.COLL).deleteMany({});
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        StreakStore.saveMany({ ["u" + i]: { count: i, lastTier: 0 } }, db)
      )
    );
    const hepsi = await StreakStore.loadMany(null, db);
    assert.equal(Object.keys(hepsi).length, 10, "10 kullanıcının hepsi durmalı");
  });

  test("lastTier korunur — bonus tekrar ödenmez", async () => {
    // Bonusun tek kez verilmesini sağlayan alan bu. Kaybolursa oyuncu aynı
    // eşikleri yeniden geçer ve LC'yi TEKRAR alır (sessiz enflasyon).
    await db.collection(StreakStore.COLL).deleteMany({});
    await StreakStore.saveMany({ oyuncu: { cumOdds: 25, count: 20, lastTier: 1 } }, db);
    const m = await StreakStore.loadMany(["oyuncu"], db);
    assert.equal(m.oyuncu.lastTier, 1);
  });

  test("saveMany SİLMEZ — kısmi liste diğerlerini korur", async () => {
    // Diğer depoların "tam değiştirme" semantiğinin TERSİ: burada kısmi liste
    // normaldir (yalnızca değişen kullanıcılar yazılır).
    await db.collection(StreakStore.COLL).deleteMany({});
    await StreakStore.saveMany({ a: { count: 1 }, b: { count: 2 } }, db);
    await StreakStore.saveMany({ a: { count: 5 } }, db);
    const m = await StreakStore.loadMany(null, db);
    assert.equal(Object.keys(m).length, 2, "b silinmemeli");
    assert.equal(m.a.count, 5);
    assert.equal(m.b.count, 2);
  });

  test("yalnızca istenen kullanıcılar okunur (sıcak yol maliyeti)", async () => {
    await db.collection(StreakStore.COLL).deleteMany({});
    await StreakStore.saveMany({ x: { count: 1 }, y: { count: 2 }, z: { count: 3 } }, db);
    const m = await StreakStore.loadMany(["x", "z"], db);
    assert.deepEqual(Object.keys(m).sort(), ["x", "z"]);
  });

  test("iç alan userIdLower sızmaz", async () => {
    await db.collection(StreakStore.COLL).deleteMany({});
    await StreakStore.saveMany({ k: { count: 1 } }, db);
    const m = await StreakStore.loadMany(["k"], db);
    assert.equal("userIdLower" in m.k, false);
  });
});
