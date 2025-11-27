"use strict";

const express = require("express");
const router  = express.Router();
const fs      = require("fs");
const fsp     = fs.promises;
const path    = require("path");

const DATA_DIR         = path.join(__dirname, "..", "data");
const LEADERBOARD_FILE = path.join(DATA_DIR, "leaderboard.json");

async function readJson(file, fallback = null) {
  try {
    const txt = await fsp.readFile(file, "utf8");
    return JSON.parse(txt);
  } catch {
    return fallback;
  }
}

/**
 * GET /api/rt/totals?userId=demo1
 * Bir kullanıcının:
 * - toplam puanı
 * - kaç maç oynadığı
 * - maç başı ortalama
 * - son 10 maç performansı
 * - toplam ceza puanı (%10 kayıplar)
 */
router.get("/totals", async (req, res) => {
  const userId = String(req.query.userId || "").trim();
  if (!userId) {
    return res.status(400).json({ ok: false, error: "USER_REQUIRED" });
  }

  const lb = await readJson(LEADERBOARD_FILE, { items: [], totals: {} });
  const items = Array.isArray(lb.items) ? lb.items : [];

  const rows = items.filter(r => String(r.userId || "") === userId);

  if (!rows.length) {
    return res.json({
      ok: true,
      userId,
      totalPoints: 0,
      played: 0,
      avgPerMatch: 0,
      penalties: 0,
      last10: []
    });
  }

  let total = 0;
  let penalties = 0;

  for (const r of rows) {
    total     += Number(r.points   || 0);
    penalties += Number(r.penalty  || 0);
  }

  const played = rows.length;
  const avg    = played ? Math.round(total / played) : 0;

  const last10 = rows
    .slice(-10)
    .map(r => ({
      fixtureId:  r.fixtureId,
      points:     Number(r.points     || 0),
      basePoints: Number(r.basePoints || 0),
      penalty:    Number(r.penalty    || 0),
      country:    r.country || null
    }));

  return res.json({
    ok: true,
    userId,
    totalPoints: total,
    played,
    avgPerMatch: avg,
    penalties,
    last10
  });
});

/**
 * GET /api/rt/totals/board
 * Genel leaderboard: kullanıcı bazlı total / played / penalties
 */
router.get("/totals/board", async (req, res) => {
  const lb = await readJson(LEADERBOARD_FILE, { items: [], totals: {} });
  const items = Array.isArray(lb.items) ? lb.items : [];

  const byUser = new Map();

  for (const r of items) {
    const uid = r.userId || "anon";
    if (!byUser.has(uid)) {
      byUser.set(uid, { userId: uid, total: 0, played: 0, penalties: 0 });
    }
    const acc = byUser.get(uid);
    acc.total     += Number(r.points   || 0);
    acc.played    += 1;
    acc.penalties += Number(r.penalty  || 0);
  }

  const rows = Array.from(byUser.values()).sort((a, b) => b.total - a.total);

  return res.json({ ok: true, leaderboard: rows });
});

module.exports = router;
