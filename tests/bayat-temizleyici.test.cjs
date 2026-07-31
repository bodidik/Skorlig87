"use strict";

/**
 * BAYAT MAÇ — sonucu gelmeyen maçta kilitli kalan para iade edilmeli.
 *
 * ⚠️ BULUNAN HATA: bu oyunda paranın tamamı bir maçın sonucuna bağlı ve sonuç
 * gelmezse KENDİLİĞİNDEN ÇÖZÜLMÜYORDU:
 *
 *   düello  — kabul edilmiş düello yalnızca `status: "open"` iken iptal
 *             edilebiliyor; kabulden sonra iki tarafın bahsi de kalıcı kilitli.
 *   havuz   — `settlePool` yalnızca settle2 sonuç getirince çağrılıyor.
 *   mini    — `settledCount < fixtureCount` iken turnuva hiç bitmiyor.
 *
 * Aynı delik kuponda da vardı (ayrıca düzeltildi). Erteleme nadir değil ve
 * skor kaynakları fiilen tek şelaleye düşmüş durumda — maç oynansa bile
 * sonucu hiç gelmeyebiliyor.
 */

const os = require("os");
const nodePath = require("path");
process.env.SKORLIG_DATA_DIR = nodePath.join(os.tmpdir(), "skorlig-bayat-test");

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const Temizleyici = require("../services/bayat-temizleyici.cjs");
const { bayatMi } = require("../lib/bayat-mac.cjs");
const { DURUM, PARA_TUTAN } = require("../lib/duel-durum.cjs");
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

const SAAT = 3600 * 1000;
const GECMIS = (saat) => new Date(Date.now() - saat * SAAT).toISOString();

const bakiye = async (uid) =>
  (await db.collection(COLL_USERS).findOne({ userIdLower: uid.toLowerCase() }))?.balance ?? 0;

beforeEach(async () => {
  for (const c of ["duels", "pools", "pool_bets", "fixtures", "match_results", COLL_USERS]) {
    await db.collection(c).deleteMany({});
  }
});

/* ── Ölçüt ───────────────────────────────────────────────────────────────── */

describe("bayat ölçütü", () => {
  test("bekleme dolmadan bayat sayılmaz", async () => {
    const r = await bayatMi({ fixtureId: "m1", kickoffISO: GECMIS(2), db });
    assert.equal(r.bayat, false);
    assert.equal(r.sebep, "BEKLENIYOR");
  });

  test("sonucu gelmiş maç bayat sayılmaz", async () => {
    await db.collection("match_results").insertOne({
      fixtureId: "m1", finalScore: { home: 1, away: 0 },
    });
    const r = await bayatMi({ fixtureId: "m1", kickoffISO: GECMIS(72), db });
    assert.equal(r.bayat, false);
    assert.equal(r.sebep, "SONUC_VAR");
  });

  test("başlama saati okunamıyorsa bayat SAYILMAZ (fail-closed)", async () => {
    // Ters varsayım, verisi bozuk maçta parayı erken iade edip gerçek sonuç
    // gelince ikinci ödemeye yol açardı.
    for (const ko of [null, "", "bozuk-tarih", undefined]) {
      const r = await bayatMi({ fixtureId: "m1", kickoffISO: ko, db });
      assert.equal(r.bayat, false, `kickoff=${ko} bayat sayilmis`);
    }
  });

  test("bekleme dolmuş + sonuç yok → bayat", async () => {
    const r = await bayatMi({ fixtureId: "m1", kickoffISO: GECMIS(72), db });
    assert.equal(r.bayat, true);
    assert.equal(r.sebep, "SONUC_GELMEDI");
  });
});

/* ── Düellolar ───────────────────────────────────────────────────────────── */

describe("düello iadesi", () => {
  const duelloEkle = (id, status, saatOnce, extra = {}) =>
    db.collection("duels").insertOne({
      id, fixtureId: "m1", stake: 25, status,
      creatorId: "ali", acceptorId: status === DURUM.AKTIF ? "veli" : null,
      kickoffISO: GECMIS(saatOnce), ...extra,
    });

  test("kabul edilmiş düelloda İKİ tarafa da iade", async () => {
    // ⚠️ Bu para eskiden kalıcı kilitliydi: kabul edilmiş düello iptal
    // edilemiyor, sonuç da hiç gelmiyor.
    await duelloEkle("d1", DURUM.AKTIF, 72);
    const r = await Temizleyici._duellolariTemizle(db);

    assert.equal(r.iptal, 1);
    assert.equal(await bakiye("ali"), 25);
    assert.equal(await bakiye("veli"), 25);
    assert.equal(r.iadeLc, 50);
  });

  test("açık düelloda yalnızca kurucuya iade", async () => {
    await duelloEkle("d2", DURUM.ACIK, 72);
    await Temizleyici._duellolariTemizle(db);

    assert.equal(await bakiye("ali"), 25);
    assert.equal(await bakiye("veli"), 0, "kabul edilmemis duelloda karsi tarafa odeme yapilmis");
  });

  test("bekleme dolmadan dokunulmaz", async () => {
    await duelloEkle("d3", DURUM.AKTIF, 2);
    const r = await Temizleyici._duellolariTemizle(db);
    assert.equal(r.iptal, 0);
    assert.equal(await bakiye("ali"), 0);
  });

  test("sonucu gelmiş maçta dokunulmaz", async () => {
    await db.collection("match_results").insertOne({
      fixtureId: "m1", finalScore: { home: 2, away: 1 },
    });
    await duelloEkle("d4", DURUM.AKTIF, 72);
    const r = await Temizleyici._duellolariTemizle(db);
    assert.equal(r.iptal, 0);
    assert.equal(await bakiye("ali"), 0, "sonucu olan macta iade yapilmis");
  });

  test("ardışık ikinci tur tekrar iade etmez", async () => {
    await duelloEkle("d5", DURUM.AKTIF, 72);
    await Temizleyici._duellolariTemizle(db);
    const araBakiye = await bakiye("ali");

    const r2 = await Temizleyici._duellolariTemizle(db);
    assert.equal(r2.iptal, 0);
    assert.equal(await bakiye("ali"), araBakiye);
  });

  test("EŞZAMANLI iki tur çift iade yapmaz", async () => {
    /**
     * ⚠️ BU TESTİN ARDIŞIK HALİ MÜHÜRÜ HİÇ SINAMIYORDU. İlk turdan sonra
     * düello artık "voided"; ikinci turun sorgusu (`status: open|active`)
     * onu zaten bulmuyor. Yani mühürü kaldırınca bile test geçiyordu —
     * negatif kontrolle yakalandı.
     *
     * Mühürün koruduğu gerçek durum bu: iki tur AYNI ANDA çalışır, ikisi de
     * listeyi "accepted" görür, ikisi de iade etmeye kalkar. Koşulun yazmanın
     * İÇİNDE olması yalnızca birinin geçmesini sağlar.
     */
    await duelloEkle("d7", DURUM.AKTIF, 72);

    const [a, b] = await Promise.all([
      Temizleyici._duellolariTemizle(db),
      Temizleyici._duellolariTemizle(db),
    ]);

    assert.equal(a.iptal + b.iptal, 1, "iki tur da muhuru almis");
    assert.equal(await bakiye("ali"), 25, "kurucuya cift iade yapilmis");
    assert.equal(await bakiye("veli"), 25, "kabul edene cift iade yapilmis");
  });

  test("iptal edilen düello 'voided' olarak işaretlenir", async () => {
    await duelloEkle("d6", DURUM.AKTIF, 72);
    await Temizleyici._duellolariTemizle(db);
    const d = await db.collection("duels").findOne({ id: "d6" });
    assert.equal(d.status, DURUM.GECERSIZ);
    assert.equal(d.voidReason, "SONUC_GELMEDI");
    assert.ok(d.settledAt, "settledAt yazilmamis — gec gelen sonuc tekrar odeyebilir");
  });
});

/* ── Havuzlar ────────────────────────────────────────────────────────────── */

describe("havuz iadesi", () => {
  async function havuzKur(saatOnce) {
    await db.collection("fixtures").insertOne({
      fixtureId: "m1", status: "NS", kickoffISO: GECMIS(saatOnce),
    });
    await db.collection("pools").insertOne({ fixtureId: "m1", settledAt: null });
    await db.collection("pool_bets").insertMany([
      { fixtureId: "m1", userId: "ali", userIdLower: "ali", side: "H", amount: 30 },
      { fixtureId: "m1", userId: "veli", userIdLower: "veli", side: "A", amount: 20 },
    ]);
  }

  test("bayat maçta tüm bahisler iade edilir", async () => {
    await havuzKur(72);
    const r = await Temizleyici._havuzlariTemizle(db);

    assert.equal(r.iptal, 1);
    assert.equal(await bakiye("ali"), 30);
    assert.equal(await bakiye("veli"), 20);
  });

  test("bekleme dolmadan dokunulmaz", async () => {
    await havuzKur(2);
    const r = await Temizleyici._havuzlariTemizle(db);
    assert.equal(r.iptal, 0);
    assert.equal(await bakiye("ali"), 0);
  });

  test("ardışık ikinci tur tekrar iade etmez", async () => {
    await havuzKur(72);
    await Temizleyici._havuzlariTemizle(db);
    const ara = await bakiye("ali");

    const r2 = await Temizleyici._havuzlariTemizle(db);
    assert.equal(r2.iptal, 0);
    assert.equal(await bakiye("ali"), ara);
  });

  test("EŞZAMANLI iki tur çift iade yapmaz", async () => {
    // Ardışık hali mühürü sinamiyor (ikinci tur havuzu zaten bulmuyor).
    await havuzKur(72);

    const [a, b] = await Promise.all([
      Temizleyici._havuzlariTemizle(db),
      Temizleyici._havuzlariTemizle(db),
    ]);

    assert.equal(a.iptal + b.iptal, 1, "iki tur da muhuru almis");
    assert.equal(await bakiye("ali"), 30, "cift iade yapilmis");
    assert.equal(await bakiye("veli"), 20, "cift iade yapilmis");
  });

  test("havuz mühürlenir — geç gelen sonuç tekrar ödeyemez", async () => {
    await havuzKur(72);
    await Temizleyici._havuzlariTemizle(db);

    const h = await db.collection("pools").findOne({ fixtureId: "m1" });
    assert.ok(h.settledAt, "settledAt yazilmamis");
    assert.equal(h.iadeEdildi, true);

    // settle2 sonradan sonuc getirse settlePool "ALREADY_SETTLED" demeli
    const PoolStore = require("../lib/pool-store.cjs");
    const s = await PoolStore.settlePool("m1", "H", db);
    assert.equal(s.ok, false);
    assert.equal(s.reason, "ALREADY_SETTLED");
  });

  test("fikstür saati bilinmiyorsa dokunulmaz", async () => {
    await db.collection("pools").insertOne({ fixtureId: "bilinmeyen", settledAt: null });
    await db.collection("pool_bets").insertOne({
      fixtureId: "bilinmeyen", userId: "ali", userIdLower: "ali", side: "H", amount: 30,
    });
    const r = await Temizleyici._havuzlariTemizle(db);
    assert.equal(r.iptal, 0);
    assert.equal(await bakiye("ali"), 0);
  });
});

/* ── Durum adı kayması ───────────────────────────────────────────────────── */

describe("düello durum adları", () => {
  /**
   * ⚠️ BU BÖLÜM GERÇEK BİR HATADAN DOĞDU. Temizleyici ilk yazıldığında para
   * tutan düelloları `["open", "accepted"]` diye sorguluyordu. Kabul edilmiş
   * düellonun durumu aslında **"active"** — yani temizleyici tam da kurtarmak
   * için yazıldığı parayı HİÇ GÖRMÜYORDU.
   *
   * İlk testler bunu yakalamadı çünkü test verisi de `"accepted"` diye
   * tohumlanmıştı: test, sistemin davranışını değil YAZARIN VARSAYIMINI
   * doğruladı. O yüzden aşağıdaki test sabit uydurmuyor — gerçek kabul yolunu
   * çalıştırıp sonucun temizleyicinin taradığı listede olduğunu doğruluyor.
   */
  const SocialStore = require("../lib/social-store.cjs");

  test("gerçek kabul yolu, temizleyicinin taradığı bir durum üretir", async () => {
    await db.collection("duels").insertOne({
      id: "dx", fixtureId: "m1", stake: 10, status: DURUM.ACIK,
      creatorId: "ali", acceptorId: null, kickoffISO: GECMIS(72),
    });

    const oldu = await SocialStore.claimDuelAccept(
      "dx", { acceptorId: "veli", acceptorName: "Veli", acceptedAt: new Date().toISOString() }, db
    );
    assert.equal(oldu, true, "kabul yolu calismadi");

    const d = await db.collection("duels").findOne({ id: "dx" });
    assert.ok(
      PARA_TUTAN.includes(d.status),
      `kabul sonrasi durum "${d.status}" temizleyicinin taradigi listede yok: ${PARA_TUTAN.join(", ")}`
    );
  });

  test("kabul edilmiş düello temizleyici tarafından gerçekten bulunur", async () => {
    // Yukarıdakinin uçtan uca hâli: durum adı kayarsa bu test para iadesinin
    // hiç yapılmadığını gösterir.
    await db.collection("duels").insertOne({
      id: "dy", fixtureId: "m1", stake: 10, status: DURUM.ACIK,
      creatorId: "ali", acceptorId: null, kickoffISO: GECMIS(72),
    });
    await SocialStore.claimDuelAccept(
      "dy", { acceptorId: "veli", acceptedAt: new Date().toISOString() }, db
    );

    const r = await Temizleyici._duellolariTemizle(db);
    assert.equal(r.iptal, 1, "kabul edilmis duello temizleyici tarafindan bulunamadi");
    assert.equal(await bakiye("ali"), 10);
    assert.equal(await bakiye("veli"), 10, "kabul edene iade yapilmamis");
  });
});
