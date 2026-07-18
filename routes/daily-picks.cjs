"use strict";

const express = require("express");
const router = express.Router();
const fetch = globalThis.fetch || require("node-fetch");
const { calcOdds, lcReward } = require("../services/odds-engine.cjs");
const { getStreak } = require("../services/streak.cjs");
const { verifyToken, optionalToken } = require("../middleware/verifyToken.cjs");

const AF_BASE = process.env.AF_BASE || "https://v3.football.api-sports.io";
const AF_KEY = process.env.AF_KEY || "";
const AF_HDR = process.env.AF_HEADER_KEY || "x-apisports-key";

const BASE_LC = 10;
const QUAD_BONUS_MULTIPLIER = 1.5;

const TEAM_RATINGS = require("../services/odds-engine.cjs").TEAM_RATINGS;

const COUNTRY_LEAGUES = {
  "Türkiye": [203, 204], "İngiltere": [39, 40], "İspanya": [140, 141],
  "Almanya": [78, 79], "Fransa": [61, 62], "İtalya": [135, 136],
  "Portekiz": [94], "Hollanda": [88], "Belçika": [144],
  "Yunanistan": [197], "Arjantin": [128], "Brezilya": [71],
  "Japonya": [98], "Suudi Arabistan": [307], "ABD": [253],
};
const GLOBAL_FALLBACK = [39, 140, 135, 78, 61, 88, 94, 203];

function matchAttraction(home, away) {
  const hr = TEAM_RATINGS[home] || 65;
  const ar = TEAM_RATINGS[away] || 65;
  return Math.max(hr, ar) + Math.min(hr, ar) * 0.4;
}

async function fetchLeagueFixtures(leagueId, dateStr) {
  if (!AF_KEY) return [];
  try {
    const qs = new URLSearchParams({ league: String(leagueId), date: dateStr, timezone: "Europe/Istanbul" });
    const r = await fetch(`${AF_BASE}/fixtures?${qs}`, {
      headers: { [AF_HDR]: AF_KEY, Accept: "application/json" },
    });
    const json = await r.json();
    return (json.response || [])
      .filter(f => ["NS", "1H", "2H", "HT", "LIVE"].includes(f.fixture?.status?.short))
      .map(f => {
        const home = f.teams?.home?.name || "?";
        const away = f.teams?.away?.name || "?";
        const odds = calcOdds(home, away);
        return {
          fixtureId: String(f.fixture?.id),
          home,
          away,
          homeLogo: f.teams?.home?.logo || null,
          awayLogo: f.teams?.away?.logo || null,
          kickoffISO: f.fixture?.date || null,
          status: f.fixture?.status?.short || "NS",
          league: f.league?.name || null,
          country: f.league?.country || null,
          leagueId,
          odds,
          rewards: {
            home: lcReward(BASE_LC, odds.home),
            draw: lcReward(BASE_LC, odds.draw),
            away: lcReward(BASE_LC, odds.away),
          },
          _attraction: matchAttraction(home, away),
        };
      });
  } catch { return []; }
}

// GET /api/daily-picks/singles?country=Türkiye
router.get("/singles", async (req, res) => {
  const country = String(req.query.country || "").trim();
  const limit = Math.min(8, Math.max(1, Number(req.query.limit) || 5));
  const dateStr = new Date().toISOString().slice(0, 10);

  try {
    const localLeagues = (country && COUNTRY_LEAGUES[country]) || [];
    const seen = new Set();
    let all = [];

    for (const lid of localLeagues) {
      const fixtures = await fetchLeagueFixtures(lid, dateStr);
      for (const f of fixtures) {
        if (!seen.has(f.fixtureId)) { seen.add(f.fixtureId); all.push(f); }
      }
    }

    if (all.length < limit) {
      for (const lid of GLOBAL_FALLBACK) {
        if (localLeagues.includes(lid)) continue;
        const fixtures = await fetchLeagueFixtures(lid, dateStr);
        for (const f of fixtures) {
          if (!seen.has(f.fixtureId)) { seen.add(f.fixtureId); all.push(f); }
        }
        if (all.length >= limit * 2) break;
      }
    }

    all.sort((a, b) => b._attraction - a._attraction);
    const picks = all.slice(0, limit).map(f => {
      const { _attraction, ...rest } = f;
      return rest;
    });

    res.json({ ok: true, date: dateStr, country: country || null, count: picks.length, picks });
  } catch (e) {
    res.status(500).json({ ok: false, error: "SINGLES_ERR", detail: String(e.message || e) });
  }
});

// GET /api/daily-picks/quad?country=Türkiye
router.get("/quad", async (req, res) => {
  const country = String(req.query.country || "").trim();
  const dateStr = new Date().toISOString().slice(0, 10);

  try {
    const localLeagues = (country && COUNTRY_LEAGUES[country]) || [];
    const seen = new Set();
    let all = [];

    for (const lid of [...localLeagues, ...GLOBAL_FALLBACK]) {
      if (seen.size >= 20) break;
      const fixtures = await fetchLeagueFixtures(lid, dateStr);
      for (const f of fixtures) {
        if (!seen.has(f.fixtureId)) { seen.add(f.fixtureId); all.push(f); }
      }
    }

    all.sort((a, b) => b._attraction - a._attraction);
    const quad = all.slice(0, 4).map(f => {
      const { _attraction, ...rest } = f;
      rest.rewards = {
        home: Math.round(lcReward(BASE_LC, rest.odds.home) * QUAD_BONUS_MULTIPLIER),
        draw: Math.round(lcReward(BASE_LC, rest.odds.draw) * QUAD_BONUS_MULTIPLIER),
        away: Math.round(lcReward(BASE_LC, rest.odds.away) * QUAD_BONUS_MULTIPLIER),
      };
      return rest;
    });

    const combinedOdds = quad.reduce((acc, f) => {
      const minOdd = Math.min(f.odds.home, f.odds.draw, f.odds.away);
      return +(acc * minOdd).toFixed(2);
    }, 1);

    res.json({
      ok: true, date: dateStr, country: country || null,
      count: quad.length, matches: quad,
      allCorrectBonus: Math.round(BASE_LC * combinedOdds * 2),
      combinedOdds,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: "QUAD_ERR", detail: String(e.message || e) });
  }
});

// GET /api/daily-picks/streak?userId=xxx
router.get("/streak", optionalToken, async (req, res) => {
  const userId = req.uid || req.query.userId;
  if (!userId) return res.status(400).json({ ok: false, error: "USER_REQUIRED" });

  try {
    const streak = await getStreak(userId);
    res.json({ ok: true, ...streak });
  } catch (e) {
    res.status(500).json({ ok: false, error: "STREAK_ERR", detail: String(e.message || e) });
  }
});

module.exports = router;
