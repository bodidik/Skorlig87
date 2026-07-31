"use strict";

/**
 * KUPON — ERTELENEN MAÇ KUPONU KİLİTLEMEZ.
 *
 * ⚠️ BULUNAN HATA: `sonuclariTopla` kupondaki HER maçın sonucunu şart
 * koşuyordu. Tek maç ertelenirse kupon SONSUZA KADAR askıda kalıyordu:
 * oyuncunun giriş bedeli yanmış, ödülü ve puanı hiç gelmiyordu.
 *
 * Kuramsal değildi: futbolda erteleme rutin (hava, kupa takvimi) ve skor
 * kaynakları fiilen tek şelaleye düşmüş durumda — bir sonuç hiç gelmeyebilir
 * de. Sezon boyunca bu neredeyse kesindi.
 *
 * KURAL: bekleme süresi (son maçtan itibaren) dolduktan sonra kupon ÇÖZÜLEN
 * maçlar üzerinden puanlanır; çözülen sayısı eşiğin altındaysa puan yazılmaz
 * ve giriş bedeli İADE edilir.
 */

const os = require("os");
const nodePath = require("path");
process.env.SKORLIG_DATA_DIR = nodePath.join(os.tmpdir(), "skorlig-kupon-settle-test");

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const Store = require("../lib/kupon-store.cjs");
const Settle = require("../lib/kupon-settle.cjs");
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

/** 8 maçlık ülke kuponu; tüm maçlar `saatOnce` saat önce başlamış. */
async function kuponKur(saatOnce = 72) {
  const ids = Array.from({ length: 8 }, (_, i) => `mac${i + 1}`);
  const kupon = {
    id: "kp_test",
    tur: "ulke",
    ulke: "Türkiye",
    haftaKey: "2026-W31",
    fixtureIds: ids,
    maclar: ids.map((id) => ({
      fixtureId: id, home: "A", away: "B",
      kickoffISO: GECMIS(saatOnce),
    })),
    girisBedeli: 10,
    ilkKickoffISO: GECMIS(saatOnce),
    kilitISO: GECMIS(saatOnce),
    durum: "locked",
    olusturulduAt: GECMIS(saatOnce + 24),
  };
  await Store.kuponOlustur(kupon, db);
  return kupon;
}

/** `adet` maçın sonucunu yaz (ev sahibi kazanır → "H"). */
async function sonuclariYaz(adet) {
  for (let i = 1; i <= adet; i++) {
    await db.collection("match_results").insertOne({
      fixtureId: `mac${i}`,
      finalScore: { home: 2, away: 0 },
      computedAt: new Date().toISOString(),
    });
  }
}

async function katil(userId, dogruSayisi) {
  const tahminler = {};
  for (let i = 1; i <= 8; i++) tahminler[`mac${i}`] = i <= dogruSayisi ? "H" : "A";
  await Store.katilimEkle({ kuponId: "kp_test", userId, tahminler, katildiAt: GECMIS(80) }, db);
}

const bakiye = async (uid) =>
  (await db.collection(COLL_USERS).findOne({ userIdLower: uid.toLowerCase() }))?.balance ?? 0;

beforeEach(async () => {
  for (const c of ["kuponlar", "kupon_katilim", "match_results", "season_totals", COLL_USERS]) {
    await db.collection(c).deleteMany({});
  }
});

/* ── Değişmeyen davranış ─────────────────────────────────────────────────── */

describe("tüm maçlar bittiğinde", () => {
  test("normal sonuçlanır, 8 üzerinden puanlanır", async () => {
    const k = await kuponKur(72);
    await katil("ali", 8);
    await sonuclariYaz(8);

    const r = await Settle.kuponuSonuclandir(k, db);
    assert.equal(r.ok, true);
    assert.equal(r.iade, undefined, "tam kupon iade edilmemeli");

    const kat = await Store.katilimGetir("kp_test", "ali", db);
    assert.equal(kat.dogru, 8);
    assert.equal(kat.toplam, 8);
    assert.ok(kat.odulLc > 0, "8/8 odul almali");
  });
});

/* ── Bulunan hata ────────────────────────────────────────────────────────── */

describe("bir maç ertelendiğinde", () => {
  test("bekleme süresi dolmadan sonuçlanmaz", async () => {
    // Maçlar 2 saat önce başladı, bekleme 48 saat → henüz erken.
    const k = await kuponKur(2);
    await katil("ali", 8);
    await sonuclariYaz(7);

    const r = await Settle.kuponuSonuclandir(k, db);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "MACLAR_BITMEDI");
    assert.equal(r.eksik, 1);
  });

  test("bekleme dolunca ÇÖZÜLEN maçlar üzerinden puanlanır", async () => {
    // ⚠️ ESKİDEN BU KUPON SONSUZA KADAR ASKIDA KALIRDI.
    const k = await kuponKur(72);        // 72 saat önce > 48 saatlik bekleme
    await katil("ali", 8);
    await sonuclariYaz(7);               // 8. maç ertelendi

    const r = await Settle.kuponuSonuclandir(k, db);
    assert.equal(r.ok, true, "erteleme kuponu hala kilitliyor");

    const kat = await Store.katilimGetir("kp_test", "ali", db);
    assert.equal(kat.toplam, 7, "puanlama tabani cozulen mac sayisi olmali");
    assert.equal(kat.dogru, 7);
    assert.ok(kat.odulLc > 0, "7/7 odul almali");
  });

  test("çözülmeyen maç oyuncunun aleyhine sayılmaz", async () => {
    // 7 maçın 7'sini bilen oyuncu, 8. maç ertelendiği için "7/8" değil "7/7"
    // sayılmalı — yoksa hiç oynanmamış maçtan ceza yemiş olurdu.
    const k = await kuponKur(72);
    await katil("ali", 7);
    await sonuclariYaz(7);

    await Settle.kuponuSonuclandir(k, db);
    const kat = await Store.katilimGetir("kp_test", "ali", db);
    assert.equal(kat.ceza, 0, "cozulmeyen mac ceza uretmis");
    assert.equal(kat.bonus > 0, true, "7/7 tam kupon bonusu almali");
  });

  test("mühürde kısmi olduğu kayıtlı kalır", async () => {
    const k = await kuponKur(72);
    await katil("ali", 8);
    await sonuclariYaz(7);
    await Settle.kuponuSonuclandir(k, db);

    const doc = await db.collection("kuponlar").findOne({ id: "kp_test" });
    assert.equal(doc.kismi, true);
    assert.equal(doc.cozulen, 7);
    assert.equal(doc.toplamMac, 8);
  });
});

/* ── Çok fazla maç çözülmezse ────────────────────────────────────────────── */

describe("çözülen maç eşiğin altındaysa", () => {
  test("puan yazılmaz, giriş bedeli iade edilir", async () => {
    const k = await kuponKur(72);
    await katil("ali", 8);
    await sonuclariYaz(3);               // 8'de 3 < ceil(8*0.5)=4

    const oncekiBakiye = await bakiye("ali");
    const r = await Settle.kuponuSonuclandir(k, db);
    assert.equal(r.ok, true);
    assert.equal(r.iade, true);
    assert.equal(await bakiye("ali") - oncekiBakiye, 10, "giris bedeli iade edilmemis");

    const toplamlar = await db.collection("season_totals").findOne({ userIdLower: "ali" });
    assert.equal(toplamlar, null, "yarim veriyle sezon toplamina puan yazilmis");
  });

  test("iade İKİ KEZ yapılmaz", async () => {
    const k = await kuponKur(72);
    await katil("ali", 8);
    await sonuclariYaz(3);

    await Settle.kuponuSonuclandir(k, db);
    const araBakiye = await bakiye("ali");

    // Mühür atıldı; ikinci çağrı taze belgeyi okur ve reddetmeli.
    const taze = await db.collection("kuponlar").findOne({ id: "kp_test" });
    const r2 = await Settle.kuponuSonuclandir(taze, db);
    assert.equal(r2.ok, false);
    assert.equal(await bakiye("ali"), araBakiye, "cift iade yapilmis");
  });
});

/* ── Fail-closed ─────────────────────────────────────────────────────────── */

describe("başlama saati okunamıyorsa", () => {
  test("bekleme süresi hesaplanamaz → sonuçlandırmaz", async () => {
    // Ters varsayım (bilinmiyorsa öde) veri bozukken erken ödeme yapardı.
    const k = await kuponKur(72);
    await db.collection("kuponlar").updateOne(
      { id: "kp_test" },
      { $set: { maclar: (k.maclar || []).map((m) => ({ ...m, kickoffISO: "bozuk-tarih" })) } }
    );
    const taze = await db.collection("kuponlar").findOne({ id: "kp_test" });
    await katil("ali", 8);
    await sonuclariYaz(7);

    const r = await Settle.kuponuSonuclandir(taze, db);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "MACLAR_BITMEDI");
  });
});
