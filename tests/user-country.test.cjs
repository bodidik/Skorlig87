"use strict";

/**
 * userId → ülke çözümü.
 *
 * NEDEN TEST EDİLİYOR: Bu katman iki kez sessizce kırıldı ve ikisinde de
 * belirti aynıydı — hata yok, sadece BOŞ ülke sıralamaları:
 *
 *  1) KAYNAK KAYMASI. Profil verisi Mongo'ya taşındıktan sonra bu dosya hâlâ
 *     users.json okuyordu. SKORLIG_USERS_FILE_MIRROR=0 yapıldığı anda dosya
 *     yazılmayı bırakır ve HER insan kullanıcı ülkesiz görünürdü.
 *
 *  2) HARF DUYARLILIĞI. Kimlikler karışık harfli (Firebase UID) ama bu katman
 *     küçük harfli anahtarla arıyor. Tam eşleşen bir sorguya küçük harfli
 *     anahtar vermek hiçbir şey bulamaz — yine hata yok, yine boş liste.
 *     Depoda ayrı `userIdLower` alanı ve indeksi bunun için var.
 *
 * Çalıştırma:  npm test
 */

const { test, describe, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const os = require("os");
const fs = require("fs");

const KUM = fs.mkdtempSync(path.join(os.tmpdir(), "skorlig-uc-"));
process.env.SKORLIG_DATA_DIR = KUM;

const Store = require("../lib/users-store.cjs");
const UC = require("../lib/user-country.cjs");

const V = { mainTeam: null, lc: 30, lcLastDaily: null };

after(() => {
  try { fs.rmSync(KUM, { recursive: true, force: true }); } catch {}
});

beforeEach(async () => {
  try { fs.unlinkSync(Store.FILE); } catch {}
  UC.invalidate();
});

describe("attachCountries", () => {
  test("insan kullanicinin ulkesi depodan cozulur", async () => {
    await Store.updateUser("ali", { country: "Türkiye" }, V, null);
    const [r] = await UC.attachCountries([{ userId: "ali" }], null);
    assert.equal(r.country, "Türkiye");
  });

  test("KARISIK HARFLI kimlik de cozulur", async () => {
    // Firebase UID'leri boyle: aRaNdOmUid123. Kucuk harfli anahtarla tam
    // eslesen sorgu yapilirsa hicbir sey bulunamaz ve kullanici ulkesiz kalir.
    await Store.updateUser("aBcDeF123", { country: "Spain" }, V, null);
    const [r] = await UC.attachCountries([{ userId: "aBcDeF123" }], null);
    assert.equal(r.country, "Spain", "buyuk/kucuk harf farki ulkeyi dusurmemeli");
  });

  test("ulkesi olmayan kullanici null doner (varsayilan ulkeye atilmaz)", async () => {
    await Store.updateUser("ulkesiz", {}, V, null);
    const [r] = await UC.attachCountries([{ userId: "ulkesiz" }], null);
    assert.equal(r.country, null);
  });

  test("hic kaydi olmayan kimlik null doner, patlamaz", async () => {
    const [r] = await UC.attachCountries([{ userId: "hickimse" }], null);
    assert.equal(r.country, null);
  });

  test("ozgun alanlar korunur", async () => {
    await Store.updateUser("x", { country: "Italy" }, V, null);
    const [r] = await UC.attachCountries([{ userId: "x", total: 42, played: 7 }], null);
    assert.equal(r.total, 42);
    assert.equal(r.played, 7);
    assert.equal(r.country, "Italy");
  });

  test("bos/gecersiz girdi bos dizi doner", async () => {
    assert.deepEqual(await UC.attachCountries([], null), []);
    assert.deepEqual(await UC.attachCountries(null, null), []);
  });

  test("cok kullanicili liste tek turda cozulur", async () => {
    for (const [id, c] of [["a", "Brazil"], ["b", "Japan"], ["c", "France"]]) {
      await Store.updateUser(id, { country: c }, V, null);
    }
    const rows = await UC.attachCountries(
      [{ userId: "a" }, { userId: "b" }, { userId: "c" }, { userId: "yok" }],
      null
    );
    assert.deepEqual(rows.map((r) => r.country), ["Brazil", "Japan", "France", null]);
  });
});

describe("countryOfUser", () => {
  test("tek kullanici cozulur", async () => {
    await Store.updateUser("tek", { country: "Germany" }, V, null);
    assert.equal(await UC.countryOfUser("tek", null), "Germany");
  });

  test("bos kimlik null", async () => {
    assert.equal(await UC.countryOfUser("", null), null);
    assert.equal(await UC.countryOfUser(null, null), null);
  });
});

describe("onbellek", () => {
  test("invalidate sonrasi yeni deger okunur", async () => {
    await Store.updateUser("degisken", { country: "Poland" }, V, null);
    assert.equal(await UC.countryOfUser("degisken", null), "Poland");

    await Store.updateUser("degisken", { country: "Austria" }, V, null);
    UC.invalidate(); // set-country bunu cagiriyor
    assert.equal(
      await UC.countryOfUser("degisken", null),
      "Austria",
      "ulke degisince siralama hemen dogru listeye dusmeli"
    );
  });
});
