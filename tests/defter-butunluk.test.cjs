"use strict";

/**
 * BAKİYEYİ DEĞİŞTİREN HER YOL DEFTERE DE YAZAR.
 *
 * ⚠️ BULUNAN: otomatik LC birikimi (`applyRegen`) bakiyeyi artırıyor ama
 * defter kaydı YALNIZCA aylık premium kasası için yazılıyordu:
 *
 *     const eklenen = aylikKasa + birikim;      // ikisi birden bakiyeye
 *     ...
 *     if (r.modifiedCount && monthlyGranted > 0) addLedgerEntryMongo(...)
 *                            ^^^^^^^^^^^^^^^^^ yalnızca kasa
 *
 * ÖLÇÜLDÜ: bakiye 2 → 14 (12 LC üretildi), defterde 0 kayıt.
 *
 * İki sonucu vardı:
 *  1) DENETİM İZİ KOPUK — `bakiye = açılış + defter toplamı` değişmezi
 *     birikim alan her kullanıcı için bozuktu.
 *  2) EKONOMİ RAPORU KÖR — `lib/economy-report.cjs` YALNIZCA defterden
 *     topluyor. Birikim oyunun sürekli çalışan ücretsiz muslugu; yani
 *     muslukları ölçmek için yazılmış rapor en büyük muslugu hiç görmüyordu.
 *
 * ⚠️ NASIL BULUNDU: "bakiyeyi $inc ile değiştiren her yerin yakınında defter
 * yazımı var mı" diye tarama yazdım; DOKUZ yer buldu, hepsi temiz çıktı.
 * Onuncu yer taramaya HİÇ takılmadı çünkü `$inc:` satır içinde değil
 * `guncelleme.$inc = {...}` biçiminde atanıyordu. Kusurlu olan tam o yerdi.
 * Aşağıdaki nöbetçi iki biçimi de tarıyor.
 */

const os = require("os");
const nodePath = require("path");
const fs = require("fs");

const TMP = nodePath.join(os.tmpdir(), "skorlig-defter-butunluk-test");
process.env.SKORLIG_DATA_DIR = TMP;
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const UID = "defter-oyuncu";
const BASLANGIC = 2;                                   // taban altı: birikim tetiklensin
const ESKI = new Date(Date.now() - 48 * 3600_000).toISOString();

let mongod = null, client = null, db = null, server = null, taban = "";

before(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const { MongoClient } = require("mongodb");
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  db = client.db("test");

  const vtYol = require.resolve("../middleware/verifyToken.cjs");
  require("../middleware/verifyToken.cjs");
  require.cache[vtYol].exports = {
    ...require.cache[vtYol].exports,
    verifyToken: (req, _res, next) => { req.uid = UID; next(); },
    optionalToken: (req, _res, next) => { req.uid = UID; next(); },
  };

  const express = require("express");
  const app = express();
  app.locals.db = db;
  app.use(express.json());
  app.use("/api/rt", require("../routes/lc-wallet.cjs"));
  await new Promise((r) => { server = app.listen(0, r); });
  taban = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) server.close();
  if (client) await client.close();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  await db.collection("lc_wallet_users").deleteMany({});
  await db.collection("lc_wallet_ledger").deleteMany({});
  await db.collection("lc_wallet_users").insertOne({
    userId: UID, userIdLower: UID, balance: BASLANGIC,
    totalEarned: 0, totalSpent: 0, lastDailyAt: null,
    lastRegenAt: ESKI, createdAt: ESKI,
  });
});

const ozet = () => fetch(`${taban}/api/rt/lc-wallet/summary?userId=${UID}`)
  .then((r) => r.json());

const bakiye = async () =>
  Number((await db.collection("lc_wallet_users").findOne({ userIdLower: UID }))?.balance || 0);

const defter = async () => {
  const k = await db.collection("lc_wallet_ledger").find({ userIdLower: UID }).toArray();
  return {
    toplam: k.reduce((a, x) => a + Number(x.amount || 0), 0),
    adet: k.length,
    sebepler: k.map((x) => x.reason || x.kind),
  };
};

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("birikim gerçekten tetikleniyor", async () => {
    const r = await ozet();
    assert.equal(r.ok, true, `summary basarisiz: ${JSON.stringify(r).slice(0, 200)}`);
    const artis = (await bakiye()) - BASLANGIC;
    assert.ok(
      artis > 0,
      `bakiye artmadi (${artis}) — birikim tetiklenmemis, test bir sey olcmuyor`
    );
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("denetim izi", () => {
  test("bakiye artışı defter toplamıyla birebir", async () => {
    await ozet();
    const artis = (await bakiye()) - BASLANGIC;
    const d = await defter();
    assert.equal(
      d.toplam, artis,
      `bakiye ${artis} LC artti ama defter toplami ${d.toplam} — ` +
      `${artis - d.toplam} LC iz birakmadan uretildi`
    );
    assert.ok(d.adet >= 1, "defterde hic kayit yok");
  });

  test("birikim kaydı `regen` sebebiyle yazılıyor", async () => {
    await ozet();
    const d = await defter();
    assert.ok(
      d.sebepler.includes("regen"),
      `birikim kaydi yok; bulunan sebepler: ${JSON.stringify(d.sebepler)}`
    );
  });

  test("ikinci çağrı ÇİFT kayıt üretmez", async () => {
    // Birikim zaman tabanlı; aynı anda ikinci çağrı yeni LC vermemeli.
    await ozet();
    const ilk = await defter();
    await ozet();
    const ikinci = await defter();
    assert.equal(ikinci.adet, ilk.adet, "ayni anda ikinci cagri fazladan kayit yazdi");
    assert.equal(ikinci.toplam, await bakiye() - BASLANGIC, "defter ile bakiye ayristi");
  });

  test("EŞZAMANLI çağrılarda defter ile bakiye ayrışmıyor", async () => {
    /**
     * Bakiye yazımı koşullu (`lastRegenAt` karşılaştırması): eşzamanlı
     * çağrılardan yalnızca biri gerçekten LC ekler. Defter kaydı o yüzden
     * `r.modifiedCount` koşuluna bağlı — koşul olmasaydı yarışı KAYBEDEN
     * istek de kayıt yazar ve defter bakiyeden fazla gösterirdi (hayalet
     * kredi: denetimde "verilmiş" görünen ama bakiyede olmayan LC).
     *
     * ⚠️ DÜRÜST SINIR: bu test o durumu ZORLAYAMIYOR. `modifiedCount`
     * korumasını kaldırıp çalıştırdım, test yine geçti — çünkü altı eşzamanlı
     * istekte bile sonrakiler güncellenmiş kaydı okuyup `regenEarned = 0`
     * hesaplıyor, yani kaybeden dal hiç çalışmıyor. Pencere bu ortamda
     * kapatılamayacak kadar dar.
     *
     * Yani buradaki koruma KANITLANMIŞ değil, gerekçelendirilmiş: koşullu
     * yazma zaten var, defter kaydını ona bağlamak bedava. Test'in gerçekten
     * kilitlediği şey daha zayıf ama yine de değerli: eşzamanlı çağrılar
     * defter ile bakiyeyi ayrıştırmıyor.
     */
    const N = 6;
    await Promise.all(Array.from({ length: N }, () => ozet()));

    const artis = (await bakiye()) - BASLANGIC;
    const d = await defter();
    assert.ok(artis > 0, "birikim hic tetiklenmedi — test bir sey olcmuyor");
    assert.equal(
      d.toplam, artis,
      `${N} eszamanli cagri: bakiye ${artis} artti, defter ${d.toplam} yaziyor — ` +
      `${d.toplam - artis} LC hayalet kredi`
    );
    assert.equal(d.adet, 1, `birikim icin ${d.adet} kayit yazilmis, tek olmali`);
  });
});

/* ── Ekonomi raporu ──────────────────────────────────────────────────────── */

describe("ekonomi raporu", () => {
  test("birikimi GİRİŞ olarak görüyor", async () => {
    /**
     * ⚠️ Raporun varlık sebebi muslukları ölçmek. Defterde iz olmayınca
     * en büyük musluk raporda HİÇ görünmüyordu.
     */
    await ozet();
    const { economyReport } = require("../lib/economy-report.cjs");
    const rap = await economyReport(db, 7);
    const hafta = rap.akis?.son7gun;
    assert.ok(hafta, `rapor sekli beklenmedik: ${JSON.stringify(Object.keys(rap))}`);
    assert.ok(
      Number(hafta.giris?.regen || 0) > 0,
      `rapor birikimi gormuyor: ${JSON.stringify(hafta.giris)}`
    );
    assert.equal(
      hafta.toplamGiris, (await bakiye()) - BASLANGIC,
      "rapordaki giris toplami gercek uretimle uyusmuyor"
    );
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: bakiyeyi değiştiren her yerin yakınında defter yazımı var", () => {
  /**
   * ⚠️ İKİ BİÇİM DE TARANIYOR. İlk sürüm yalnızca satır içi `$inc: { balance`
   * arıyordu ve kusurlu olan tek yeri KAÇIRDI — orada güncelleme nesnesi
   * ayrı kuruluyor (`guncelleme.$inc = { balance: ... }`). Bir taramanın
   * bulduğu dokuz temiz yer, kaçırdığı onuncuyu telafi etmiyor.
   */
  const KOK = nodePath.join(__dirname, "..");
  const bulunan = [];
  const kusurlu = [];

  for (const alt of ["routes", "lib", "services"]) {
    const d = nodePath.join(KOK, alt);
    if (!fs.existsSync(d)) continue;
    for (const dosya of fs.readdirSync(d)) {
      if (!dosya.endsWith(".cjs")) continue;
      const satirlar = fs.readFileSync(nodePath.join(d, dosya), "utf8").split("\n");
      satirlar.forEach((l, i) => {
        const t = l.trim();
        if (t.startsWith("*") || t.startsWith("//") || t.startsWith("/*")) return;
        // Hem `$inc: { balance ... }` hem `X.$inc = { balance ... }`
        if (!/\$inc\s*[:=]\s*\{[^}]*balance/.test(l)) return;
        const yer = `${alt}/${dosya}:${i + 1}`;
        bulunan.push(yer);
        const pencere = satirlar.slice(Math.max(0, i - 25), i + 45).join("\n");
        if (!/lc_wallet_ledger|addLedger|COLL_LEDGER/.test(pencere)) kusurlu.push(yer);
      });
    }
  }

  assert.ok(bulunan.length >= 9, `cok az yer bulundu (${bulunan.length}) — tarama bozulmus olabilir`);
  assert.ok(
    bulunan.some((y) => y.startsWith("routes/lc-wallet.cjs")),
    "atama bicimi (`guncelleme.$inc = ...`) taramaya takilmiyor — kusurlu olan yer o biçimdeydi"
  );
  assert.deepStrictEqual(
    kusurlu,
    [],
    "Bu yerler bakiyeyi degistiriyor ama yakininda defter yazimi yok.\n" +
      "Denetim izi kopar ve /api/admin/economy o LC'yi hic gormez:\n" + kusurlu.join("\n")
  );
});
