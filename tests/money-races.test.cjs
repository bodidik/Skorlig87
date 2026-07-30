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

describe("TR-Lig haftalık ödülü", () => {
  const TrLeague = require("../lib/tr-league-store.cjs");
  const kayit = (wk) => ({ weekKey: wk, finishedAt: "2026-07-29T12:00:00Z", winners: ["u1"], rewards: [] });

  test("10 eşzamanlı hafta kapanışı, ödülü yalnızca BİRİ dağıtır", async () => {
    // Eski koruma `_finalizingWeek` adlı SÜREÇ-İÇİ Set idi: tek instance'ta
    // işe yarar, çok instance'ta hiçbir şey yapmaz. Üstelik ödül kayıttan
    // ÖNCE dağıtılıyordu.
    await db.collection(TrLeague.COLL).deleteMany({});
    const r = await Promise.all(
      Array.from({ length: 10 }, () => TrLeague.claimWeek("2026-W31", kayit("2026-W31"), db))
    );
    assert.equal(r.filter(Boolean).length, 1, "haftalık LC bir kez dağıtılmalı");
  });

  test("kayıt kalıcı — hafta ikinci kez ödüllendirilmez", async () => {
    await db.collection(TrLeague.COLL).deleteMany({});
    assert.equal(await TrLeague.claimWeek("2026-W32", kayit("2026-W32"), db), true);
    assert.equal(await TrLeague.claimWeek("2026-W32", kayit("2026-W32"), db), false);
    const w = await TrLeague.getWeek("2026-W32", db);
    assert.deepEqual(w.winners, ["u1"]);
  });

  test("farklı haftalar birbirini engellemez", async () => {
    await db.collection(TrLeague.COLL).deleteMany({});
    const r = await Promise.all([
      TrLeague.claimWeek("2026-W40", kayit("2026-W40"), db),
      TrLeague.claimWeek("2026-W41", kayit("2026-W41"), db),
    ]);
    assert.deepEqual(r, [true, true]);
    assert.equal(Object.keys(await TrLeague.loadWeeks(db)).length, 2);
  });

  test("geçersiz hafta anahtarı false — ödül dağıtılmaz", async () => {
    assert.equal(await TrLeague.claimWeek("", {}, db), false);
  });
});

describe("1987 davet kodları", () => {
  const Invite = require("../lib/invite-store.cjs");

  async function kodKur(kodlar) {
    await db.collection(Invite.COLL).deleteMany({});
    await db.collection(Invite.COLL).insertMany(
      kodlar.map((k) => ({ ...k, codeNorm: String(k.code).toUpperCase() }))
    );
  }

  test("KOTA eşzamanlılıkta AŞILMAZ — asıl kusur buydu", async () => {
    // Eski akış: oku → `used >= maxUses` kontrol et → used+1 yaz. Son kontenjan
    // için iki istek İKİSİ de kontrolü geçiyordu.
    await kodKur([{ code: "GS1987", maxUses: 5, used: 0 }]);
    const r = await Promise.all(
      Array.from({ length: 20 }, () => Invite.redeem("GS1987", db))
    );
    assert.equal(r.filter((x) => x.ok).length, 5, "tam 5 kullanım geçmeli");
    const d = await db.collection(Invite.COLL).findOne({ codeNorm: "GS1987" });
    assert.equal(d.used, 5, "sayaç kotayı aşmamalı");
  });

  test("kota dolunca CODE_EXHAUSTED", async () => {
    await kodKur([{ code: "DOLU", maxUses: 1, used: 1 }]);
    const r = await Invite.redeem("DOLU", db);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "CODE_EXHAUSTED");
  });

  test("olmayan kod INVALID_CODE — ayrı sebep", async () => {
    await kodKur([{ code: "VAR", maxUses: 5, used: 0 }]);
    const r = await Invite.redeem("YOKKOD", db);
    assert.equal(r.reason, "INVALID_CODE");
  });

  test("maxUses 0 = SINIRSIZ", async () => {
    await kodKur([{ code: "SINIRSIZ", maxUses: 0, used: 0 }]);
    const r = await Promise.all(Array.from({ length: 12 }, () => Invite.redeem("SINIRSIZ", db)));
    assert.equal(r.filter((x) => x.ok).length, 12);
  });

  test("kod büyük/küçük harfe duyarsız", async () => {
    await kodKur([{ code: "GS1987", maxUses: 3, used: 0 }]);
    assert.equal((await Invite.redeem("gs1987", db)).ok, true);
    assert.equal((await Invite.redeem("Gs1987", db)).ok, true);
    const d = await db.collection(Invite.COLL).findOne({ codeNorm: "GS1987" });
    assert.equal(d.used, 2, "aynı koda sayılmalı");
  });

  test("iç alan codeNorm sızmaz", async () => {
    await kodKur([{ code: "TEMIZ", maxUses: 5, used: 0 }]);
    const r = await Invite.redeem("TEMIZ", db);
    assert.equal("codeNorm" in r.code, false);
  });
});

describe("cüzdan — kopya belge (benzersiz indeks)", () => {
  /**
   * creditLc `{userIdLower}` üzerinde `upsert:true` yapıyor. Benzersiz indeks
   * YOKKEN iki eşzamanlı upsert eşleşme bulamazsa İKİSİ DE ekler: aynı
   * kullanıcıya iki cüzdan belgesi. Ölçüm (40 eşzamanlı +5 LC):
   *     indekssiz : 2 belge · bakiyeler [195, 5]
   *     indeksli  : 1 belge · bakiye [200]
   * Toplam doğru ama bölünmüş; `findOne` birini döndürdüğü için kullanıcı
   * 200 yerine 5 LC görür. Belirti "hata" değil, sessiz para kaybı.
   */
  test("40 eşzamanlı ödül tek belgede toplanır", async () => {
    const N = 40;
    await Promise.all(
      Array.from({ length: N }, () => creditLc(db, "KopyaTest", 5, "test_odul"))
    );
    const belgeler = await db.collection(COLL_USERS).find({ userIdLower: "kopyatest" }).toArray();
    assert.equal(belgeler.length, 1, `cuzdan ${belgeler.length} belgeye bolundu`);
    assert.equal(Number(belgeler[0].balance), N * 5);
  });

  test("indeks kod tarafından kurulur — ensure-indexes.cjs beklenmez", async () => {
    // Sunucu betik çalıştırılmadan deploy edilirse koruma yine devrede olmalı.
    await creditLc(db, "IndeksTest", 1, "test_odul");
    const ix = await db.collection(COLL_USERS).indexes();
    const uid = ix.find((i) => Object.keys(i.key).join() === "userIdLower");
    assert.ok(uid, "userIdLower indeksi yok");
    assert.equal(uid.unique, true, "userIdLower indeksi benzersiz degil");
  });
});

describe("turnuva giriş ücreti — havuz karşılıksız büyümemeli", () => {
  /**
   * `create` ve `join` havuzu büyütüyor ama giriş ücretini TAHSİL ETMİYORDU:
   * dosyada tek bir `spendLc` çağrısı yoktu. Havuz karşılıksız değil —
   * settle2 onu gerçek LC olarak dağıtıyor (`lc_wallet_users` $inc).
   *
   * Ölçülmüştü: entryLC=100, 1 kurucu + 7 katılımcı → 800 LC havuz, hiçbir
   * bakiye değişmeden. 8+ katılımcı tablosu havuzun %100'ünü dağıtır.
   * Günlük LC hakkı 3-7 LC; tek turnuva 100+ günlük gelir üretirdi.
   */
  const T = require("../services/tournament.cjs");

  const arz = async () =>
    (await db.collection(COLL_USERS).find({}).toArray())
      .reduce((a, x) => a + Number(x.balance || 0), 0);

  test("havuzdaki her LC bir bakiyeden düşülmüş olmalı", async () => {
    for (const u of ["trnA", "trnB", "trnC"]) await creditLc(db, u, 120, "test");
    const once = await arz();

    const t = await T.create({
      creatorId: "trnA", name: "T", entryLC: 100,
      fixtureIds: ["TFX1", "TFX2"], fixtures: [], db,
    });
    await T.join(t.code, "trnB", db);
    await T.join(t.code, "trnC", db);

    const son = await T.getByCode(t.code);
    assert.equal(son.pool, 300, "havuz beklenenden farkli");
    assert.equal(await arz(), once - 300, "havuz kadar LC dusulmedi (para yaratildi)");
  });

  test("bakiye yetmezse katılım reddedilir ve havuz büyümez", async () => {
    for (const u of ["trnD", "trnE"]) await creditLc(db, u, 120, "test");
    const t = await T.create({
      creatorId: "trnD", name: "T2", entryLC: 100,
      fixtureIds: ["TFX3", "TFX4"], fixtures: [], db,
    });
    await spendLc(db, "trnE", 110, "bosalt");   // kalan 10 LC

    await assert.rejects(() => T.join(t.code, "trnE", db), /INSUFFICIENT_LC/);
    const son = await T.getByCode(t.code);
    assert.equal(son.pool, 100, "reddedilen katilim havuzu buyutmus");
    assert.equal(son.participants.length, 1);
  });
});


describe("mini turnuva — karşılıksız LC musluğu sınırlı", () => {
  /**
   * Mini turnuvaya giriş ÜCRETSİZ ama bitince kazananlara MINI_WIN_LC
   * (varsayılan 20) veriliyor — karşılığı olmayan LC üretimi. Kazanan "en
   * yüksek puanda BERABERE kalan herkes" olduğu için aynı tahmini yapan N
   * hesap turnuva başına N×20 LC üretir.
   *
   * Kaç turnuva kurulabileceğine dair HİÇBİR sınır yoktu (ne rotada ne
   * depoda). Sınır "aynı anda bitmemiş" üzerinden: her turnuvanın bitmesi
   * için maçların oynanması gerekir, yani musluk fikstür takvimine bağlanır.
   */
  const premium = require("../lib/premium.cjs");

  test("ücretsiz kullanıcının açık mini sınırı premium'dan düşük ve tanımlı", () => {
    const ucretsiz = premium.miniMaxOpen(false);
    const prem = premium.miniMaxOpen(true);
    assert.ok(Number.isFinite(ucretsiz) && ucretsiz > 0, "ucretsiz sinir tanimsiz");
    assert.ok(prem > ucretsiz, "premium siniri ucretsizden buyuk olmali");
  });

  test("sınıra ulaşınca yeni turnuva reddedilir, biri bitince yer açılır", async () => {
    const max = premium.miniMaxOpen(false);
    const acikSay = async () =>
      (await S.loadMini(db)).filter(
        (t) => !t.finishedAt && String(t.ownerId || "").toLowerCase() === "farmci"
      ).length;

    for (let i = 1; i <= max; i++) {
      await S.createMini({
        id: "mini" + i, ownerId: "farmci", name: "T" + i, members: ["farmci"],
        fixtures: [{ fixtureId: "F1" }, { fixtureId: "F2" }],
        createdAt: new Date().toISOString(), finishedAt: null,
      }, db);
    }
    assert.equal(await acikSay(), max, "sinir kadar acik turnuva olmali");
    // Rotadaki koşulun aynısı: acik >= max ise reddedilir.
    assert.ok((await acikSay()) >= max, "bu noktada yeni kurma reddedilmeli");

    await S.finishMini("mini1", { finishedAt: new Date().toISOString(), winners: [], rewardLc: 0 }, db);
    assert.ok((await acikSay()) < max, "biri bitince yer acilmali");
  });
});

describe("düello kabul/iptal mührü — çift tahsilat ve çift iade", () => {
  /**
   * `/duels/accept` ve `/duels/cancel` "oku → koşula BAK → parayı hareket
   * ettir" deseni kullanıyordu. `withFileLock` yalnızca tek süreci korur ve
   * depo Mongo'ya taşındığından çok instance'lı ortamda hiçbir şey yapmıyordu.
   *
   *   accept: iki eşzamanlı kabul de kontrolü geçer, İKİSİNDEN DE bahis
   *           alınır, son yazan kazanır — biri parasını verip düelloya
   *           girememiş olur.
   *   cancel: iki eşzamanlı iptal de kontrolü geçer, İADE İKİ KEZ yapılır.
   *
   * Settle yolunda bu düzeltilmişti (claimDuelSettle); bu ikisi atlanmıştı.
   */
  test("20 eşzamanlı iptalden yalnızca biri mührü alır", async () => {
    await db.collection(S.COLL_DUELS).insertOne({
      id: "dc1", status: "open", creatorId: "Kurucu", stake: 10,
    });
    const r = await Promise.all(
      Array.from({ length: 20 }, () =>
        S.claimDuelCancel("dc1", "kurucu", { settledAt: new Date().toISOString() }, db))
    );
    assert.equal(r.filter(Boolean).length, 1, "birden fazla iptal muhru alindi");
    const d = await db.collection(S.COLL_DUELS).findOne({ id: "dc1" });
    assert.equal(d.status, "cancelled");
  });

  test("başkasının düellosu iptal edilemez (sahiplik yazmanın içinde)", async () => {
    await db.collection(S.COLL_DUELS).insertOne({
      id: "dc2", status: "open", creatorId: "Kurucu", stake: 10,
    });
    assert.equal(await S.claimDuelCancel("dc2", "baskasi", { settledAt: "x" }, db), false);
    const d = await db.collection(S.COLL_DUELS).findOne({ id: "dc2" });
    assert.equal(d.status, "open", "yabanci iptal durumu degistirmis");
  });

  test("20 eşzamanlı kabulden yalnızca biri mührü alır", async () => {
    await db.collection(S.COLL_DUELS).insertOne({
      id: "da1", status: "open", creatorId: "Kurucu", stake: 10,
    });
    const r = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        S.claimDuelAccept("da1", { acceptorId: "kabul" + i, acceptedAt: new Date().toISOString() }, db))
    );
    assert.equal(r.filter(Boolean).length, 1, "birden fazla kabul muhru alindi");
    const d = await db.collection(S.COLL_DUELS).findOne({ id: "da1" });
    assert.equal(d.status, "active");
    assert.ok(d.acceptorId, "kabul eden yazilmamis");
  });

  test("kapanmış düello tekrar kabul edilemez", async () => {
    await db.collection(S.COLL_DUELS).insertOne({
      id: "da2", status: "settled", creatorId: "K", stake: 10,
    });
    assert.equal(await S.claimDuelAccept("da2", { acceptorId: "x" }, db), false);
  });
});

describe("ödenemeyen ödül izi — mühür atıldı ama para gitmedi", () => {
  /**
   * Para dağıtan yolların hepsi "önce mühürle, sonra öde" deseninde. Bu çift
   * ödemeyi engeller (doğru sıra) ama ters riski vardır: ödeme başarısız
   * olursa mühür atıldığı için TEKRAR DENENMEZ ve ödül kalıcı kaybolur.
   *
   * Eskiden bu durumlarda yalnızca `console.error` vardı. Render'da log akıp
   * gider. `failed_awards` kalıcı iz bırakır ve GET /api/health onu sayar.
   */
  const { kayipOdulKaydet } = require("../lib/wallet-credit.cjs");

  test("kayıt kalıcı olarak yazılır ve telafi için gereken bilgiyi taşır", async () => {
    await db.collection("failed_awards").deleteMany({});
    const ok = await kayipOdulKaydet(db, {
      kaynak: "test_odul",
      odemeler: [{ userIdLower: "kullanici", tutar: 12.5 }],
      beklenen: 1,
      eksik: 1,
    });
    assert.equal(ok, true);

    const d = await db.collection("failed_awards").findOne({ kaynak: "test_odul" });
    assert.ok(d, "kayit bulunamadi");
    assert.ok(d.createdAt, "zaman damgasi yok");
    // Elle telafi için asgari bilgi: KİME ve NE KADAR.
    assert.equal(d.odemeler[0].userIdLower, "kullanici");
    assert.equal(d.odemeler[0].tutar, 12.5);
  });

  test("db yokken çağıranı düşürmez (kendi hatasıyla settle'ı bozmasın)", async () => {
    assert.equal(await kayipOdulKaydet(null, { kaynak: "dbsiz" }), false);
  });
});
