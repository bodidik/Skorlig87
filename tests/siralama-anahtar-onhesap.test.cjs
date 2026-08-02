"use strict";

/**
 * ÖNCELİK SIRALAMASI — anahtarlar karşılaştırıcı İÇİNDE hesaplanmasın.
 *
 * ⚠️ BULGU (kullanıcı deneyimi turu 3, 2026-08-03): olay döngüsü blokajı
 * düzeltildikten SONRA ana ekranın kalan en büyük maliyeti buydu.
 * `sortByPriority` `priorityOf` ve `koMs`'i KARŞILAŞTIRICININ İÇİNDE
 * çağırıyordu; sıralama O(n log n) karşılaştırma yapıyor, yani 1771
 * fikstürde ~19.000 karşılaştırma × 2 çağrı ≈ 38.000 hesap — oysa öğe
 * başına BİR kez yeterli. `priorityOf` içinde iki `teamCountry` çağrısı ve
 * tarih ayrıştırma var.
 *
 * ÖLÇÜLDÜ (gerçek üretim verisi, 1896 fikstür):
 *     önce : 4378 ms
 *     sonra:  408 ms      (~11 kat)
 * Ana ekran (schedule) 4.1 sn → beklenen ~1 sn.
 *
 * ⚠️ SIRA BİREBİR AYNI, VE BU ÖLÇÜLDÜ: eski sürüm git'ten çıkarılıp yan yana
 * çalıştırıldı, dört farklı kullanıcı ülkesi için (Türkiye, England, Brazil,
 * ülkesiz) 1896 fikstürde **0 sıra farkı**. Sıralama bu uygulamada görünür
 * bir üründür — kullanıcının kendi ülkesinin maçları üste çıkıyor — yani
 * "hızlandırdım ama sıra değişti" kabul edilemez.
 */

const test = require("node:test");
const describe = require("node:test").describe;
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
const FP = require("../lib/fixture-priority.cjs");

const mac = (id, o = {}) => ({
  fixtureId: id, home: "A" + id, away: "B" + id,
  league: "Lig", country: "Other",
  kickoffISO: new Date(Date.UTC(2026, 7, 3, 12, 0)).toISOString(),
  ...o,
});

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("öncelik sınıfları ayrışıyor", () => {
    assert.ok(FP.P_COUNTRY < FP.P_GLOBAL);
    assert.ok(FP.P_GLOBAL < FP.P_BIG);
    assert.ok(FP.P_BIG < FP.P_OTHER);
    assert.ok(FP.P_OTHER < FP.P_FRIENDLY);
  });
});

/* ── Davranış korunuyor ──────────────────────────────────────────────────── */

describe("sıralama davranışı", () => {
  test("öncelik grubu sırası korunuyor", () => {
    const liste = [
      mac("hazirlik", { league: "Hazırlık Maçları" }),
      mac("digeri", { country: "Peru" }),
      mac("buyuk", { country: "England", league: "Premier League" }),
      mac("kendi", { country: "Türkiye" }),
    ];
    const s = FP.sortByPriority(liste, "Türkiye").map((f) => f.fixtureId);
    assert.equal(s[0], "kendi", `kullanicinin ulkesi ilk degil: ${s.join(",")}`);
    assert.equal(s[s.length - 1], "hazirlik", "hazirlik maci sonda degil");
  });

  test("aynı öncelikte KICKOFF sırası", () => {
    const t = (h) => new Date(Date.UTC(2026, 7, 3, h, 0)).toISOString();
    const liste = [
      mac("gec", { country: "Peru", kickoffISO: t(20) }),
      mac("erken", { country: "Peru", kickoffISO: t(10) }),
      mac("orta", { country: "Peru", kickoffISO: t(15) }),
    ];
    assert.deepEqual(
      FP.sortByPriority(liste, "Türkiye").map((f) => f.fixtureId),
      ["erken", "orta", "gec"]
    );
  });

  test("KARARLI: öncelik ve saat eşitse GİRİŞ SIRASI korunuyor", () => {
    /**
     * ⚠️ Süsleme sırasında `i` alanı tam bunun için var. Kararsız bir sıralama
     * aynı istekte farklı sonuç verebilir ve liste kullanıcının gözünde
     * "titrer" — üstelik hata olarak görünmez.
     */
    const t = new Date(Date.UTC(2026, 7, 3, 12, 0)).toISOString();
    const liste = ["a", "b", "c", "d", "e"].map((id) =>
      mac(id, { country: "Peru", kickoffISO: t })
    );
    assert.deepEqual(
      FP.sortByPriority(liste, "Türkiye").map((f) => f.fixtureId),
      ["a", "b", "c", "d", "e"]
    );
  });

  test("girdi dizisi DEĞİŞTİRİLMİYOR", () => {
    const liste = [mac("x"), mac("y")];
    const kopya = liste.slice();
    FP.sortByPriority(liste, "Türkiye");
    assert.deepEqual(liste, kopya, "cagiranin dizisi yerinde siralandi");
  });

  test("boş/bozuk girdi", () => {
    assert.deepEqual(FP.sortByPriority([], "Türkiye"), []);
    assert.deepEqual(FP.sortByPriority(null, "Türkiye"), []);
    assert.deepEqual(FP.sortByPriority(undefined, ""), []);
  });

  test("saati okunamayan maç sıralamayı ÇÖKERTMİYOR", () => {
    const liste = [mac("bozuk", { kickoffISO: "abc" }), mac("iyi")];
    const s = FP.sortByPriority(liste, "Türkiye");
    assert.equal(s.length, 2);
  });
});

/* ── Hız ─────────────────────────────────────────────────────────────────── */

describe("karşılaştırıcı içinde hesap yok", () => {
  test("2000 fikstür makul sürede sıralanıyor", () => {
    /* ⚠️ EŞİK GEVŞEK (2 sn) — test makineleri değişken. Gerçek değerler çok
     * uzakta: önce 4378 ms, sonra 408 ms. Kusur geri gelirse (karşılaştırıcı
     * içinde teamCountry) bu eşik kesin yakalar. */
    const liste = Array.from({ length: 2000 }, (_, i) =>
      mac(`F${i}`, {
        home: `Takim ${i % 400}`, away: `Rakip ${i % 300}`,
        country: ["Türkiye", "England", "Peru", "Brazil"][i % 4],
      })
    );
    const t0 = Date.now();
    FP.sortByPriority(liste, "Türkiye");
    const gecen = Date.now() - t0;
    assert.ok(gecen < 2000, `sortByPriority ${gecen}ms — anahtarlar yeniden hesaplaniyor olabilir`);
  });
});

/* ── Nöbetçi ─────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: priorityOf karşılaştırıcının İÇİNDE çağrılmıyor", () => {
  const src = fs.readFileSync(path.join(KOK, "lib", "fixture-priority.cjs"), "utf8")
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");
  const i = src.indexOf("function sortByPriority");
  const govde = src.slice(i, src.indexOf("\n}", i));
  const kars = govde.slice(govde.indexOf(".sort("));
  assert.ok(!/priorityOf\(/.test(kars),
    "priorityOf karsilastirici icinde — O(n log n) kez hesaplanir (4378ms)");
  assert.ok(!/koMs\(/.test(kars), "koMs karsilastirici icinde — tarih her karsilastirmada ayristirilir");
  assert.ok(/a\.i - b\.i/.test(kars), "kararlilik garantisi kalkmis");
});
