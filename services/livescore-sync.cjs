"use strict";

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

const DATA_DIR   = path.join(__dirname, "..", "data");
const LIVE_DIR   = path.join(DATA_DIR, "live");
const FIXTURES_FILE = path.join(DATA_DIR, "fixtures.json");
const RESULTS_FILE  = path.join(DATA_DIR, "results.json");   // settle2'nin okuduğu file
const MATCH_RESULTS_FILE = path.join(DATA_DIR, "match-results.json");

const livescoreScraper = require("./livescore-scraper.cjs");

// track which fixtureIds we already settled this session
const _settledThisSession = new Set();
let _lastSync   = null;
let _syncInProgress = false;
let _apiPort    = 4102;

// ──────────────────────────────────────────────
// helpers
// ──────────────────────────────────────────────
function readJsonSync(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}
async function readJson(file, fb = null) {
  try { return JSON.parse(await fsp.readFile(file, "utf8")); } catch { return fb; }
}
async function writeJsonAtomic(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fsp.rename(tmp, file);
}

function liveStateFile(fid) {
  return path.join(LIVE_DIR, `${String(fid)}.json`);
}

// ──────────────────────────────────────────────
// Team name normalization
// Kendi fixtures'ımızdaki isimler Maçkolik'tekiyle örtüşmeyebilir.
// Her iki tarafı da normalize ediyoruz.
// ──────────────────────────────────────────────
const TEAM_MAP = {
  "galatasaray":  ["galatasaray", "galatasaray sk", "gs"],
  "fenerbahçe":   ["fenerbahçe", "fenerbahce", "fb"],
  "beşiktaş":     ["beşiktaş", "besiktas", "bjk"],
  "trabzonspor":  ["trabzonspor", "ts"],
  "başakşehir":   ["başakşehir", "istanbul başakşehir", "basaksehir"],
  "kayserispor":  ["kayserispor", "kayseri"],
  "sivasspor":    ["sivasspor", "sivas"],
  "konyaspor":    ["konyaspor", "konya"],
  "antalyaspor":  ["antalyaspor", "antalya"],
  "gaziantep":    ["gaziantep", "gaziantep fk", "gaziantepspor"],
  "hatayspor":    ["hatayspor", "hatay"],
  "kasımpaşa":    ["kasımpaşa", "kasimpasa"],
  "alanyaspor":   ["alanyaspor", "alanya"],
  "adana demirspor": ["adana demirspor", "adana demir"],
  "giresunspor":  ["giresunspor", "giresun"],
  "ümraniyespor": ["ümraniyespor", "umraniyespor", "ümraniye"],
  "kocaelispor":  ["kocaelispor", "kocaeli"],
  "istanbulspor": ["istanbulspor", "istanbul spor"],
  "erzurumspor":  ["erzurumspor fk", "erzurumspor", "erzurum"],
  "rizespor":     ["ç. rizespor", "çaykur rizespor", "rizespor", "rize"],
  "arsenal":      ["arsenal"],
  "chelsea":      ["chelsea"],
  "liverpool":    ["liverpool"],
  "manchester city": ["manchester city", "man city", "man. city"],
  "manchester united": ["manchester united", "man utd", "man. united"],
  "tottenham":    ["tottenham", "tottenham hotspur", "spurs"],
  "real madrid":  ["real madrid"],
  "barcelona":    ["fc barcelona", "barcelona"],
  "atletico madrid": ["atlético madrid", "atletico madrid", "atletico de madrid"],
};

function normalizeTeam(name) {
  if (!name) return "";
  const n = name.toLowerCase().trim();
  for (const [canonical, variants] of Object.entries(TEAM_MAP)) {
    if (variants.some(v => n === v || n.includes(v))) return canonical;
  }
  return n;
}

// ──────────────────────────────────────────────
// Match a fixture to a livescore entry
// ──────────────────────────────────────────────
function findLiveMatch(fixture, allMatches) {
  const fixHome = normalizeTeam(fixture.home);
  const fixAway = normalizeTeam(fixture.away);

  const kickoff = new Date(fixture.kickoffISO || fixture.kickoffDate || "");
  const kickoffValid = !isNaN(kickoff.getTime());

  return allMatches.find(m => {
    if (normalizeTeam(m.homeTeam) !== fixHome) return false;
    if (normalizeTeam(m.awayTeam) !== fixAway) return false;

    if (!kickoffValid || !m.matchDate) return true;

    try {
      const [dateStr, timeStr] = m.matchDate.split(" ");
      const [hh, mm] = (timeStr || "00:00").split(":").map(Number);
      const liveKO = new Date(dateStr);
      liveKO.setHours(hh, mm, 0, 0);
      return Math.abs(kickoff - liveKO) / 60000 <= 45; // 45 dk tolerans
    } catch { return true; }
  });
}

// ──────────────────────────────────────────────
// Parse HT from "İY 0-1" string
// ──────────────────────────────────────────────
function parseHT(htScore) {
  if (!htScore) return null;
  const m = htScore.match(/(\d+)-(\d+)/);
  if (!m) return null;
  return { home: parseInt(m[1], 10), away: parseInt(m[2], 10) };
}

// ──────────────────────────────────────────────
// Write live state so settle2 can read it
// ──────────────────────────────────────────────
async function writeLiveState(fixtureId, liveMatch, scores, nowISO) {
  const stateFile = liveStateFile(fixtureId);
  const prev = await readJson(stateFile, {});
  const st = {
    ...prev,
    fixtureId,
    status: scores.isFT ? "FT" : "LIVE",
    isLive: !scores.isFT,
    score: { home: scores.home, away: scores.away },
    updatedAt: nowISO,
    source: "livescore-sync",
  };
  if (scores.htHome != null) st.htScore = { home: scores.htHome, away: scores.htAway };
  if (liveMatch.homeRed) st.redHome = liveMatch.homeRed;
  if (liveMatch.awayRed) st.redAway = liveMatch.awayRed;

  await writeJsonAtomic(stateFile, st);
}

// ──────────────────────────────────────────────
// Also write to results.json so settle2 bootstrap picks it up
// ──────────────────────────────────────────────
async function writeResultsEntry(fixture, scores, nowISO) {
  const results = await readJson(RESULTS_FILE, []);
  const list = Array.isArray(results) ? results : (results?.items || []);

  const idx = list.findIndex(r => r.fixtureId === fixture.fixtureId);
  const entry = idx >= 0 ? list[idx] : {
    fixtureId: fixture.fixtureId,
    home: fixture.home,
    away: fixture.away,
    source: "livescore-sync",
  };

  entry.homeScore  = scores.home;
  entry.awayScore  = scores.away;
  entry.status     = scores.isFT ? "FT" : "LIVE";
  entry.syncedAt   = nowISO;
  if (scores.htHome != null) {
    entry.htHome = scores.htHome;
    entry.htAway = scores.htAway;
  }

  if (idx >= 0) list[idx] = entry; else list.push(entry);

  const toWrite = Array.isArray(results) ? list : { items: list };
  await writeJsonAtomic(RESULTS_FILE, toWrite);
}

// ──────────────────────────────────────────────
// Trigger settle2 via HTTP
// ──────────────────────────────────────────────
async function triggerSettle(fixtureId) {
  const url = `http://localhost:${_apiPort}/api/rt/settle2?fixtureId=${encodeURIComponent(fixtureId)}`;
  try {
    const res = await fetch(url, { method: "POST", signal: AbortSignal.timeout(15000) });
    const j = await res.json();
    if (j.ok) {
      console.log(`[sync] ✅ settle OK → ${fixtureId} (${j.settled} settled)`);
    } else {
      console.error(`[sync] ⚠️  settle FAILED → ${fixtureId}: ${j.error} — ${j.detail}`);
    }
    return j;
  } catch (e) {
    console.error(`[sync] settle fetch error → ${fixtureId}: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

// ──────────────────────────────────────────────
// Main sync loop
// ──────────────────────────────────────────────
async function sync() {
  if (_syncInProgress) return _lastSync;
  _syncInProgress = true;

  const startMs = Date.now();
  const nowISO  = new Date().toISOString();

  try {
    const fixturesData = readJsonSync(FIXTURES_FILE);
    const lsCache      = livescoreScraper.getCache();

    if (!fixturesData?.fixtures?.length) throw new Error("No fixtures");
    if (!lsCache?.leagues) throw new Error("Livescore cache empty");

    // Flatten livescore matches
    const allLive = [];
    for (const lg of Object.values(lsCache.leagues)) {
      if (lg.matches) allLive.push(...lg.matches);
    }

    const matchResults = await readJson(MATCH_RESULTS_FILE, { items: [] });
    const settledIds   = new Set(
      (Array.isArray(matchResults) ? matchResults : matchResults.items || [])
        .map(r => r.fixtureId)
    );

    let newFT = 0;
    let newLive = 0;
    const settleQueue = [];

    for (const fixture of fixturesData.fixtures) {
      const fid      = fixture.fixtureId;
      const liveMatch = findLiveMatch(fixture, allLive);
      if (!liveMatch) continue;

      const htParsed = parseHT(liveMatch.htScore);
      const hasScore = liveMatch.homeScore != null && liveMatch.awayScore != null;

      const scores = {
        home:   hasScore ? parseInt(liveMatch.homeScore, 10) : 0,
        away:   hasScore ? parseInt(liveMatch.awayScore, 10) : 0,
        isFT:   liveMatch.isFinished,
        htHome: htParsed?.home ?? null,
        htAway: htParsed?.away ?? null,
      };

      if (!hasScore && !htParsed) continue; // maç henüz başlamadı

      // Write live state (HT+FT veya sadece LIVE)
      await writeLiveState(fid, liveMatch, scores, nowISO);
      if (scores.isFT) await writeResultsEntry(fixture, scores, nowISO);

      // Settle trigger — sadece FT + daha önce settle edilmemişse
      if (scores.isFT && !settledIds.has(fid) && !_settledThisSession.has(fid)) {
        settleQueue.push(fid);
        newFT++;
      } else if (!scores.isFT && hasScore) {
        newLive++;
      }
    }

    // Settle sırayla (flood önlemi)
    for (const fid of settleQueue) {
      _settledThisSession.add(fid); // optimistic lock
      await triggerSettle(fid);
      await new Promise(r => setTimeout(r, 500)); // biraz bekle aralarında
    }

    const duration = Date.now() - startMs;
    if (newFT || newLive) {
      console.log(`[sync] ${nowISO} — FT settle: ${newFT}, live updates: ${newLive} (${duration}ms)`);
    }

    _lastSync = { ts: nowISO, newFT, newLive, duration };
    return _lastSync;
  } catch (e) {
    console.error("[sync] error:", e.message);
    _lastSync = { ts: nowISO, error: e.message };
    return _lastSync;
  } finally {
    _syncInProgress = false;
  }
}

function getLastSync() { return _lastSync || { ts: null }; }

function start(intervalMs = 30 * 1000, apiPort = 4102) {
  _apiPort = apiPort;
  console.log(`[sync] starting, interval=${intervalMs / 1000}s`);
  sync();
  setInterval(sync, intervalMs);
}

module.exports = { sync, getLastSync, start };
