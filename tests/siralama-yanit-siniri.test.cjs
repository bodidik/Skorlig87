"use strict";

/**
 * SIRALAMA YANITI İSTENİRSE SINIRLANABİLİR — SIRALAR BOZULMADAN.
 *
 * ⚠️ ÖLÇÜLDÜ (2026-08-02, canlı sunucu): varsayılan istek 1575 satır,
 * 256 KB, 660 ms döndürüyordu. `app/(tabs)/stats.tsx` bunun İLK 100'ünü
 * çiziyor ("Daha fazla göster" ile 100'er açılıyor) — yani 16 KATI veri
 * indiriliyordu.
 *
 * ⚠️ EKRAN TARAFI ZATEN DÜZELTİLMİŞTİ, AĞ TARAFI KALMIŞTI. stats.tsx'te
 * "hepsini çizmek arayüzü donduruyordu" notu var ve çizim 100 ile
 * sınırlanmış; ama istek hâlâ tüm tabloyu çekiyordu. Yarım düzeltmenin
 * tipik izi: belirti kaybolur, maliyet kalır.
 *
 * ⚠️ ASIL RİSK BÜYÜMEDE: uygulama küresel tasarlanmış (19 ülkelik bot
 * kadrosu). 50 bin kullanıcıda bu uç ~8 MB gönderirdi.
 *
 * ⚠️ VARSAYILAN DEĞİŞTİRİLMEDİ, bilinçli: sessizce kırpmak 2000. sıradaki
 * oyuncunun kendini hiç görememesi demekti. Kırpma çağıranın AÇIK tercihi.
 *
 * ⚠️ SIRALAMA META VERİSİ TAM KÜMEDEN: `scope.poolSize`, `botCount`,
 * `humanCount` ve sıra numaraları kırpmadan ÖNCE hesaplanır. Ters sıra
 * (önce kes, sonra hesapla) havuzu ve sıraları bozardı — bu test onu tutuyor.
 */

const test = require("node:test");
const describe = require("node:test").describe;
const assert = require("node:assert/strict");
const path = require("path");
const os = require("os");
const fs = require("fs");

const KOK = path.join(__dirname, "..");
let MongoMemoryServer = null;
try { ({ MongoMemoryServer } = require("mongodb-memory-server")); } catch {}
const atla = () => !MongoMemoryServer;
const sebep = "mongodb-memory-server kurulu degil";

const KUM = fs.mkdtempSync(path.join(os.tmpdir(), "skorlig-lb-"));
process.env.SKORLIG_DATA_DIR = KUM;

const Season = require("../lib/season.cjs");
const SEZON = Season.seasonKey();
const N = 250;

describe("sıralama yanıt sınırı", () => {
  let mongod, cli, db, srv, port;

  test("kur", { skip: atla() && sebep }, async () => {
    const { MongoClient } = require("mongodb");
    mongod = await MongoMemoryServer.create();
    /* ⚠️ KÜRESEL BAĞLANTIYI DA BELLEK-İÇİNE YÖNLENDİR. Depolar `db`
     * verilmediğinde `getDb()` üzerinden KÜRESEL bağlantıyı deniyor; .env'deki
     * gerçek Atlas adresine gidip istek 10 sn zaman aşımına uğruyordu.
     * (tests/e2e-cekirdek-dongu.test.cjs aynı izolasyonu yapıyor.) */
    process.env.MONGODB_URI = mongod.getUri();
    process.env.MONGODB_DB = "t";
    cli = await MongoClient.connect(mongod.getUri());
    db = cli.db("t");
    await db.collection("season_totals").insertMany(
      Array.from({ length: N }, (_, i) => ({
        season: SEZON,
        userIdLower: `u${i}`,
        userId: `U${i}`,
        totalPoints: N - i,      // azalan: sira belirgin olsun
        matches: 12,
        totalPenalty: 0,
      }))
    );

    const express = require("express");
    const app = express();
    app.use((q, _r, n) => { q.app.locals.db = db; n(); });
    app.use("/api/leaderboard", require(path.join(KOK, "routes", "leaderboard.cjs")));
    await new Promise((r) => { srv = app.listen(0, r); });
    port = srv.address().port;
  });

  const al = (q) =>
    fetch(`http://127.0.0.1:${port}/api/leaderboard/${q}`, { signal: AbortSignal.timeout(10000) })
      .then(async (r) => ({ s: r.status, j: await r.json().catch(() => null) }));

  test("kurulum sınandı: sınırsız istek TÜM satırları döndürüyor", { skip: atla() && sebep }, async () => {
    /* ⚠️ Bu olmadan "sınır çalışıyor" iddiası hiçbir şey kanıtlamaz:
     * uç zaten boş dönüyorsa her limit testi geçer. */
    const r = await al("");
    assert.equal(r.s, 200);
    assert.equal((r.j.leaderboard || []).length, N, "tum satirlar donmuyor — test bir sey olcmuyor");
  });

  test("limit İSTENİRSE uygulanıyor", { skip: atla() && sebep }, async () => {
    const r = await al("?limit=20");
    assert.equal((r.j.leaderboard || []).length, 20, "limit yoksayiliyor — 250 satir gonderiliyor");
  });

  test("VARSAYILAN değişmedi (sessiz kırpma yok)", { skip: atla() && sebep }, async () => {
    /* ⚠️ Sessizce kırpmak, alt sıradaki oyuncunun kendini hiç görememesi
     * demekti. Kırpma çağıranın açık tercihi olmalı. */
    const r = await al("");
    assert.equal((r.j.leaderboard || []).length, N, "varsayilan istek sessizce kirpiliyor");
  });

  test("SIRALAR ve HAVUZ tam kümeden — kırpma bozmuyor", { skip: atla() && sebep }, async () => {
    /**
     * ⚠️ İKİ İDDİA, BİRİ YAPISAL BİRİ YÜK TAŞIYOR — ayrımı yazıyorum çünkü
     * negatif kontrol bunu ortaya çıkardı:
     *
     *   poolSize : YAPISAL GÜVENCE. `scopedRank` içinde havuzdan hesaplanıyor
     *              (`poolSize: pool.length`), yani kırpmadan bağımsız. Meta'yı
     *              kırpılmış listeden hesaplamayı DENEDİM, test kırılmadı —
     *              çünkü kırılamaz. Burada belge olarak duruyor, kanıt olarak
     *              değil. Bu yapı değişirse asıl koruma alttaki iddiadır.
     *
     *   sıralama : ASIL YÜK BU. Kırpılmış liste, tam listenin BAŞI olmalı.
     *              `kirp` bozulursa (yanlış dilim, sıralamadan önce kesme)
     *              burada yakalanır.
     */
    const tam = await al("");
    const kirpik = await al("?limit=20");
    assert.equal(kirpik.j.scope.poolSize, tam.j.scope.poolSize,
      "havuz boyutu kirpmaya gore degisti — yapisal guvence bozulmus, alttaki siralama iddiasi tek koruma");
    assert.deepEqual(
      (kirpik.j.leaderboard || []).map((x) => x.userId),
      (tam.j.leaderboard || []).slice(0, 20).map((x) => x.userId),
      "kirpilmis liste tam listenin bası degil — siralama bozulmus"
    );
  });

  test("saçma limit değerleri güvenli", { skip: atla() && sebep }, async () => {
    assert.equal((await al("?limit=0")).j.leaderboard.length, N, "limit=0 tumunu dondurmeli (gecersiz)");
    assert.equal((await al("?limit=-5")).j.leaderboard.length, 1, "negatif limit en az 1'e cekilmeli");
    assert.equal((await al("?limit=abc")).j.leaderboard.length, N, "sayi olmayan limit yoksayilmali");
    assert.equal((await al("?limit=99999")).j.leaderboard.length, N, "tavan ustu limit tum listeyi vermeli");
  });

  test("İSTEMCİ limit gönderiyor (yarım düzeltme olmasın)", { skip: atla() && sebep }, () => {
    /**
     * ⚠️ SUNUCUYA SINIR EKLEYİP İSTEMCİYİ BAĞLAMAMAK, KUSURU ÇÖZMEZ —
     * 256 KB gitmeye devam ederdi. Bugün tam bu yarım-düzeltme biçimini
     * üç kez gördüm (Mongo dalı vs dosya yedeği, depo vs rota, ekran çizimi
     * vs ağ). Bu iddia bağlantının kurulu kaldığını tutuyor.
     */
    const MOBIL = path.join(KOK, "..", "mobile");
    const ekran = path.join(MOBIL, "app", "(tabs)", "stats.tsx");
    if (!fs.existsSync(ekran)) return; // mobil depo yaninda degil
    const src = fs.readFileSync(ekran, "utf8");
    assert.ok(/limit=\$\{sinir\}/.test(src),
      "stats ekrani limit GONDERMIYOR — sunucudaki sinir kullanilmiyor, tum tablo iniyor");
    /* ⚠️ Sınır DURUMDAN değil PARAMETREDEN okunmalı: setState eşzamansız,
     * hemen ardından yapılan istek eski sınırı gönderirdi. */
    assert.ok(/loadTotals\(scope, humansOnly, yeniSinir\)/.test(src),
      "daha fazla goster yeni siniri GECIRMIYOR — liste sessizce kisa kalir");
  });

  test("kapat", { skip: atla() && sebep }, async () => {
    srv?.close(); await cli?.close(); await mongod?.stop();
    try { fs.rmSync(KUM, { recursive: true, force: true }); } catch {}
  });
});
