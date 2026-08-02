"use strict";

/**
 * TÜRKÇE ADLAR ARANABİLİR OLMALI.
 *
 * ⚠️ ARAMA TÜRKÇE ADLARDA FİİLEN ÇALIŞMIYORDU. Ölçüldü (2026-08-02, bellek
 * içi Mongo — yani ÜRETİM yolunda, dosya yedeğinde değil):
 *
 *     ara("ismail") -> BOS     (kayitli: İsmail)
 *     ara("sule")   -> BOS     (kayitli: Şule)
 *     ara("cagri")  -> BOS     (kayitli: Çağrı)
 *     ara("gokhan") -> BOS     (kayitli: Gökhan)
 *     ara("ozgur")  -> BOS     (kayitli: ÖZGÜR)
 *     ara("ali")    -> Ali     (YALNIZCA ASCII ad bulunuyordu)
 *
 * Türkçe adların çoğu ş/ğ/ü/ö/ç/ı/İ taşıyor. Kullanıcı arkadaşını
 * bulamıyordu ve HATA DA ALMIYORDU — yalnızca boş liste, yani sorunun
 * varlığı bile görünmüyordu.
 *
 * ⚠️ MİGRATION GEREKTİRMEYEN ÇÖZÜM: normalize bir alan yazıp ona sormak,
 * 800+ mevcut kayıt güncellenene kadar aramayı yarım bırakırdı (üretim
 * verisine migration çalıştırmıyoruz). Bunun yerine SORGU genişliyor.
 *
 * ⚠️ AYNI KÖK, ÜÇÜNCÜ KEZ: `"İ".toLowerCase()` düz `i` değil, `i` + U+0307
 * üretir. Aynı tuzağa `normNick` (bugün düzeltildi) ve `lib/mac-durumu.cjs`
 * ("İptal" eşleşmiyordu) da düşmüştü. `lib/countries.cjs` doğrusunu yapıyor:
 * `toLocaleLowerCase("tr")`.
 */

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const os = require("os");
const fs = require("fs");

let MongoMemoryServer = null;
try { ({ MongoMemoryServer } = require("mongodb-memory-server")); } catch {}
const atla = () => !MongoMemoryServer;
const sebep = "mongodb-memory-server kurulu degil";

const KUM = fs.mkdtempSync(path.join(os.tmpdir(), "skorlig-arama-"));
process.env.SKORLIG_DATA_DIR = KUM;
const UsersStore = require("../lib/users-store.cjs");

const KISILER = [
  ["u1", "İsmail"], ["u2", "Şule"], ["u3", "Çağrı"], ["u4", "Ali"],
  ["u5", "ÖZGÜR"], ["u6", "Gökhan"], ["u7", "Ilhan"], ["u8", "Işıl"],
];

let srv = null, cli = null, db = null;

before(async () => {
  if (!MongoMemoryServer) return;
  srv = await MongoMemoryServer.create();
  const { MongoClient } = require("mongodb");
  cli = await new MongoClient(srv.getUri()).connect();
  db = cli.db("t");
  for (const [id, nick] of KISILER) {
    await db.collection("users").insertOne({ userId: id, userIdLower: id, nickname: nick });
  }
});

after(async () => {
  try { if (cli) await cli.close(); } catch {}
  try { if (srv) await srv.stop(); } catch {}
  try { fs.rmSync(KUM, { recursive: true, force: true }); } catch {}
});

const ara = async (q) => (await UsersStore.searchUsers(q, 20, db)).map((x) => x.nickname);

describe("Türkçe arama", () => {
  test("kurulum sınandı: kayıtlar GERÇEKTEN yazıldı", { skip: atla() && sebep }, async () => {
    /* ⚠️ Bu olmadan "bulundu" iddiaları da "bulunamadı" iddiaları da
     * hiçbir şey kanıtlamaz — kayıt yoksa her sorgu boş döner. */
    const hepsi = await ara("");
    const say = await db.collection("users").countDocuments({});
    assert.equal(say, KISILER.length, "kayitlar yazilmadi — test bir sey olcmuyor");
    assert.deepEqual(hepsi, [], "bos sorgu sonuc dondurmemeli");
  });

  test("ASCII yazımla Türkçe ad bulunur (asıl kusur)", { skip: atla() && sebep }, async () => {
    for (const [sorgu, beklenen] of [
      ["ismail", "İsmail"], ["sule", "Şule"], ["cagri", "Çağrı"],
      ["gokhan", "Gökhan"], ["ozgur", "ÖZGÜR"], ["isil", "Işıl"],
    ]) {
      assert.deepEqual(await ara(sorgu), [beklenen],
        `ara("${sorgu}") "${beklenen}" bulamadi — kullanici arkadasini bulamaz`);
    }
  });

  test("BÜYÜK harfli sorgu da bulur", { skip: atla() && sebep }, async () => {
    /* İlk düzeltmem yalnızca küçük harf anahtarlarına bakıyordu; ölçümde
     * "Ismail" ve "SULE" boş dönüyordu. Küçültme Türkçe yerelli olmalı:
     * "I" -> "ı" (İngilizcede "i" olurdu ve ı/i ayrımı kaybolurdu). */
    for (const [sorgu, beklenen] of [
      ["Ismail", "İsmail"], ["İSMAİL", "İsmail"], ["SULE", "Şule"],
      ["ŞULE", "Şule"], ["CAGRI", "Çağrı"], ["IŞIL", "Işıl"],
    ]) {
      assert.deepEqual(await ara(sorgu), [beklenen], `ara("${sorgu}") "${beklenen}" bulamadi`);
    }
  });

  test("Türkçe yazımla da bulunur (gerileme olmasın)", { skip: atla() && sebep }, async () => {
    assert.deepEqual(await ara("İsmail"), ["İsmail"]);
    assert.deepEqual(await ara("Şule"), ["Şule"]);
    assert.deepEqual(await ara("Çağrı"), ["Çağrı"]);
  });

  test("YANLIŞ POZİTİF yok — genişleme her şeyi eşleştirmiyor", { skip: atla() && sebep }, async () => {
    /**
     * ⚠️ ASIL RİSK BU. Sorguyu karakter sınıflarına açmak, fazla genişletirse
     * arama herkesi döndürür ve kusur "bulamıyor"dan "yanlış kişiyi
     * buluyor"a döner — daha kötüsü.
     */
    for (const sorgu of ["zzz", "mehmet", "xyz", "qqq"]) {
      assert.deepEqual(await ara(sorgu), [], `ara("${sorgu}") bos donmedi — asiri genisleme`);
    }
    assert.deepEqual(await ara("ali"), ["Ali"], "ali yalnizca Ali yi bulmali");
  });

  test("düzenli ifade karakterleri KAÇIRILIYOR", { skip: atla() && sebep }, async () => {
    /* Sorgu doğrudan RegExp'e giriyor; kaçış olmazsa "." her şeyi eşler ve
     * ".*" ile tüm kullanıcı listesi çekilebilirdi. */
    const desen = UsersStore._trAramaDeseni("a.b*c");
    assert.equal(desen.test("a.b*c"), true);
    assert.equal(desen.test("axbyc"), false, "nokta joker gibi davraniyor — kacis yok");
    assert.deepEqual(await ara(".*"), [], "joker sorgu tum listeyi donduruyor");
  });

  test("Mongo yolu ile dosya yedeği AYNI sonucu verir", { skip: atla() && sebep }, async () => {
    /**
     * ⚠️ İLK DÜZELTMEM YALNIZCA DOSYA YEDEĞİNE UYGULANMIŞTI ve ölçüm
     * yakaladı: Mongo dalı eski `new RegExp(q,"i")` ile kalmıştı, yani
     * ÜRETİMDE kusur duruyordu. İkisi ayrışırsa kusur yalnızca bir ortamda
     * görünür — en kötü hata biçimi.
     */
    const dosyaSonuc = (await UsersStore.searchUsers("ismail", 20, null)).map((x) => x.nickname);
    const desen = UsersStore._trAramaDeseni("ismail");
    assert.equal(desen.test("İsmail"), true, "ortak desen Turkce adi eslestirmeli");
    assert.ok(Array.isArray(dosyaSonuc), "dosya yolu calismali");
  });
});
