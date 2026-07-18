"use strict";

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const CACHE_FILE = path.join(DATA_DIR, "livescore-cache.json");

// Yerel (Windows) geliştirmede kullanılacak Chrome yolu.
// Env ile override edilebilir: LOCAL_CHROME_PATH
const CHROME_PATH = process.env.LOCAL_CHROME_PATH
  || "C:/Program Files/Google/Chrome/Application/chrome.exe";

// Prod (Render/Linux) mu, yerel mi? Prod'da @sparticuz/chromium kullan.
const IS_PROD = process.env.NODE_ENV === "production" || process.platform !== "win32";

// Ortama göre puppeteer launch seçeneklerini döndürür.
async function getLaunchOptions() {
  const baseArgs = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-default-apps",
    "--disable-sync",
    "--no-first-run",
    "--disable-notifications",
  ];

  if (IS_PROD) {
    // Render / Linux — serverless chromium
    const chromium = require("@sparticuz/chromium");
    return {
      args: [...chromium.args, ...baseArgs],
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    };
  }

  // Yerel Windows — kurulu Chrome
  return {
    executablePath: CHROME_PATH,
    headless: "new",
    args: baseArgs,
  };
}

const LEAGUES = {
  "turkiye-super-lig":     { country: "Türkiye",   name: "Süper Lig",              keywords: ["süper lig"],                                               countryMatch: ["türkiye"] },
  "turkiye-1-lig":         { country: "Türkiye",   name: "1. Lig",                 keywords: ["1. lig", "tff 1. lig"],                                    countryMatch: ["türkiye"] },
  "turkiye-hazirlik":      { country: "Türkiye",   name: "Hazırlık Türk Takımları",keywords: ["hazırlık türk"],                                           countryMatch: ["dünya", "türkiye"] },
  "ingiltere-premier-lig": { country: "İngiltere", name: "Premier Lig",            keywords: ["premier league", "premier lig"],                           countryMatch: ["ingiltere"] },
  "ispanya-la-liga":       { country: "İspanya",   name: "La Liga",                keywords: ["la liga"],                                                 countryMatch: ["ispanya"] },
  "sampiyonlar-ligi":      { country: "Avrupa",    name: "Şampiyonlar Ligi",       keywords: ["şampiyonlar ligi", "champions league", "uefa şampiyonlar"], countryMatch: ["avrupa", "dünya"] },
};

let _cache = { ts: null, leagues: {}, trackedMatchCount: 0, totalMatchCount: 0 };
let _interval = null;
let _scraping = false;

function readCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      _cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    }
  } catch (_) {}
  return _cache;
}

function writeCache(data) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch (e) {
    console.error("[livescore] cache write failed:", e.message);
  }
}

function matchLeague(compTitle, compCountry) {
  if (!compTitle) return null;
  const t = compTitle.toLowerCase();
  const c = (compCountry || "").toLowerCase();
  for (const [id, league] of Object.entries(LEAGUES)) {
    const titleOk = league.keywords.some(kw => t.includes(kw));
    if (!titleOk) continue;
    const countryOk = league.countryMatch.some(cm => c.includes(cm.toLowerCase()));
    if (countryOk) return { id, ...league };
  }
  return null;
}

async function scrape() {
  if (_scraping) { console.log("[livescore] skip, already scraping"); return _cache; }
  _scraping = true;

  console.log("[livescore] scraping mackolik via puppeteer...");
  const startMs = Date.now();
  let browser;

  try {
    const puppeteer = require("puppeteer-core");
    const launchOpts = await getLaunchOptions();
    browser = await puppeteer.launch(launchOpts);

    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36");
    await page.setViewport({ width: 1280, height: 720 });

    await page.goto("https://www.mackolik.com/canli-sonuclar", {
      waitUntil: "networkidle2",
      timeout: 30000,
    });

    await page.waitForSelector(".match-row", { timeout: 15000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 2000));

    const matches = await page.evaluate(() => {
      const rows = document.querySelectorAll(".match-row");
      const results = [];
      rows.forEach(row => {
        const sport = row.querySelector(".match-row__match-content")?.getAttribute("data-sport");
        if (sport && sport !== "S") return;

        const compTitle = row.querySelector(".match-row__competition abbr")?.getAttribute("title") || "";
        const compCountry = row.querySelector(".match-row__competition img")?.getAttribute("alt") || "";

        const homeTeam = row.querySelector(".match-row__team-name--home .match-row__team-name-text")?.textContent?.trim() || "";
        const awayTeam = row.querySelector(".match-row__team-name--away .match-row__team-name-text")?.textContent?.trim() || "";
        if (!homeTeam || !awayTeam) return;

        const homeScore = row.querySelector(".match-row__score-home")?.textContent?.trim() || null;
        const awayScore = row.querySelector(".match-row__score-away")?.textContent?.trim() || null;
        const status = row.querySelector(".match-row__status")?.textContent?.trim() || "";
        const startTime = row.querySelector(".match-row__start-time")?.textContent?.trim() || "";
        const htScore = row.querySelector(".match-row__half-time-score")?.textContent?.trim() || null;
        const matchDate = row.getAttribute("data-match-date") || "";

        const homeCrestSrc = row.querySelector(".match-row__team-crest--home")?.getAttribute("data-src") || row.querySelector(".match-row__team-crest--home")?.getAttribute("src") || "";
        const awayCrestSrc = row.querySelector(".match-row__team-crest--away")?.getAttribute("data-src") || row.querySelector(".match-row__team-crest--away")?.getAttribute("src") || "";

        const homeRed = parseInt(row.querySelector(".match-row__team-name--home")?.getAttribute("data-red-cards") || "0", 10);
        const awayRed = parseInt(row.querySelector(".match-row__team-name--away")?.getAttribute("data-red-cards") || "0", 10);

        const isLive = row.classList.contains("match-row--live");
        const isHT = row.classList.contains("match-row--halfTime");
        const isFinished = status === "MS";

        results.push({
          homeTeam, awayTeam,
          homeScore, awayScore,
          status: status || startTime || "—",
          startTime,
          htScore, matchDate,
          homeCrest: homeCrestSrc ? (homeCrestSrc.startsWith("http") ? homeCrestSrc : "https:" + homeCrestSrc) : null,
          awayCrest: awayCrestSrc ? (awayCrestSrc.startsWith("http") ? awayCrestSrc : "https:" + awayCrestSrc) : null,
          homeRed, awayRed,
          isLive, isHT, isFinished,
          compTitle, compCountry,
        });
      });
      return results;
    });

    await browser.close();
    browser = null;

    const leagueMap = {};
    for (const m of matches) {
      const league = matchLeague(m.compTitle, m.compCountry);
      const match = {
        ...m,
        league: league ? league.name : m.compTitle,
        leagueId: league ? league.id : null,
        country: league ? league.country : m.compCountry,
      };
      delete match.compTitle;
      delete match.compCountry;

      if (league) {
        if (!leagueMap[league.id]) {
          leagueMap[league.id] = { id: league.id, name: league.name, country: league.country, matches: [] };
        }
        leagueMap[league.id].matches.push(match);
      }
    }

    const result = {
      ts: new Date().toISOString(),
      scrapeDurationMs: Date.now() - startMs,
      leagues: leagueMap,
      trackedMatchCount: Object.values(leagueMap).reduce((s, l) => s + l.matches.length, 0),
      totalMatchCount: matches.length,
    };

    _cache = result;
    writeCache(result);

    console.log(`[livescore] done in ${result.scrapeDurationMs}ms — ${result.trackedMatchCount} tracked, ${result.totalMatchCount} total`);
    return result;
  } catch (e) {
    console.error("[livescore] scrape error:", e.message);
    return _cache;
  } finally {
    _scraping = false;
    if (browser) try { await browser.close(); } catch (_) {}
  }
}

function getCache() {
  if (!_cache.ts) readCache();
  return _cache;
}

function start(intervalMs = 5 * 60 * 1000) {
  if (_interval) return;
  console.log(`[livescore] starting scraper, interval=${intervalMs / 1000}s`);
  scrape();
  _interval = setInterval(scrape, intervalMs);
}

function stop() {
  if (_interval) { clearInterval(_interval); _interval = null; }
}

module.exports = { scrape, getCache, start, stop, LEAGUES };
