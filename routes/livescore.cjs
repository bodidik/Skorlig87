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

module.exports = router;
