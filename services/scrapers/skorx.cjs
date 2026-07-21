"use strict";

/**
 * SkorX Scraper — canlı skor + sonuçlar (Maçkolik yedeği)
 *
 * SkorX.com'dan HTML fetch ile canlı skor çeker.
 * livescore-scraper.cjs ile aynı formatta veri döndürür:
 * { ts, leagues: { [leagueId]: { name, country, matches: [...] } } }
 */

const SKORX_URL = "https://www.skorx.com/tr/canli-mac-sonuclari";

// Türkçe lig isimleri → SkorLig lig eşlemeleri
const LEAGUE_PATTERNS = [
  { pattern: /süper lig/i,              id: "turkiye-super-lig",     name: "Süper Lig",              country: "Türkiye" },
  { pattern: /tff 1\.?\s*lig|1\.\s*lig/i, id: "turkiye-1-lig",      name: "1. Lig",                 country: "Türkiye" },
  { pattern: /champions league|şampiyonlar/i, id: "sampiyonlar-ligi", name: "Şampiyonlar Ligi",      country: "Avrupa" },
  { pattern: /europa league/i,          id: "europa-league",          name: "Europa League",          country: "Avrupa" },
  { pattern: /premier league/i,         id: "ingiltere-premier-lig",  name: "Premier League",         country: "İngiltere" },
  { pattern: /la liga/i,                id: "ispanya-la-liga",         name: "La Liga",                country: "İspanya" },
  { pattern: /bundesliga/i,             id: "almanya-bundesliga",      name: "Bundesliga",             country: "Almanya" },
  { pattern: /serie a/i,                id: "italya-serie-a",          name: "Serie A",                country: "İtalya" },
  { pattern: /ligue 1/i,                id: "fransa-ligue-1",          name: "Ligue 1",                country: "Fransa" },
];

function matchLeague(leagueText) {
  const t = String(leagueText || "");
  for (const def of LEAGUE_PATTERNS) {
    if (def.pattern.test(t)) return def;
  }
  return { id: "other", name: t, country: "Diğer" };
}

// Sayısal skor mu?
function parseScore(s) {
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

// Süreyi dakikaya çevir: "45+2", "90", "HT" → number | null
function parseMinute(s) {
  if (!s) return null;
  const t = s.trim();
  if (/ht|iy|half/i.test(t)) return 45;
  const m = t.match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

// HTML'den maç satırlarını basit regex ile çeker (JS engine gerektirmez)
function parseMatchRows(html) {
  const matches = [];

  // SkorX genellikle <table> veya <div class="match-row"> yapısı kullanır.
  // İki yaklaşımı ardışık deneriz.

  // --- Yaklaşım 1: JSON-LD veya data attribute'lardan ---
  const jsonLdMatch = html.match(/<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/i);
  if (jsonLdMatch) {
    try {
      const parsed = JSON.parse(jsonLdMatch[1]);
      const events = parsed?.events ?? parsed?.matches ?? parsed?.data;
      if (Array.isArray(events) && events.length) {
        for (const ev of events) {
          const home = ev.homeTeam?.name ?? ev.home ?? "";
          const away = ev.awayTeam?.name ?? ev.away ?? "";
          if (!home || !away) continue;
          const hs = parseScore(ev.homeScore ?? ev.score?.home);
          const as_ = parseScore(ev.awayScore ?? ev.score?.away);
          matches.push({
            homeTeam: home, awayTeam: away,
            homeScore: hs != null ? String(hs) : null,
            awayScore: as_ != null ? String(as_) : null,
            status: ev.status ?? (ev.finished ? "MS" : ""),
            isLive: !!ev.live || !!ev.isLive,
            isFinished: ev.finished === true || ev.status === "FT" || ev.status === "MS",
            compTitle: ev.league?.name ?? ev.tournament ?? "",
            compCountry: ev.league?.country ?? ev.country ?? "",
            htScore: ev.htScore ?? null,
            minute: String(ev.minute ?? ""),
          });
        }
        return matches;
      }
    } catch { /* fall through */ }
  }

  // --- Yaklaşım 2: HTML satır regex ---
  // SkorX'in ortak DOM yapısı: .event-row veya tr[data-id]
  const rowRe = /(?:class="[^"]*(?:event-row|match-row|live-match)[^"]*")[^>]*>([\s\S]*?)<\/(?:div|tr)>/gi;
  const teamRe = /<[^>]+class="[^"]*(?:home|away|team-name)[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/i;
  const scoreRe = /(\d+)\s*[-:]\s*(\d+)/;
  const minuteRe = /(\d{1,3}(?:[+\']\d+)?)\s*(?:'|dk|min)/i;

  let row;
  while ((row = rowRe.exec(html)) !== null) {
    const inner = row[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const teams = inner.split(/\s{2,}|-\s/).map(s => s.trim()).filter(Boolean);
    if (teams.length < 2) continue;

    const scoreM = scoreRe.exec(inner);
    const minuteM = minuteRe.exec(inner);

    matches.push({
      homeTeam: teams[0],
      awayTeam: teams[teams.length - 1],
      homeScore: scoreM ? scoreM[1] : null,
      awayScore: scoreM ? scoreM[2] : null,
      status: minuteM ? minuteM[0] : (scoreM ? "LIVE" : "NS"),
      isLive: !!minuteM,
      isFinished: /(?:ms|ft|bitti|finished)/i.test(inner),
      compTitle: "",
      compCountry: "",
      htScore: null,
      minute: minuteM ? minuteM[1] : "",
    });
  }

  return matches;
}

async function fetchHtml() {
  const res = await fetch(SKORX_URL, {
    headers: {
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "tr-TR,tr;q=0.9",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`SkorX ${res.status}: ${res.statusText}`);
  return res.text();
}

/**
 * Ana scrape fonksiyonu.
 * Döndürür: { ts, leagues, trackedMatchCount, totalMatchCount, source }
 * Format, livescore-scraper.cjs ile aynı → livescore-sync.cjs doğrudan kullanabilir.
 */
async function scrape() {
  const ts = new Date().toISOString();
  let html;

  try {
    html = await fetchHtml();
  } catch (e) {
    console.error("[skorx] fetch failed:", e.message);
    return { ts, leagues: {}, trackedMatchCount: 0, totalMatchCount: 0, source: "skorx", error: e.message };
  }

  const rawMatches = parseMatchRows(html);
  const leagues = {};
  let tracked = 0;

  for (const m of rawMatches) {
    const def = matchLeague(m.compTitle || m.compCountry || "");
    const lid = def.id;

    if (!leagues[lid]) {
      leagues[lid] = { id: lid, name: def.name, country: def.country, matches: [] };
    }

    leagues[lid].matches.push({
      homeTeam:   m.homeTeam,
      awayTeam:   m.awayTeam,
      homeScore:  m.homeScore,
      awayScore:  m.awayScore,
      status:     m.status,
      isLive:     m.isLive,
      isFinished: m.isFinished,
      htScore:    m.htScore,
      minute:     m.minute,
      homeRed:    0,
      awayRed:    0,
      league:     def.name,
      leagueId:   lid,
      country:    def.country,
    });
    tracked++;
  }

  console.log(`[skorx] scraped ${tracked} matches across ${Object.keys(leagues).length} leagues`);
  return { ts, leagues, trackedMatchCount: tracked, totalMatchCount: tracked, source: "skorx" };
}

// livescore-scraper.cjs ile uyumlu interface
let _cache = { ts: null, leagues: {}, trackedMatchCount: 0, totalMatchCount: 0 };

function getCache() { return _cache; }

async function refresh() {
  const result = await scrape();
  _cache = result;
  return result;
}

module.exports = { scrape, getCache, refresh };
