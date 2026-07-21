"use strict";

const express = require("express");
const router = express.Router();
const scraper = require("../services/livescore-scraper.cjs");

router.get("/matches", (req, res) => {
  try {
    const cache = scraper.getCache();
    const leagueId = req.query.league;

    if (leagueId && cache.leagues && cache.leagues[leagueId]) {
      return res.json({
        ok: true,
        ts: cache.ts,
        league: cache.leagues[leagueId],
      });
    }

    res.json({
      ok: true,
      ts: cache.ts,
      scrapeDurationMs: cache.scrapeDurationMs,
      trackedMatchCount: cache.trackedMatchCount,
      totalMatchCount: cache.totalMatchCount,
      leagues: cache.leagues || {},
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get("/leagues", (_req, res) => {
  res.json({ ok: true, leagues: scraper.LEAGUES });
});

router.post("/refresh", async (_req, res) => {
  try {
    const result = await scraper.scrape();
    res.json({ ok: true, ts: result?.ts, trackedMatchCount: result?.trackedMatchCount });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

const syncService = require("../services/livescore-sync.cjs");

router.post("/sync", async (_req, res) => {
  try {
    const result = await syncService.sync();
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get("/sync-status", (_req, res) => {
  const status = syncService.getLastSync();
  res.json({ ok: true, ...status });
});

// Kaynak kademe kaydını göster (hangi kaynak aktif/planlı, tier sırası)
const sources = require("../services/sources.cjs");
router.get("/sources", (_req, res) => {
  res.json({ ok: true, sources: sources.allSources() });
});

// GET /api/livescore/fixtures?country=Türkiye&limit=50
// Bilyoner'dan gelecek maçları + oranları çeker
router.get("/fixtures", async (req, res) => {
  try {
    const bilyoner = require("../services/scrapers/bilyoner.cjs");
    const country = req.query.country ? [req.query.country] : [];
    const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));
    const result = await bilyoner.scrape({ maxFixtures: limit, countries: country });
    res.json({ ok: true, ts: result.ts, count: result.fixtures.length, fixtures: result.fixtures, source: result.source, error: result.error || null });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/livescore/live-fallback
// Maçkolik cache boşsa SkorX'i dener
router.get("/live-fallback", async (req, res) => {
  try {
    const mackolikCache = scraper.getCache();
    const hasMackolik = mackolikCache?.ts && Object.keys(mackolikCache.leagues || {}).length > 0;

    if (hasMackolik) {
      return res.json({ ok: true, source: "mackolik", ts: mackolikCache.ts, leagues: mackolikCache.leagues });
    }

    const skorx = require("../services/scrapers/skorx.cjs");
    const result = await skorx.refresh();
    res.json({ ok: true, source: "skorx", ts: result.ts, leagues: result.leagues, trackedMatchCount: result.trackedMatchCount });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/livescore/refresh-bilyoner
router.post("/refresh-bilyoner", async (req, res) => {
  try {
    const bilyoner = require("../services/scrapers/bilyoner.cjs");
    const result = await bilyoner.scrape({ maxFixtures: 100 });
    res.json({ ok: true, ts: result.ts, count: result.fixtures.length, error: result.error || null });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
