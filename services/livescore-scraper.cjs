"use strict";

const fs   = require("fs");
const path = require("path");

const DATA_DIR   = path.join(__dirname, "..", "data");
const CACHE_FILE = path.join(DATA_DIR, "livescore-cache.json");

const CHROME_PATH = process.env.LOCAL_CHROME_PATH
  || "C:/Program Files/Google/Chrome/Application/chrome.exe";

const IS_PROD = process.env.NODE_ENV === "production" || process.platform !== "win32";

const NAV_TIMEOUT  = 15000; // 15s per source
const SEL_TIMEOUT  = 10000;
const BLOCKED_TYPES = new Set(["image", "stylesheet", "font", "media"]);

async function getLaunchOptions() {
  const baseArgs = [
    "--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu",
    "--disable-dev-shm-usage", "--disable-extensions",
    "--disable-background-networking", "--disable-default-apps",
    "--disable-sync", "--no-first-run", "--disable-notifications",
  ];
  if (IS_PROD) {
    const chromium = require("@sparticuz/chromium");
    return { args: [...chromium.args, ...baseArgs], executablePath: await chromium.executablePath(), headless: chromium.headless };
  }
  return { executablePath: CHROME_PATH, headless: "new", args: baseArgs };
}

// ─── League map ───────────────────────────────────────────────────────────────

const LEAGUES = {
  "turkiye-super-lig":     { country: "Türkiye",   name: "Süper Lig",        keywords: ["süper lig", "super lig", "trendyol süper", "turkish super lig"],   countryMatch: ["türkiye", "turkey"] },
  "turkiye-1-lig":         { country: "Türkiye",   name: "1. Lig",           keywords: ["1. lig", "tff 1. lig", "tff first league"],                        countryMatch: ["türkiye", "turkey"] },
  "turkiye-hazirlik":      { country: "Türkiye",   name: "Hazırlık",         keywords: ["hazırlık türk"],                                                   countryMatch: ["dünya", "türkiye", "turkey"] },
  "ingiltere-premier-lig": { country: "İngiltere", name: "Premier Lig",      keywords: ["premier league", "premier lig"],                                   countryMatch: ["ingiltere", "england"] },
  "ispanya-la-liga":       { country: "İspanya",   name: "La Liga",          keywords: ["la liga"],                                                         countryMatch: ["ispanya", "spain"] },
  "sampiyonlar-ligi":      { country: "Avrupa",    name: "Şampiyonlar Ligi", keywords: ["şampiyonlar ligi", "champions league", "uefa champions league"],   countryMatch: ["avrupa", "dünya", "europe", "world"] },
};

// ─── Source stats (başarı oranı takibi) ──────────────────────────────────────

const STATS_FILE   = path.join(DATA_DIR, "livescore-stats.json");
const MIN_ATTEMPTS = 15;   // istatistik için minimum deneme sayısı
const WARN_RATE    = 0.25; // %25 altı başarı → eleme önerisi

function readStats() {
  try { if (fs.existsSync(STATS_FILE)) return JSON.parse(fs.readFileSync(STATS_FILE, "utf8")); } catch (_) {}
  return {};
}

function saveStats(stats) {
  try { fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2), "utf8"); } catch (_) {}
}

function recordAttempt(stats, name, success) {
  if (!stats[name]) stats[name] = { attempts: 0, success: 0, lastSuccess: null, lastAttempt: null };
  const s = stats[name];
  s.attempts++;
  s.lastAttempt = new Date().toISOString();
  if (success) { s.success++; s.lastSuccess = s.lastAttempt; }
}

function checkAndWarnStats(stats) {
  const poor = [];
  for (const [name, s] of Object.entries(stats)) {
    if (s.attempts >= MIN_ATTEMPTS && s.success / s.attempts < WARN_RATE) {
      poor.push({ name, rate: Math.round(s.success / s.attempts * 100), attempts: s.attempts });
    }
  }
  if (poor.length) {
    console.warn("[livescore] ⚠️  Düşük başarı oranlı kaynaklar (eleme önerilir):");
    poor.forEach(p => console.warn(`   → ${p.name}: %${p.rate} başarı (${p.attempts} deneme)`));
  }
  return poor;
}

// ─── Cache helpers ────────────────────────────────────────────────────────────

let _cache    = { ts: null, leagues: {}, trackedMatchCount: 0, totalMatchCount: 0 };
let _interval = null;
let _scraping = false;

function readCache() {
  try { if (fs.existsSync(CACHE_FILE)) _cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")); } catch (_) {}
  return _cache;
}

function writeCache(data) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch (e) { console.error("[livescore] cache write failed:", e.message); }
}

function matchLeague(compTitle, compCountry) {
  if (!compTitle) return null;
  const t = compTitle.toLowerCase();
  const c = (compCountry || "").toLowerCase();
  for (const [id, league] of Object.entries(LEAGUES)) {
    if (!league.keywords.some(kw => t.includes(kw))) continue;
    if (league.countryMatch.some(cm => c.includes(cm.toLowerCase()))) return { id, ...league };
  }
  return null;
}

function slugify(str) {
  return (str || "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64) || "other";
}

// ─── Shared browser helper ────────────────────────────────────────────────────

async function scrapeWithBrowser(url, parseFn, selectorHint) {
  const puppeteer  = require("puppeteer-core");
  const launchOpts = await getLaunchOptions();
  const browser    = await puppeteer.launch(launchOpts);
  try {
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36");
    await page.setViewport({ width: 1280, height: 800 });
    await page.setRequestInterception(true);
    page.on("request", req => {
      if (BLOCKED_TYPES.has(req.resourceType())) req.abort();
      else req.continue();
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
    if (selectorHint) await page.waitForSelector(selectorHint, { timeout: SEL_TIMEOUT }).catch(() => {});
    await new Promise(r => setTimeout(r, 1200));
    return await page.evaluate(parseFn);
  } finally {
    try { await browser.close(); } catch (_) {}
  }
}

// ─── Source 1: Maçkolik ───────────────────────────────────────────────────────

function fromMackolik() {
  return scrapeWithBrowser(
    "https://www.mackolik.com/canli-sonuclar",
    () => {
      const rows = document.querySelectorAll(".match-row");
      const results = [];
      rows.forEach(row => {
        const sport = row.querySelector(".match-row__match-content")?.getAttribute("data-sport");
        if (sport && sport !== "S") return;
        const compTitle   = row.querySelector(".match-row__competition abbr")?.getAttribute("title") || "";
        const compCountry = row.querySelector(".match-row__competition img")?.getAttribute("alt") || "";
        const homeTeam    = row.querySelector(".match-row__team-name--home .match-row__team-name-text")?.textContent?.trim() || "";
        const awayTeam    = row.querySelector(".match-row__team-name--away .match-row__team-name-text")?.textContent?.trim() || "";
        if (!homeTeam || !awayTeam) return;
        const homeScore = row.querySelector(".match-row__score-home")?.textContent?.trim() || null;
        const awayScore = row.querySelector(".match-row__score-away")?.textContent?.trim() || null;
        const status    = row.querySelector(".match-row__status")?.textContent?.trim() || "";
        const startTime = row.querySelector(".match-row__start-time")?.textContent?.trim() || "";
        const htScore   = row.querySelector(".match-row__half-time-score")?.textContent?.trim() || null;
        const matchDate = row.getAttribute("data-match-date") || "";
        const hcSrc = row.querySelector(".match-row__team-crest--home")?.getAttribute("data-src") || row.querySelector(".match-row__team-crest--home")?.getAttribute("src") || "";
        const acSrc = row.querySelector(".match-row__team-crest--away")?.getAttribute("data-src") || row.querySelector(".match-row__team-crest--away")?.getAttribute("src") || "";
        const homeRed = parseInt(row.querySelector(".match-row__team-name--home")?.getAttribute("data-red-cards") || "0", 10);
        const awayRed = parseInt(row.querySelector(".match-row__team-name--away")?.getAttribute("data-red-cards") || "0", 10);
        results.push({
          homeTeam, awayTeam, homeScore, awayScore,
          status: status || startTime || "—", startTime, htScore, matchDate,
          homeCrest: hcSrc ? (hcSrc.startsWith("http") ? hcSrc : "https:" + hcSrc) : null,
          awayCrest: acSrc ? (acSrc.startsWith("http") ? acSrc : "https:" + acSrc) : null,
          homeRed, awayRed,
          isLive: row.classList.contains("match-row--live"),
          isHT:   row.classList.contains("match-row--halfTime"),
          isFinished: status === "MS",
          compTitle, compCountry,
        });
      });
      return results;
    },
    ".match-row"
  );
}

// ─── Source 2: Bilyoner ───────────────────────────────────────────────────────

function fromBilyoner() {
  return scrapeWithBrowser(
    "https://www.bilyoner.com/canli-mac-sonuclari",
    () => {
      // Angular app — tries several selector patterns
      const rows = document.querySelectorAll(
        ".event-row, .live-event-item, [class*='liveEvent'], [class*='EventRow'], [class*='event-item']"
      );
      const results = [];
      rows.forEach(row => {
        const teams     = row.querySelectorAll("[class*='team-name'], [class*='teamName'], [class*='TeamName']");
        if (teams.length < 2) return;
        const homeTeam  = teams[0]?.textContent?.trim() || "";
        const awayTeam  = teams[1]?.textContent?.trim() || "";
        if (!homeTeam || !awayTeam) return;
        const scoreEls  = row.querySelectorAll("[class*='score'], [class*='Score']");
        const homeScore = scoreEls[0]?.textContent?.trim() || null;
        const awayScore = scoreEls[1]?.textContent?.trim() || null;
        const statusEl  = row.querySelector("[class*='status'], [class*='Status'], [class*='minute'], [class*='time']");
        const status    = statusEl?.textContent?.trim() || "—";
        const leagueEl  = row.closest("[class*='league'], [class*='competition'], [class*='League']")
                            ?.querySelector("[class*='title'], [class*='name']");
        results.push({
          homeTeam, awayTeam, homeScore, awayScore,
          status, startTime: "", htScore: null, matchDate: "",
          homeCrest: null, awayCrest: null, homeRed: 0, awayRed: 0,
          isLive: true, isHT: status === "HT", isFinished: false,
          compTitle: leagueEl?.textContent?.trim() || "",
          compCountry: "Turkey",
        });
      });
      return results;
    },
    null
  );
}

// ─── Source 3: Nesine ─────────────────────────────────────────────────────────

function fromNesine() {
  return scrapeWithBrowser(
    "https://iddaa.nesine.com/canli",
    () => {
      const rows = document.querySelectorAll(
        ".match-row, .event-row, [class*='MatchRow'], [class*='matchRow'], [class*='EventRow']"
      );
      const results = [];
      rows.forEach(row => {
        const teams    = row.querySelectorAll("[class*='team'], [class*='Team']");
        if (teams.length < 2) return;
        const homeTeam = teams[0]?.textContent?.trim() || "";
        const awayTeam = teams[1]?.textContent?.trim() || "";
        if (!homeTeam || !awayTeam) return;
        const scoreEls  = row.querySelectorAll("[class*='score'], [class*='Score']");
        const homeScore = scoreEls[0]?.textContent?.trim() || null;
        const awayScore = scoreEls[1]?.textContent?.trim() || null;
        const status    = row.querySelector("[class*='time'], [class*='minute'], [class*='status'], [class*='Status']")?.textContent?.trim() || "—";
        results.push({
          homeTeam, awayTeam, homeScore, awayScore,
          status, startTime: "", htScore: null, matchDate: "",
          homeCrest: null, awayCrest: null, homeRed: 0, awayRed: 0,
          isLive: true, isHT: status === "HT", isFinished: false,
          compTitle: "", compCountry: "Turkey",
        });
      });
      return results;
    },
    null
  );
}

// ─── Source 4: BBC Sport ──────────────────────────────────────────────────────

function fromBBC() {
  return scrapeWithBrowser(
    "https://www.bbc.com/sport/football/scores-fixtures",
    () => {
      const fixtures = document.querySelectorAll(".sp-c-fixture");
      const results  = [];
      fixtures.forEach(f => {
        const teams    = f.querySelectorAll(".sp-c-fixture__team-name-trunc, .sp-c-fixture__team-name");
        if (teams.length < 2) return;
        const homeTeam = teams[0]?.textContent?.trim() || "";
        const awayTeam = teams[1]?.textContent?.trim() || "";
        if (!homeTeam || !awayTeam) return;
        const scores   = f.querySelectorAll(".sp-c-fixture__number--score");
        const homeScore = scores[0]?.textContent?.trim() || null;
        const awayScore = scores[1]?.textContent?.trim() || null;
        const timeEl   = f.querySelector(".sp-c-fixture__number--time, .sp-c-fixture__status");
        const status   = timeEl?.textContent?.trim() || "—";
        const isLive   = f.classList.contains("sp-c-fixture--live") || /\d+'/.test(status);
        const sectionH = f.closest("[class*='fixture-group'], section")?.querySelector("h2, h3");
        results.push({
          homeTeam, awayTeam, homeScore, awayScore,
          status, startTime: "", htScore: null, matchDate: "",
          homeCrest: null, awayCrest: null, homeRed: 0, awayRed: 0,
          isLive, isHT: status === "HT", isFinished: status === "FT",
          compTitle: sectionH?.textContent?.trim() || "",
          compCountry: "England",
        });
      });
      return results;
    },
    ".sp-c-fixture"
  );
}

// ─── Source 5: Sky Sports ─────────────────────────────────────────────────────

function fromSkySports() {
  return scrapeWithBrowser(
    "https://www.skysports.com/football-scores-fixtures",
    () => {
      const rows    = document.querySelectorAll(".matches__item");
      const results = [];
      rows.forEach(row => {
        const homeTeam = row.querySelector(".matches__participant--side-one .matches__participant-name, [class*='home'] [class*='name']")?.textContent?.trim() || "";
        const awayTeam = row.querySelector(".matches__participant--side-two .matches__participant-name, [class*='away'] [class*='name']")?.textContent?.trim() || "";
        if (!homeTeam || !awayTeam) return;
        const homeScore = row.querySelector(".matches__teamscores-side--home, [class*='score-home']")?.textContent?.trim() || null;
        const awayScore = row.querySelector(".matches__teamscores-side--away, [class*='score-away']")?.textContent?.trim() || null;
        const status    = row.querySelector(".matches__status, .matches__date")?.textContent?.trim() || "—";
        results.push({
          homeTeam, awayTeam, homeScore, awayScore,
          status, startTime: "", htScore: null, matchDate: "",
          homeCrest: null, awayCrest: null, homeRed: 0, awayRed: 0,
          isLive: /\d+'/.test(status) || status === "HT",
          isHT: status === "HT", isFinished: status === "FT",
          compTitle: "", compCountry: "",
        });
      });
      return results;
    },
    null
  );
}

// ─── Source 6: Goal.com ───────────────────────────────────────────────────────

function fromGoal() {
  return scrapeWithBrowser(
    "https://www.goal.com/en/live-scores",
    () => {
      // React app — data-testid attributes or compiled class patterns
      const rows    = document.querySelectorAll("[data-testid='match-row'], [class*='MatchRow'], [class*='matchRow'], .match-cell");
      const results = [];
      rows.forEach(row => {
        const homeTeam  = row.querySelector("[data-testid='home-team-name'], [class*='HomeTeam'] span, [class*='homeTeam'] span")?.textContent?.trim() || "";
        const awayTeam  = row.querySelector("[data-testid='away-team-name'], [class*='AwayTeam'] span, [class*='awayTeam'] span")?.textContent?.trim() || "";
        if (!homeTeam || !awayTeam) return;
        const homeScore = row.querySelector("[data-testid='home-score'], [class*='HomeScore'], [class*='homeScore']")?.textContent?.trim() || null;
        const awayScore = row.querySelector("[data-testid='away-score'], [class*='AwayScore'], [class*='awayScore']")?.textContent?.trim() || null;
        const status    = row.querySelector("[data-testid='match-status'], [class*='MatchTime'], [class*='matchTime']")?.textContent?.trim() || "—";
        results.push({
          homeTeam, awayTeam, homeScore, awayScore,
          status, startTime: "", htScore: null, matchDate: "",
          homeCrest: null, awayCrest: null, homeRed: 0, awayRed: 0,
          isLive: /\d+'/.test(status) || status === "HT",
          isHT: status === "HT", isFinished: status === "FT",
          compTitle: "", compCountry: "",
        });
      });
      return results;
    },
    null
  );
}

// ─── Source 7: API-Football (HTTP, no browser) ────────────────────────────────

function fromApiFootball() {
  const key = process.env.AF_KEY;
  if (!key) return Promise.reject(new Error("AF_KEY not set"));

  return new Promise((resolve, reject) => {
    const https = require("https");
    const req = https.get(
      { hostname: "v3.football.api-sports.io", path: "/fixtures?live=all", headers: { "x-apisports-key": key } },
      (res) => {
        let raw = "";
        res.on("data", c => raw += c);
        res.on("end", () => {
          try {
            const json = JSON.parse(raw);
            if (json.errors && Object.keys(json.errors).length)
              return reject(new Error("api-football: " + JSON.stringify(json.errors)));
            const matches = (json.response || []).map(f => {
              const elapsed = f.fixture.status.elapsed;
              const short   = f.fixture.status.short;
              return {
                homeTeam:  f.teams.home.name,
                awayTeam:  f.teams.away.name,
                homeScore: f.goals.home !== null ? String(f.goals.home) : null,
                awayScore: f.goals.away !== null ? String(f.goals.away) : null,
                status:    elapsed ? `${elapsed}'` : short,
                startTime: (f.fixture.date || "").substring(11, 16),
                matchDate: (f.fixture.date || "").substring(0, 10),
                htScore:   f.score.halftime.home !== null ? `${f.score.halftime.home}-${f.score.halftime.away}` : null,
                homeCrest: f.teams.home.logo || null,
                awayCrest: f.teams.away.logo || null,
                homeRed: 0, awayRed: 0,
                isLive:    ["1H","HT","2H","ET","BT","P","SUSP","INT","LIVE"].includes(short),
                isHT:      short === "HT",
                isFinished: short === "FT",
                compTitle:   f.league.name,
                compCountry: f.league.country,
              };
            });
            resolve(matches);
          } catch (e) { reject(e); }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("api-football timeout")); });
  });
}

// ─── Source 8: TNT Sports ─────────────────────────────────────────────────────

function fromTNTSports() {
  return scrapeWithBrowser(
    "https://www.tntsports.co.uk/football/score-center.shtml",
    () => {
      // TNT/Discovery — score-center page, usually server-rendered
      const rows = document.querySelectorAll(
        ".match, .fixture, .event, [class*='scoreItem'], [class*='score-item'], [class*='match-row']"
      );
      const results = [];
      rows.forEach(row => {
        const homeTeam = row.querySelector("[class*='home'] [class*='team'], [class*='homeTeam'], [class*='home-team']")?.textContent?.trim()
          || row.querySelector("[class*='team']:first-child")?.textContent?.trim() || "";
        const awayTeam = row.querySelector("[class*='away'] [class*='team'], [class*='awayTeam'], [class*='away-team']")?.textContent?.trim()
          || row.querySelector("[class*='team']:last-child")?.textContent?.trim() || "";
        if (!homeTeam || !awayTeam || homeTeam === awayTeam) return;
        const homeScore = row.querySelector("[class*='homeScore'], [class*='home-score'], [class*='score']:first-of-type")?.textContent?.trim() || null;
        const awayScore = row.querySelector("[class*='awayScore'], [class*='away-score'], [class*='score']:last-of-type")?.textContent?.trim() || null;
        const status    = row.querySelector("[class*='status'], [class*='minute'], [class*='time'], [class*='clock']")?.textContent?.trim() || "—";
        const compEl    = row.closest("[class*='competition'], [class*='league'], [class*='tournament']")?.querySelector("[class*='name'], [class*='title'], h2, h3");
        results.push({
          homeTeam, awayTeam, homeScore, awayScore,
          status, startTime: "", htScore: null, matchDate: "",
          homeCrest: null, awayCrest: null, homeRed: 0, awayRed: 0,
          isLive: /\d+'/.test(status) || status === "HT",
          isHT: status === "HT", isFinished: ["FT","AET","PEN"].includes(status),
          compTitle:   compEl?.textContent?.trim() || "",
          compCountry: "",
        });
      });
      return results;
    },
    null
  );
}

// ─── Source 9: WSL Football ───────────────────────────────────────────────────
// Not: WSL = Women's Super League (İngiltere kadın futbolu).
// Türk ligleri için veri üretmez; genel kapsamı genişletmek için eklendi.

function fromWSLFootball() {
  return scrapeWithBrowser(
    "https://www.wslfootball.com/fixtures/index",
    () => {
      const rows = document.querySelectorAll(
        ".fixture-row, .match-row, .fixture, [class*='fixture'], [class*='match']"
      );
      const results = [];
      rows.forEach(row => {
        const teamEls  = row.querySelectorAll("[class*='team-name'], [class*='teamName'], [class*='club-name'], td.team");
        if (teamEls.length < 2) return;
        const homeTeam = teamEls[0]?.textContent?.trim() || "";
        const awayTeam = teamEls[1]?.textContent?.trim() || "";
        if (!homeTeam || !awayTeam) return;
        const scoreEls  = row.querySelectorAll("[class*='score'], td.score");
        const rawScore  = scoreEls[0]?.textContent?.trim() || "";
        const parts     = rawScore.split(/[-–]/);
        const homeScore = parts[0]?.trim() || null;
        const awayScore = parts[1]?.trim() || null;
        const status    = row.querySelector("[class*='status'], [class*='time'], td.time")?.textContent?.trim() || "—";
        results.push({
          homeTeam, awayTeam, homeScore, awayScore,
          status, startTime: "", htScore: null, matchDate: "",
          homeCrest: null, awayCrest: null, homeRed: 0, awayRed: 0,
          isLive: /\d+'/.test(status) || status === "HT",
          isHT: status === "HT", isFinished: status === "FT",
          compTitle: "Women's Super League", compCountry: "England",
        });
      });
      return results;
    },
    null
  );
}

// ─── Source 10: SoccersAPI livescore widget ───────────────────────────────────

function fromSoccersAPI() {
  return scrapeWithBrowser(
    "https://livescore.soccersapi.com/livescore-widget",
    () => {
      // Widget sayfası — React veya Angular tabanlı olabilir
      const rows = document.querySelectorAll(
        "[class*='match'], [class*='fixture'], [class*='event'], [class*='game'], tr.match"
      );
      const results = [];
      rows.forEach(row => {
        const homeTeam = row.querySelector("[class*='home'] [class*='name'], [class*='homeTeam'], [class*='home-name']")?.textContent?.trim() || "";
        const awayTeam = row.querySelector("[class*='away'] [class*='name'], [class*='awayTeam'], [class*='away-name']")?.textContent?.trim() || "";
        if (!homeTeam || !awayTeam) return;
        const homeScore = row.querySelector("[class*='homeScore'], [class*='home-score'], [class*='home'] [class*='score']")?.textContent?.trim() || null;
        const awayScore = row.querySelector("[class*='awayScore'], [class*='away-score'], [class*='away'] [class*='score']")?.textContent?.trim() || null;
        const status    = row.querySelector("[class*='status'], [class*='time'], [class*='minute']")?.textContent?.trim() || "—";
        const compEl    = row.closest("[class*='league'], [class*='competition']")?.querySelector("[class*='name'], [class*='title']");
        results.push({
          homeTeam, awayTeam, homeScore, awayScore,
          status, startTime: "", htScore: null, matchDate: "",
          homeCrest: null, awayCrest: null, homeRed: 0, awayRed: 0,
          isLive: /\d+'/.test(status) || status === "HT",
          isHT: status === "HT", isFinished: status === "FT",
          compTitle:   compEl?.textContent?.trim() || "",
          compCountry: "",
        });
      });
      return results;
    },
    null
  );
}

// ─── Waterfall ────────────────────────────────────────────────────────────────

const SOURCES = [
  { name: "mackolik",     fn: fromMackolik },
  { name: "bilyoner",     fn: fromBilyoner },
  { name: "nesine",       fn: fromNesine },
  { name: "bbc",          fn: fromBBC },
  { name: "skysports",    fn: fromSkySports },
  { name: "goal",         fn: fromGoal },
  { name: "tntsports",    fn: fromTNTSports },
  { name: "wslfootball",  fn: fromWSLFootball },
  { name: "soccersapi",   fn: fromSoccersAPI },
  { name: "api-football", fn: fromApiFootball },
];

// ─── Main scrape ──────────────────────────────────────────────────────────────

async function scrape() {
  if (_scraping) { console.log("[livescore] skip, already scraping"); return _cache; }
  _scraping = true;

  console.log("[livescore] waterfall başlıyor...");
  const startMs = Date.now();
  const stats   = readStats();

  let rawMatches = null;
  let usedSource = null;

  for (const { name, fn } of SOURCES) {
    try {
      console.log(`[livescore] ${name} deneniyor...`);
      const result = await fn();
      const ok = result && result.length > 0;
      recordAttempt(stats, name, ok);
      if (ok) {
        rawMatches = result;
        usedSource = name;
        console.log(`[livescore] ${name}: ${result.length} maç bulundu`);
        break;
      }
      console.log(`[livescore] ${name}: 0 maç — sonraki kaynak`);
    } catch (e) {
      recordAttempt(stats, name, false);
      console.warn(`[livescore] ${name} hata: ${e.message}`);
    }
  }

  saveStats(stats);
  checkAndWarnStats(stats); // düşük performanslı kaynakları logla

  if (!rawMatches) {
    console.error("[livescore] tüm kaynaklar başarısız, stale cache dönülüyor");
    _scraping = false;
    return _cache;
  }

  try {
    const leagueMap = {};
    for (const m of rawMatches) {
      const known  = matchLeague(m.compTitle, m.compCountry);
      const lid    = known?.id      ?? slugify((m.compTitle || "") + "-" + (m.compCountry || ""));
      const lname  = known?.name    ?? m.compTitle   ?? "Diğer";
      const lcountry = known?.country ?? m.compCountry ?? "";
      const match  = { ...m, league: lname, leagueId: lid, country: lcountry };
      delete match.compTitle;
      delete match.compCountry;
      if (!leagueMap[lid])
        leagueMap[lid] = { id: lid, name: lname, country: lcountry, known: !!known, matches: [] };
      leagueMap[lid].matches.push(match);
    }

    const result = {
      ts:                new Date().toISOString(),
      source:            usedSource,
      scrapeDurationMs:  Date.now() - startMs,
      leagues:           leagueMap,
      trackedMatchCount: Object.values(leagueMap).reduce((s, l) => s + l.matches.length, 0),
      totalMatchCount:   rawMatches.length,
    };

    _cache = result;
    writeCache(result);
    console.log(`[livescore] tamamlandı (${usedSource}) ${result.scrapeDurationMs}ms — ${result.trackedMatchCount}/${result.totalMatchCount} takip edilen`);
    return result;
  } catch (e) {
    console.error("[livescore] işlem hatası:", e.message);
    return _cache;
  } finally {
    _scraping = false;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

function getCache() {
  if (!_cache.ts) readCache();
  return _cache;
}

// Kaynak başarı istatistiklerini döner + eleme önerisi üretir
function getStats() {
  const stats = readStats();
  const report = Object.entries(stats).map(([name, s]) => ({
    name,
    attempts: s.attempts,
    success:  s.success,
    rate:     s.attempts ? Math.round(s.success / s.attempts * 100) : null,
    lastSuccess: s.lastSuccess,
    suggestion: s.attempts >= MIN_ATTEMPTS && s.success / s.attempts < WARN_RATE ? "ELE" : "TUT",
  }));
  report.sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1));
  return report;
}

function start(intervalMs = 5 * 60 * 1000) {
  if (_interval) return;
  console.log(`[livescore] scraper başlatıldı, aralık=${intervalMs / 1000}s`);
  scrape();
  _interval = setInterval(scrape, intervalMs);
}

function stop() {
  if (_interval) { clearInterval(_interval); _interval = null; }
}

module.exports = { scrape, getCache, getStats, start, stop, LEAGUES };
