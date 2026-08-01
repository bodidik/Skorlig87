"use strict";

/**
 * YETKİSİ ALINAN YÖNETİCİ BAYAT DOSYADAN GERİ GELMEZ.
 *
 * ⚠️ BULUNAN: `lib/moderation-store.cjs listAdmins`, Mongo boş dönünce
 * KOŞULSUZ olarak dosyaya düşüyor ve dosya içeriğini Mongo'ya TOHUMLUYORDU.
 * `SKORLIG_MODERATION_FILE_MIRROR=0` iken `removeAdmin` aynayı tazelemiyor
 * (kod `if (mirrorOn()) await aynayiTazele(...)` diyor), yani dosya bayat
 * kalıyor. Tek yöneticinin yetkisi alınınca Mongo boşalıyor, okuma bayat
 * dosyaya düşüyor ve yönetici GERİ GELİYOR.
 *
 * ÖLÇÜLDÜ (tek yönetici, yetkisi alındı):
 *     ayna açık   → listAdmins: []                temiz
 *     ayna kapalı → listAdmins: [eski-yonetici]   YETKİ GERİ GELDİ
 *
 * ⚠️ SADECE "GERİ GELDİ" DEĞİL — tohumlama onu Mongo'ya YENİDEN YAZIYORDU.
 * Yani yetki alma işlemi etkisiz kalmakla kalmıyor, kaldırılan kayıt birincil
 * depoya geri dönüyordu. Kendi kendini yanlış yönde onaran bir arıza.
 *
 * ⚠️ HATA DURUMU AYRI TUTULDU: Mongo OKUNAMAZSA (istisna) dosyaya düşmek
 * DOĞRU — "kimse yönetici değil" demek yönetimi tamamen kilitler. Ayrım
 * `mongoBos` değişkeninde: boş sonuç ile okunamayan sonuç aynı şey değil.
 *
 * ⚠️ AYNI KURAL ÜÇÜNCÜ KEZ: `lib/streak-store.cjs` ve `lib/social-store.cjs`
 * de aynı "dosyaya düş" kestirmesiyle kusur üretmişti.
 */

const os = require("os");
const path = require("path");
const fs = require("fs");
const cp = require("child_process");

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

const KOK = path.join(__dirname, "..");
const TMP = path.join(os.tmpdir(), "skorlig-yetki-geri-test");

let mongod = null, uri = null;

before(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  mongod = await MongoMemoryServer.create();
  uri = mongod.getUri();
});

after(async () => {
  if (mongod) await mongod.stop();
});

/**
 * ⚠️ AYRI SÜREÇTE ÇALIŞIYOR: `FILE_MIRROR` modül yüklenirken bir kez
 * okunuyor, aynı süreçte değiştirilemez.
 */
function senaryo({ aynaKapali, dosyadakiler = ["eski-yonetici"], islem }) {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  fs.writeFileSync(
    path.join(TMP, "admin-users.json"),
    JSON.stringify({ items: dosyadakiler, updatedAt: new Date().toISOString() })
  );

  const betik = `
    process.env.SKORLIG_DATA_DIR = ${JSON.stringify(TMP)};
    process.env.MONGODB_URI = ${JSON.stringify(uri)};
    ${aynaKapali ? 'process.env.SKORLIG_MODERATION_FILE_MIRROR = "0";' : ""}
    const { MongoClient } = require("mongodb");
    const M = require(${JSON.stringify(path.join(KOK, "lib", "moderation-store.cjs").replace(/\\/g, "/"))});
    (async () => {
      const c = await MongoClient.connect(process.env.MONGODB_URI);
      const db = c.db("mod");
      await db.collection("admin_users").deleteMany({});
      await db.collection("banned_users").deleteMany({});
      const sonuc = await (${islem})(M, db);
      const mongoda = (await db.collection("admin_users").find({}).toArray()).map((d) => d.userId);
      console.log("SONUC:" + JSON.stringify({ ...sonuc, mongoda }));
      await c.close();
    })();
  `;
  const cikti = cp.execFileSync(process.execPath, ["-e", betik], {
    cwd: KOK, encoding: "utf8", timeout: 90000,
  });
  const satir = cikti.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("SONUC:")).pop();
  assert.ok(satir, `alt surec cikti uretmedi:\n${cikti.slice(-400)}`);
  return JSON.parse(satir.slice("SONUC:".length));
}

const YETKI_AL = `async (M, db) => {
  await M.addAdmin("eski-yonetici", db);
  const once = await M.listAdmins(db);
  await M.removeAdmin("eski-yonetici", db);
  return { once, sonra: await M.listAdmins(db) };
}`;

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("yönetici eklenebiliyor ve listede görünüyor", () => {
    const r = senaryo({ aynaKapali: false, islem: YETKI_AL });
    assert.deepEqual(r.once, ["eski-yonetici"], "admin hic eklenmedi — test bir sey olcmuyor");
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("yetki alma kalıcı", () => {
  test("ayna AÇIKKEN yetki geri gelmiyor (zaten çalışıyordu)", () => {
    const r = senaryo({ aynaKapali: false, islem: YETKI_AL });
    assert.deepEqual(r.sonra, [], `yetki geri geldi: ${JSON.stringify(r.sonra)}`);
  });

  test("ayna KAPALIYKEN de yetki geri GELMİYOR", () => {
    const r = senaryo({ aynaKapali: true, islem: YETKI_AL });
    assert.deepEqual(
      r.sonra, [],
      "ayna kapaliyken bayat dosyadan yonetici dirildi — yetki alma etkisiz"
    );
  });

  test("kaldırılan kayıt Mongo'ya GERİ YAZILMIYOR", () => {
    /**
     * Asıl tehlike buydu: tohumlama, bayat dosyayı birincil depoya geri
     * yazıyordu. Yani arıza kendi kendini YANLIŞ yönde onarıyordu.
     */
    const r = senaryo({ aynaKapali: true, islem: YETKI_AL });
    assert.deepEqual(
      r.mongoda, [],
      `kaldirilan yonetici mongoya geri tohumlanmis: ${JSON.stringify(r.mongoda)}`
    );
  });
});

describe("ayna açıkken göç davranışı korundu", () => {
  test("Mongo boş + ayna açık → dosyadan okunuyor ve tohumlanıyor", () => {
    /**
     * ⚠️ TERS YÖNE KAÇMADIĞIMIZIN KANITI. Ayna AÇIKKEN dosyadan okuma göç
     * yolunun ta kendisi: üretim kendi dosyasından Mongo'ya geçiyor. Onu da
     * kapatsaydım, ilk açılışta tüm yöneticiler kaybolurdu.
     */
    const r = senaryo({
      aynaKapali: false,
      dosyadakiler: ["dosyadaki-yonetici"],
      islem: `async (M, db) => ({ once: [], sonra: await M.listAdmins(db) })`,
    });
    assert.deepEqual(r.sonra, ["dosyadaki-yonetici"], "goc yolu kirildi — dosyadaki yoneticiler kayboldu");
    assert.deepEqual(r.mongoda, ["dosyadaki-yonetici"], "tohumlama calismadi");
  });

  test("ayna KAPALI + Mongo boş → dosya okunmuyor", () => {
    const r = senaryo({
      aynaKapali: true,
      dosyadakiler: ["dosyadaki-yonetici"],
      islem: `async (M, db) => ({ once: [], sonra: await M.listAdmins(db) })`,
    });
    assert.deepEqual(r.sonra, [], "ayna kapaliyken bayat dosya okundu");
    assert.deepEqual(r.mongoda, [], "ayna kapaliyken tohumlama yapildi");
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

const kaynak = fs.readFileSync(path.join(KOK, "lib", "moderation-store.cjs"), "utf8")
  .split("\n")
  .map((l) => {
    const t = l.trim();
    return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
  })
  .join("\n");

test("NÖBETÇİ: boş sonuç ile OKUNAMAYAN sonuç ayrı tutuluyor", () => {
  /**
   * Ayrım kritik: Mongo okunamıyorsa dosyaya düşmek DOĞRU (yoksa yönetim
   * kilitlenir), Mongo BOŞSA ve ayna kapalıysa düşmek YANLIŞ.
   */
  assert.ok(/let mongoBos = false;/.test(kaynak), "bos/okunamayan ayrimi kaldirilmis");
  const adet = (kaynak.match(/if \(mongoBos && !mirrorOn\(\)\) return \[\];/g) || []).length;
  assert.equal(adet, 2, `koruma ${adet} listede var — admin ve yasak listelerinin ikisinde de olmali`);
});

test("NÖBETÇİ: yetki alma aynayı tazeliyor (ayna açıkken)", () => {
  assert.ok(
    /deleteOne\(\{ userId: uid \}\);[\s\S]{0,120}mirrorOn\(\)/.test(kaynak),
    "removeAdmin aynayi tazelemiyor — dosya bayatlar"
  );
});
