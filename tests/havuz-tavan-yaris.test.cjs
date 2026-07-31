"use strict";

/**
 * HAVUZ BAHİS TAVANI EŞZAMANLI İSTEKTE DE TUTAR.
 *
 * ⚠️ BULUNAN: mevcut bahis OKUNUYOR, tavan hesaplanıyor, sonra LC harcanıp
 * bahis `$inc` ile ARTIRILIYOR — arada kilit yoktu. Aynı kullanıcının
 * eşzamanlı istekleri hepsi aynı "mevcut"u görüp hepsi geçiyordu.
 *
 * ÖLÇÜLDÜ (bellek-içi Mongo, tavan 20, 8 istek × 20 LC, 3 deneme):
 *     sıralı    → 1 kabul, bahis toplamı  20        (tavan tutuyor)
 *     eşzamanlı → 6-8 kabul, toplam 120-160         (tavanın 6-8 katı)
 *     düzeltme sonrası eşzamanlı → 1 kabul, toplam 20
 *
 * ⚠️ SIRALI TABAN ŞARTTI: tavan havuzla birlikte büyüyor (`betCap(pool)`), yani
 * "zaten büyüyor olabilir" ihtimalini elemeden eşzamanlı sonucu tek başına bir
 * şey kanıtlamazdı. Sıralıda 20'de kalıyor — fark eşzamanlılıktan.
 *
 * ⚠️ AYNI TURDA ÖLÇÜLEN ÜÇ KAPI TEMİZ ÇIKTI, hepsi burada kayıtlı olsun:
 *   • kupon katılım giriş bedeli → 8 eşzamanlı istek, 1 katılım, 1 kez ücret
 *   • mini turnuva üye tavanı    → 49 üye + 8 katılım = 50 (`$expr + $size`)
 *   • davet kodu maxUses         → 8 eşzamanlı, maxUses 3, tam 3 kabul
 */

const os = require("os");
const nodePath = require("path");
const fs = require("fs");

const TMP = nodePath.join(os.tmpdir(), "skorlig-havuz-tavan-test");
process.env.SKORLIG_DATA_DIR = TMP;
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const Pool = require("../lib/pool-store.cjs");

const FID = "htfx-1";
const UID = "havuz-oyuncu";
const OTEKI = "havuz-oyuncu-2";

let mongod = null, client = null, db = null;

before(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const { MongoClient } = require("mongodb");
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  db = client.db("test");

  await db.collection("fixtures").insertOne({
    fixtureId: FID, home: "Ev", away: "Dep",
    kickoffISO: new Date(Date.now() + 8 * 3600_000).toISOString(), status: "NS",
  });
});

after(async () => {
  if (client) await client.close();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  await db.collection(Pool.COLL_BETS).deleteMany({});
  await db.collection(Pool.COLL_POOLS).deleteMany({});
  await db.collection("lc_wallet_users").deleteMany({});
  await db.collection("lc_wallet_ledger").deleteMany({});
  for (const uid of [UID, OTEKI]) {
    await db.collection("lc_wallet_users").insertOne({
      userId: uid, userIdLower: uid, balance: 100000,
      totalEarned: 0, totalSpent: 0, createdAt: new Date().toISOString(),
    });
  }
});

const bahis = (uid, tutar, side = "H") =>
  Pool.placeBet({ fixtureId: FID, userId: uid, side, amount: tutar, isBot: false }, db);

const toplamBahis = async (uid) =>
  Number((await db.collection(Pool.COLL_BETS)
    .findOne({ fixtureId: FID, userIdLower: uid.toLowerCase() }))?.amount || 0);

const N = 8;

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("tek bahis kabul ediliyor", async () => {
    const r = await bahis(UID, Pool.CAP_FLOOR);
    assert.equal(r.ok, true, `bahis reddedildi: ${JSON.stringify(r)}`);
    assert.equal(await toplamBahis(UID), Pool.CAP_FLOOR);
  });

  test("tavan gerçekten sıfırdan büyük", () => {
    assert.ok(Pool.CAP_FLOOR > 0, "tavan tabani sifir — test bir sey olcmuyor");
  });
});

/* ── Sıralı taban ────────────────────────────────────────────────────────── */

describe("sıralı", () => {
  test(`${N} ardışık istek tavanı aşmaz`, async () => {
    let kabul = 0;
    for (let i = 0; i < N; i++) {
      if ((await bahis(UID, Pool.CAP_FLOOR)).ok) kabul++;
    }
    assert.equal(kabul, 1, "sirali istekte de tavan asiliyor — sorun eszamanlilik degil");
    assert.equal(await toplamBahis(UID), Pool.CAP_FLOOR);
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("eşzamanlı", () => {
  test(`${N} eşzamanlı istek tavanı AŞMAZ`, async () => {
    const r = await Promise.all(Array.from({ length: N }, () => bahis(UID, Pool.CAP_FLOOR)));
    const kabul = r.filter((x) => x.ok).length;
    const toplam = await toplamBahis(UID);

    assert.equal(
      toplam, Pool.CAP_FLOOR,
      `${N} eszamanli istek toplami ${toplam}'a cikardi (tavan ${Pool.CAP_FLOOR}) — ` +
      "tavan kontrolu ile yazma arasi kilitsiz"
    );
    assert.equal(kabul, 1, "birden fazla istek kabul edildi");
    assert.ok(
      r.filter((x) => !x.ok).every((x) => x.reason === "OVER_CAP"),
      `beklenmeyen ret sebepleri: ${JSON.stringify(r.filter((x) => !x.ok).map((x) => x.reason))}`
    );
  });

  test("reddedilen isteklerin LC'si düşmüyor", async () => {
    // Tavan reddi harcamadan ÖNCE olmalı; sonra olsaydı para gider, bahis olmazdı.
    await Promise.all(Array.from({ length: N }, () => bahis(UID, Pool.CAP_FLOOR)));
    const bak = Number((await db.collection("lc_wallet_users")
      .findOne({ userIdLower: UID }))?.balance || 0);
    assert.equal(100000 - bak, Pool.CAP_FLOOR, "kabul edilmeyen istekler de LC dusurmus");
  });

  test("başka oyuncunun bahsi engellenmiyor", async () => {
    /**
     * ⚠️ BU TEST TANECİKLİĞİ DOĞRULAMAZ — negatif kontrolde ortaya çıktı:
     * kilidi maç başına yapmak (tüm oyuncuları sıraya sokmak) bu testi
     * kırmıyor, çünkü sıraya girmek de sonunda başarıyla bitiyor.
     *
     * Taneciklik (maç, kullanıcı) seçimi bir DOĞRULUK değil VERİM kararı:
     * tavan kullanıcının KENDİ toplamına uygulanıyor, yani yarış yalnızca
     * kullanıcının kendisiyle. Maç başına kilit de doğru olurdu, sadece
     * gereksiz yere herkesi bekletirdi.
     *
     * Testin gerçekten ölçtüğü şey: kilit iki farklı oyuncuyu KİLİTLEMİYOR
     * (yanlış anahtarla yazılmış bir kilit burada takılırdı).
     */
    const [a, b] = await Promise.all([
      bahis(UID, Pool.CAP_FLOOR),
      bahis(OTEKI, Pool.CAP_FLOOR),
    ]);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true, "ikinci oyuncunun bahsi kabul edilmedi");
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: tavan kontrolü ile yazma aynı kilitte", () => {
  const ham = fs.readFileSync(nodePath.join(__dirname, "..", "lib", "pool-store.cjs"), "utf8");
  const src = ham
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");

  const kilit = src.indexOf("withFileLock(`pool-bet:");
  assert.ok(kilit > 0, "(mac, kullanici) basina kilit yok");

  const kontrol = src.indexOf("yeniToplam > tavan", kilit);
  const yazma = src.indexOf("$inc: { amount: tutar }", kilit);
  assert.ok(kontrol > kilit, "tavan kontrolu kilidin disinda");
  assert.ok(yazma > kontrol, "yazma kontrolden once");
});
