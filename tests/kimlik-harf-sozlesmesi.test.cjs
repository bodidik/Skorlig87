"use strict";

/**
 * KULLANICI KİMLİĞİNDE BÜYÜK/KÜÇÜK HARF SÖZLEŞMESİ.
 *
 * ⚠️ BU TURDA KUSUR BULUNAMADI — açıkça yazıyorum. Ölçülenler:
 *     lc-wallet.json  840 kayit   harf varyanti 0
 *     users.json      841 kayit   harf varyanti 0
 *     preds.json    46811 kayit   harf varyanti 0
 *   moderation-store  : norm() KÜÇÜLTÜYOR — yasak harf değiştirerek atlanamaz
 *   users-store       : normId() yalnızca kırpar (tam eşleşme), lowId() küçültür
 *   grup üyeleri      : yazarken de okurken de normUserId — TUTARLI
 *
 * ⚠️ AMA BU TASARIM SESSİZCE KIRILIR ve dosyanın kendi notu bunu yazıyor:
 * "küçük harfe indirgenmiş bir anahtarla ARAMA YAPILDIĞINDA hiçbir şey
 * bulamaz — HATA DA VERMEZ, sessizce boş döner."
 *
 * İki ayrı arama fonksiyonu var ve karıştırmak belirti üretmiyor:
 *     getUsersByIds(ids)        → TAM eşleşme (ham Firebase UID)
 *     getUsersByIdsLower(ids)   → küçük harf anahtarı (userIdLower)
 *
 * Yanlışını seçen çağıran boş harita alır; ekranda kullanıcı adsız/ülkesiz
 * görünür, log'a hiçbir şey düşmez. Bu testler sözleşmeyi tutuyor: bir gün
 * biri "yardımcı olsun" diye tek yerde küçültme eklerse burada patlar.
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

const KUM = fs.mkdtempSync(path.join(os.tmpdir(), "skorlig-kimlik-"));
process.env.SKORLIG_DATA_DIR = KUM;
process.env.SKORLIG_USERS_FILE_MIRROR = "0";

const UsersStore = require("../lib/users-store.cjs");
const Moderation = require("../lib/moderation-store.cjs");

/* Gerçek Firebase UID'leri karışık harflidir — testin anlamı buna dayanıyor. */
const UID = "AbCdEf123XyZ";

let srv = null, cli = null, db = null;

before(async () => {
  if (!MongoMemoryServer) return;
  srv = await MongoMemoryServer.create();
  const { MongoClient } = require("mongodb");
  cli = await new MongoClient(srv.getUri()).connect();
  db = cli.db("t");
  await UsersStore.updateUser(UID, { name: "Karisik Harf" }, { mainTeam: null, lc: 0 }, db);
});

after(async () => {
  try { if (cli) await cli.close(); } catch {}
  try { if (srv) await srv.stop(); } catch {}
  try { fs.rmSync(KUM, { recursive: true, force: true }); } catch {}
});

describe("kimlik harf sözleşmesi", () => {
  test("kurulum sınandı: karışık harfli kullanıcı GERÇEKTEN yazıldı", { skip: atla() && sebep }, async () => {
    /* ⚠️ Bu olmadan aşağıdaki "boş döndü" iddiaları hiçbir şey kanıtlamaz —
     * kullanıcı hiç yazılmamışsa da boş döner. */
    const u = await UsersStore.getUser(UID, db);
    assert.ok(u, "kullanici yazilmadi — testler bir sey olcmuyor");
    assert.equal(u.userId, UID, "kimlik HARFI KORUNARAK saklanmali");
  });

  test("TAM EŞLEŞME fonksiyonu ham kimliği bulur", { skip: atla() && sebep }, async () => {
    const map = await UsersStore.getUsersByIds([UID], db);
    assert.ok(map[UID], "ham kimlikle bulunamadi");
  });

  test("TAM EŞLEŞME fonksiyonu KÜÇÜLTÜLMÜŞ kimliği BULAMAZ — sessizce", { skip: atla() && sebep }, async () => {
    /**
     * ⚠️ TEHLİKENİN KENDİSİ. Yanlış fonksiyonu seçmek hata vermiyor, boş
     * harita veriyor: ekranda kullanıcı adsız/ülkesiz görünür ve log temiz
     * kalır. Bu testin işi davranışı BELGELEMEK — düzeltmek değil; iki
     * fonksiyonun ayrı olması kasıtlı.
     */
    const map = await UsersStore.getUsersByIds([UID.toLowerCase()], db);
    assert.deepEqual(Object.keys(map), [],
      "tam eslesme kucuk harfli kimligi buldu — iki fonksiyonlu tasarim artik gecersiz, cagiranlar gozden gecirilmeli");
  });

  test("KÜÇÜK HARF fonksiyonu küçültülmüş kimliği bulur", { skip: atla() && sebep }, async () => {
    const map = await UsersStore.getUsersByIdsLower([UID.toLowerCase()], db);
    assert.ok(map[UID.toLowerCase()], "userIdLower ile bulunamadi — siralamada ulke cozumu bu yolu kullaniyor");
  });

  test("KÜÇÜK HARF fonksiyonu ham kimlikle de çalışır (kendisi küçültür)", { skip: atla() && sebep }, async () => {
    const map = await UsersStore.getUsersByIdsLower([UID], db);
    assert.ok(map[UID.toLowerCase()], "lowId cagiranin verdigini kucultmuyor");
  });

  test("YASAK harf değiştirerek ATLANAMAZ", { skip: atla() && sebep }, async () => {
    /**
     * ⚠️ GÜVENLİK. Yasak listesi ham kimlikle tutulsaydı, yasaklı kullanıcı
     * kimliğinin harfini değiştirip geri girebilirdi. `moderation-store.norm`
     * küçülttüğü için atlanamıyor; test bunu kilitliyor.
     */
    await Moderation.ban(UID, { neden: "test" }, db);
    const yasakli = await Moderation.bannedSet(db);
    assert.ok(yasakli.size > 0, "yasak yazilmadi — test bir sey olcmuyor");
    /* Küme KÜÇÜK harfli anahtar tutuyor; kontrol eden taraf da küçültmeli.
     * Her yazım varyantı aynı anahtara düşmeli, yoksa yasak atlanır. */
    for (const varyant of [UID, UID.toLowerCase(), UID.toUpperCase()]) {
      assert.equal(yasakli.has(varyant.toLowerCase()), true, `yasak "${varyant}" yaziminda ATLANDI`);
    }
    await Moderation.unban(UID, db);
    assert.equal((await Moderation.bannedSet(db)).has(UID.toLowerCase()), false,
      "yasak kaldirilamiyor — test bir sey olcmuyor");
  });

  test("grup üyeleri yazarken ve okurken AYNI normalleştirmeyi kullanır", { skip: atla() && sebep }, () => {
    /**
     * ⚠️ İkisi ayrışırsa grup tablosu üyeleri bulamaz ve ekranda ad yerine
     * ham kimlik görünür (`u.name || uid` yedeği). Belirti "grup boş" değil,
     * "grupta herkes kimlik numarası" olur — kolay gözden kaçar.
     */
    const src = fs.readFileSync(path.join(__dirname, "..", "routes", "users.cjs"), "utf8");
    const govde = src.match(/function normUserId[\s\S]*?\n\}/);
    assert.ok(govde, "normUserId bulunamadi");
    assert.ok(!/toLowerCase/.test(govde[0]),
      "normUserId artik kuculttuyor ama getUsersByIds TAM eslesme yapiyor — grup tablosu bos doner");
  });
});
