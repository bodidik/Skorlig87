"use strict";

/**
 * HESAP SİLME BAŞKALARININ VERİSİNİ GÖTÜRMÜYOR.
 *
 * ⚠️ BULUNAN: `routes/users.cjs` hesap silme akışı TÜM arkadaşlık verisini
 * okuyup kullanıcıya ait satırları süzüyor ve TÜMÜNÜ geri yazıyordu
 * (`SocialStore.saveFriends` → `replaceAll`, tüm koleksiyonu değiştirir).
 * Gruplar için de aynısı.
 *
 * Okuma ile yazma arasında başkalarının kurduğu arkadaşlık, gönderdiği istek,
 * koyduğu engel SESSİZCE siliniyordu — hesabını silen bir kullanıcı, o sırada
 * arkadaş olan iki yabancının bağlantısını da götürüyordu.
 *
 * ÖLÇÜLDÜ: silme akışı sürerken `cem-deniz` arkadaşlığı ve `mehmet→zeynep`
 * isteği eklendi; snapshot geri yazılınca İKİSİ DE yok oldu. Hata yok, log yok.
 *
 * ⚠️ BU KUSURU `tests/snapshot-yazimi-nobetcisi.test.cjs` BULDU. Turnuvada
 * aynı sınıfı düzelttikten sonra nöbetçiyi yazdım; ilk çalıştırmada muafiyet
 * listemde olmayan bu iki yeri gösterdi.
 */

const os = require("os");
const nodePath = require("path");
const fs = require("fs");

const TMP = nodePath.join(os.tmpdir(), "skorlig-hesap-silme-test");
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
process.env.SKORLIG_DATA_DIR = TMP;

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

let mongod = null, client = null, db = null, S = null;

before(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const { MongoClient } = require("mongodb");
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  client = await MongoClient.connect(mongod.getUri());
  /* Veritabanı adı lib/mongo.cjs ile aynı olmalı — bkz. turnuva testindeki not. */
  db = client.db("skorlig");
  S = require("../lib/social-store.cjs");
});

after(async () => {
  /* Global bağlantı kapatılmazsa koşucu asılı kalır. */
  try { await require("../lib/mongo.cjs").close(); } catch {}
  if (client) await client.close();
  if (mongod) await mongod.stop();
});

const baglar = async () =>
  (await S.loadFriends(db)).links.map((l) => `${l.a}-${l.b}`).sort();

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("arkadaşlık GERÇEKTEN yazılıyor", async () => {
    /* Sıfır sonuç kanıt değil: yazma hiç çalışmasaydı "silindi" iddiaları da
     * kendiliğinden geçerdi. */
    await S.addLink("k-a", "k-b", db);
    const l = await baglar();
    assert.ok(l.includes("k-a-k-b"), `baglanti yazilmadi: ${JSON.stringify(l)}`);
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("hedefli silme", () => {
  test("kullanıcının kayıtları gidiyor, İLGİSİZ olanlar duruyor", async () => {
    await S.addLink("silinen", "biri", db);
    await S.addLink("ali", "veli", db);
    await S.addRequest("silinen", "baskasi", db);
    await S.addBlock("ucuncu", "dorduncu", db);

    const r = await S.removeUserFromSocial("silinen", db);
    assert.equal(r.ok, true, `silme basarisiz: ${JSON.stringify(r)}`);

    const kalan = await baglar();
    assert.ok(
      !kalan.some((x) => x.includes("silinen")),
      `silinen kullanicinin baglantisi duruyor: ${JSON.stringify(kalan)}`
    );
    assert.ok(
      kalan.includes("ali-veli"),
      `ILGISIZ baglanti silindi: ${JSON.stringify(kalan)}`
    );

    const veri = await S.loadFriends(db);
    assert.ok(
      !veri.requests.some((x) => String(x.from ?? x.a).toLowerCase() === "silinen"),
      "silinen kullanicinin istegi duruyor"
    );
    assert.equal(
      veri.blocks.length, 1,
      `ILGISIZ engel silindi: ${JSON.stringify(veri.blocks)}`
    );
  });

  test("ARAYA GİREN yazmalar korunuyor", async () => {
    /**
     * Kusurun özü buydu: silme akışı snapshot alıp geri yazınca, arada
     * eklenen kayıtlar yok oluyordu. Hedefli `deleteMany` yalnızca eşleşen
     * satırları siler, koleksiyonun geri kalanına dokunmaz.
     */
    await S.addLink("ar-silinen", "ar-biri", db);

    /* Silme ile aynı anda gelen yazmalar */
    const [, , silme] = await Promise.all([
      S.addLink("cem", "deniz", db),
      S.addRequest("mehmet", "zeynep", db),
      S.removeUserFromSocial("ar-silinen", db),
    ]);
    assert.equal(silme.ok, true);

    const veri = await S.loadFriends(db);
    const l = veri.links.map((x) => `${x.a}-${x.b}`);
    const q = veri.requests.map((x) => `${x.from ?? x.a}->${x.to ?? x.b}`);

    assert.ok(
      l.includes("cem-deniz"),
      `araya giren arkadaslik silindi: ${JSON.stringify(l)} — snapshot yazimi ` +
      `koleksiyonun tamamini degistiriyor`
    );
    assert.ok(
      q.includes("mehmet->zeynep"),
      `araya giren istek silindi: ${JSON.stringify(q)}`
    );
    assert.ok(
      !l.some((x) => x.includes("ar-silinen")),
      `silinmesi gereken baglanti duruyor: ${JSON.stringify(l)}`
    );
  });

  test("harf düzeni farklı olsa da siliniyor", async () => {
    /**
     * ⚠️ `addLink` kimlikleri HAM saklıyor (`{a: String(a)}`), eski süzme
     * ölçütü ise `toLowerCase()` karşılaştırması yapıyordu. Hedefli silmede
     * düz eşitlik kullansaydım "HarfLi" kaydı "harfli" hesabı silinince
     * geride kalırdı.
     */
    await S.addLink("HarfLi", "karsi", db);
    const r = await S.removeUserFromSocial("harfli", db);
    assert.equal(r.ok, true);

    const kalan = await baglar();
    assert.ok(
      !kalan.some((x) => x.toLowerCase().includes("harfli")),
      `harf duzeni farkli kayit silinmedi: ${JSON.stringify(kalan)}`
    );
  });
});

describe("gruplar", () => {
  test("sahip olduğu grup silinir, üyelikten çıkarılır, İLGİSİZ grup durur", async () => {
    await S.saveGroups({
      SAHIP1: { name: "Benim", ownerId: "g-silinen", members: ["g-silinen", "x"] },
      UYE1:   { name: "Uyeyim", ownerId: "baskasi", members: ["baskasi", "g-silinen"] },
      ILGISIZ:{ name: "Ilgisiz", ownerId: "yabanci", members: ["yabanci"] },
    }, db);

    const r = await S.removeUserFromGroups("g-silinen", db);
    assert.equal(r.ok, true, `grup silme basarisiz: ${JSON.stringify(r)}`);

    const g = await S.loadGroups(db);
    assert.ok(!g.SAHIP1, "sahip oldugu grup silinmedi");
    assert.ok(g.UYE1, "uye oldugu grup YANLISLIKLA silindi");
    assert.ok(
      !(g.UYE1.members || []).includes("g-silinen"),
      `uyelikten cikarilmadi: ${JSON.stringify(g.UYE1.members)}`
    );
    assert.ok(g.ILGISIZ, "ILGISIZ grup silindi");
    assert.deepEqual(
      g.ILGISIZ.members, ["yabanci"],
      `ILGISIZ grubun uyeleri degisti: ${JSON.stringify(g.ILGISIZ.members)}`
    );
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: hesap silme hedefli depo çağrılarını kullanıyor", () => {
  const src = fs.readFileSync(
    nodePath.join(__dirname, "..", "routes", "users.cjs"), "utf8"
  );
  const kod = src.split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");

  for (const cagri of ["removeUserFromSocial", "removeUserFromGroups"]) {
    assert.ok(
      kod.includes(cagri),
      `hesap silme ${cagri} kullanmiyor — snapshot yazimina geri donulmus, ` +
      `araya giren her arkadaslik/istek/grup sessizce silinir`
    );
  }
});
