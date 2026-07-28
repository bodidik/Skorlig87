"use strict";

/**
 * Kullanıcı profili deposu — dosya modu davranışı.
 *
 * NEDEN TEST EDİLİYOR: Bu katmanın koruduğu şey PROFİL VERİSİ (ülke, takım,
 * takma ad, ligler, dil) ve bozulma biçimi sessiz. Eski kod her deploy'da
 * profilleri kaybediyordu ve kimse hata görmüyordu — `ensureUser` kullanıcıyı
 * bulamayınca sıfırdan yaratıyor, boş profil dönüyordu.
 *
 * Ayrıca kayıp güncelleme yarışı vardı: setter'lar oku→değiştir→tümünü-yaz
 * yapıyor ve dosya kilidi kullanmıyordu; eşzamanlı iki çağrıdan biri
 * kayboluyordu. Aşağıda eşzamanlılık testi bunu tutuyor.
 *
 * Mongo modu ayrı sınanır (canlı küme gerekir); burada dosya modu ve
 * bayrak davranışı doğrulanıyor.
 *
 * Çalıştırma:  npm test
 */

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const os = require("os");
const fs = require("fs");
const fsp = fs.promises;

// SKORLIG_DATA_DIR modül yüklenirken okunuyor — require'dan ÖNCE ayarlanmalı,
// yoksa testler GERÇEK data/users.json'a yazar (bu tuzağa daha önce düşüldü).
const KUM = fs.mkdtempSync(path.join(os.tmpdir(), "skorlig-users-"));
process.env.SKORLIG_DATA_DIR = KUM;

const Store = require("../lib/users-store.cjs");

const VARSAYILAN = { mainTeam: null, lc: 30, lcLastDaily: null };

async function sifirla() {
  try { await fsp.unlink(Store.FILE); } catch {}
}

after(async () => {
  try { fs.rmSync(KUM, { recursive: true, force: true }); } catch {}
});

describe("ensureUser — dosya modu", () => {
  test("yeni kullanici varsayilanlarla yaratilir", async () => {
    await sifirla();
    const u = await Store.ensureUser("kisi1", VARSAYILAN, null);
    assert.equal(u.userId, "kisi1");
    assert.equal(u.lc, 30);
    assert.equal(u.mainTeam, null);
    assert.ok(u.createdAt, "createdAt yazilmali");
  });

  test("mevcut kullanici KORUNUR (ustune yazilmaz)", async () => {
    await sifirla();
    await Store.updateUser("kisi1", { country: "Türkiye", nickname: "deniz" }, VARSAYILAN, null);
    const u = await Store.ensureUser("kisi1", VARSAYILAN, null);
    // Asil regresyon riski: ensureUser'in mevcut profili sifirlamasi.
    assert.equal(u.country, "Türkiye");
    assert.equal(u.nickname, "deniz");
  });

  test("eski kayitta eksik alan tamamlanir", async () => {
    await sifirla();
    await fsp.writeFile(Store.FILE, JSON.stringify({ items: [{ userId: "eski" }] }), "utf8");
    const u = await Store.ensureUser("eski", VARSAYILAN, null);
    assert.equal(u.lc, 30, "eksik lc tamamlanmali");
    assert.equal(u.lcLastDaily, null);
  });

  test("bos kimlik reddedilir", async () => {
    await assert.rejects(() => Store.ensureUser("", VARSAYILAN, null), /USER_REQUIRED/);
    await assert.rejects(() => Store.ensureUser("   ", VARSAYILAN, null), /USER_REQUIRED/);
  });
});

describe("updateUser", () => {
  test("yalnizca verilen alan degisir, digerleri durur", async () => {
    await sifirla();
    await Store.updateUser("k", { country: "Spain", nickname: "ali" }, VARSAYILAN, null);
    await Store.updateUser("k", { mainTeam: "Barcelona" }, VARSAYILAN, null);

    const u = await Store.getUser("k", null);
    assert.equal(u.mainTeam, "Barcelona");
    assert.equal(u.country, "Spain", "onceki alan silinmemeli");
    assert.equal(u.nickname, "ali");
  });

  test("kullanici yoksa yaratilir", async () => {
    await sifirla();
    await Store.updateUser("yeni", { country: "Brazil" }, VARSAYILAN, null);
    const u = await Store.getUser("yeni", null);
    assert.equal(u.country, "Brazil");
    assert.equal(u.lc, 30, "varsayilanlar da uygulanmali");
  });

  test("EŞZAMANLI farkli alan yazimlari birbirini EZMEZ", async () => {
    await sifirla();
    await Store.ensureUser("yaris", VARSAYILAN, null);

    // Eski kod dosya kilidi kullanmiyordu: iki cagri da ayni anda okuyup
    // ayni anda yaziyordu, sonuncusu digerini siliyordu.
    await Promise.all([
      Store.updateUser("yaris", { country: "Italy" }, VARSAYILAN, null),
      Store.updateUser("yaris", { nickname: "zeynep" }, VARSAYILAN, null),
      Store.updateUser("yaris", { mainTeam: "Roma" }, VARSAYILAN, null),
    ]);

    const u = await Store.getUser("yaris", null);
    assert.equal(u.country, "Italy", "ulke kaybolmamali");
    assert.equal(u.nickname, "zeynep", "takma ad kaybolmamali");
    assert.equal(u.mainTeam, "Roma", "takim kaybolmamali");
  });

  test("ayni kullaniciya paralel yazimlar tek kayit birakir", async () => {
    await sifirla();
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        Store.updateUser("tek", { [`alan${i}`]: i }, VARSAYILAN, null)
      )
    );
    const kitap = await Store._readBook();
    const kayitlar = kitap.items.filter((x) => x.userId === "tek");
    assert.equal(kayitlar.length, 1, "cift kayit olusmamali");
  });
});

describe("getUsersByIds", () => {
  test("yalnizca istenen kimlikler doner", async () => {
    await sifirla();
    for (const id of ["a", "b", "c", "d"]) {
      await Store.updateUser(id, { country: "X" + id }, VARSAYILAN, null);
    }
    const map = await Store.getUsersByIds(["a", "c"], null);
    assert.deepEqual(Object.keys(map).sort(), ["a", "c"]);
    assert.equal(map.a.country, "Xa");
  });

  test("bos liste bos nesne doner (gereksiz okuma yok)", async () => {
    assert.deepEqual(await Store.getUsersByIds([], null), {});
    assert.deepEqual(await Store.getUsersByIds(null, null), {});
  });

  test("olmayan kimlik sessizce atlanir", async () => {
    await sifirla();
    await Store.updateUser("var", {}, VARSAYILAN, null);
    const map = await Store.getUsersByIds(["var", "yok"], null);
    assert.ok(map.var);
    assert.equal(map.yok, undefined);
  });
});

describe("isNicknameTaken", () => {
  test("baskasinin takma adi alinmis sayilir", async () => {
    await sifirla();
    await Store.updateUser("u1", { nickname: "Deniz", nicknameNorm: "deniz" }, VARSAYILAN, null);
    assert.equal(await Store.isNicknameTaken("deniz", "u2", null), true);
  });

  test("kendi takma adi cakisma sayilmaz", async () => {
    await sifirla();
    await Store.updateUser("u1", { nickname: "Deniz", nicknameNorm: "deniz" }, VARSAYILAN, null);
    assert.equal(await Store.isNicknameTaken("deniz", "u1", null), false);
  });

  test("baskasinin KIMLIGI ile cakisma da yakalanir", async () => {
    // Okunabilir userId'li eski hesaplarin taklit edilmesini engelliyor.
    await sifirla();
    await Store.updateUser("admin", {}, { ...VARSAYILAN, userIdNorm: "admin" }, null);
    assert.equal(await Store.isNicknameTaken("admin", "baskasi", null), true);
  });

  test("bos aday cakisma degil", async () => {
    assert.equal(await Store.isNicknameTaken("", "u", null), false);
    assert.equal(await Store.isNicknameTaken(null, "u", null), false);
  });
});

describe("davet kodu", () => {
  test("kodla kullanici bulunur", async () => {
    await sifirla();
    await Store.updateUser("sahip", { inviteCode: "AB12CD" }, VARSAYILAN, null);
    const u = await Store.findByInviteCode("AB12CD", null);
    assert.equal(u.userId, "sahip");
  });

  test("kod BUYUK harfe normalize edilir", async () => {
    // Uretim buyuk harfli; arama kucuk harfle gelirse bulamamak kullaniciya
    // "gecersiz kod" der.
    await sifirla();
    await Store.updateUser("sahip", { inviteCode: "AB12CD" }, VARSAYILAN, null);
    assert.ok(await Store.findByInviteCode("ab12cd", null));
    assert.ok(await Store.findByInviteCode(" Ab12Cd ", null));
  });

  test("olmayan kod null doner", async () => {
    await sifirla();
    assert.equal(await Store.findByInviteCode("YOKKOD", null), null);
    assert.equal(await Store.findByInviteCode("", null), null);
  });

  test("cakisma kontrolu", async () => {
    await sifirla();
    await Store.updateUser("s", { inviteCode: "XYZ999" }, VARSAYILAN, null);
    assert.equal(await Store.isInviteCodeTaken("XYZ999", null), true);
    assert.equal(await Store.isInviteCodeTaken("BASKA1", null), false);
  });
});

describe("listByTeam", () => {
  test("takimi tutanlar doner, digerleri gelmez", async () => {
    await sifirla();
    await Store.updateUser("a", { mainTeam: "Galatasaray" }, VARSAYILAN, null);
    await Store.updateUser("b", { mainTeam: "Fenerbahçe" }, VARSAYILAN, null);
    await Store.updateUser("c", { mainTeam: "Galatasaray" }, VARSAYILAN, null);

    const list = await Store.listByTeam("Galatasaray", null);
    assert.deepEqual(list.map((u) => u.userId).sort(), ["a", "c"]);
  });

  test("buyuk/kucuk harf duyarsiz (eski davranis)", async () => {
    await sifirla();
    await Store.updateUser("a", { mainTeam: "Galatasaray" }, VARSAYILAN, null);
    assert.equal((await Store.listByTeam("galatasaray", null)).length, 1);
    assert.equal((await Store.listByTeam("GALATASARAY", null)).length, 1);
  });

  test("bos takim bos liste", async () => {
    assert.deepEqual(await Store.listByTeam("", null), []);
    assert.deepEqual(await Store.listByTeam(null, null), []);
  });
});

describe("searchUsers", () => {
  test("takma ad ve kimlik uzerinde arar", async () => {
    await sifirla();
    await Store.updateUser("deniz123", { nickname: "Deniz" }, VARSAYILAN, null);
    await Store.updateUser("ahmet", { nickname: "Ahmet" }, VARSAYILAN, null);

    assert.equal((await Store.searchUsers("deniz", 20, null)).length, 1);
    assert.equal((await Store.searchUsers("ahmet", 20, null)).length, 1);
  });

  test("eski `name` alani da aranir", async () => {
    // Eski hesaplarda nickname yerine name var; kapsam disi birakmak onlari
    // aramada gorunmez yapardi.
    await sifirla();
    await Store.updateUser("eski1", { name: "Mehmet" }, VARSAYILAN, null);
    assert.equal((await Store.searchUsers("mehmet", 20, null)).length, 1);
  });

  test("SINIR uygulanir (sinirsiz sonuc donmez)", async () => {
    await sifirla();
    for (let i = 0; i < 30; i++) {
      await Store.updateUser("kisi" + i, { nickname: "test" + i }, VARSAYILAN, null);
    }
    // Sinirsiz donmek 500.000 kullanicida tek istekle tum koleksiyonu
    // bellege alirdi.
    assert.equal((await Store.searchUsers("kisi", 5, null)).length, 5);
  });

  test("bos sorgu bos liste", async () => {
    assert.deepEqual(await Store.searchUsers("", 20, null), []);
    assert.deepEqual(await Store.searchUsers(null, 20, null), []);
  });
});

describe("dosya bicimleri", () => {
  test("duz dizi bicimi okunabilir", async () => {
    await sifirla();
    await fsp.writeFile(Store.FILE, JSON.stringify([{ userId: "dizi1", country: "Japan" }]), "utf8");
    const u = await Store.getUser("dizi1", null);
    assert.equal(u.country, "Japan");
  });

  test("bozuk dosya patlamaz, bos kabul edilir", async () => {
    await sifirla();
    await fsp.writeFile(Store.FILE, "{bozuk json", "utf8");
    assert.equal(await Store.getUser("x", null), null);
    assert.equal(await Store.countUsers(null), 0);
  });

  test("dosya yokken getUser null doner", async () => {
    await sifirla();
    assert.equal(await Store.getUser("hickimse", null), null);
  });
});
