"use strict";

/**
 * Sıralama adaleti kuralları.
 *
 * NEDEN VAR (ölçüldü 2026-07-29): sıralama güven ağırlıklı ortalama kullanıyor
 * ve güven ağırlığı = oynanan maç sayısı idi. Oynamak LC'ye bağlı, LC de parayla
 * alınabiliyor. Sonuç: 200 kişilik havuzda ÜÇÜ DE 6.0 ortalamalı oyuncular
 *     20 maç → 3. sıra | 60 maç → 2. sıra | 120 maç → 1. sıra
 * yani premium, DAHA İYİ TAHMİN ETMEDEN sıra satın alıyordu.
 *
 * Bu dosya üç şeyi birlikte tutar; biri için yapılan düzeltme diğerini bozarsa
 * burada yakalanır:
 *   1) para sıra satın alamaz          (tavan)
 *   2) yetenek hâlâ kazanır            (avg tavansız)
 *   3) tek şanslı tahmin zirve getirmez (daraltma)
 *
 * Çalıştırma:  npm test
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { rankRows, rankingMeta, RANK_MAX_PLAYED } = require("../lib/ranking.cjs");

/** Gerçekçi bir havuz: 200 vasat oyuncu, havuz ortalamasını 4.14 yapar. */
function havuz(n = 200, ort = 4.14, mac = 20) {
  return Array.from({ length: n }, (_, i) => ({
    userId: "p" + i,
    total: ort * mac,
    played: mac,
    penalties: 0,
  }));
}
const oyuncu = (userId, ort, mac) => ({ userId, total: ort * mac, played: mac, penalties: 0 });
const sirasi = (rows, userId) => rows.findIndex((r) => r.userId === userId) + 1;

describe("para sıra satın alamaz", () => {
  test("aynı yetenek, farklı maç sayısı → tavandan sonra AYNI rating", () => {
    const r = rankRows([
      ...havuz(),
      oyuncu("tavan", 6.0, RANK_MAX_PLAYED),
      oyuncu("iki_kat", 6.0, RANK_MAX_PLAYED * 2),
      oyuncu("yedi_kat", 6.0, RANK_MAX_PLAYED * 7),
    ]);
    const rating = (u) => r.find((x) => x.userId === u).rating;
    assert.equal(rating("iki_kat"), rating("tavan"), "2 kat maç avantaj vermemeli");
    assert.equal(rating("yedi_kat"), rating("tavan"), "7 kat maç da vermemeli");
  });

  test("REGRESYON: tavan kalkarsa bu test düşer", () => {
    // Kusurun kendisi. Tavan silinirse 400 maçlı oyuncunun rating'i 60 maçlıyı
    // geçer ve üstteki test kırmızıya döner — bu test o kusuru belgeler.
    const r = rankRows([...havuz(), oyuncu("cok", 6.0, 400)]);
    assert.equal(r.find((x) => x.userId === "cok").ratingWeight, RANK_MAX_PLAYED);
  });

  test("eşitlik bozucu da tavanlı — avantaj arka kapıdan girmemeli", () => {
    // Aynı rating'te eskiden "çok oynayan üstte" idi; tavanı kapatıp burayı
    // açık bırakmak düzeltmeyi anlamsız kılardı.
    const r = rankRows([
      oyuncu("az", 5.0, RANK_MAX_PLAYED),
      oyuncu("cok", 5.0, RANK_MAX_PLAYED * 5),
    ]);
    assert.equal(r[0].rating, r[1].rating, "rating eşit olmalı");
    assert.equal(r[0].userId, "az", "eşitlikte userId'ye düşmeli, maç sayısına değil");
  });

  test("tavan ÜCRETSİZ oyuncunun erişebileceği yerde olmalı", () => {
    // Günlük taban 6 LC, tahmin bedeli 3 LC → 2 maç/gün, 30 günde 60 maç.
    // Tavan bunun üstüne çıkarsa "erişilemez alan" yaratır ve pay-to-win geri gelir.
    const GUNLUK_TABAN = 6;
    const GIRIS_BEDELI = 3;
    const aylikUcretsiz = (GUNLUK_TABAN / GIRIS_BEDELI) * 30;
    assert.ok(RANK_MAX_PLAYED <= aylikUcretsiz, "tavan bir ayda ücretsiz kazanılabilmeli");
  });
});

describe("yetenek hâlâ kazanır", () => {
  test("iyi/az maç, vasat/çok maçı geçer", () => {
    const r = rankRows([...havuz(), oyuncu("iyi", 9.0, 25), oyuncu("vasat", 5.0, 400)]);
    assert.ok(sirasi(r, "iyi") < sirasi(r, "vasat"));
    assert.equal(sirasi(r, "iyi"), 1);
  });

  test("tavan üstünde bile ortalamayı yükseltmek işe yarar", () => {
    // Tavan güveni sınırlar, yeteneği değil: 400 maçta 7.0 tutmak,
    // 400 maçta 6.0 tutmaktan hâlâ üstün olmalı.
    const r = rankRows([...havuz(), oyuncu("a", 6.0, 400), oyuncu("b", 7.0, 400)]);
    assert.ok(sirasi(r, "b") < sirasi(r, "a"));
  });
});

describe("küçük örneklem zirve getirmez", () => {
  test("tek şanslı tahmin, 30 maçlık istikrarı geçemez", () => {
    const r = rankRows([
      ...havuz(),
      { userId: "sansli", total: 14, played: 1, penalties: 0 },
      oyuncu("istikrarli", 8.0, 30),
    ]);
    assert.ok(sirasi(r, "istikrarli") < sirasi(r, "sansli"));
  });

  test("hiç oynamamış oyuncu nötr — zirveye çıkamaz", () => {
    const r = rankRows([...havuz(), { userId: "yeni", total: 0, played: 0, penalties: 0 }]);
    assert.ok(sirasi(r, "yeni") > 1);
    assert.equal(r.find((x) => x.userId === "yeni").avg, 0);
  });
});

describe("meta şeffaflığı", () => {
  test("tavan istemciye bildirilir", () => {
    // Kullanıcı neden 400 maçın 60 maçtan iyi olmadığını görebilmeli.
    const m = rankingMeta(havuz());
    assert.equal(m.maxPlayedForRating, RANK_MAX_PLAYED);
    assert.match(m.note, /sıra satın alamaz|sıralamayı DEĞİŞTİRMEZ/);
  });

  test("boş liste patlamaz", () => {
    assert.deepEqual(rankRows([]), []);
    assert.equal(rankingMeta([]).priorMean, 0);
  });
});

describe("nitelik eşiği — tek şanslı maç zirveye çıkmasın", () => {
  /**
   * Dosya başındaki tasarım notu "tek şanslı tahmin zirve getirmez" diyor ve
   * bu MAÇ BAŞINA AZAMİ ~12 PUAN varsayımıyla kalibre edilmişti. Puanlama
   * çarpanları sonradan genişledi (settle2: "üst sınır kalktı") ve tek maçtan
   * çıkabilecek azami puan 56'ya yükseldi:
   *   sonuç 3×4.0 + kesin skor 12×2.5 + yan kalemler ×1.4 ≈ 53 (×1.05 ülke)
   *
   * Ölçülmüştü: 1 maç / 56 puan → rating 13.33, 60 maç / 9.80 ort → 9.70.
   * Yani tek maçlık oyuncu sezon lideri oluyordu.
   *
   * K'yı büyütmek çözmez: 1×56'nın 60×9.8'i geçmemesi için K > 513 gerekir.
   */
  const R = require("../lib/ranking.cjs");

  const havuz = () => [
    { userId: "sansli_1mac",    total: 56,       played: 1,  penalties: 0 },
    { userId: "sansli_5mac",    total: 64,       played: 5,  penalties: 0 },
    { userId: "iyi_12mac",      total: 12 * 11.5, played: 12, penalties: 0 },
    { userId: "tutarli_60mac",  total: 60 * 9.8, played: 60, penalties: 0 },
    { userId: "ortalama_60mac", total: 60 * 7,   played: 60, penalties: 0 },
  ];

  test("tek maçlık oyuncu zirveye çıkamaz", () => {
    const s = R.rankRows(havuz());
    assert.notEqual(s[0].userId, "sansli_1mac", "tek maclik oyuncu lider olmus");
    const yer = s.findIndex((r) => r.userId === "sansli_1mac");
    const tutarli = s.findIndex((r) => r.userId === "tutarli_60mac");
    assert.ok(yer > tutarli, "tek maclik oyuncu tutarli oyuncunun ustunde");
  });

  test("eşik altındaki rating havuz ortalamasını aşmaz", () => {
    const s = R.rankRows(havuz());
    const prior = R.computePriorMean(havuz());
    for (const r of s) {
      if (r.played < R.RANK_MIN_PLAYED) {
        assert.ok(r.rating <= prior + 1e-9,
          `${r.userId} esik altinda ama rating ${r.rating} > ortalama ${prior}`);
        assert.equal(r.qualified, false);
      }
    }
  });

  test("eşik altındaki oyuncu LİSTEDE KALIR (sert baraj değil)", () => {
    const s = R.rankRows(havuz());
    assert.ok(s.some((r) => r.userId === "sansli_1mac"), "oyuncu listeden dusmus");
    const r = s.find((x) => x.userId === "sansli_1mac");
    // Gerçek istatistikleri görünür kalmalı; yalnızca rating tavanlı.
    assert.equal(r.played, 1);
    assert.equal(r.avg, 56);
    assert.equal(r.minPlayed, R.RANK_MIN_PLAYED);
  });

  test("eşiği geçen gerçekten iyi oyuncu lider olur", () => {
    const s = R.rankRows(havuz());
    assert.equal(s[0].userId, "iyi_12mac");
    assert.equal(s[0].qualified, true);
  });

  test("çok maçlı vasat oyuncu (bot) en altta kalır", () => {
    const s = R.rankRows(havuz());
    assert.equal(s[s.length - 1].userId, "ortalama_60mac");
  });
});
