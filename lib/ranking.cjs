"use strict";

/**
 * Liderlik tablosu sıralaması — tek kaynak.
 *
 * NEDEN KÜMÜLATİF PUAN DEĞİL:
 *   1000 aktif bot her maça tahmin verir, insan haftada 2-3 maça. Kümülatif
 *   toplamda botlar kaçınılmaz olarak öne geçer ve tablo ulaşılmaz hale gelir.
 *
 * NEDEN DÜZ ORTALAMA DA DEĞİL:
 *   Tek maçta underdog tutan (12 puan / 1 maç = 12.0 ortalama) 50 maçta 11.0
 *   ortalaması olan herkesi geçer. Yeni hesap açıp tek şanslı tahminle zirveye
 *   yerleşmek mümkün olur — kümülatiften daha kötü bir açık.
 *
 * ÇÖZÜM — güven ağırlıklı ortalama (Bayes daraltması, IMDb ağırlıklı puan):
 *
 *     rating = (played × avg + K × priorMean) / (played + K)
 *
 *   priorMean : havuzun genel ortalaması
 *   K         : güven sabiti (kaç maçlık "kanıt" gerektiği)
 *
 *   K = 10 iken (varsayılan):
 *     1 maç,  12.0 ort. → M'ye büyük ölçüde çekilir, zirve getirmez
 *     3 maç,  12.0 ort. → kendi ortalamasının ~%23'ünü korur
 *     30 maç,  8.0 ort. → neredeyse 8.0 kalır → 3 maçlık sıcak seriyi geçer
 *
 *   Böylece süreklilik ödüllendirilir, tek şanslı tahmin zirve getirmez, ama
 *   yeni oyuncu tabloda görünmez de olmaz (sert maç barajı bunu yapardı).
 *
 *   K değeri ölçüldü: K=5'te 3 maçlık oyuncu 30 maçlık oyuncuyu geçiyordu
 *   (küçük örneklem fazla ödüllendiriliyor). K=10 dengeyi kuruyor; K=15-20
 *   daha da muhafazakâr ama yeni oyuncuyu geç görünür kılıyor.
 *   Her K değerinde çok maçlı vasat oyuncu (bot) en altta kalır — asıl amaç bu.
 */

// Güven sabiti — kaç maçlık kanıt "kendi ortalamasına güven" için yeterli
const CONFIDENCE_K = Number(process.env.SKORLIG_RANK_CONFIDENCE_K || 10);

// priorMean için havuz ortalaması hesaplanamazsa kullanılacak taban
const FALLBACK_PRIOR = Number(process.env.SKORLIG_RANK_FALLBACK_PRIOR || 0);

const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;

/**
 * Havuzun genel ortalamasını hesaplar: toplam puan / toplam maç.
 * Maç başına ortalamaların ortalaması DEĞİL — az maçlı oyuncular
 * genel ortalamayı çarpıtmasın diye maç ağırlıklı hesaplanır.
 */
function computePriorMean(rows) {
  let pts = 0;
  let played = 0;
  for (const r of rows) {
    pts += Number(r.total || 0);
    played += Number(r.played || 0);
  }
  if (played <= 0) return FALLBACK_PRIOR;
  return pts / played;
}

/**
 * rows: [{ userId, total, played, penalties }]
 * dönüş: aynı diziye avg + rating eklenmiş, rating'e göre azalan sıralı.
 *
 * Sıralama anahtarı: rating → eşitlikte played (çok oynayan üstte)
 *                            → eşitlikte total → eşitlikte userId (kararlı)
 */
function rankRows(rows) {
  const list = Array.isArray(rows) ? rows.slice() : [];
  const priorMean = computePriorMean(list);

  for (const r of list) {
    const total = Number(r.total || 0);
    const played = Number(r.played || 0);
    const avg = played > 0 ? total / played : 0;
    const rating =
      played > 0
        ? (played * avg + CONFIDENCE_K * priorMean) / (played + CONFIDENCE_K)
        : priorMean; // hiç oynamamış → nötr, zirveye çıkamaz

    r.avg = r2(avg);
    r.rating = r2(rating);
  }

  list.sort(
    (a, b) =>
      (b.rating || 0) - (a.rating || 0) ||
      (b.played || 0) - (a.played || 0) ||
      (b.total || 0) - (a.total || 0) ||
      String(a.userId).localeCompare(String(b.userId))
  );

  return list;
}

/** Sıralamanın nasıl hesaplandığını istemciye açıklamak için meta. */
function rankingMeta(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return {
    sortedBy: "rating",
    method: "confidence_weighted_average",
    confidenceK: CONFIDENCE_K,
    priorMean: r2(computePriorMean(list)),
    note:
      "rating = (played × avg + K × priorMean) / (played + K). Az maçlı oyuncu " +
      "havuz ortalamasına çekilir; maç sayısı arttıkça kendi ortalamasına yaklaşır.",
  };
}

module.exports = { rankRows, rankingMeta, computePriorMean, CONFIDENCE_K };
