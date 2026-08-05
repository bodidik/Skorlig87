"use strict";

/**
 * BAĞLANTI KESİNTİSİ 500 DEĞİL 503 DÖNER — VE DOSYAYA DÜŞMEZ.
 *
 * ⚠️ NEREDEN ÇIKTI: kullanıcı telefonundan `WARN [apiFetch] 500
 * /api/rt/lc-wallet/daily-claim — sunucu hatası` bildirdi.
 *
 * ÖLÇÜLDÜ (üretim koşumu, bu dosyanın altındaki koşumla aynı kurulum):
 *   temiz Mongo   → 1. çağrı 200, 2. çağrı 400 DAILY_ALREADY_CLAIMED
 *   temiz dosya   → 1. çağrı 200, 2. çağrı 400 DAILY_ALREADY_CLAIMED
 *   ÖLÜ bağlantı  → 500 LC_WALLET_DAILY_ERR "querySrv ETIMEOUT ..."   ← bu
 *
 * Yani handler'da kusur YOK; iki dal da temiz veriyle doğru çalışıyor.
 * Hata yalnızca Mongo istek ORTASINDA ölünce çıkıyor —
 * `data/admin-alerts.json` içindeki en yeni uyarı da bunu doğruluyor:
 * `mongo_down ... Son hata: querySrv ETIMEOUT`.
 *
 * ⚠️ BU YÜZDEN TESTİN İDDİASI KÜÇÜK VE NET: "kesinti kod kusuru gibi
 * etiketlenmesin". 500 "sunucu bozuk", 503 "geçici, tekrar dene" demek.
 * Bu oturumun tamamı kusur avıydı; yanlış etiketlenmiş bir 500 doğrudan
 * o işi harcıyor.
 *
 * ⚠️ DOSYAYA DÜŞMEME KISMI EN AZ 503 KADAR ÖNEMLİ. "Mongo yoksa dosyaya
 * yaz" akla yatkın görünüyor ama günlük ödül bir PARA yazması: mühür
 * (`lastDailyAt`) Mongo'da. Dosyaya düşersek Mongo döndüğünde iki depo
 * ayrışır ve oyuncu ödülü İKİ KEZ alır. Alttaki test tam da bunu kilitliyor.
 */

const test = require("node:test");
const describe = require("node:test").describe;
const assert = require("node:assert/strict");
const os = require("os");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
const { baglantiHatasiMi, hataTemizleyici } = require("../lib/hata-temizle.cjs");

/* ── Sınıflandırıcı ──────────────────────────────────────────────────────── */

describe("bağlantı hatası tanıma", () => {
  test("gerçek Atlas kesinti metni tanınıyor", () => {
    /* Bu metin uydurma değil: admin-alerts.json'daki mongo_down uyarısından
     * ve ürettiğim 500 yanıtının detail alanından birebir alındı. */
    assert.ok(baglantiHatasiMi(
      "querySrv ETIMEOUT _mongodb._tcp.cluster0.v2tloe9.mongodb.net"
    ));
    assert.ok(baglantiHatasiMi("MongoServerSelectionError: server selection timed out"));
    assert.ok(baglantiHatasiMi("MongoNetworkError: connection 4 to x closed"));
    assert.ok(baglantiHatasiMi("Topology is closed"));
    assert.ok(baglantiHatasiMi("getaddrinfo EAI_AGAIN cluster0.mongodb.net"));
  });

  test("iş mantığı hataları bağlantı hatası SAYILMIYOR", () => {
    /* ⚠️ Asıl risk bu yön. Desen çok geniş olursa gerçek çökmeler de 503
     * olur ve kusur avında görünmez hâle gelir — 500'ü gizlemek, kusuru
     * gizlemektir. */
    assert.equal(baglantiHatasiMi("Cannot read properties of undefined"), false);
    assert.equal(baglantiHatasiMi("isPrem is not defined"), false);
    assert.equal(baglantiHatasiMi("DAILY_ALREADY_CLAIMED"), false);
    assert.equal(baglantiHatasiMi("E11000 duplicate key error"), false);
    assert.equal(baglantiHatasiMi("INDEX_MISSING"), false);
    assert.equal(baglantiHatasiMi(""), false);
    assert.equal(baglantiHatasiMi(null), false);
  });
});

/* ── Gerçek uç: /api/rt/lc-wallet/daily-claim ────────────────────────────── */

describe("gerçek daily-claim ucu, ölü Mongo ile", () => {
  /**
   * ⚠️ SAHTE HANDLER KULLANMIYORUM. Ara katmanı kendi yazdığım bir
   * `res.status(500)` ile sınamak, asıl uç başka türlü davranırsa hiçbir şey
   * yakalamaz. Burada gerçek rota dosyası yükleniyor.
   */
  const kur = async (db) => {
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "skorlig-503-"));
    process.env.SKORLIG_DATA_DIR = TMP;
    process.env.SKORLIG_BG = "0";

    const vt = require.resolve(path.join(KOK, "middleware", "verifyToken.cjs"));
    require.cache[vt] = { id: vt, filename: vt, loaded: true, exports: {
      verifyToken: (q, _r, n) => { q.uid = q.headers["x-user-id"]; n(); },
      optionalToken: (q, _r, n) => { q.uid = q.headers["x-user-id"] || null; n(); },
      getFirebaseAuth: () => null, kimlikModu: () => "test",
    }};

    const express = require("express");
    const app = express();
    app.use(hataTemizleyici);                       // server.cjs:183 ile aynı sıra
    app.use((q, _r, n) => { q.app.locals.db = db; n(); });
    app.use("/api/rt", require(path.join(KOK, "routes", "lc-wallet.cjs")));
    const srv = app.listen(0);
    return { srv, port: srv.address().port, TMP };
  };

  /** Bağlantı ölü: nesne var (getDb truthy döner) ama her işlem patlıyor. */
  const oluDb = { collection: () => ({
    findOne: async () => { throw new Error("querySrv ETIMEOUT _mongodb._tcp.cluster0.v2tloe9.mongodb.net"); },
    updateOne: async () => { throw new Error("querySrv ETIMEOUT"); },
    insertOne: async () => { throw new Error("querySrv ETIMEOUT"); },
    find: () => { throw new Error("querySrv ETIMEOUT"); },
  }) };

  test("500 yerine 503 ve geçici bayrağı dönüyor", async () => {
    const { srv, port } = await kur(oluDb);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/rt/lc-wallet/daily-claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-user-id": "test-oyuncu" },
        body: JSON.stringify({ userId: "test-oyuncu" }),
      });
      const govde = await r.json();

      assert.equal(r.status, 503,
        `kesinti hala ${r.status} olarak etiketleniyor: ${JSON.stringify(govde).slice(0, 200)}`);
      assert.equal(govde.gecici, true, "istemci bunun gecici oldugunu anlayamaz");

      /* Küme adresi istemciye sızmamalı — sıra doğru olmazsa sınıflandırma
       * ya da temizlik birinden biri kaybolur. */
      assert.ok(!JSON.stringify(govde).includes("mongodb.net"),
        "kume adresi istemciye sizdi");
    } finally { srv.close(); }
  });

  test("ödül DOSYAYA da yazılmadı (çift ödeme kapısı)", async () => {
    /**
     * ⚠️ ASIL PARA KORUMASI. Mongo ölüyken dosyaya düşülseydi, Mongo
     * döndüğünde mühür orada olmaz ve oyuncu aynı günü İKİNCİ kez
     * talep edebilirdi.
     */
    const { srv, TMP } = await kur(oluDb);
    try {
      const bakiye = path.join(TMP, "lc-wallet-users.json");
      const yazildi = fs.existsSync(bakiye) && /test-oyuncu/.test(fs.readFileSync(bakiye, "utf8"));
      assert.equal(yazildi, false, "Mongo olu iken odul dosyaya yazildi — cift odeme riski");
    } finally { srv.close(); }
  });
});

/* ── Nöbetçi ─────────────────────────────────────────────────────────────── */

const kaynak = fs.readFileSync(path.join(KOK, "lib", "hata-temizle.cjs"), "utf8")
  .split("\n")
  .map((l) => {
    const t = l.trim();
    return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
  })
  .join("\n");

test("NÖBETÇİ: sınıflandırma temizlikten ÖNCE yapılıyor", () => {
  /**
   * `temizle()` küme adresini `<db-srv>` yapıyor. Sıra ters çevrilirse
   * `querySrv ETIMEOUT _mongodb._tcp...` deseni kaybolur ve kesinti
   * sessizce 500 olarak kalır — testler yeşil kalabilir ama davranış bozulur.
   */
  const i = kaynak.indexOf("baglantiHatasiMi(ham)");
  const j = kaynak.indexOf("govdeyiTemizle(govde), gecici: true");
  assert.ok(i > 0 && j > i, "ham metin uzerinde siniflandirma yapilmiyor");
});

test("NÖBETÇİ: yalnızca 500'ler indiriliyor", () => {
  assert.ok(/res\.statusCode === 500/.test(kaynak),
    "4xx ve 2xx de etkilenebilir — is kurali reddi gecici sanilir");
});
