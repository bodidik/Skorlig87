"use strict";

/**
 * ÖDENEMEYEN PARA GÖRÜNÜR VE KAPATILABİLİR OLMALI.
 *
 * ⚠️ BU, DİĞER TÜM PARA DÜZELTMELERİNİN DAYANDIĞI KATMAN. Bu kod tabanında
 * ödemeler MÜHÜRDEN SONRA yapılır (çift ödeme olmasın diye); bedeli, ödeme
 * başarısız olursa TEKRAR DENENMEMESİ. Tek telafi yolu `failed_awards` izi.
 * O iz görünmezse, kuponda/havuzda/turnuvada/düelloda yazılan onca kayıt
 * hiçbir işe yaramaz.
 *
 * İKİ KUSUR ÖLÇÜLDÜ (2026-08-02):
 *
 *  1) SAYAÇ ASLA DÜŞMÜYORDU. `countDocuments({})` her kaydı sonsuza dek
 *     sayıyordu ve kaydı KAPATMANIN hiçbir yolu yoktu — ne alan, ne uç.
 *     Operatör borcu elle telafi etse bile sayı sabit kalıyor, dolayısıyla
 *     YENİ bir kayıp (3 → 4) gürültüden ayırt edilemiyordu.
 *
 *  2) SAĞLIK UCU SESSİZDİ. Ödenmemiş ödül sayısı `sorunVar`a hiç girmiyordu;
 *     uç `ok:true` ve HTTP 200 dönüyordu. İzleme araçları durum koduna ya da
 *     `ok` alanına bakar — yani karşılığı ödenmemiş para hiç alarm üretmiyordu.
 *
 * ⚠️ 503 DÖNMEK YANLIŞ ÇÖZÜM OLURDU ve test bunu KORUYOR: servis Render'da
 * çalışıyor, sağlık ucu 503 verince örnek sağlıksız sayılıp yeniden
 * başlatılabilir — muhasebe sorununu KESİNTİYE çevirirdi. Bu yüzden ayrı bir
 * `paraUyarisi` bayrağı var ve durum kodu bilerek 200 kalıyor.
 */

const test = require("node:test");
const describe = require("node:test").describe;
const assert = require("node:assert/strict");
const path = require("path");

const KOK = path.join(__dirname, "..");
let MongoMemoryServer = null;
try { ({ MongoMemoryServer } = require("mongodb-memory-server")); } catch {}
const atla = () => !MongoMemoryServer;
const sebep = "mongodb-memory-server kurulu degil";

const TOKEN = "test-admin-token";

describe("kayıp para görünürlüğü", () => {
  let mongod, cli, db, srv, port, eskiToken;

  test("kur", { skip: atla() && sebep }, async () => {
    eskiToken = process.env.SKORLIG_ADMIN_TOKEN;
    process.env.SKORLIG_ADMIN_TOKEN = TOKEN;

    const { MongoClient } = require("mongodb");
    const express = require(path.join(KOK, "node_modules", "express"));
    mongod = await MongoMemoryServer.create();
    cli = await MongoClient.connect(mongod.getUri());
    db = cli.db("t");

    const app = express();
    app.use((q, _r, n) => { q.app.locals.db = db; n(); });
    app.use("/api/admin", require(path.join(KOK, "routes", "admin-users.cjs")));
    srv = app.listen(0);
    port = srv.address().port;
  });

  const cagir = (yol, opts = {}) =>
    fetch(`http://127.0.0.1:${port}${yol}`, {
      ...opts,
      headers: { "Content-Type": "application/json", "x-admin-token": TOKEN, ...(opts.headers || {}) },
    }).then(async (r) => ({ s: r.status, j: await r.json().catch(() => null) }));

  test("borç LİSTELENEBİLİR — kim, ne kadar", { skip: atla() && sebep }, async () => {
    /* Niyet "elle telafi edilebilsin"di; okunamayan borç telafi edilemez. */
    const { kayipOdulKaydet } = require(path.join(KOK, "lib", "wallet-credit.cjs"));
    await kayipOdulKaydet(db, {
      kaynak: "kupon_odul",
      odemeler: [{ userIdLower: "ali", tutar: 20 }, { userIdLower: "veli", tutar: 5 }],
      beklenen: 2, eksik: 2,
    });

    const r = await cagir("/api/admin/failed-awards");
    assert.equal(r.s, 200);
    assert.equal(r.j.toplam, 1, "kayit listelenmedi");
    assert.equal(r.j.toplamBorcLc, 25, "toplam borc yanlis — operator ne odeyecegini bilemez");
  });

  test("YETKİSİZ okuyamaz (borç listesi kullanıcı kimliği içerir)", { skip: atla() && sebep }, async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/admin/failed-awards`).then((x) => x.status);
    assert.notEqual(r, 200, "borc listesi kimliksiz okunabiliyor");
  });

  test("borç KAPATILABİLİR ve sayaçtan düşer", { skip: atla() && sebep }, async () => {
    const liste = await cagir("/api/admin/failed-awards");
    const id = liste.j.kayitlar[0]._id;

    const kapat = await cagir("/api/admin/failed-awards/resolve", {
      method: "POST", body: JSON.stringify({ id, not: "elle odendi" }),
    });
    assert.equal(kapat.s, 200, "kapatma basarisiz");

    const sonra = await cagir("/api/admin/failed-awards");
    assert.equal(sonra.j.toplam, 0, "kapatilan kayit hala acik gorunuyor — sayac hic dusmez");

    const hepsi = await cagir("/api/admin/failed-awards?all=1");
    assert.equal(hepsi.j.toplam, 1, "kayit SILINMEMELI — iz kalici olmali");
  });

  test("aynı kayıt İKİ KEZ kapatılamaz", { skip: atla() && sebep }, async () => {
    const hepsi = await cagir("/api/admin/failed-awards?all=1");
    const id = hepsi.j.kayitlar[0]._id;
    const tekrar = await cagir("/api/admin/failed-awards/resolve", {
      method: "POST", body: JSON.stringify({ id }),
    });
    assert.equal(tekrar.s, 409, "cift kapatma gecti — kim ne zaman kapatti izi ezilir");
  });

  test("SAĞLIK UCU: para alarmı var ve durum kodu 200 KALIYOR", { skip: atla() && sebep }, async () => {
    /**
     * ⚠️ İKİ YÖNLÜ İDDİA. `paraUyarisi` yoksa kayıp para sessiz kalır;
     * ama durum kodu 503 olursa Render örneği yeniden başlatır ve muhasebe
     * sorunu KESİNTİYE dönüşür. İkisi de kusur.
     */
    const fs = require("fs");
    const src = fs.readFileSync(path.join(KOK, "server.cjs"), "utf8");
    const blok = src.slice(src.indexOf('app.get("/api/health"'), src.indexOf('app.get("/api/health"') + 3000);

    /* ⚠️ YANIT GÖVDESİNİ HEDEFLE, blok metnini değil. İlk yazımım blokta
     * `paraUyarisi` GEÇİYOR MU diye bakıyordu; alanı yanıttan silince `const`
     * tanımı ve yorum blokta kaldığı için test YEŞİL KALDI. Negatif kontrol
     * yakaladı — sondanın kendisi de sınanmalı. */
    const govde = blok.slice(blok.indexOf("res.status("), blok.indexOf("uptimeSec"));
    assert.ok(/^\s*paraUyarisi\s*,/m.test(govde),
      "paraUyarisi YANITTA yok — kayip para izleme icin gorunmez kalir");
    assert.ok(/cozuldu:\s*\{\s*\$ne:\s*true\s*\}/.test(blok),
      "sayim COZULMEMIS filtresi kullanmiyor — sayac hic dusmez");
    assert.ok(!/sorunVar\s*=[^;]*odenmemisOdul/.test(blok),
      "odenmemis odul durum kodunu 503 yapiyor — Render orneyi yeniden baslatir");
  });

  test("kapat", { skip: atla() && sebep }, async () => {
    if (eskiToken === undefined) delete process.env.SKORLIG_ADMIN_TOKEN;
    else process.env.SKORLIG_ADMIN_TOKEN = eskiToken;
    srv?.close(); await cli?.close(); await mongod?.stop();
  });
});
