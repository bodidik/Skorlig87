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

/**
 * GÜVEN TAVANI — para ile sıra satın alınmasını engeller.
 *
 * ÖLÇÜLDÜ (2026-07-29): 200 kişilik havuzda, ÜÇÜ DE 6.0 ortalamalı üç oyuncu:
 *     20 maç → 3. sıra (rating 5.41)
 *     60 maç → 2. sıra (rating 5.75)
 *    120 maç → 1. sıra (rating 5.86)
 * Yetenek aynı, sıra farklı. Tek değişken oynanan maç sayısı — o da LC ile
 * sınırlı: her tahmin 3 LC. Ücretsiz oyuncu günlük tabandan ayda ~60 LC (20 maç)
 * çıkarabilir; premium ayda 300 LC kasa + 10/gün ile ~600 LC (200 maç). Yani
 * premium, DAHA İYİ TAHMİN ETMEDEN sıra satın alıyordu. Pay-to-win.
 *
 * ÇÖZÜM: `avg`'ye (yeteneğe) dokunma, yalnızca daraltmanın PAYDASINI tavanla.
 * Tavana ulaşan herkes aynı güveni alır; fazla maç oynamak eğlence/düello/havuz
 * için hâlâ değerli ama sıralamada karşılığı yok.
 *
 * Tavan neden 60: günlük taban 6 LC ÷ 3 LC = 2 maç/gün × 30 gün. Ücretsiz
 * oyuncunun HİÇ para harcamadan bir ayda ulaşabileceği sayı. Daha düşük tavan
 * yeni oyuncuyu erken "tam güvenilir" sayardı; daha yükseği ücretsiz oyuncunun
 * erişemeyeceği bir alan bırakırdı.
 */
const RANK_MAX_PLAYED = Number(process.env.SKORLIG_RANK_MAX_PLAYED || 60);

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
    // Güven ağırlığı tavanlı; `avg` (yetenek) tavansız. bkz. RANK_MAX_PLAYED
    const w = Math.min(played, RANK_MAX_PLAYED);
    const rating =
      played > 0
        ? (w * avg + CONFIDENCE_K * priorMean) / (w + CONFIDENCE_K)
        : priorMean; // hiç oynamamış → nötr, zirveye çıkamaz

    r.avg = r2(avg);
    r.rating = r2(rating);
    r.ratingWeight = w; // şeffaflık: tavana ulaşan oyuncu bunu görebilmeli
  }

  list.sort(
    (a, b) =>
      (b.rating || 0) - (a.rating || 0) ||
      // Eşitlik bozucuda da tavan uygulanır; yoksa tavanı kapattığımız
      // avantaj eşitlikte arka kapıdan geri girerdi.
      Math.min(b.played || 0, RANK_MAX_PLAYED) - Math.min(a.played || 0, RANK_MAX_PLAYED) ||
      // Sonra ham isabet (avg). Eskiden burada kümülatif `total` vardı; o da
      // maç sayısıyla büyüdüğü için tavanı kapatıp burayı bırakmak, aynı
      // avantajı eşitlikten geri sokuyordu — testle yakalandı.
      (b.avg || 0) - (a.avg || 0) ||
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
    maxPlayedForRating: RANK_MAX_PLAYED,
    priorMean: r2(computePriorMean(list)),
    note:
      "rating = (w × avg + K × priorMean) / (w + K), w = min(played, " +
      RANK_MAX_PLAYED +
      "). Az maçlı oyuncu havuz ortalamasına çekilir; maç sayısı arttıkça kendi " +
      "ortalamasına yaklaşır. " +
      RANK_MAX_PLAYED +
      " maçtan sonra ek maç sıralamayı DEĞİŞTİRMEZ — böylece daha çok LC " +
      "(premium/satın alma) sıra satın alamaz, yalnızca isabet oranı yükseltir.",
  };
}

module.exports = {
  rankRows,
  rankingMeta,
  computePriorMean,
  CONFIDENCE_K,
  RANK_MAX_PLAYED,
};
