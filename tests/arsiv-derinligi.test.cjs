"use strict";

/**
 * GEÇMİŞ SEZON ARŞİVİ PREMIUM AYRICALIĞI — İKİ YÖNDE DE KİLİTLİ.
 *
 * ⚠️ BU TURDA KUSUR BULUNAMADI, açıkça yazıyorum. Canlı sunucuda uçtan uca
 * ölçüldü (kimliksiz = ücretsiz kademe, derinlik 1):
 *     istenen 2026-08 -> uygulanan 2026-08   kisitli hayir
 *     istenen 2026-07 -> uygulanan 2026-07   kisitli hayir
 *     istenen 2026-06 -> uygulanan 2026-08   kisitli EVET
 *     istenen 2025-12 -> uygulanan 2026-08   kisitli EVET
 *
 * ⚠️ AMA İKİ YÖNDE DE SESSİZCE BOZULUR:
 *   - derinlik sınırsıza kayarsa premium'un satın alınan bir ayrıcalığı
 *     bedava olur (ekran "12 sezon arşiv" diye satıyor);
 *   - derinlik 0'a kayarsa ÜCRETSİZ kullanıcı bir önceki sezonu da göremez
 *     ve bunu yalnızca "tablo boş" olarak yaşar.
 * İkisi de hata üretmez. Bu yüzden nöbetçi.
 *
 * ⚠️ SAYI DEĞİL İLİŞKİ SINANIYOR: premium derinliği ücretsizden BÜYÜK olmalı.
 * Sabit sayı yazmak, ortam değişkeni değişince testi yanlış yere bağlardı —
 * aynı hatayı bugün premium tablosunda gördüm (ekran 5 diyordu, ödeme yolu 3).
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
const premium = require("../lib/premium.cjs");
const Season = require("../lib/season.cjs");

describe("arşiv derinliği", () => {
  test("kurulum sınandı: derinlik okunabiliyor", () => {
    const uc = premium.seasonArchiveDepth(false);
    const pr = premium.seasonArchiveDepth(true);
    assert.ok(Number.isFinite(uc) && Number.isFinite(pr), "derinlik sayi degil");
    assert.ok(uc >= 1, `ucretsiz derinlik ${uc} — onceki sezon hic gorunmez`);
  });

  test("premium ücretsizden DAHA DERİN (satılan sey gercek olsun)", () => {
    assert.ok(premium.seasonArchiveDepth(true) > premium.seasonArchiveDepth(false),
      "premium arsiv avantaji YOK — ekran bunu ayricalik diye satiyor");
  });

  test("sıralama ucu derinliği GERÇEKTEN uyguluyor (kaynak kapısı)", () => {
    /* ⚠️ Sabitin doğru olması yetmez; ucun onu ÇAĞIRDIĞINI de tutuyoruz.
     * Bugün bir kez sabit doğruyken çağıranın onu hiç kullanmadığı bir
     * durum bulundu (arama düzeltmesi depoda vardı, rota geri alıyordu). */
    const src = fs.readFileSync(path.join(KOK, "routes", "leaderboard.cjs"), "utf8");
    assert.ok(/premium\.seasonArchiveDepth\(/.test(src),
      "leaderboard derinligi hic sormuyor — arsiv sinirsiz acik");
    assert.ok(/archiveLimited/.test(src),
      "kisitlama istemciye BILDIRILMIYOR — kullanici neden eski sezonu goremedigini anlamaz");
  });

  test("kısıtlama SESSİZ değil: güncel sezona düşerken haber veriliyor", () => {
    /**
     * ⚠️ Sessizce güncel sezona düşmek en kötü biçim: kullanıcı geçmiş sezona
     * baktığını sanarak bugünkü tabloyu okur. `archiveLimited` bayrağı
     * ekranda uyarıya dönüşüyor (app/(tabs)/stats.tsx `scope.archiveLimited`).
     */
    const src = fs.readFileSync(path.join(KOK, "routes", "leaderboard.cjs"), "utf8");
    const i = src.indexOf("arsivKisitli = true");
    assert.ok(i > 0, "kisitlama bayragi bulunamadi — test bir sey olcmuyor");
    const govde = src.slice(Math.max(0, i - 400), i + 600);
    assert.ok(/Season\.seasonKey\(\)/.test(govde), "kisitlanan istek guncel sezona dusmuyor");
  });

  test("İSTEMCİ kısıtlamayı okuyor (yarım düzeltme olmasın)", () => {
    /* Sunucu bildirse de ekran okumazsa kullanıcı yine sessizce yanlış
     * tabloyu görür — bugün üç kez bu yarım-düzeltme biçimi çıktı. */
    const MOBIL = path.join(KOK, "..", "mobile");
    const ekran = path.join(MOBIL, "app", "(tabs)", "stats.tsx");
    if (!fs.existsSync(ekran)) return;
    const src = fs.readFileSync(ekran, "utf8");
    assert.ok(/archiveLimited/.test(src),
      "stats ekrani archiveLimited bayragini okumuyor — kisitlama kullaniciya gorunmez");
  });

  test("sezon anahtarı biçimi geriye doğru tutarlı", () => {
    /* Derinlik hesabı `previousKey` zincirine dayanıyor; zincir bozulursa
     * kısıtlama yanlış sezonda devreye girer. */
    let k = Season.seasonKey();
    for (let i = 0; i < 14; i++) {
      const onceki = Season.previousKey(k);
      assert.ok(/^\d{4}-(\d{2}|Q[1-4])$/.test(onceki), `gecersiz sezon anahtari: ${onceki}`);
      assert.notEqual(onceki, k, "previousKey ayni anahtari donduruyor — zincir ilerlemiyor");
      k = onceki;
    }
  });
});
