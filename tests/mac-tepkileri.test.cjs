"use strict";

/**
 * MAÇ TEPKİLERİ — kapalı listeli maç odası.
 *
 * BU TESTİN ASIL İŞİ: odanın SERBEST METİN TAŞIMADIĞINI korumak.
 *
 * Özelliğin bütün gerekçesi bu: sohbet yerine kapalı liste seçildi ki
 * moderasyon yükü sıfır kalsın. Doğrulama istemciye kayarsa özellik anlamını
 * yitirir — elle atılan bir POST istediği metni `key` olarak yazar ve odada
 * moderasyonsuz serbest metin belirir. Sunucu tarafı doğrulama bu özelliğin
 * TEK güvenlik özelliği; testin çoğu ona bakıyor.
 *
 * İkinci iş: kimliğin GÖVDEDEN alınmadığını korumak. Bu depoda aynı sınıf
 * defalarca bulundu (bkz. lib/kimlik-kontrol.cjs).
 */

const test = require("node:test");
const describe = require("node:test").describe;
const assert = require("node:assert/strict");
const os = require("os");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "skorlig-tepki-"));
process.env.SKORLIG_DATA_DIR = TMP;
process.env.SKORLIG_BG = "0";
/* Bekleme süresini testte kısaltıyoruz: 3 sn beklemek testi 20 sn uzatırdı.
 * Beklemenin KENDİSİ ayrıca sınanıyor (aşağıda), yani kısaltmak koruma
 * kaybettirmiyor. */
process.env.SKORLIG_TEPKI_BEKLEME_MS = "120";
process.env.SKORLIG_TEPKI_KISI_AZAMI = "5";

const vt = require.resolve(path.join(KOK, "middleware", "verifyToken.cjs"));
require.cache[vt] = { id: vt, filename: vt, loaded: true, exports: {
  verifyToken: (q, r, n) => {
    if (!q.headers["x-user-id"]) return r.status(401).json({ ok: false, error: "AUTH" });
    q.uid = q.headers["x-user-id"]; n();
  },
  optionalToken: (q, _r, n) => { q.uid = q.headers["x-user-id"] || null; n(); },
  getFirebaseAuth: () => null, kimlikModu: () => "test",
}};

const uyu = (ms) => new Promise((r) => setTimeout(r, ms));

describe("maç tepkileri", () => {
  let mongod, cli, db, srv, port, Store;

  test("kur", async () => {
    const { MongoMemoryServer } = require("mongodb-memory-server");
    const { MongoClient } = require("mongodb");
    const express = require("express");
    mongod = await MongoMemoryServer.create();
    cli = await MongoClient.connect(mongod.getUri());
    db = cli.db("t");

    await db.collection("users").insertMany([
      { userId: "AYSE", userIdLower: "ayse", nickname: "Ayşe" },
      { userId: "BURAK", userIdLower: "burak", nickname: "Burak" },
    ]);

    Store = require(path.join(KOK, "lib", "reactions-store.cjs"));

    const app = express();
    app.use((q, _r, n) => { q.app.locals.db = db; n(); });
    app.use("/api/rt", require(path.join(KOK, "routes", "reactions.cjs")));
    srv = app.listen(0);
    port = srv.address().port;
  });

  const G = (yol, h) =>
    fetch(`http://127.0.0.1:${port}${yol}`, { headers: h || {} })
      .then(async (r) => ({ s: r.status, j: await r.json().catch(() => null) }));

  const P = (govde, h) =>
    fetch(`http://127.0.0.1:${port}/api/rt/reactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(h || {}) },
      body: JSON.stringify(govde),
    }).then(async (r) => ({ s: r.status, j: await r.json().catch(() => null) }));

  const AYSE = { "x-user-id": "AYSE" };
  const BURAK = { "x-user-id": "BURAK" };

  /* ── Temel akış ────────────────────────────────────────────────────────── */

  describe("temel akış", () => {
    test("kurulum: oda BAŞTA boş", async () => {
      /* Sıfır sonuç kanıt değildir — bu yüzden dolmadan ÖNCEKİ hâli ölçüyoruz
       * ki aşağıdaki sayımların gerçekten yazmadan geldiği belli olsun. */
      const r = await G("/api/rt/reactions?fixtureId=FX1");
      assert.equal(r.s, 200);
      assert.equal(r.j?.total, 0, "yeni mac odasi bos baslamali");
      assert.deepEqual(r.j?.counts, {});
    });

    test("tepki yazılıyor ve sayımda görünüyor", async () => {
      const p = await P({ fixtureId: "FX1", key: "gol" }, AYSE);
      assert.equal(p.s, 200, `yazma reddedildi: ${JSON.stringify(p.j)}`);
      assert.equal(p.j?.counts?.gol, 1, "yanit GUNCEL sayimi icermeli — istemci " +
        "yoklamayi beklemeden dogru sayiyi gosterebilsin");

      const r = await G("/api/rt/reactions?fixtureId=FX1");
      assert.equal(r.j?.counts?.gol, 1);
      assert.equal(r.j?.total, 1);
    });

    test("akışta görünen ad çözülüyor", async () => {
      const r = await G("/api/rt/reactions?fixtureId=FX1");
      const olay = r.j?.feed?.[0];
      assert.ok(olay, "akis bos");
      assert.equal(olay.key, "gol");
      assert.equal(olay.displayName, "Ayşe",
        "gorunen ad cozulmedi — odada ham kimlikler gorunur");
    });

    test("farklı kullanıcılar birbirini EZMİYOR", async () => {
      /* Tek belgede sayaç tutulsaydı ikinci yazma birincinin uzerine yazardi
       * (bkz. snapshot-yazimi-nobetcisi). Olay basina belge tam bunu onluyor. */
      await uyu(150);
      await P({ fixtureId: "FX1", key: "ates" }, BURAK);
      const r = await G("/api/rt/reactions?fixtureId=FX1");
      assert.equal(r.j?.counts?.gol, 1, "ilk tepki kayboldu");
      assert.equal(r.j?.counts?.ates, 1, "ikinci tepki yazilmadi");
      assert.equal(r.j?.total, 2);
    });

    test("maçlar birbirine KARIŞMIYOR", async () => {
      const r = await G("/api/rt/reactions?fixtureId=FX2");
      assert.equal(r.j?.total, 0, "baska macin tepkileri sizdi");
    });
  });

  /* ── Asıl koruma: serbest metin yok ────────────────────────────────────── */

  describe("kapalı liste", () => {
    test("LİSTEDE OLMAYAN anahtar REDDEDİLİYOR", async () => {
      const p = await P({ fixtureId: "FX1", key: "hakem satilmis seni ..." }, AYSE);
      assert.equal(p.s, 400,
        "serbest metin `key` olarak kabul edildi — odada moderasyonsuz metin " +
        "belirir ve ozelligin butun gerekcesi cokerdi");
      assert.equal(p.j?.error, "UNKNOWN_REACTION");
    });

    test("reddedilen metin SAKLANMIYOR", async () => {
      /* Reddetmek yetmez: 400 dönüp yine de yazan bir sürüm testin ilk
       * iddiasını geçerdi. Depoya doğrudan bakıyoruz. */
      const hepsi = await db.collection(Store.COLL).find({ fixtureIdLower: "fx1" }).toArray();
      const metinler = hepsi.map((o) => o.key);
      assert.ok(
        metinler.every((k) => Store.TEPKI_KUMESI.has(k)),
        `depoda liste disi anahtar var: ${JSON.stringify(metinler)}`
      );
    });

    test("izin verilen liste SUNUCUDAN dönüyor", async () => {
      /* İstemci kendi kopyasını tutarsa iki liste sessizce ayrışır ve kullanıcı
       * bastığı tepkinin reddedildiğini ancak deneyince öğrenir. */
      const r = await G("/api/rt/reactions?fixtureId=FX1");
      assert.ok(Array.isArray(r.j?.keys) && r.j.keys.length > 0, "keys donmuyor");
      assert.deepEqual([...r.j.keys].sort(), [...Store.TEPKILER].sort());
    });

    test("NEGATİF KONTROL: listedeki anahtar KABUL ediliyor", async () => {
      /* Yukarıdaki reddetme, uç her şeyi reddettiği için de geçebilirdi.
       * Bu iddia sondanın gerçekten AYIRT ettiğini gösteriyor. */
      await uyu(150);
      const p = await P({ fixtureId: "FX3", key: Store.TEPKILER[0] }, AYSE);
      assert.equal(p.s, 200, "gecerli anahtar da reddediliyor — uc her seyi rededdiyor");
    });
  });

  /* ── Kimlik ────────────────────────────────────────────────────────────── */

  describe("kimlik", () => {
    test("KİMLİKSİZ yazamıyor", async () => {
      const p = await P({ fixtureId: "FX1", key: "gol" }, {});
      assert.equal(p.s, 401, "kimliksiz tepki yazabiliyor");
    });

    test("kimlik GÖVDEDEN alınmıyor", async () => {
      /* Gövdeye baskasinin kimligini yazip onun adina tepki basmak. */
      await uyu(150);
      await P({ fixtureId: "FX4", key: "helal", userId: "BURAK" }, AYSE);
      const r = await G("/api/rt/reactions?fixtureId=FX4");
      assert.equal(r.j?.feed?.[0]?.userId, "AYSE",
        "govdedeki userId kullanildi — herkes herkesin adina tepki basabilir");
    });

    test("misafir odayı OKUYABİLİYOR", async () => {
      /* Aşırı kilitlemek de kusur olurdu: odanın dolu görünmesi, kayıt olmayan
       * kullanıcıyı içeri çeken şeyin ta kendisi. */
      const r = await G("/api/rt/reactions?fixtureId=FX1", {});
      assert.equal(r.s, 200);
      assert.ok(r.j?.total > 0, "misafire oda bos gorunuyor");
    });
  });

  /* ── Sel koruması ──────────────────────────────────────────────────────── */

  describe("sel koruması", () => {
    test("arka arkaya basma BEKLETİLİYOR", async () => {
      await uyu(150);
      const ilk = await P({ fixtureId: "FX5", key: "sok" }, AYSE);
      assert.equal(ilk.s, 200, "ilk tepki gecmeliydi");

      const hemen = await P({ fixtureId: "FX5", key: "sok" }, AYSE);
      assert.equal(hemen.s, 429, "bekleme suresi uygulanmiyor — tek kullanici " +
        "odayi saniyede onlarca tepkiyle doldurabilir");
      assert.equal(hemen.j?.error, "TOO_FAST");
    });

    test("bekleme dolunca YENİDEN yazılabiliyor", async () => {
      /* Negatif kontrol: yukarıdaki 429, uç sürekli 429 döndüğü için de
       * geçebilirdi. */
      await uyu(150);
      const p = await P({ fixtureId: "FX5", key: "sok" }, AYSE);
      assert.equal(p.s, 200, "bekleme dolduktan sonra da reddediliyor");
    });

    test("maç başına ÜST SINIR var", async () => {
      const AZAMI = Store.KISI_BASI_AZAMI;
      let sonuncu = null;
      // Sınıra kadar bas (FX5'te zaten 2 tane var).
      for (let i = 0; i < AZAMI + 2; i++) {
        await uyu(150);
        sonuncu = await P({ fixtureId: "FX5", key: "guldum" }, AYSE);
        if (sonuncu.s === 429 && sonuncu.j?.error === "REACTION_LIMIT") break;
      }
      assert.equal(sonuncu?.j?.error, "REACTION_LIMIT",
        `kisi basi ust sinir (${AZAMI}) uygulanmiyor — tek kullanici odayi ` +
        `sinirsiz doldurabilir`);
    });

    test("sınır KİŞİ BAŞINA, oda geneline değil", async () => {
      /* Ayşe sınırı doldurdu; Burak hâlâ yazabilmeli. Sınırın yanlış yerde
       * (maç başına) uygulanması odayı ilk gelen için kapatırdı. */
      await uyu(150);
      const p = await P({ fixtureId: "FX5", key: "helal" }, BURAK);
      assert.equal(p.s, 200,
        "bir kullanicinin sinir doldurmasi DIGERLERINI de kilitliyor");
    });

    test("sınır MAÇ BAŞINA, kullanıcı geneline değil", async () => {
      /* Ayşe FX5'te sınırı doldurdu ama başka maça yazabilmeli. */
      await uyu(150);
      const p = await P({ fixtureId: "FX6", key: "gol" }, AYSE);
      assert.equal(p.s, 200,
        "bir mactaki sinir kullaniciyi TUM maclarda kilitliyor");
    });
  });

  /* ── Uç gerçekten bağlı mı ─────────────────────────────────────────────── */

  describe("uç sunucuya bağlı", () => {
    test("server.cjs reactions rotasını MOUNT ediyor", () => {
      /* Modül kusursuz calissa bile sunucu onu baglamiyorsa kullanici hicbir
       * sey gormez. Bugun ayni kopus DailyMatchCard'ta yasandi: bilesen
       * yazilmis, hicbir ekrana baglanmamisti. */
      const src = fs.readFileSync(path.join(KOK, "server.cjs"), "utf8");
      assert.ok(
        /require\(["']\.\/routes\/reactions\.cjs["']\)/.test(src),
        "routes/reactions.cjs server.cjs icinde hic yuklenmiyor — uc ERISILEMEZ"
      );
      const satir = src.split("\n").find((l) => /routes\/reactions\.cjs/.test(l));
      assert.ok(/["']\/api\/rt["']/.test(satir),
        `reactions /api/rt altina baglanmali (istemci oraya bakiyor): ${satir}`);
    });

    test("hız sınırı kuralı TANIMLI", () => {
      /* Kural yoksa DEFAULT_RULE (120/dk) gecerli olurdu — bir tepki ucu icin
       * fazla comert. */
      const rl = require(path.join(KOK, "middleware", "rateLimit.cjs"));
      const src = fs.readFileSync(path.join(KOK, "middleware", "rateLimit.cjs"), "utf8");
      assert.ok(/reactions/.test(src), "reactions icin hiz siniri kurali yok");
      assert.ok(!/\/api\\\/rt\\\/reactions[^\n]*SKIP/.test(src));
    });
  });

  test("kapat", async () => {
    try { srv?.close(); } catch {}
    try { await cli?.close(); } catch {}
    try { await mongod?.stop(); } catch {}
  });
});
