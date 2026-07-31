"use strict";

/**
 * DÜELLO BAYATLIĞI İSTEMCİNİN YAZDIĞI SAATE BAĞLI OLAMAZ.
 *
 * ⚠️ BULUNAN: `/api/duels/create` `kickoffISO`yu istek gövdesinden alıp
 * düelloya yazıyordu ve `services/bayat-temizleyici.cjs` tam o alanla karar
 * veriyor:
 *
 *     const durum = await bayatMi({ fixtureId: d.fixtureId, kickoffISO: d.kickoffISO, db });
 *     if (!durum.bayat) continue;
 *     ... status = GECERSIZ ... creditLc(uid, stake, "duel_void_refund") ...
 *
 * Yani alan görüntü değil, PARA KARARI. Kurucu geçmiş bir saat yazarak KABUL
 * EDİLMİŞ bir düelloyu istediği an dağıtabiliyordu (iki tarafın bahsi iade).
 * Ters yönde — geleceğe atılmış saat — güvenlik ağı hiç çalışmaz ve para
 * kalıcı olarak kilitli kalırdı.
 *
 * ⚠️ AYNI SINIFIN ÜÇÜNCÜ ÖRNEĞİ (düello takım adları, mini turnuva saati,
 * bu). Düzeltme bu kez ÇAĞIRANDA değil `lib/bayat-mac.cjs` İÇİNDE: yetkili
 * kaynak fikstür deposu, çağıranın verdiği değer yalnızca depoda karşılık
 * yoksa kullanılıyor. Böylece bu düzeltmeden ÖNCE kurulmuş düellolar da
 * korunuyor.
 */

const os = require("os");
const nodePath = require("path");
const fs = require("fs");

const TMP = nodePath.join(os.tmpdir(), "skorlig-duel-bayat-test");
process.env.SKORLIG_DATA_DIR = TMP;
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const { DURUM } = require("../lib/duel-durum.cjs");

const FID = "dbx-1";
const KURUCU = "kurucu-a";
const KABUL = "kabul-b";
const BAHIS = 25;

const GERCEK_SAAT = new Date(Date.now() + 10 * 3600_000).toISOString();  // 10 saat sonra
const YALAN_SAAT  = new Date(Date.now() - 200 * 3600_000).toISOString(); // 200 saat önce

let mongod = null, client = null, db = null;

before(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const { MongoClient } = require("mongodb");
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  db = client.db("test");

  await db.collection("fixtures").insertOne({
    fixtureId: FID, home: "EvTakim", away: "DepTakim",
    kickoffISO: GERCEK_SAAT, status: "NS",
  });
});

after(async () => {
  if (client) await client.close();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  await db.collection("duels").deleteMany({});
  await db.collection("lc_wallet_users").deleteMany({});
  await db.collection("lc_wallet_ledger").deleteMany({});
  for (const uid of [KURUCU, KABUL]) {
    await db.collection("lc_wallet_users").insertOne({
      userId: uid, userIdLower: uid, balance: 100,
      totalEarned: 0, totalSpent: 0, createdAt: new Date().toISOString(),
    });
  }
});

/** Kabul edilmiş (aktif) bir düello — `kickoffISO` istenen değerle. */
async function duelloYaz(kickoffISO) {
  await db.collection("duels").insertOne({
    id: "D1", fixtureId: FID, stake: BAHIS,
    creatorId: KURUCU, acceptorId: KABUL,
    status: DURUM.AKTIF,
    home: "EvTakim", away: "DepTakim",
    kickoffISO,
    createdAt: new Date().toISOString(),
  });
}

const bakiye = async (uid) =>
  Number((await db.collection("lc_wallet_users").findOne({ userIdLower: uid }))?.balance || 0);

const temizle = () => require("../services/bayat-temizleyici.cjs");

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

test("temizleyici gerçekten çalışıyor (test ölü değil)", async () => {
  /* Depoda OLMAYAN bir maç için çağıranın saati geçerli — temizleyicinin
   * gerçekten iade yaptığını böyle doğruluyoruz. Bu kontrol olmasaydı
   * aşağıdaki "iade yapılmadı" iddiaları boşlukta doğru görünürdü. */
  await db.collection("duels").insertOne({
    id: "D0", fixtureId: "depoda-yok", stake: BAHIS,
    creatorId: KURUCU, acceptorId: KABUL, status: DURUM.AKTIF,
    kickoffISO: YALAN_SAAT, createdAt: new Date().toISOString(),
  });
  const r = await temizle()._duellolariTemizle(db);
  assert.ok(r.iptal >= 1, `hicbir duello iptal edilmedi: ${JSON.stringify(r)}`);
  assert.equal(await bakiye(KURUCU), 100 + BAHIS, "iade yapilmamis");
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("kayıttaki yalan saat", () => {
  test("düelloyu GEÇERSİZ yapmaz, para iade EDİLMEZ", async () => {
    await duelloYaz(YALAN_SAAT);

    const r = await temizle()._duellolariTemizle(db);
    assert.equal(r.iptal, 0, "yalan saat duelloyu dagitti — kurucu istedigi an bozabilir");

    const d = await db.collection("duels").findOne({ id: "D1" });
    assert.equal(d.status, DURUM.AKTIF, "duello gecersiz yapilmis");
    assert.equal(await bakiye(KURUCU), 100, "kurucuya iade yapilmis");
    assert.equal(await bakiye(KABUL), 100, "kabul edene iade yapilmis");
  });

  test("gerçek saatle de bekliyor (maç henüz oynanmadı)", async () => {
    await duelloYaz(GERCEK_SAAT);
    const r = await temizle()._duellolariTemizle(db);
    assert.equal(r.iptal, 0);
  });
});

describe("gerçekten bayatlamış maç", () => {
  test("sunucu saati geçmişse düello İPTAL edilir ve iade yapılır", async () => {
    /* Kapalı tarafa fazla kaçmadığımızı gösteriyor: güvenlik ağı hâlâ
     * çalışıyor. Sunucudaki saati geçmişe alıyoruz — istemci değil. */
    await db.collection("fixtures").updateOne(
      { fixtureId: FID }, { $set: { kickoffISO: YALAN_SAAT } }
    );
    try {
      // Kayıtta GELECEK saat yazıyor olsa bile sunucu değeri kazanmalı.
      await duelloYaz(GERCEK_SAAT);
      const r = await temizle()._duellolariTemizle(db);
      assert.equal(r.iptal, 1, "gercekten bayat mac icin guvenlik agi calismadi");

      const d = await db.collection("duels").findOne({ id: "D1" });
      assert.equal(d.status, DURUM.GECERSIZ);
      assert.equal(await bakiye(KURUCU), 100 + BAHIS);
      assert.equal(await bakiye(KABUL), 100 + BAHIS, "kabul edene iade yapilmamis");
    } finally {
      await db.collection("fixtures").updateOne(
        { fixtureId: FID }, { $set: { kickoffISO: GERCEK_SAAT } }
      );
    }
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: bayatMi önce depoya bakıyor", () => {
  const ham = fs.readFileSync(nodePath.join(__dirname, "..", "lib", "bayat-mac.cjs"), "utf8");
  const src = ham
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");

  const depo = src.indexOf('collection("fixtures")');
  const cagiran = src.indexOf("String(kickoffISO");
  assert.ok(depo > 0 && cagiran > 0, "tarama kaliplari bulunamadi");
  assert.ok(
    depo < cagiran,
    "cagiranin saati depodan ONCE okunuyor — yalan bir tarih depoyu devre disi birakir"
  );
});

test("NÖBETÇİ: create gövdeden kickoffISO okumuyor", () => {
  const ham = fs.readFileSync(nodePath.join(__dirname, "..", "routes", "duels.cjs"), "utf8");
  const src = ham
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");

  const bas = src.indexOf('router.post("/duels/create"');
  assert.ok(bas > 0, "create rotasi bulunamadi");
  const kalan = src.slice(bas + 10);
  const sonraki = kalan.search(/\r?\n(router\.|async function|function|module\.exports)/);
  const govde = sonraki > 0 ? src.slice(bas, bas + 10 + sonraki) : src.slice(bas);

  assert.ok(
    !/\bkickoffISO\b\s*[,}]/.test(govde.slice(0, govde.indexOf("const nowISO"))),
    "create hala govdeden kickoffISO cozuyor"
  );
  assert.ok(/takim\.kickoffISO/.test(govde), "saat sunucudan yazilmiyor");
});
