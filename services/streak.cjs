"use strict";

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const STREAK_FILE = path.join(DATA_DIR, "streaks.json");

const TIERS = [
  { threshold:  5,  bonus:  5, label: "Isınıyor",         badge: null },
  { threshold: 10,  bonus: 15, label: "Ateşte",           badge: "fire" },
  { threshold: 20,  bonus: 25, label: "Durdurulamıyor",   badge: "unstoppable" },
];

async function loadStreaks() {
  try {
    const txt = await fsp.readFile(STREAK_FILE, "utf8");
    return JSON.parse(txt);
  } catch {
    return {};
  }
}

async function saveStreaks(data) {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.writeFile(STREAK_FILE, JSON.stringify(data, null, 2), "utf8");
}

function getUserStreak(streaks, userId) {
  const uid = String(userId).toLowerCase();
  if (!streaks[uid]) {
    streaks[uid] = {
      cumOdds: 0, count: 0, lastTier: -1, history: [],
      activeSeries: true, seriesCumOdds: 0, seriesCount: 0,
      bestSeries: 0,
    };
  }
  const s = streaks[uid];
  if (s.activeSeries == null) s.activeSeries = true;
  if (s.seriesCumOdds == null) s.seriesCumOdds = 0;
  if (s.seriesCount == null) s.seriesCount = 0;
  if (s.bestSeries == null) s.bestSeries = 0;
  return s;
}

function currentTier(cumOdds) {
  let tier = null;
  for (const t of TIERS) {
    if (cumOdds >= t.threshold) tier = t;
  }
  return tier;
}

async function recordCorrect(userId, fixtureId, odds) {
  const streaks = await loadStreaks();
  const s = getUserStreak(streaks, userId);

  // Genel birikim (hiç sıfırlanmaz)
  s.cumOdds = +(s.cumOdds + odds).toFixed(2);
  s.count += 1;

  // Aktif seri (yanlış gelince kesilir, doğruyla yeniden başlar)
  if (!s.activeSeries) {
    s.activeSeries = true;
    s.seriesCumOdds = 0;
    s.seriesCount = 0;
  }
  s.seriesCumOdds = +(s.seriesCumOdds + odds).toFixed(2);
  s.seriesCount += 1;

  if (s.seriesCumOdds > s.bestSeries) s.bestSeries = s.seriesCumOdds;

  s.history.push({ fixtureId, odds, at: new Date().toISOString(), correct: true });
  if (s.history.length > 50) s.history = s.history.slice(-50);

  // Tier bonusu aktif seriye bakılarak verilir
  const tier = currentTier(s.seriesCumOdds);
  let bonusLC = 0;
  let newTierReached = null;

  if (tier) {
    const tierIdx = TIERS.indexOf(tier);
    if (tierIdx > s.lastTier) {
      bonusLC = tier.bonus;
      newTierReached = tier;
      s.lastTier = tierIdx;
    }
  }

  await saveStreaks(streaks);
  return { cumOdds: s.cumOdds, count: s.count, seriesCumOdds: s.seriesCumOdds, seriesCount: s.seriesCount, bonusLC, tier: newTierReached, currentTier: tier, bestSeries: s.bestSeries };
}

async function recordWrong(userId, fixtureId) {
  const streaks = await loadStreaks();
  const s = getUserStreak(streaks, userId);

  s.history.push({ fixtureId, odds: 0, at: new Date().toISOString(), correct: false });
  if (s.history.length > 50) s.history = s.history.slice(-50);

  // Seri kesilir ama genel birikim sıfırlanmaz — yeni doğru tahminle yeni seri başlar
  s.activeSeries = false;
  s.seriesCumOdds = 0;
  s.seriesCount = 0;
  s.lastTier = -1;

  await saveStreaks(streaks);
  return { cumOdds: s.cumOdds, count: s.count, bonusLC: 0, tier: null, currentTier: currentTier(s.cumOdds), seriesBroken: true };
}

/**
 * Toplu seri kaydı — tek maçtaki tüm doğru/yanlış sonuçları TEK dosya
 * okuma+yazma ile işler (maç başına N ayrı yazma yerine 1).
 *
 * entries: [{ userId, fixtureId, correct: boolean, odds?: number }]
 *   - correct=true  → seriye odds eklenir, tier atlandıysa bonusLC verilir
 *   - correct=false → seri kırılır
 *   - odds verilmezse 1.0 kabul edilir (nadir seçim = yüksek odds = hızlı tier)
 *
 * dönüş: Map<userId, { bonusLC, tier, seriesCount, seriesCumOdds }>
 */
async function recordBatch(entries) {
  const out = new Map();
  if (!Array.isArray(entries) || entries.length === 0) return out;

  const streaks = await loadStreaks();
  let dirty = false;

  for (const e of entries) {
    const userId = e && e.userId;
    if (!userId) continue;
    const s = getUserStreak(streaks, userId);
    dirty = true;

    if (e.correct) {
      const odds = Number.isFinite(Number(e.odds)) ? Number(e.odds) : 1.0;

      s.cumOdds = +(s.cumOdds + odds).toFixed(2);
      s.count += 1;

      if (!s.activeSeries) {
        s.activeSeries = true;
        s.seriesCumOdds = 0;
        s.seriesCount = 0;
        s.lastTier = -1;
      }
      s.seriesCumOdds = +(s.seriesCumOdds + odds).toFixed(2);
      s.seriesCount += 1;
      if (s.seriesCumOdds > s.bestSeries) s.bestSeries = s.seriesCumOdds;

      s.history.push({ fixtureId: e.fixtureId, odds, at: new Date().toISOString(), correct: true });
      if (s.history.length > 50) s.history = s.history.slice(-50);

      const tier = currentTier(s.seriesCumOdds);
      let bonusLC = 0;
      let newTier = null;
      if (tier) {
        const tierIdx = TIERS.indexOf(tier);
        if (tierIdx > s.lastTier) {
          bonusLC = tier.bonus;
          newTier = tier;
          s.lastTier = tierIdx;
        }
      }
      out.set(userId, { bonusLC, tier: newTier, seriesCount: s.seriesCount, seriesCumOdds: s.seriesCumOdds });
    } else {
      s.history.push({ fixtureId: e.fixtureId, odds: 0, at: new Date().toISOString(), correct: false });
      if (s.history.length > 50) s.history = s.history.slice(-50);
      s.activeSeries = false;
      s.seriesCumOdds = 0;
      s.seriesCount = 0;
      s.lastTier = -1;
      out.set(userId, { bonusLC: 0, tier: null, seriesCount: 0, seriesCumOdds: 0, seriesBroken: true });
    }
  }

  if (dirty) await saveStreaks(streaks);
  return out;
}

async function getStreak(userId) {
  const streaks = await loadStreaks();
  const s = getUserStreak(streaks, userId);
  return {
    cumOdds: s.cumOdds, count: s.count,
    seriesCumOdds: s.seriesCumOdds, seriesCount: s.seriesCount,
    activeSeries: s.activeSeries, bestSeries: s.bestSeries,
    currentTier: currentTier(s.seriesCumOdds),
  };
}

module.exports = { recordCorrect, recordWrong, recordBatch, getStreak, TIERS, currentTier };
