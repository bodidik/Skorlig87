"use strict";

/**
 * GÜNLÜK HATIRLATMA CÜZDANI MONGO'DAN OKUR.
 *
 * ⚠️ BULUNAN: `services/push-scheduler.cjs` hatırlatma listesini YALNIZCA
 * `data/lc-wallet.json`dan okuyordu:
 *
 *     const wallet = await readJson(WALLET, null);
 *     const users = Array.isArray(wallet?.users) ? wallet.users : [];
 *
 * Bakiye Mongo'ya taşındı ve `SKORLIG_WALLET_FILE_MIRROR=0` iken o dosya HİÇ
 * YAZILMIYOR (üstelik Render'ın diski kalıcı da değil). Sonuç: liste boş,
 * hatırlatma kimseye gitmiyor ve hiçbir yerde hata görünmüyor — özellik
 * sessizce ölü.
 *
 * ÖLÇÜLDÜ (bellek-içi Mongo, ayna kapalı, AYNI koşum düzeni):
 *     eski (dosyadan okuma) → hedef 0
 *     yeni (Mongo birincil) → hedef 20
 *
 * ⚠️ İLK ÖLÇÜMÜM GEÇERSİZDİ: `dbAl()` paylaşılan bağlantıyı istiyor ve testteki
 * bellek-içi Mongo'yu tanımıyordu, yani düzeltmeden SONRA da 0 çıktı. Koşum
 * düzenini onarıp eski davranışı da aynı düzende ölçtüm — ancak o zaman
 * 0 → 20 farkı bulgunun kendisine ait oldu.
 *
 * Aynı sınıf bu oturumda ikinci kez: ana ekranın hızlı-oyun bölümü de artık
 * beslenmeyen bir kaynaktan okuduğu için boş kalıyordu. Mühür tarafı (`dbAl`)
 * zaten Mongo kullanıyordu; okuma tarafı geçirilmeyi unutmuştu.
 */

const os = require("os");
const nodePath = require("path");
const fs = require("fs");

const TMP = nodePath.join(os.tmpdir(), "skorlig-gunluk-hatirlatma-test");
process.env.SKORLIG_DATA_DIR = TMP;
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
process.env.SKORLIG_WALLET_FILE_MIRROR = "0";   // üretimdeki hâl
process.env.SKORLIG_PUSH = "0";                 // gerçek gönderim yok
process.env.SKORLIG_TZ = "Europe/Istanbul";     // dayKey/todayKey icin sabit

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const KISI = 20;
let mongod = null, client = null, db = null, Sch = null, DAILY_HOUR = 19;

before(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const { MongoClient } = require("mongodb");
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  db = client.db("test");

  /* ⚠️ PAYLAŞILAN BAĞLANTIYI TANIT. `dbAl()` `lib/mongo.cjs` getDb()
   * çağırıyor; tanıtmazsak servis Mongo'yu göremez ve test düzeltmeyi DEĞİL
   * kendi kurulum hatasını ölçer (ilk denemede tam olarak bu oldu). */
  const mYol = require.resolve("../lib/mongo.cjs");
  require("../lib/mongo.cjs");
  require.cache[mYol].exports = {
    ...require.cache[mYol].exports,
    getDb: async () => db,
  };

  Sch = require("../services/push-scheduler.cjs");

  // Saat sabiti kaynaktan okunuyor — uydurmak "saat-dışı" ile ölü test verir.
  const src = fs.readFileSync(nodePath.join(__dirname, "..", "services", "push-scheduler.cjs"), "utf8");
  const m = /SKORLIG_PUSH_DAILY_HOUR \?\? (\d+)/.exec(src);
  DAILY_HOUR = Number(process.env.SKORLIG_PUSH_DAILY_HOUR ?? (m ? m[1] : 19));
});

after(async () => {
  if (client) await client.close();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  await db.collection("lc_wallet_users").deleteMany({});
  await db.collection("push_sent").deleteMany({}).catch(() => {});
  try { fs.rmSync(nodePath.join(TMP, "push-sent.json")); } catch { /* yok */ }
  try { fs.rmSync(nodePath.join(TMP, "lc-wallet.json")); } catch { /* yok */ }
});

/** Günlük hakkını almamış, aktif kullanıcılar. */
async function kullanicilariKur(n = KISI) {
  const dun = new Date(Date.now() - 24 * 3600_000).toISOString();
  await db.collection("lc_wallet_users").insertMany(
    Array.from({ length: n }, (_, i) => ({
      userId: `oyuncu-${i}`, userIdLower: `oyuncu-${i}`,
      balance: 5, totalEarned: 0, totalSpent: 0,
      lastDailyAt: dun, updatedAt: new Date().toISOString(), createdAt: dun,
    }))
  );
}

const saatte = () => {
  const d = new Date();
  d.setHours(DAILY_HOUR, 0, 0, 0);
  return d;
};

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("dosya aynası gerçekten kapalı", () => {
    // Açık olsaydı test Mongo yolunu değil dosya yolunu ölçerdi.
    assert.equal(process.env.SKORLIG_WALLET_FILE_MIRROR, "0");
    assert.ok(!fs.existsSync(nodePath.join(TMP, "lc-wallet.json")), "cuzdan dosyasi var");
  });

  test("saat sabiti doğru okundu (saat-dışı dönmüyor)", async () => {
    await kullanicilariKur(1);
    const r = await Sch.runDailyReminder(saatte());
    assert.notEqual(r.skipped, "saat-dışı", `DAILY_HOUR yanlis okundu (${DAILY_HOUR})`);
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("hatırlatma hedefi", () => {
  test("Mongo'daki kullanıcılara ulaşıyor", async () => {
    await kullanicilariKur();
    const r = await Sch.runDailyReminder(saatte());
    assert.equal(
      r.targets, KISI,
      `Mongo'da ${KISI} uygun kullanici varken hedef ${r.targets} — ` +
      "liste artik beslenmeyen dosyadan okunuyor olabilir"
    );
  });

  test("bugün hakkını ALMIŞ kullanıcı hedeflenmiyor", async () => {
    /* ⚠️ 'bugun' zamanlayicinin BAKACAGI ana denk gelmeli — bagimsiz `new Date`
     * degil. Eskiden `new Date().toISOString()` yaziliyor ve UTC gununden
     * dilimleniyordu; zamanlayici `dayKey`e (Istanbul) gecince iki taraf
     * Istanbul 00:00-02:59 penceresinde bir gun ayrisiyor ve `almis` kullanici
     * hedeflenir olacakti. Damgayi tam `saatte()` aninda uret ki zamanlayicinin
     * `today` hesabiyla ayni Istanbul gununu goruyoruz. */
    const su = saatte();
    const bugun = su.toISOString();
    const dun = new Date(su.getTime() - 24 * 3600_000).toISOString();
    await db.collection("lc_wallet_users").insertMany([
      { userId: "almis", userIdLower: "almis", lastDailyAt: bugun, updatedAt: bugun, createdAt: bugun },
      { userId: "almamis", userIdLower: "almamis",
        lastDailyAt: dun, updatedAt: bugun, createdAt: bugun },
    ]);
    const r = await Sch.runDailyReminder(su);
    assert.equal(r.targets, 1, "bugun hakkini almis kullaniciya da hatirlatma gidiyor");
  });

  test("uzun süredir uğramayan kullanıcı hedeflenmiyor (spam olmasın)", async () => {
    const cokEski = new Date(Date.now() - 60 * 24 * 3600_000).toISOString();
    await db.collection("lc_wallet_users").insertOne({
      userId: "kayip", userIdLower: "kayip",
      lastDailyAt: cokEski, updatedAt: cokEski, createdAt: cokEski,
    });
    const r = await Sch.runDailyReminder(saatte());
    assert.ok(!r.targets, `60 gundur ugramayan kullaniciya hatirlatma gidiyor (${r.targets})`);
  });

  test("aynı gün İKİNCİ çağrı gönderim yapmıyor (mühür)", async () => {
    await kullanicilariKur();
    const ilk = await Sch.runDailyReminder(saatte());
    assert.equal(ilk.targets, KISI);
    const ikinci = await Sch.runDailyReminder(saatte());
    assert.equal(ikinci.skipped, "bugün-gönderildi", "ayni gun ikinci kez gonderiliyor");
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: cüzdan okuması Mongo birincil, dosya yalnızca yedek", () => {
  const src = fs.readFileSync(nodePath.join(__dirname, "..", "services", "push-scheduler.cjs"), "utf8")
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");

  assert.ok(
    /cuzdanKullanicilari\s*\(/.test(src),
    "cuzdan okumasi ortak yardimciya tasinmamis"
  );
  const mongo = src.indexOf('collection("lc_wallet_users")');
  const dosya = src.indexOf("readJson(WALLET");
  assert.ok(mongo > 0, "Mongo'dan hic okunmuyor");
  assert.ok(dosya > 0, "dosya yedegi kaldirilmis — Mongo erisilemezken hatirlatma tamamen durur");
  assert.ok(mongo < dosya, "dosya Mongo'dan ONCE okunuyor — ayna kapaliyken liste bos kalir");
});
