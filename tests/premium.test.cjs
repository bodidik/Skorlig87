"use strict";

/**
 * Premium üyelik çözümü.
 *
 * NEDEN TEST EDİLİYOR: Burası PARA. `isPremium()` yanlışlıkla false dönerse
 * ödeme yapmış kullanıcı aylık 300 LC kasasını, günlük hakkını, birikim
 * tavanını ve mağaza bonusunu kaybeder — ve hiçbir hata üretilmez, kimse
 * fark etmez.
 *
 * Gerçek risk buydu: bu modül users.json'u DOĞRUDAN okuyordu. Profil verisi
 * Mongo'ya taşındıktan sonra SKORLIG_USERS_FILE_MIRROR=0 yapıldığı anda dosya
 * boşalacağı için TÜM premium üyeler sessizce ücretsiz kademeye düşerdi.
 *
 * Ayrıca kimlik harf duyarlılığı: Firebase UID'leri karışık harfli ve bu
 * modül küçük harfli sorgu yapıyor. Tam eşleşen sorguya geçmek, harf farkı
 * olan her kullanıcıyı "premium değil" yapardı.
 *
 * Çalıştırma:  npm test
 */

const { test, describe, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const os = require("os");
const fs = require("fs");

const KUM = fs.mkdtempSync(path.join(os.tmpdir(), "skorlig-prem-"));
process.env.SKORLIG_DATA_DIR = KUM;

const Store = require("../lib/users-store.cjs");
const premium = require("../lib/premium.cjs");

const V = { mainTeam: null, lc: 30, lcLastDaily: null };
const GUN = 86400000;

after(() => {
  try { fs.rmSync(KUM, { recursive: true, force: true }); } catch {}
});

beforeEach(() => {
  try { fs.unlinkSync(Store.FILE); } catch {}
});

describe("isPremium", () => {
  test("suresi gecerli premium true doner", async () => {
    await Store.updateUser("odeyen", {
      premium: true,
      premiumUntil: new Date(Date.now() + 30 * GUN).toISOString(),
    }, V, null);
    assert.equal(await premium.isPremium("odeyen", null), true);
  });

  test("suresi DOLMUS premium false doner", async () => {
    await Store.updateUser("suresi_bitti", {
      premium: true,
      premiumUntil: new Date(Date.now() - GUN).toISOString(),
    }, V, null);
    assert.equal(await premium.isPremium("suresi_bitti", null), false);
  });

  test("sure YOKSA premium sayilmaz (fail-closed)", async () => {
    /**
     * ⚠️ BU TEST DAVRANISI TERSINE CEVIRDI. Eskiden "suresiz premium
     * (premiumUntil yok) true doner" diyordu — ama lib/premium.cjs'in KENDI
     * BASLIGI bunun tersini soyluyor:
     *   "premiumUntil: ISO tarih (yoksa/expired ise premium sayilmaz)"
     *
     * Eski testin bir gerekcesi yoktu; kodun o anki halini tarif ediyordu.
     * Celiski tehlikeliydi: sozlesmeden akil yuruten biri (yonetici araci,
     * tasima betigi, elle DB duzeltmesi) `premium: true` yazip sureyi bos
     * birakinca KALICI premium vermis olurdu.
     *
     * Degisiklik mevcut kullanicilari etkilemiyor: kodda premium veren TEK
     * yol (premium/subscribe) her zaman premiumUntil yaziyor, 1987 uyeligi
     * ise daha onceki dalda donuyor (asagidaki test onu koruyor).
     *
     * Suresiz premium gercekten istenirse ACIK bir alan (premiumForever)
     * eklenmeli — "alan yok" bir niyet beyani degildir.
     */
    await Store.updateUser("suresiz", { premium: true }, V, null);
    assert.equal(await premium.isPremium("suresiz", null), false);
  });

  test("premium olmayan false doner", async () => {
    await Store.updateUser("ucretsiz", { country: "Türkiye" }, V, null);
    assert.equal(await premium.isPremium("ucretsiz", null), false);
  });

  test("1987 segmenti premium sayilir (geriye uyum)", async () => {
    await Store.updateUser("gs1", { is1987: true }, V, null);
    await Store.updateUser("gs2", { segment: "1987" }, V, null);
    assert.equal(await premium.isPremium("gs1", null), true);
    assert.equal(await premium.isPremium("gs2", null), true);
  });

  test("KARISIK HARFLI kimlik de cozulur", async () => {
    // Firebase UID bicimi. Tam eslesen sorgu kullanilsaydi bu kullanici
    // odeme yapmis olmasina ragmen ucretsiz kademeye duserdi.
    await Store.updateUser("aBcXyZ99", {
      premium: true,
      premiumUntil: new Date(Date.now() + 10 * GUN).toISOString(),
    }, V, null);
    assert.equal(await premium.isPremium("aBcXyZ99", null), true);
  });

  test("olmayan kullanici false, patlamaz", async () => {
    assert.equal(await premium.isPremium("hickimse", null), false);
  });

  test("bos kimlik false", async () => {
    assert.equal(await premium.isPremium("", null), false);
    assert.equal(await premium.isPremium(null, null), false);
  });
});

describe("premiumStatus", () => {
  test("aktif uyede sure ve kaynak doner", async () => {
    const until = new Date(Date.now() + 5 * GUN).toISOString();
    await Store.updateUser("u", { premium: true, premiumUntil: until }, V, null);

    const s = await premium.premiumStatus("u", null);
    assert.equal(s.active, true);
    assert.equal(s.premiumUntil, until);
    assert.equal(s.via, "premium");
    assert.ok(s.perks.monthlyFloor > 0, "ayricalik ozeti gelmeli");
    assert.ok(Array.isArray(s.plans) && s.plans.length, "paketler gelmeli");
  });

  test("1987 uyesinde via=1987", async () => {
    await Store.updateUser("gs", { is1987: true }, V, null);
    const s = await premium.premiumStatus("gs", null);
    assert.equal(s.active, true);
    assert.equal(s.via, "1987");
  });

  test("olmayan kullanicida active=false, patlamaz", async () => {
    const s = await premium.premiumStatus("yok", null);
    assert.equal(s.active, false);
    assert.equal(s.via, null);
  });
});

describe("ayricalik degerleri", () => {
  test("premium gunluk LC ucretsizden yuksek", () => {
    assert.ok(premium.dailyLc(true) > premium.dailyLc(false));
  });

  test("mac girisi bedeli premium'dan ETKILENMEZ (adil oyun)", () => {
    // Bilincli tasarim: premium'un puan/odul avantaji yok.
    assert.equal(premium.matchCost(true, 7), 7);
    assert.equal(premium.matchCost(false, 7), 7);
  });

  test("ucretsiz kademede birikim parametresi null (kendi varsayilanini kullanir)", () => {
    assert.equal(premium.regenParams(false), null);
    assert.ok(premium.regenParams(true).cap > 0);
  });
});

describe("aylik kasa", () => {
  test("premium olmayana verilmez", () => {
    const w = { balance: 0 };
    assert.equal(premium.grantMonthlyIfDue(w, false), 0);
    assert.equal(w.balance, 0);
  });

  test("premium'a bir kez verilir, ayni ay TEKRAR verilmez", () => {
    const w = { balance: 0, totalEarned: 0 };
    const ilk = premium.grantMonthlyIfDue(w, true);
    assert.ok(ilk > 0);
    assert.equal(w.balance, ilk);

    // Cift verme korumasi: ayni takvim ayinda ikinci cagri 0 donmeli.
    const ikinci = premium.grantMonthlyIfDue(w, true);
    assert.equal(ikinci, 0);
    assert.equal(w.balance, ilk, "bakiye ikinci kez artmamali");
  });

  test("sonraki ay TABAN ALTINDAYSA tekrar tamamlanir", () => {
    const w = { balance: 0, totalEarned: 0 };
    premium.grantMonthlyIfDue(w, true, new Date("2026-07-15T00:00:00Z"));
    const taban = w.balance;
    // Oyuncu ay boyunca oynayip bakiyesini tuketti.
    w.balance = 5;
    premium.grantMonthlyIfDue(w, true, new Date("2026-08-01T00:00:00Z"));
    assert.equal(w.balance, taban, "yeni ayda tabana tamamlanmali");
  });

  test("ZENGIN OYUNCUYA HICBIR SEY VERILMEZ — duzeltmenin ozu", () => {
    // Eski hal kosulsuz +300 idi: bakiyesi 500 olan da her ay 300 daha
    // aliyordu, yani arz sinirsiz birikiyordu.
    const w = { balance: 500, totalEarned: 0 };
    const v = premium.grantMonthlyIfDue(w, true, new Date("2026-07-15T00:00:00Z"));
    assert.equal(v, 0);
    assert.equal(w.balance, 500, "bakiye artmamali");
    assert.equal(w.lastMonthlyAt, "2026-07", "yine de ay muhurlenmeli");
  });

  test("muhur 0 verildiginde de basilir — ay icinde tekrar tamamlanmaz", () => {
    // Muhur basilmasaydi: bakiye 60'in ustundeyken atlanir, gun icinde
    // oyuncu 10'a duser ve ayni ay icinde tekrar 60'a tamamlanirdi.
    const w = { balance: 500, totalEarned: 0 };
    premium.grantMonthlyIfDue(w, true, new Date("2026-07-15T00:00:00Z"));
    w.balance = 10; // ay icinde harcadi
    const v = premium.grantMonthlyIfDue(w, true, new Date("2026-07-20T00:00:00Z"));
    assert.equal(v, 0, "ayni ay icinde ikinci tamamlama olmamali");
    assert.equal(w.balance, 10);
  });

  test("aylik taban, gunluk oyun bedelinin cok ustunde OLMAMALI", () => {
    // Ayni gerekce gunluk tabanda da vardi: taban cok yuksek olursa
    // kaybetmek bedava olur ve iade esigi duzeltmesi anlamsizlasir.
    const GIRIS = 3;
    const taban = premium.PERKS.monthlyFloor;
    assert.ok(taban / GIRIS <= 30, "aylik taban 30 mactan fazlasini karsilamamali");
  });
});
