"use strict";

/**
 * SEZON — sıralamanın zaman penceresi.
 *
 * NEDEN VAR: kümülatif tek tablo zamanla kopuyor (bkz. docs/ekonomi-tasarim.md
 * §3.2). Sezon anahtarı iki yerde kritik:
 *   • settle2 yazarken bileşik anahtarın parçası
 *   • leaderboard okurken süzgeç
 * İkisi ayrışırsa tablo sessizce boşalır ya da hiç sıfırlanmaz.
 *
 * Çalıştırma:  npm test
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const Season = require("../lib/season.cjs");

describe("sezon anahtarı", () => {
  test("aylık biçim sıfır dolgulu ve SIRALANABİLİR", () => {
    // Arşiv sorguları anahtarları doğrudan karşılaştırıyor; "2026-9" olsaydı
    // "2026-10" < "2026-9" çıkardı.
    const k = Season.seasonKey(new Date("2026-03-15T12:00:00Z"));
    assert.match(k, /^\d{4}-(0[1-9]|1[0-2])$/);
    assert.ok("2026-09" < "2026-10", "sıralama doğru olmalı");
  });

  test("geçerli anahtar biçimleri", () => {
    assert.equal(Season.isValidKey("2026-07"), true);
    assert.equal(Season.isValidKey("2026-Q3"), true);
    assert.equal(Season.isValidKey("2026-13"), false, "13. ay olmaz");
    assert.equal(Season.isValidKey("2026-7"), false, "dolgusuz reddedilmeli");
    assert.equal(Season.isValidKey(""), false);
    assert.equal(Season.isValidKey("'; DROP"), false);
  });

  test("önceki sezon — YIL SINIRINDA da doğru", () => {
    assert.equal(Season.previousKey("2026-07"), "2026-06");
    assert.equal(Season.previousKey("2026-01"), "2025-12", "ocak → önceki yılın aralığı");
    assert.equal(Season.previousKey("2026-Q3"), "2026-Q2");
    assert.equal(Season.previousKey("2026-Q1"), "2025-Q4", "Q1 → önceki yılın Q4'ü");
  });

  test("bozuk anahtar null döner, patlamaz", () => {
    assert.equal(Season.previousKey("sacma"), null);
  });

  test("etiket insan okunur", () => {
    assert.equal(Season.label("2026-07"), "Temmuz 2026");
    assert.equal(Season.label("2026-01"), "Ocak 2026");
    assert.equal(Season.label("2026-Q3"), "2026 3. çeyrek");
  });

  test("ZAMAN DİLİMİ: sınır Europe/Istanbul'a göre", () => {
    // Sunucu UTC çalışıyor (Render). Ayın son gününün 22:00 UTC'si
    // İstanbul'da ERTESİ AY 01:00'dir — `getMonth()` kullanılsaydı sezon
    // 3 saat kayardı. Aynı hata fikstür filtresinde yaşanmıştı.
    const utcSonGun = new Date("2026-07-31T22:00:00Z"); // İstanbul: 1 Ağustos 01:00
    assert.equal(Season.seasonKey(utcSonGun), "2026-08", "İstanbul'a göre ağustos");
    const utcIlkGun = new Date("2026-08-01T00:30:00Z"); // İstanbul: 1 Ağustos 03:30
    assert.equal(Season.seasonKey(utcIlkGun), "2026-08");
  });

  test("ay ortası net", () => {
    assert.equal(Season.seasonKey(new Date("2026-07-15T12:00:00Z")), "2026-07");
  });
});

/* ─────────────── sezon yalıtımı (Mongo'ya karşı) ─────────────── */

const { before, after, beforeEach } = require("node:test");
const SeasonTotals = require("../lib/season-totals.cjs");

let mongod = null, client = null, db = null;

before(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const { MongoClient } = require("mongodb");
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  db = client.db("test");
});
after(async () => {
  if (client) await client.close();
  if (mongod) await mongod.stop();
});
beforeEach(async () => { await db.collection("season_totals").deleteMany({}); });

describe("sezon yalıtımı", () => {
  test("BOŞ SEZON dosyaya DÜŞMEZ — sezon gerçekten sıfırlanır", async () => {
    // Yakalandı sezon dönümüne 2 gün kala: Mongo'da 0 kayıt bulununca dosyaya
    // düşülüyor ve dosyadaki ÖNCEKİ AY verisi YENİ AY etiketiyle dönüyordu.
    // Yani 1 Ağustos'ta tablo hiç sıfırlanmayacaktı.
    const simdi = Season.seasonKey();
    await db.collection("season_totals").insertOne({
      season: simdi, userIdLower: "a", userId: "a", totalPoints: 50, matches: 10,
    });

    const gelecek = "2099-01"; // kesinlikle boş bir sezon
    const r = await SeasonTotals.loadTotals(db, gelecek);
    assert.equal(r.items.length, 0, "boş sezon boş dönmeli");
    assert.equal(r.source, "mongo_season_totals", "dosyaya düşülmemeli");
  });

  test("her sezon KENDİ kayıtlarını döndürür", async () => {
    await db.collection("season_totals").insertMany([
      { season: "2026-07", userIdLower: "a", userId: "a", totalPoints: 50, matches: 10 },
      { season: "2026-08", userIdLower: "a", userId: "a", totalPoints: 5, matches: 1 },
    ]);
    assert.equal((await SeasonTotals.loadTotals(db, "2026-07")).items[0].totalPoints, 50);
    assert.equal((await SeasonTotals.loadTotals(db, "2026-08")).items[0].totalPoints, 5);
  });

  test("aynı oyuncu iki sezonda AYRI belge tutabilir", async () => {
    // Eski tekil `{userIdLower}` benzersiz indeksi kalsaydı ikinci sezon
    // yazılamazdı — migration bu yüzden indeksi bileşiğe çeviriyor.
    await db.collection("season_totals").createIndex(
      { season: 1, userIdLower: 1 }, { unique: true }
    );
    await db.collection("season_totals").insertOne({ season: "2026-07", userIdLower: "a" });
    await db.collection("season_totals").insertOne({ season: "2026-08", userIdLower: "a" });
    assert.equal(await db.collection("season_totals").countDocuments(), 2);
  });
});

describe("sezon kovaları ayrı — 1 Ağustos'ta tablo sıfırlanmalı", () => {
  /**
   * Sezon AYLIK. Dönüşün gerçekten çalışması iki şeye bağlı:
   *   1) Okuma: leaderboard `season` alanına göre süzmeli (doğrulandı)
   *   2) Yazma: settle sezon anahtarını YAZMA ANINDA hesaplamalı
   *
   * (2) kritik: anahtar modül yüklenirken bir kez hesaplanıp saklansaydı,
   * sunucu Temmuz'da açılıp Ağustos'a girdiğinde yeni maçlar TEMMUZ kovasına
   * yazılırdı ve sezon hiç sıfırlanmazdı — üstelik hata üretmeden.
   */
  const path = require("path");
  const fs = require("fs");
  const Season = require("../lib/season.cjs");

  test("sezon anahtarı hiçbir yerde modül düzeyinde sabitlenmemiş", () => {
    const kokler = ["routes", "lib", "services"];
    const kalip = /^(const|let)\s+\w+\s*=\s*(Season\.)?seasonKey\(\)/m;
    for (const k of kokler) {
      const dizin = path.join(__dirname, "..", k);
      for (const ad of fs.readdirSync(dizin)) {
        if (!ad.endsWith(".cjs")) continue;
        const src = fs.readFileSync(path.join(dizin, ad), "utf8");
        assert.ok(!kalip.test(src),
          `${k}/${ad}: sezon anahtari modul duzeyinde sabitlenmis — ay donunce eski sezona yazar`);
      }
    }
  });

  test("ay sınırında anahtar değişir (Istanbul saatiyle)", () => {
    const tem = Season.seasonKey(new Date("2026-07-31T23:59:00+03:00"));
    const agu = Season.seasonKey(new Date("2026-08-01T00:01:00+03:00"));
    assert.equal(tem, "2026-07");
    assert.equal(agu, "2026-08");
    assert.equal(Season.previousKey(agu), tem);
  });
});
