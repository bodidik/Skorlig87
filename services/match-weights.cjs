"use strict";

/**
 * MAÇ AĞIRLIKLARI — puanlamanın tek doğruluk kaynağı.
 *
 * Bu formüller hem settle (gerçek puanı veren) hem de tahmin ekranının
 * "kazanabileceğin puan" önizlemesi tarafından kullanılır.
 *
 * NEDEN BU DOSYA VAR: Formüller bir dönem settle2.cjs içinde gömülüydü ve
 * mobil taraf kendi kopyasını tutuyordu. Kopyalar birbirinden ayrıldı —
 * ekranda "3 puan" yazarken sunucu 12 puan veriyordu (%823 sapma). Ekranda
 * gösterilen sayı sunucunun vereceği sayıysa, formül tek yerde yaşamalı.
 *
 * Buradaki değerleri değiştirmek GERÇEK PUANLAMAYI değiştirir.
 */

const { calcOdds } = require("./odds-engine.cjs");

const BOOKMAKER_MARGIN = 1.08;

/* ── Ülke/lig ağırlığı ───────────────────────────────────────────────────── */
// Üst düzey ligler biraz daha değerli; listede olmayan ülke 1.0 alır.
const SCORE_WEIGHTS = {
  "Türkiye": 1.0,
  Turkey: 1.0,
  England: 1.05,
  Spain: 1.05,
  Germany: 1.05,
  Italy: 1.05,
  France: 1.05,
  Netherlands: 1.03,
  Belgium: 1.03,
  Greece: 1.03,
  Portugal: 1.03,
  Brazil: 1.03,
  Argentina: 1.03,
  Japan: 1.03,
  Russia: 1.03,
  Ukraine: 1.03,
  USA: 1.02,
  "United States": 1.02,
  "Saudi Arabia": 1.02,
  "Suudi Arabistan": 1.02,
};

function getScoreWeight(country) {
  const c = String(country || "").trim();
  return Object.prototype.hasOwnProperty.call(SCORE_WEIGHTS, c) ? SCORE_WEIGHTS[c] : 1.0;
}

/* ── Maç sonucu (1X2) çarpanı ────────────────────────────────────────────── */
/**
 * Odds → çarpan. Favoriyi bilmek az, sürprizi bilmek çok kazandırır.
 *   1.01 odds → 0.34x (~1 puan)   |   4.0+ odds → 4.0x (12 puan)
 *
 * TOPLULUK DAĞILIMINA BAKMAZ: kaç kişi ne seçtiği bu çarpanı etkilemez.
 * Bu sayede yeni açılmış maçta da doğru değer üretir (soğuk başlangıç yok).
 */
function oddsMultiplier(home, away, oc) {
  const o = calcOdds(home || "", away || "");
  const raw = oc === "H" ? o.home : oc === "A" ? o.away : o.draw;
  return Math.max(0.34, Math.min(4.0, raw));
}

/* ── Maç zorluk çarpanı (yan kalemler) ───────────────────────────────────── */
/**
 * İlk gol / ilk yarı / kırmızı / penaltı puanlarına uygulanır.
 *
 * Ölçü favorinin ima edilen olasılığı: yüksekse maç tahmin edilebilir demektir.
 *   favProb ≈ 0.45 (dengeli) → ~1.10   ödül biraz artar
 *   favProb ≈ 0.75 (eşitsiz) → ~0.60   ödül azalır
 *
 * DİKKAT: Bir dönem bu (home_odds + away_odds)/4 idi; hem YÖNÜ TERSTİ hem
 * DOYUYORDU. Underdog oddsı sınırsız büyüdüğü için (Real Madrid-Ümraniyespor
 * → away 877) toplam her zaman tavana çarpıyor, en dengesiz maç en yüksek
 * çarpanı alıyordu. Oysa eşitsiz maçta ilk golü bilmek KOLAYDIR.
 */
function matchDifficulty(home, away) {
  const o = calcOdds(home || "", away || "");
  const implied = (odds) => (odds > 0 ? BOOKMAKER_MARGIN / odds : 0);
  const favProb = Math.max(implied(o.home), implied(o.draw), implied(o.away));
  return Math.max(0.6, Math.min(1.4, 2 * (1 - favProb)));
}

/* ── Kesin skor çarpanı (topluluk nadirliği) ─────────────────────────────── */
/**
 * "Adil pay" ≈ tahminlerin %5'i (20 yaygın skor varsayımı)
 *   %25 seçmişse → 0.6x (~7 puan)  |  %5 → 1.0x (12 puan)  |  hiç → 2.5x (30 puan)
 *
 * Bu çarpan topluluğa BAĞLIDIR — nadirlik ödülü tanım gereği başkalarının ne
 * seçtiğine bakar. 5 kişiden az katılımda güven harmanı (conf) ile 1.0'a
 * yaklaştırılır: düz kesilmez, kademeli yaklaşır.
 *
 * @param {number} humanTotal  bot olmayan tahmin sayısı
 * @param {Map<string,number>} scorePickMap  "h-a" → kaç kişi seçti
 */
function scoreMultiplier(humanTotal, scorePickMap, key) {
  if (humanTotal < 2) return 1.0;
  const conf = Math.min(1, humanTotal / 5);
  const n = (scorePickMap && scorePickMap.get(key)) || 0;
  const fairShare = humanTotal * 0.05;
  const raw = n === 0 ? 2.5 : fairShare / n;
  const damped = 1 + (raw - 1) * conf;
  return Math.max(0.6, Math.min(2.5, damped));
}

/* ── Baz puanlar (çarpansız) ─────────────────────────────────────────────── */
// Ön yüz önizlemesi bunları sunucudan alır ki sabitler tek yerde kalsın.
const BASE_POINTS = {
  outcome:      3,    // × oddsMultiplier
  exactScore:   12,   // × scoreMultiplier
  firstGoal:    1,    // × matchDifficulty
  firstHalf:    2,    // × matchDifficulty
  redAny:       1.5,  // × matchDifficulty
  redSide:      1,    // × matchDifficulty
  penaltyAny:   1.5,  // × matchDifficulty
  penaltySide:  1,    // × matchDifficulty
};

const PENALTY_POINTS = {
  firstGoal:   0.2,
  firstHalf:   0.4,
  redAny:      0.3,
  redSide:     0.2,
  penaltyAny:  0.3,
  penaltySide: 0.2,
};

module.exports = {
  BOOKMAKER_MARGIN,
  SCORE_WEIGHTS,
  BASE_POINTS,
  PENALTY_POINTS,
  getScoreWeight,
  oddsMultiplier,
  matchDifficulty,
  scoreMultiplier,
};
