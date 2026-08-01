"use strict";

/**
 * SIRALAMADA AYNI KULLANICI İKİ KEZ GÖRÜNMEZ.
 *
 * ⚠️ BULUNAN: güncel sezon sorgusu, `season` alanı OLMAYAN eski kayıtları da
 * kapsıyor (geçiş dönemi için, bilinçli):
 *
 *     { $or: [{ season: sezon }, { season: { $exists: false } }] }
 *
 * Ama YAZMA tarafı `filter: { season, userIdLower }` kullanıyor. Eski belgede
 * `season` olmadığı için eşleşmiyor ve `$setOnInsert` İKİNCİ bir belge
 * yaratıyor. Yani eski kayıtlı bir kullanıcı yeni bir maç oynar oynamaz
 * sıralamada iki kez görünüyor ve puanı ikiye bölünüyor.
 *
 * ÖLÇÜLDÜ (bellek-içi Mongo): aynı kullanıcı için eski (40 puan, 10 maç) ve
 * yeni (25 puan, 5 maç) belge → sorgu 3 satır, tekil kullanıcı 2.
 * Birleştirmeden sonra 2 satır, 65 puan / 15 maç.
 *
 * ⚠️ KENDİLİĞİNDEN TETİKLENİYOR: kullanıcının bir şey yapmasına gerek yok,
 * sadece migration'dan sonra bir maç oynaması yetiyor.
 *
 * ⚠️ VERİ TAŞIMA YAPILMADI. Eski belgeleri güncellemek bir migration olurdu
 * (ve üretim verisine karşı migration çalıştırmıyorum); okuma tarafında
 * birleştirmek geri dönüşsüz değil ve taşıma yapılana kadar doğru sonuç
 * veriyor. Taşıma yapılırsa bu kod kendiliğinden etkisiz kalır.
 */

const test = require("node:test");
const describe = require("node:test").describe;
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ST = require("../lib/season-totals.cjs");

const ESKI = {
  userId: "Ayni-Kisi", userIdLower: "ayni-kisi",
  totalPoints: 40, totalPenalty: 2, matches: 10, lastAt: "2026-07-01T00:00:00.000Z",
};
const YENI = {
  userId: "AyniKisi", userIdLower: "ayni-kisi", season: "2026-08",
  totalPoints: 25, totalPenalty: 1, matches: 5, lastAt: "2026-08-01T00:00:00.000Z",
};
const TEK = {
  userId: "Tek-Kisi", userIdLower: "tek-kisi", season: "2026-08",
  totalPoints: 30, totalPenalty: 0, matches: 6, lastAt: "2026-08-01T00:00:00.000Z",
};

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("birleştirici dışa açık", () => {
    assert.equal(typeof ST.belgeleriBirlestir, "function", "belgeleriBirlestir disa acilmamis");
  });

  test("tek belgeli kullanıcı bozulmuyor", () => {
    const [x] = ST.belgeleriBirlestir([TEK]);
    assert.equal(x.totalPoints, 30);
    assert.equal(x.matches, 6);
    assert.equal(x.userId, "Tek-Kisi");
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("mükerrer kayıt", () => {
  test("aynı kullanıcının iki belgesi TEK satıra iniyor", () => {
    const d = ST.belgeleriBirlestir([ESKI, YENI, TEK]);
    const kimlikler = d.map((x) => x.userIdLower);
    assert.equal(
      kimlikler.length, new Set(kimlikler).size,
      `ayni kullanici birden fazla satirda: ${JSON.stringify(kimlikler)}`
    );
    assert.equal(d.length, 2);
  });

  test("puan, ceza ve maç sayısı TOPLANIYOR (bölünmüyor)", () => {
    const d = ST.belgeleriBirlestir([ESKI, YENI]);
    assert.equal(d.length, 1);
    assert.equal(d[0].totalPoints, 65, "puanlar toplanmadi");
    assert.equal(d[0].totalPenalty, 3, "cezalar toplanmadi");
    assert.equal(d[0].matches, 15, "mac sayilari toplanmadi");
  });

  test("en son tarih korunuyor", () => {
    const d = ST.belgeleriBirlestir([YENI, ESKI]);   // ters sırada da
    assert.equal(d[0].lastAt, YENI.lastAt, "eski tarih one gecmis");
  });

  test("görünen ad SEZONLU belgeden alınıyor", () => {
    // Eski kayıttaki ad bayat olabilir; kullanıcı adını sonradan degistirmis olabilir.
    const d = ST.belgeleriBirlestir([ESKI, YENI]);
    assert.equal(d[0].userId, YENI.userId);
  });

  test("büyük/küçük harf farkı aynı kullanıcı sayılıyor", () => {
    const a = { ...ESKI, userIdLower: undefined, userId: "Ayni-Kisi" };
    const b = { ...YENI, userIdLower: undefined, userId: "AYNI-KISI" };
    const d = ST.belgeleriBirlestir([a, b]);
    assert.equal(d.length, 1, "harf farki ayri kullanici sayilmis");
  });

  test("kimliksiz belge atlanıyor (uydurma satır üretilmiyor)", () => {
    const d = ST.belgeleriBirlestir([{ totalPoints: 99 }, TEK]);
    assert.equal(d.length, 1);
    assert.equal(d[0].userIdLower, "tek-kisi");
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: her iki okuyucu da birleştiriyor", () => {
  /**
   * Sezon toplamları İKİ yerden okunuyor (`lib/season-totals.cjs` ve
   * `routes/leaderboard.cjs`). Biri birleştirip öteki birleştirmezse aynı
   * kullanıcı bir ekranda tek, ötekinde çift görünür — bu oturumda "aynı
   * savunma bir yerde eksik" kalıbı defalarca hata üretti.
   */
  const kok = path.join(__dirname, "..");
  for (const yol of ["lib/season-totals.cjs", "routes/leaderboard.cjs"]) {
    const src = fs.readFileSync(path.join(kok, yol), "utf8")
      .split("\n")
      .map((l) => {
        const t = l.trim();
        return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
      })
      .join("\n");
    assert.ok(
      /belgeleriBirlestir\s*\(/.test(src),
      `${yol}: sezon belgeleri birlestirilmeden okunuyor — mukerrer satir cikar`
    );
  }
});
