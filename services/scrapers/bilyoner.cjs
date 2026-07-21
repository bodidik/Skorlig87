"use strict";

/**
 * Bilyoner Scraper — fixtures + odds
 *
 * Bilyoner'ın spor API'sinden gelecek iddaa programını çeker.
 * Dönen veri: { ts, fixtures: [{fixtureId, home, away, kickoffISO, league, country, odds}] }
 *
 * API endpoint: sportsbookv2.bilyoner.com (Iddaa bülteni)
 */

const BILYONER_API = "https://sportsbookv2.bilyoner.com/sports-core/bulletin/v2/";

// Turnuva id → SkorLig lig adı / ülke eşlemeleri
const LEAGUE_MAP = {
  // Türkiye
  "1002": { league: "Süper Lig",       country: "Türkiye" },
  "1003": { league: "1. Lig",          country: "Türkiye" },
  "1004": { league: "2. Lig",          country: "Türkiye" },
  // Avrupa
  "2001": { league: "Champions League", country: "Avrupa" },
  "2002": { league: "Europa League",    country: "Avrupa" },
  "2003": { league: "Conference League",country: "Avrupa" },
  // İngiltere
  "3001": { league: "Premier League",   country: "İngiltere" },
  "3002": { league: "Championship",     country: "İngiltere" },
  // İspanya
  "4001": { league: "La Liga",          country: "İspanya" },
  // Almanya
  "5001": { league: "Bundesliga",       country: "Almanya" },
  // İtalya
  "6001": { league: "Serie A",          country: "İtalya" },
  // Fransa
  "7001": { league: "Ligue 1",          country: "Fransa" },
};

function resolveLeague(tournamentId, tournamentName) {
  const mapped = LEAGUE_MAP[String(tournamentId)];
  if (mapped) return mapped;
  const name = String(tournamentName || "").toLowerCase();
  if (name.includes("süper lig") || name.includes("super lig")) return { league: "Süper Lig", country: "Türkiye" };
  if (name.includes("1. lig")) return { league: "1. Lig", country: "Türkiye" };
  if (name.includes("champions")) return { league: "Champions League", country: "Avrupa" };
  if (name.includes("europa")) return { league: "Europa League", country: "Avrupa" };
  if (name.includes("premier")) return { league: "Premier League", country: "İngiltere" };
  if (name.includes("la liga")) return { league: "La Liga", country: "İspanya" };
  if (name.includes("bundesliga")) return { league: "Bundesliga", country: "Almanya" };
  if (name.includes("serie a")) return { league: "Serie A", country: "İtalya" };
  if (name.includes("ligue 1")) return { league: "Ligue 1", country: "Fransa" };
  return { league: tournamentName || "Diğer", country: "Diğer" };
}

// Outcome oddı bul: marketler içinde 1X2 (match_winner) piyasasını ara
function extractOdds(markets) {
  if (!Array.isArray(markets)) return null;
  const mw = markets.find(m =>
    m.marketType === "match_winner" ||
    m.marketTypeId === 1 ||
    (m.name || "").toLowerCase().includes("maç sonucu") ||
    (m.name || "").toLowerCase().includes("1x2")
  );
  if (!mw || !Array.isArray(mw.outcomes)) return null;

  let home = null, draw = null, away = null;
  for (const o of mw.outcomes) {
    const t = (o.type || o.outcomeType || "").toLowerCase();
    const n = (o.name || "").toLowerCase();
    if (t === "home"    || n === "1" || n.includes("ev sahibi"))  home = Number(o.odds || o.price || 0);
    if (t === "draw"    || n === "x" || n.includes("beraberlik")) draw = Number(o.odds || o.price || 0);
    if (t === "away"    || n === "2" || n.includes("deplasman"))  away = Number(o.odds || o.price || 0);
  }
  if (!home || !draw || !away) return null;
  return { home: Math.round(home * 100) / 100, draw: Math.round(draw * 100) / 100, away: Math.round(away * 100) / 100 };
}

async function fetchBulletin(sportId = 1, bulletinType = 0) {
  const url = new URL(BILYONER_API);
  url.searchParams.set("sportId", sportId);
  url.searchParams.set("bulletinType", bulletinType);

  const res = await fetch(url.toString(), {
    headers: {
      "Accept": "application/json",
      "Accept-Language": "tr-TR,tr;q=0.9",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "Origin": "https://www.bilyoner.com",
      "Referer": "https://www.bilyoner.com/",
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) throw new Error(`Bilyoner API ${res.status}: ${res.statusText}`);
  return res.json();
}

/**
 * Ana scrape fonksiyonu.
 * @param {object} opts
 * @param {number} opts.maxFixtures  - maksimum fixture sayısı (default 50)
 * @param {string[]} opts.countries  - filtre: ["Türkiye"] gibi; boşsa hepsi
 * @returns {{ ts, fixtures, source }}
 */
async function scrape({ maxFixtures = 50, countries = [] } = {}) {
  const ts = new Date().toISOString();
  let raw;

  try {
    raw = await fetchBulletin(1, 0);
  } catch (e) {
    console.error("[bilyoner] fetchBulletin failed:", e.message);
    return { ts, fixtures: [], source: "bilyoner", error: e.message };
  }

  // Bilyoner API şeması değişkendir; birkaç yapıyı dene
  const events = raw?.data?.events ?? raw?.events ?? raw?.items ?? raw ?? [];
  if (!Array.isArray(events)) {
    return { ts, fixtures: [], source: "bilyoner", error: "Unexpected response shape" };
  }

  const fixtures = [];
  for (const ev of events) {
    if (!ev || typeof ev !== "object") continue;

    // Takım isimleri
    const home = String(ev.homeTeam?.name ?? ev.home ?? ev.homeTeamName ?? "").trim();
    const away = String(ev.awayTeam?.name ?? ev.away ?? ev.awayTeamName ?? "").trim();
    if (!home || !away) continue;

    // Kickoff
    const kickoffRaw = ev.date ?? ev.kickoffDate ?? ev.startTime ?? ev.eventDate;
    const kickoffISO = kickoffRaw ? new Date(kickoffRaw).toISOString() : null;
    if (!kickoffISO) continue;

    // Lig / ülke
    const tournId = ev.tournament?.id ?? ev.tournamentId ?? null;
    const tournName = ev.tournament?.name ?? ev.tournamentName ?? ev.leagueName ?? "";
    const { league, country } = resolveLeague(tournId, tournName);

    // Filtre
    if (countries.length && !countries.includes(country)) continue;

    // Odds
    const odds = extractOdds(ev.markets ?? ev.outcomes ?? ev.odds);

    const fixtureId = `BLY-${ev.id ?? ev.eventId ?? `${home}-${away}-${kickoffISO}`.replace(/\s+/g, "_")}`;

    fixtures.push({ fixtureId, home, away, kickoffISO, league, country, odds, source: "bilyoner" });
    if (fixtures.length >= maxFixtures) break;
  }

  console.log(`[bilyoner] scraped ${fixtures.length} fixtures`);
  return { ts, fixtures, source: "bilyoner" };
}

module.exports = { scrape };
