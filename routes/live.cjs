/**
 * routes/live.cjs
 * Lokal fikstür dosyasını okur:
 *   D:\APPden\SkorLig\api\data\live\fixtures.json
 *
 * Uçlar:
 *   GET /api/fixtures
 *   GET /api/fixtures?team=Galatasaray
 *   GET /api/live/fixtures
 *   GET /api/live/fixtures?team=Galatasaray
 */

"use strict";

const express = require("express");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

const router = express.Router();

// ---- Yol: data/live/fixtures.json
const DATA_DIR = path.join(__dirname, "..", "data");
const LIVE_DIR = path.join(DATA_DIR, "live");
const LIVE_FIXTURES_FILE = path.join(LIVE_DIR, "fixtures.json");

// ---- Normalizasyon
function normalizeLocalFixture(rec) {
  const home =
    rec.home ||
    rec.homeTeam ||
    rec.home_name ||
    rec.ev ||
    null;

  const away =
    rec.away ||
    rec.awayTeam ||
    rec.away_name ||
    rec.dep ||
    null;

  const league =
    rec.league ||
    rec.leagueName ||
    rec.competition ||
    rec.tournament ||
    null;

  const kickoffISO =
    rec.kickoffISO ||
    rec.date ||
    rec.kickoff ||
    rec.startTime ||
    rec.matchDate ||
    null;

  const fixtureId =
    rec.fixtureId ||
    rec.id ||
    rec.idFixture ||
    rec.matchId ||
    `${home || "HOME"}-${away || "AWAY"}-${kickoffISO || "TBD"}`;

  const country = rec.country || rec.leagueCountry || null;

  return {
    fixtureId,
    home,
    away,
    league,
    kickoffISO,
    country,
    status: rec.status || "NS",
    source: rec.source || "local-file",
  };
}

// ---- Takım filtresi
function matchTeam(rec, team) {
  const t = String(team || "").toLowerCase();
  if (!t) return true;
  const home = String(rec.home || "").toLowerCase();
  const away = String(rec.away || "").toLowerCase();
  return home.includes(t) || away.includes(t);
}

// ---- fixtures.json oku
async function loadLocalFixturesFile() {
  try {
    const txt = await fsp.readFile(LIVE_FIXTURES_FILE, "utf8");
    const raw = JSON.parse(txt);

    if (Array.isArray(raw)) return raw;
    if (Array.isArray(raw.fixtures)) return raw.fixtures;
    if (Array.isArray(raw.items)) return raw.items;
    return [];
  } catch {
    // dosya yoksa veya bozuksa boş dönem
    return [];
  }
}

// ---- Handler: /fixtures, /live/fixtures
async function fixturesHandler(req, res) {
  try {
    const team = String(req.query.team || "").trim();

    const raw = await loadLocalFixturesFile();
    const all = raw.map((rec) => normalizeLocalFixture(rec));

    const filtered = team ? all.filter((f) => matchTeam(f, team)) : all;

    // kickoffISO varsa tarihe göre sırala
    const sorted = filtered.slice().sort((a, b) => {
      const ta = new Date(a.kickoffISO || 0).getTime();
      const tb = new Date(b.kickoffISO || 0).getTime();
      return ta - tb;
    });

    return res.json({
      ok: true,
      count: sorted.length,
      fixtures: sorted,
    });
  } catch (e) {
    console.error("FIXTURES_HANDLER_FAIL", e);
    return res.status(500).json({
      ok: false,
      error: "FIXTURES_FAILED",
      detail: String(e && (e.message || e)),
    });
  }
}

// ---- Uçlar
// /api/fixtures
router.get("/fixtures", fixturesHandler);

// /api/live/fixtures  (eski alışkanlık için)
router.get("/live/fixtures", fixturesHandler);

module.exports = router;
