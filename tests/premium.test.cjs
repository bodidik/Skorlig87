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

  test("suresiz premium (premiumUntil yok) true doner", async () => {
    await Store.updateUser("suresiz", { premium: true }, V, null);
    assert.equal(await premium.isPremium("suresiz", null), true);
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
    assert.ok(s.perks.monthlyLc > 0, "ayricalik ozeti gelmeli");
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

  test("sonraki ay tekrar verilir", () => {
    const w = { balance: 0, totalEarned: 0 };
    premium.grantMonthlyIfDue(w, true, new Date("2026-07-15T00:00:00Z"));
    const b1 = w.balance;
    premium.grantMonthlyIfDue(w, true, new Date("2026-08-01T00:00:00Z"));
    assert.ok(w.balance > b1, "yeni ayda kasa yenilenmeli");
  });
});
