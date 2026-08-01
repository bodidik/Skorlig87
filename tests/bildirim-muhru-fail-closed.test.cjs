"use strict";

/**
 * BENZERSİZ İNDEKS YOKSA BİLDİRİM MÜHRÜ SESSİZCE AÇILMAZ.
 *
 * ⚠️ BULUNAN: `lib/push-sent-store.cjs` çift-gönderim korumasının TEK
 * mekanizması `{key:1}` benzersiz indeksi — `insertOne` 11000 verirse
 * "başkası aldı" demek. `ensureIndexes` indeksi kuramazsa hatayı LOGLAYIP
 * geçiyordu ve `claimKeys` yoluna devam ediyordu. İndeks yoksa `insertOne`
 * HER ÇAĞRIDA başarılı olur, yani her anahtar yeniden "alınır".
 *
 * ÖLÇÜLDÜ (koleksiyona kopya kayıt bırakıp benzersiz indeks kurulumunu
 * düşürdüm — göç öncesi ya da yarım yazma bırakılmış bir koleksiyonun tam
 * hâli):
 *     önce  1. çağrı → ["mac:2:basliyor"]
 *           2. çağrı → ["mac:2:basliyor"]
 *           3. çağrı → ["mac:2:basliyor"]
 *           yani aynı bildirim HER TURDA yeniden gönderilir
 *     sonra 1./2./3. çağrı → null   (çağıran dosya yoluna düşüyor)
 *
 * Dosyanın kendi başlığı bedelini yazıyor: "Bildirim spam'i, para kaybından
 * farklı ama uygulamayı sildiren şeydir."
 *
 * ⚠️ `null` DÖNÜYOR, BOŞ DİZİ DEĞİL — ayrım kritik. `null` çağıranı DOSYA
 * yoluna düşürüyor (`services/push-scheduler.cjs`: `if (alinan) return alinan;`)
 * ve orada kendi kilidi + kendi anahtar kontrolü var. Boş dizi dönmek
 * bildirimleri tamamen susturur, bu da dosya yedeğinin var olma sebebine
 * aykırı olurdu.
 */

const os = require("os");
const path = require("path");
const fs = require("fs");

const TMP = path.join(os.tmpdir(), "skorlig-push-muhur-test");
process.env.SKORLIG_DATA_DIR = TMP;
process.env.SKORLIG_BG = "0";

const { test, describe, before, after, beforeEach } = require("node:test");
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
 * boyunca önbellekleniyor (üretimde doğru davranış), ama iki senaryo aynı
 * önbelleği paylaşırsa ikincisi VAKUMDA geçer.
 */
function tazeModul() {
  delete require.cache[require.resolve("../lib/push-sent-store.cjs")];
  return require("../lib/push-sent-store.cjs");
}

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("normal koşulda mühür çalışıyor", async () => {
    const PS = tazeModul();
    const db = client.db("normal");
    const ilk = await PS.claimKeys(["mac:1:basliyor"], db);
    const ikinci = await PS.claimKeys(["mac:1:basliyor"], db);
    assert.deepEqual(ilk, ["mac:1:basliyor"], "ilk cagri anahtari almadi — test bir sey olcmuyor");
    assert.deepEqual(ikinci, [], "ayni anahtar ikinci kez alindi — muhur hic calismiyor");
  });

  test("Mongo yoksa null dönüyor (dosya yedeği devralsın)", async () => {
    const PS = tazeModul();
    assert.equal(await PS.claimKeys(["x"], null), null);
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("indeks kurulamadığında", () => {
  /** Benzersiz indeksin kurulmasını engelle: aynı anahtardan iki kayıt. */
  async function bozukKoleksiyon(ad) {
    const db = client.db(ad);
    await db.collection("push_sent").deleteMany({});
    await db.collection("push_sent").insertMany([
      { key: "kopya", at: new Date() },
      { key: "kopya", at: new Date() },
    ]);
    return db;
  }

  test("aynı anahtar TEKRAR TEKRAR alınmıyor", async () => {
    const PS = tazeModul();
    const db = await bozukKoleksiyon("bozuk1");
    const sonuclar = [];
    for (let i = 0; i < 3; i++) sonuclar.push(await PS.claimKeys(["mac:2:basliyor"], db));
    for (const s of sonuclar) {
      assert.equal(
        s, null,
        `indeks yokken anahtar alindi (${JSON.stringify(s)}) — ayni bildirim her turda tekrar gonderilir`
      );
    }
  });

  test("benzersiz indeks GERÇEKTEN kurulamamış (senaryo doğru)", async () => {
    const PS = tazeModul();
    const db = await bozukKoleksiyon("bozuk2");
    await PS.claimKeys(["z"], db).catch(() => {});
    const adlar = (await db.collection("push_sent").indexes()).map((i) => i.name);
    assert.ok(!adlar.includes("key_1"), `benzersiz indeks kurulmus (${adlar.join(", ")}) — senaryo cokmus`);
  });

  test("hiçbir kayıt yazılmamış (yarım mühür bırakmıyor)", async () => {
    const PS = tazeModul();
    const db = await bozukKoleksiyon("bozuk3");
    await PS.claimKeys(["mac:3:basliyor"], db);
    const n = await db.collection("push_sent").countDocuments({ key: "mac:3:basliyor" });
    assert.equal(n, 0, "muhur guvenilmezken yine de kayit yazilmis");
  });
});

/* ── Uçtan uca: çağıran dosya yoluna düşüyor ─────────────────────────────── */

describe("çağıran dosya yedeğine düşüyor", () => {
  test("null dönünce bildirim susmuyor, dosya devralıyor", async () => {
    /**
     * ⚠️ Bu testin işi `null`'ın DOĞRU yorumlandığını göstermek. Boş dizi
     * dönseydi çağıran "hepsi alınmış" sanıp bildirimleri tamamen susturur,
     * yani dosya yedeği hiç devreye girmezdi.
     */
    const alt = path.join(TMP, "e2e");
    fs.rmSync(alt, { recursive: true, force: true });
    fs.mkdirSync(alt, { recursive: true });

    const db = client.db("e2e");
    await db.collection("push_sent").deleteMany({});
    await db.collection("push_sent").insertMany([
      { key: "kopya", at: new Date() }, { key: "kopya", at: new Date() },
    ]);

    const { execFileSync } = require("child_process");
    const betik = `
      process.env.SKORLIG_DATA_DIR = ${JSON.stringify(alt)};
      process.env.SKORLIG_BG = "0";
      const { MongoClient } = require("mongodb");
      (async () => {
        const c = await MongoClient.connect(${JSON.stringify(mongod.getUri())});
        const db = c.db("e2e");
        const mp = require.resolve(${JSON.stringify(path.join(KOK, "lib", "mongo.cjs").replace(/\\/g, "/"))});
        require.cache[mp] = { id: mp, filename: mp, loaded: true,
          exports: { getDb: async () => db, close: async () => {} } };
        const S = require(${JSON.stringify(path.join(KOK, "services", "push-scheduler.cjs").replace(/\\/g, "/"))});
        const f = S._claimKeys || S.claimKeys;
        if (!f) { console.log("SONUC:" + JSON.stringify({ yok: Object.keys(S) })); await c.close(); return; }
        const r = [];
        for (let i = 0; i < 3; i++) r.push(await f(["x:1"]));
        console.log("SONUC:" + JSON.stringify(r));
        await c.close();
      })();
    `;
    const cikti = execFileSync(process.execPath, ["-e", betik], { cwd: KOK, encoding: "utf8", timeout: 90000 });
    const satir = cikti.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("SONUC:")).pop();
    assert.ok(satir, `alt surec cikti uretmedi:\n${cikti.slice(-400)}`);
    const r = JSON.parse(satir.slice(6));
    if (r.yok) return; // fonksiyon dışa açılmamış — bu yol ayrıca sınanmıyor

    assert.deepEqual(r[0], ["x:1"], "ilk cagri anahtari almali (dosya yolu devralmadi)");
    assert.deepEqual(r[1], [], "ikinci cagri tekrar aldi — dosya yolu da korumuyor");
    assert.deepEqual(r[2], [], "ucuncu cagri tekrar aldi");
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: indeks durumu KONTROL EDİLİYOR, sonuç yok sayılmıyor", () => {
  const src = fs.readFileSync(path.join(KOK, "lib", "push-sent-store.cjs"), "utf8")
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");

  assert.ok(/const indeksHazir = await ensureIndexes\(db\);/.test(src), "indeks sonucu okunmuyor");
  assert.ok(/if \(!indeksHazir\)[\s\S]{0,200}return null;/.test(src), "indeks yokken fail-closed degil");
  assert.ok(/return true;/.test(src) && /return false;/.test(src), "ensureIndexes basari bildirmiyor");
});
