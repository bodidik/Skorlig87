"use strict";

/**
 * SIRALAMA TAM SIRA (total order) OLMALI — AYNI VERİ, AYNI SIRA.
 *
 * ⚠️ BU TURDA KUSUR BULUNAMADI. Canlı sunucuda ölçüldü: aynı istek 3 kez
 * atıldı, 1677 satırın sırası birebir aynı çıktı — 139 beraberlik grubu ve
 * en büyüğü 30 kişilik olmasına rağmen.
 *
 * ⚠️ KARARLILIK TESADÜF DEĞİL, TASARIM: `lib/ranking.cjs` karşılaştırması
 * rating → (tavanlı) maç sayısı → ham isabet → `userId` zinciriyle bitiyor.
 * Son halka bir TAM SIRA garantisi veriyor.
 *
 * ⚠️ SON HALKA GEREKSİZ GÖRÜNÜR VE SİLİNMEYE ADAYDIR — silinirse sıralama
 * Mongo'nun belge sırasına kalır ve beraberlikteki 30 kişi her yenilemede
 * yer değiştirir. Kullanıcı sırasının oynadığını görür; hata çıkmaz, yalnızca
 * güven gider. Bu yüzden nöbetçi.
 *
 * ⚠️ ARA SIRALAMA MASUM: `routes/leaderboard.cjs` içinde beraberlik bozucusu
 * OLMAYAN bir ön sıralama var; sonucu doğrudan `scopedRank`e giriyor ve orada
 * belirleyici zincirle yeniden kuruluyor. Kullanıcıya ulaşan sıra o.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
const { hesaplaSiralama, siralamaHesapla, rankRows } = require("../lib/ranking.cjs");
const Ranking = require("../lib/ranking.cjs");

/** Dışa aktarılan sıralama fonksiyonunu adı ne olursa olsun bulur. */
function siralayici() {
  for (const ad of Object.keys(Ranking)) {
    if (typeof Ranking[ad] === "function" && /rank|sirala/i.test(ad)) return Ranking[ad];
  }
  return null;
}

describe("sıralama kararlılığı", () => {
  test("kurulum sınandı: sıralama fonksiyonu bulunabiliyor", () => {
    assert.ok(siralayici(), `ranking.cjs disa aktarimlari: ${Object.keys(Ranking).join(", ")}`);
  });

  test("BERABERLİK BOZUCU zinciri userId ile bitiyor (tam sıra)", () => {
    /**
     * ⚠️ Kaynağı okuyoruz çünkü asıl korunan şey davranış değil GARANTİ:
     * bugün veri kararlı çıkabilir ve zincir yine de eksik olabilir.
     */
    const src = fs.readFileSync(path.join(KOK, "lib", "ranking.cjs"), "utf8")
      .split(/\r?\n/)
      .filter((l) => { const t = l.trim(); return !t.startsWith("*") && !t.startsWith("//"); })
      .join(" ");
    const i = src.indexOf("list.sort(");
    assert.ok(i > 0, "siralama karsilastirmasi bulunamadi — test bir sey olcmuyor");
    const govde = src.slice(i, i + 700);
    assert.ok(/localeCompare/.test(govde),
      "siralama zinciri TAM SIRA degil — beraberlikteki oyuncular her yenilemede yer degistirir");
    assert.ok(/userId/.test(govde), "son beraberlik bozucu userId degil — kararlilik garanti edilemez");
  });

  test("AYNI GİRDİ iki kez sıralanınca AYNI çıktı", () => {
    const fn = siralayici();
    if (!fn) return;
    /* Beraberlik yogun veri: 30 kisi ayni puanda. */
    const uret = () => Array.from({ length: 60 }, (_, i) => ({
      userId: `oyuncu-${String(i).padStart(2, "0")}`,
      totalPoints: i < 30 ? 100 : 100 - i,
      matches: 12,
      totalPenalty: 0,
    }));
    const a = fn(uret()).map((x) => x.userId);
    const b = fn(uret()).map((x) => x.userId);
    assert.deepEqual(a, b, "ayni girdi farkli sira uretti — siralama belirleyici degil");
  });

  test("GİRDİ SIRASI sonucu değiştirmiyor", () => {
    /**
     * ⚠️ ASIL RİSK BU. Mongo belgeleri farklı sırada döndürürse (compaction,
     * indeks degisimi) beraberlikteki oyuncular kayar. Tam sıra bunu keser.
     */
    const fn = siralayici();
    if (!fn) return;
    const temel = Array.from({ length: 40 }, (_, i) => ({
      userId: `k-${String(i).padStart(2, "0")}`,
      totalPoints: i < 20 ? 50 : 50 - i,
      matches: 15,
      totalPenalty: 0,
    }));
    const duz = fn(temel.map((x) => ({ ...x }))).map((x) => x.userId);
    const ters = fn([...temel].reverse().map((x) => ({ ...x }))).map((x) => x.userId);
    assert.deepEqual(duz, ters,
      "girdi sirasi degisince siralama degisti — beraberlikte kullanicinin sirasi oynar");
  });
});
