"use strict";

const express = require("express");
const router  = express.Router();
const path    = require("path");
const fs      = require("fs");
const fsp     = fs.promises;

const DATA_DIR         = path.join(__dirname, "..", "data");
const LEADERBOARD_FILE = path.join(DATA_DIR, "leaderboard.json");

async function readJson(file, fb=null){
  try{
    const txt = await fsp.readFile(file,"utf8");
    return JSON.parse(txt);
  }catch{ return fb; }
}

/**
 * GET /api/leaderboard
 * Tüm kullanıcıların:
 *  - total (toplam puan)
 *  - played (maç sayısı)
 *  - penalties (toplam kesinti)
 *  - avg (maç başı)
 */
router.get("/", async (req,res)=>{
  const lb = await readJson(LEADERBOARD_FILE, { items:[], totals:{} });
  const items  = Array.isArray(lb.items) ? lb.items : [];
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

  const rows = Array.from(byUser.values())
    .map(r => ({
      ...r,
      avg: r.played ? Math.round(r.total / r.played) : 0
    }))
    .sort((a,b)=> b.total - a.total);

  res.json({ ok:true, leaderboard: rows, updatedAt: lb.updatedAt || null });
});

module.exports = router;
