"use strict";
const express = require("express");
const router  = express.Router();
const fs      = require("fs");
const fsp     = fs.promises;
const path    = require("path");

const DATA_DIR         = path.join(__dirname, "..", "data");
const LEADERBOARD_FILE = path.join(DATA_DIR, "leaderboard.json");
const TOTALS_FILE      = path.join(DATA_DIR, "totals.json");

async function readJson(file, fb = null) {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"));
  } catch {
    return fb;
  }
}

/**
 * TOTALS loader:
 *  - totals.json beklenen format: { items:[{ userId,totalPoints,totalPenalty,matches,lastAt }], updatedAt }
 *  - Eski formatlara karşı toleranslı
 *  - Puanlara göre azalan sırada döner
 */
async function loadTotals() {
  const raw = await readJson(TOTALS_FILE, { items: [], updatedAt: null });

  let items = [];
  if (Array.isArray(raw?.items)) {
    items = raw.items;
  } else if (Array.isArray(raw)) {
    // Eski tip: direkt array tutulmuşsa
    items = raw;
  }

  const norm = items.map((x) => ({
    userId: String(x.userId || x.user || "anon"),
    totalPoints: Number(x.totalPoints ?? x.points ?? 0),
    totalPenalty: Number(x.totalPenalty ?? 0),
    matches: Number(x.matches ?? 0),
    lastAt: x.lastAt || null,
  }));

  norm.sort((a, b) => b.totalPoints - a.totalPoints);

  return {
    items: norm,
    updatedAt: raw.updatedAt || null,
  };
}

/** GET /api/rt/board2 → ham leaderboard.json içeriği (debug / eski kullanım) */
router.get("/board2", async (req, res) => {
  const lb = await readJson(LEADERBOARD_FILE, { items: [], updatedAt: null });
  res.json({
    ok: true,
    leaderboard: Array.isArray(lb.items) ? lb.items : [],
    updatedAt: lb.updatedAt || null,
  });
});

/** GET /api/rt/totals[?userId=demo1] → totals.json’dan normalize liste */
router.get("/totals", async (req, res) => {
  const userId = String(req.query.userId || "");
  const { items, updatedAt } = await loadTotals();

  const out = userId
    ? items.filter((x) => String(x.userId).toLowerCase() === userId.toLowerCase())
    : items;

  res.json({ ok: true, items: out, updatedAt });
});

module.exports = router;
