const express = require("express");
require("dotenv").config();
const router = express.Router();

const rawBase = (process.env.AF_BASE || "").trim();
const BASE = (rawBase ? rawBase : "https://v3.football.api-sports.io").replace(/\/?$/, "/");if (!BASE) { throw new Error('AF_BASE_MISSING'); }
const KEY_HEADER = process.env.AF_HEADER_KEY || "x-apisports-key";
const KEY = process.env.AF_KEY;

// Basit in-memory cache (per-key TTL)
const cache = new Map();
async function cachedFetch(url, ttlMs) {
  const now = Date.now();
  const hit = cache.get(url);
  if (hit && (now - hit.t) < ttlMs) return hit.data;

  const r = await fetch(url, { headers: { [KEY_HEADER]: KEY } });
  const data = await r.json();
  if (r.ok) cache.set(url, { t: now, data });
  return data;
}
const u = (p, q = {}) => {
  if (!BASE) throw new Error("AF_BASE_MISSING");
  const path = String(p || "").replace(/^\//, "");
  const url = new URL(path, BASE);
  for (const [k, v] of Object.entries(q)) if (v != null && v !== "") url.searchParams.set(k, v);
  return url.toString();
};

/**
 * GET /api/skorlig/summary?league=XXX&season=YYYY&date=YYYY-MM-DD&live=all|0
 * - Tek çağrı ile gerekli ana blokları döndürür
 * - Upstream’e en az sayıda istek: fixtures(+opsiyonel live), standings
 * - Cache: fixtures 30-60sn; standings 60sn; live 30sn
 */
router.get("/summary", async (req, res) => {
  try {
    const { league, season, date, live } = req.query;

    // TTL’ler (ms)
    const TTL_FIXTURES = 60 * 1000; // 60 sn
    const TTL_STAND    = 60 * 1000; // 60 sn
    const TTL_LIVE     = 30 * 1000; // 30 sn

    // Fixtures (date varsa tarihe göre; yoksa lig/sezon)
    let fixturesUrl = null;
    if (live === "all") {
      fixturesUrl = u("/fixtures", { live: "all", league, season });
    } else if (date) {
      fixturesUrl = u("/fixtures", { date, league, season });
    } else if (league && season) {
      fixturesUrl = u("/fixtures", { league, season });
    }

    const [fixtures, standings] = await Promise.all([
      fixturesUrl ? cachedFetch(fixturesUrl, live === "all" ? TTL_LIVE : TTL_FIXTURES) : Promise.resolve({ response: [] }),
      (league && season) ? cachedFetch(u("/standings", { league, season }), TTL_STAND) : Promise.resolve({ response: [] }),
    ]);

    res.json({
      ok: true,
      league,
      season,
      date: date || null,
      live: live === "all",
      fixtures: fixtures.response ?? [],
      standings: standings.response?.[0]?.league?.standings?.[0] ?? [],
    });
  } catch (e) {
    res.status(500).json({ ok:false, error:"SKORLIG_SUMMARY_ERROR", detail:String(e) });
  }
});

/**
 * GET /api/skorlig/events?fixture=ID
 * - Maç içi olaylar (gol/kırmızı vs)
 * - Cache: 12 sn (10–15 sn arası)
 */
router.get("/events", async (req, res) => {
  try {
    const { fixture } = req.query;
    if (!fixture) return res.status(400).json({ ok:false, error:"fixture_required" });
    const TTL_EVENTS = 12 * 1000;
    const data = await cachedFetch(u("/fixtures/events", { fixture }), TTL_EVENTS);
    res.json({ ok:true, events: data.response ?? [] });
  } catch (e) {
    res.status(500).json({ ok:false, error:"SKORLIG_EVENTS_ERROR", detail:String(e) });
  }
});

module.exports = router;





