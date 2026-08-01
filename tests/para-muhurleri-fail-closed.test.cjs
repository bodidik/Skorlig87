"use strict";

/**
 * PARA MÜHÜRLERİ: BENZERSİZ İNDEKS KURULAMAZSA İŞLEM YAPILMAZ.
 *
 * ⚠️ BULUNAN (iki depoda aynı kalıp): `ensureIndexes` benzersiz indeksi
 * kuramazsa hatayı LOGLAYIP geçiyordu ve akış devam ediyordu. Oysa bu iki
 * fonksiyonun atomikliği TAMAMEN o indekse dayanıyor — `insertOne`'ın 11000
 * vermesi "başkası aldı" demek. İndeks yoksa 11000 hiç gelmez.
 *
 * ÖLÇÜLDÜ (koleksiyona kopya kayıt bırakıp indeks kurulumunu düşürdüm; göç
 * öncesi ya da yarım yazma bırakılmış bir koleksiyonun tam hâli):
 *
 *   lib/davet-odul-store.cjs `odulMuhurle`
 *       önce : üç çağrı → [true, true, true]   → davet ödülü İKİ TARAFA ÜÇ KEZ
 *       sonra: üç çağrı → [false, false, false]
 *     Dosyanın kendi başlığı: "30 LC yerine 60 LC basılır".
 *
 *   lib/kupon-store.cjs `katilimEkle`
 *       önce : üç çağrı → [ok, ok, ok], kayıt 3 → aynı oyuncu üç kez katıldı
 *       sonra: üç çağrı → [hata, hata, hata], kayıt 0
 *     Dosyanın kendi notu: "Benzersizlik olmazsa aynı kişi iki kez ödeyip
 *     iki kez ödül alabilir." `routes/kupon.cjs` sırası "önce tahsilat, sonra
 *     kayıt" olduğu için giriş bedeli üç kez tahsil edilirdi.
 *
 * ⚠️ FAIL-CLOSED SEÇİLDİ, çünkü iki tarafın bedeli simetrik değil: koruma
 * yokken devam etmek PARA ÜRETİR (geri alınamaz), durmak yalnızca işlemi
 * geciktirir. Kupon tarafında çağıran zaten `!ok` durumunda ücreti İADE
 * ediyor, yani oyuncu parasız kalmıyor.
 *
 * ⚠️ HAVUZ BAHSİ AYNI KUSURU TAŞIMIYOR — ölçtüm ve dürüstçe yazıyorum:
 * `lib/pool-store.cjs placeBet` benzersiz indekse DAYANMIYOR; koruması
 * `withFileLock(pool-bet:<fid>:<uid>)` + tavan kontrolü ve `$inc`'li upsert.
 * Orada indeksin yokluğu çift bahis üretmiyor.
 *
 * ⚠️ AYNI KALIP ÖNCE `lib/push-sent-store.cjs`'te bulunmuştu (bildirim spam'i);
 * bu tur para tarafındaki iki taşıyıcısını kapatıyor.
 */

const os = require("os");
const path = require("path");
const fs = require("fs");

const TMP = path.join(os.tmpdir(), "skorlig-para-muhur-test");
process.env.SKORLIG_DATA_DIR = TMP;
process.env.SKORLIG_BG = "0";

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

const KOK = path.join(__dirname, "..");
let mongod = null, client = null;

before(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const { MongoClient } = require("mongodb");
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
});

after(async () => {
  if (client) await client.close();
  if (mongod) await mongod.stop();
});

/**
 * ⚠️ MODÜL HER SENARYODA YENİDEN YÜKLENİYOR: `_indexPromise` süreç ömrü
 * boyunca önbellekleniyor (üretimde doğru), ama iki senaryo aynı önbelleği
 * paylaşırsa ikincisi VAKUMDA geçer.
 */
function taze(rel) {
  delete require.cache[require.resolve(rel)];
  return require(rel);
}

/* ── Davet ödülü mührü ───────────────────────────────────────────────────── */

describe("davet ödülü mührü", () => {
  test("KURULUM: normal koşulda ödül bir kez veriliyor", async () => {
    const DO = taze("../lib/davet-odul-store.cjs");
    const db = client.db("davet_ok");
    const r = [];
    for (let i = 0; i < 3; i++) r.push(await DO.odulMuhurle("oyuncu", db));
    assert.deepEqual(r, [true, false, false], `muhur calismiyor: ${JSON.stringify(r)}`);
  });

  test("indeks kurulamazsa ödül VERİLMİYOR", async () => {
    const DO = taze("../lib/davet-odul-store.cjs");
    const db = client.db("davet_bozuk");
    // Benzersiz indeksi engelle
    await db.collection(DO.COLL).insertMany([
      { anahtar: "kopya", at: new Date() }, { anahtar: "kopya", at: new Date() },
    ]);
    const r = [];
    for (let i = 0; i < 3; i++) r.push(await DO.odulMuhurle("kurban", db));
    assert.deepEqual(
      r, [false, false, false],
      `indeks yokken odul verildi (${JSON.stringify(r)}) — davet odulu iki tarafa tekrar tekrar odenir`
    );
  });

  test("senaryo gerçekten kurulmuş (indeks yok)", async () => {
    const db = client.db("davet_bozuk");
    const adlar = (await db.collection("invite_redeems").indexes()).map((i) => i.name);
    assert.ok(!adlar.includes("anahtar_1"), `benzersiz indeks kurulmus (${adlar}) — senaryo cokmus`);
  });
});

/* ── Kupon katılımı ──────────────────────────────────────────────────────── */

describe("kupon katılımı", () => {
  test("KURULUM: normal koşulda ikinci katılım reddediliyor", async () => {
    const KS = taze("../lib/kupon-store.cjs");
    const db = client.db("kupon_ok");
    const ilk = await KS.katilimEkle({ kuponId: "k1", userId: "oyuncu", odenen: 25 }, db);
    const ikinci = await KS.katilimEkle({ kuponId: "k1", userId: "oyuncu", odenen: 25 }, db);
    assert.equal(ilk.ok, true, "ilk katilim reddedildi — test bir sey olcmuyor");
    assert.equal(ikinci.ok, false, "ayni oyuncu ikinci kez katildi");
    assert.equal(ikinci.reason, "ALREADY_JOINED");
  });

  test("indeks kurulamazsa katılım YAZILMIYOR", async () => {
    const KS = taze("../lib/kupon-store.cjs");
    const db = client.db("kupon_bozuk");
    await db.collection(KS.COLL_KATILIM).insertMany([
      { kuponId: "kopya", userIdLower: "d", userId: "d" },
      { kuponId: "kopya", userIdLower: "d", userId: "d" },
    ]);
    const r = [];
    for (let i = 0; i < 3; i++) {
      r.push(await KS.katilimEkle({ kuponId: "kupon1", userId: "oyuncu", odenen: 25 }, db));
    }
    assert.deepEqual(
      r.map((x) => x.ok), [false, false, false],
      "indeks yokken katilim yazildi — oyuncu giris bedelini tekrar tekrar oder"
    );
    const n = await db.collection(KS.COLL_KATILIM).countDocuments({ kuponId: "kupon1" });
    assert.equal(n, 0, `${n} katilim kaydi yazilmis — koruma yokken yazma yapilmamali`);
  });

  test("çağıranın iade edebilmesi için ok:false ve sebep dönüyor", async () => {
    /**
     * `routes/kupon.cjs` sırası "önce tahsilat, sonra kayıt": kayıt
     * başarısızsa ücreti iade ediyor. Sebep alanı olmadan iade yolu
     * ayırt edemezdi.
     */
    const KS = taze("../lib/kupon-store.cjs");
    const db = client.db("kupon_bozuk2");
    await db.collection(KS.COLL_KATILIM).insertMany([
      { kuponId: "kopya", userIdLower: "d", userId: "d" },
      { kuponId: "kopya", userIdLower: "d", userId: "d" },
    ]);
    const r = await KS.katilimEkle({ kuponId: "k", userId: "u", odenen: 25 }, db);
    assert.equal(r.ok, false);
    assert.ok(r.reason, "sebep alani yok — cagiran iadeyi ayirt edemez");
  });
});

/* ── Havuz: aynı kusur YOK ───────────────────────────────────────────────── */

describe("havuz bahsi", () => {
  test("koruma benzersiz indekse DEĞİL kilide dayanıyor", () => {
    /**
     * ⚠️ Bu test bir kusuru kapatmıyor, kapsamı DÜRÜSTÇE sınırlıyor.
     * `placeBet` çift bahse karşı `withFileLock(pool-bet:<fid>:<uid>)` ve
     * tavan kontrolü kullanıyor; benzersiz indeks yardımcı. O yüzden oraya
     * fail-closed eklemedim — eklersem indeks gecikmesinde bahisler
     * gereksizce reddedilirdi.
     */
    const src = fs.readFileSync(path.join(KOK, "lib", "pool-store.cjs"), "utf8")
      .split("\n")
      .map((l) => {
        const t = l.trim();
        return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
      })
      .join("\n");
    assert.ok(/withFileLock\(`pool-bet:/.test(src), "havuz bahsi kilidi kalkmis");
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

const kaynak = (rel) =>
  fs.readFileSync(path.join(KOK, rel), "utf8")
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");

test("NÖBETÇİ: para mühürleri indeks sonucunu OKUYOR", () => {
  for (const rel of ["lib/davet-odul-store.cjs", "lib/kupon-store.cjs", "lib/push-sent-store.cjs"]) {
    const src = kaynak(rel);
    assert.ok(/return true;/.test(src), `${rel}: ensureIndexes basari bildirmiyor`);
    assert.ok(/return false;/.test(src), `${rel}: ensureIndexes hata bildirmiyor`);
    assert.ok(
      /!\(await ensureIndexes\(|!indeksHazir/.test(src),
      `${rel}: indeks sonucu kontrol edilmiyor — koruma yokken islem yapilir`
    );
  }
});
