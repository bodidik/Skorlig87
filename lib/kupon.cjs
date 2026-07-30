"use strict";

/**
 * HAFTALIK KUPON — oyun mantığı (saf fonksiyonlar, I/O yok).
 *
 * OYUN: bir haftanın belirli maçları TEK kupon olur. Oyuncu kuponu satın alır
 * ve maçların HEPSİNE tahmin girer. Hafta bitince başarıya göre puan ve LC
 * kazanır.
 *
 * İKİ TÜR:
 *   ulke   — her ülke kendi ligi, hafta sonu. Oyuncu kendi ülkesinin kuponunu
 *            görür; ülkeler kendi içinde yarışır.
 *   avrupa — hafta ortası Avrupa kupası maçları. TEK kupon, TÜM ülkeler aynı
 *            tabloda yarışır. Kendi giriş bedeli ve puanlaması var.
 *
 * ⚠️ ÖDÜL HAVUZDAN DEĞİL, BAŞARIDAN. Giriş bedelleri havuzda toplanıp
 * dağıtılmıyor — YAKILIYOR. Ödül ise doğru sayısına göre ÜRETİLİYOR. Bu
 * bilinçli: pari-mutuel havuz (bkz. lib/pool-store.cjs) zaten var ve orada
 * ödül toplanan paraya bağlı. Burada oyuncu başkalarına karşı değil KENDİ
 * başarısına karşı oynuyor.
 *
 * ⚠️ EKONOMİ: bu tasarım LC BASAR. Kademeler `beklenenOdul()` ile ölçüldü ve
 * ortalama oyuncu için giriş bedelinin ALTINDA kalacak şekilde seçildi —
 * yani net etki deflasyonist. Kademeleri değiştirirsen tests/kupon.test.cjs
 * içindeki beklenen-değer testi seni uyarır.
 */

/* ── Tür tanımları ───────────────────────────────────────────────────────── */

const TUR = { ULKE: "ulke", AVRUPA: "avrupa" };

/**
 * Kupon başına maç sayısı. Ülke kuponu 8 (bir hafta sonu tipik lig turu),
 * Avrupa kuponu 6 (hafta ortası tur daha küçük).
 */
const MAC_SAYISI = {
  [TUR.ULKE]: Number(process.env.SKORLIG_KUPON_MAC_ULKE || 8),
  [TUR.AVRUPA]: Number(process.env.SKORLIG_KUPON_MAC_AVRUPA || 6),
};

/**
 * Giriş bedeli (LC).
 *
 * ⚠️ Tek tek oynamaktan UCUZ olmalı, yoksa kuponun anlamı kalmaz: 8 maç ayrı
 * ayrı 8×3 = 24 LC eder (bkz. lib/ekonomi.cjs MAC_GIRIS_BEDELI). Kupon 10 LC.
 * Avrupa kuponu daha az maç ama daha yüksek ödül taşıdığı için 15 LC.
 */
const GIRIS_BEDELI = {
  [TUR.ULKE]: Number(process.env.SKORLIG_KUPON_GIRIS_ULKE || 10),
  [TUR.AVRUPA]: Number(process.env.SKORLIG_KUPON_GIRIS_AVRUPA || 15),
};

/* ── Puanlama ────────────────────────────────────────────────────────────── */

/** Doğru tahmin başına temel puan. */
const DOGRU_PUAN = Number(process.env.SKORLIG_KUPON_DOGRU_PUAN || 10);

/**
 * Hepsini bilme bonusu — puan olarak, çarpan değil.
 * Kuponun asıl cazibesi bu: 8/8 nadirdir ve görünür bir ödül hak eder.
 */
const TAM_BONUS = Number(process.env.SKORLIG_KUPON_TAM_BONUS || 60);

/**
 * ⚠️ YÜZDESEL CEZA. Başarı oranı eşiğin altındaysa kazanılan puanın bir kısmı
 * geri alınır.
 *
 * NEDEN ORANSAL: sabit ceza az maçlı kuponda ezici, çok maçlıda etkisiz olur.
 * Yüzde, kupon boyutundan bağımsız aynı caydırıcılığı verir.
 *
 * NEDEN VAR: kupon ucuz ve tahminlerin hepsi tek seferde giriliyor. Cezasız
 * bırakılırsa rastgele doldurup şansa oynamak bedava bir kumar olur; ceza,
 * "bilmediğin maça da mecburen tahmin veriyorsun" gerçeğinin karşılığı.
 *
 * Eşik ve oran ayrı: eşiğin ALTINDA kalan, kazandığı puanın ORAN kadarını
 * kaybeder. Hiç puan kazanmadıysa ceza da 0'dır — eksiye düşülmez.
 */
const CEZA_ESIGI = Number(process.env.SKORLIG_KUPON_CEZA_ESIGI || 0.4); // %40 doğru
const CEZA_ORANI = Number(process.env.SKORLIG_KUPON_CEZA_ORANI || 0.5); // kazancın %50'si

/**
 * Bir kuponun puanını hesaplar.
 *
 * @param {number} dogru   doğru bilinen maç sayısı
 * @param {number} toplam  kupondaki maç sayısı
 * @returns {{puan:number, taban:number, bonus:number, ceza:number, oran:number}}
 */
function puanla(dogru, toplam) {
  const d = Math.max(0, Math.min(Number(dogru) || 0, Number(toplam) || 0));
  const t = Math.max(0, Number(toplam) || 0);
  if (t === 0) return { puan: 0, taban: 0, bonus: 0, ceza: 0, oran: 0 };

  const taban = d * DOGRU_PUAN;
  const bonus = d === t ? TAM_BONUS : 0;
  const oran = d / t;

  // Ceza yalnızca KAZANILAN puandan alınır; bonus zaten tam kuponda verilir,
  // yani cezayla aynı anda oluşamaz.
  const ceza = oran < CEZA_ESIGI ? Math.round(taban * CEZA_ORANI * 10) / 10 : 0;

  return {
    puan: Math.round((taban + bonus - ceza) * 10) / 10,
    taban, bonus, ceza,
    oran: Math.round(oran * 100) / 100,
  };
}

/* ── Ödül (LC) ───────────────────────────────────────────────────────────── */

/**
 * Başarıya göre LC ödülü — HAVUZDAN DEĞİL, ÜRETİLİR.
 *
 * Kademeler doğru ORANINA göre, maç sayısına değil: ülke (8 maç) ve Avrupa
 * (6 maç) kuponları aynı tabloyu kullanabilsin.
 *
 * ⚠️ Avrupa kuponu daha zorludur (kupa maçları daha oynak), o yüzden çarpanı
 * yüksek. Bu, giriş bedelinin de yüksek olmasının karşılığı.
 */
const ODUL_KADEMELERI = [
  { oran: 1.00, lc: Number(process.env.SKORLIG_KUPON_ODUL_TAM || 150) },
  { oran: 0.875, lc: Number(process.env.SKORLIG_KUPON_ODUL_7 || 50) },  // 7/8
  { oran: 0.75, lc: Number(process.env.SKORLIG_KUPON_ODUL_6 || 20) },   // 6/8
  { oran: 0.625, lc: Number(process.env.SKORLIG_KUPON_ODUL_5 || 8) },   // 5/8
];

const AVRUPA_CARPANI = Number(process.env.SKORLIG_KUPON_AVRUPA_CARPAN || 1.5);

/**
 * Kazanılan LC.
 * @returns {number} 0 ise ödül yok (eşiğin altında)
 */
function odul(dogru, toplam, tur = TUR.ULKE) {
  const t = Number(toplam) || 0;
  if (t === 0) return 0;
  const oran = Math.max(0, Math.min(Number(dogru) || 0, t)) / t;

  let lc = 0;
  for (const k of ODUL_KADEMELERI) {
    if (oran >= k.oran - 1e-9) { lc = k.lc; break; }
  }
  if (!lc) return 0;
  if (tur === TUR.AVRUPA) lc = Math.round(lc * AVRUPA_CARPANI);
  return lc;
}

/* ── Ekonomi ölçümü ──────────────────────────────────────────────────────── */

/**
 * Verilen isabet olasılığında bir kuponun BEKLENEN LC ödülünü hesaplar
 * (binom dağılımı). Denge ayarı için: sonuç giriş bedelinin altındaysa oyun
 * net LC YAKAR, üstündeyse BASAR.
 *
 * ⚠️ Bu fonksiyon testte kullanılıyor — kademeleri değiştirirsen ölçüm seni
 * uyarır. "Ödül hatırı sayılır olsun" isteği ile enflasyon arasındaki dengeyi
 * gözle değil bununla kur.
 *
 * @param {number} p       maç başına doğru bilme olasılığı (0..1)
 * @param {number} toplam  kupondaki maç sayısı
 */
function beklenenOdul(p, toplam, tur = TUR.ULKE) {
  const n = Number(toplam) || 0;
  if (n <= 0) return 0;
  const fakt = (k) => { let r = 1; for (let i = 2; i <= k; i++) r *= i; return r; };
  const binom = (n_, k) => fakt(n_) / (fakt(k) * fakt(n_ - k));
  let toplamBeklenen = 0;
  for (let k = 0; k <= n; k++) {
    const olasilik = binom(n, k) * Math.pow(p, k) * Math.pow(1 - p, n - k);
    toplamBeklenen += olasilik * odul(k, n, tur);
  }
  return Math.round(toplamBeklenen * 100) / 100;
}

module.exports = {
  TUR,
  MAC_SAYISI,
  GIRIS_BEDELI,
  DOGRU_PUAN,
  TAM_BONUS,
  CEZA_ESIGI,
  CEZA_ORANI,
  ODUL_KADEMELERI,
  AVRUPA_CARPANI,
  puanla,
  odul,
  beklenenOdul,
};
