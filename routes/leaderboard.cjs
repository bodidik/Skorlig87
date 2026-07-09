"use strict";

const express = require("express");
const router  = express.Router();
const path    = require("path");
const fs      = require("fs");
const fsp     = fs.promises;

const DATA_DIR         = path.join(__dirname, "..", "data");
const LEADERBOARD_FILE = path.join(DATA_DIR, "leaderboard.json");
const TOTALS_FILE      = path.join(DATA_DIR, "totals.json");

async function readJson(file, fb=null){
  try{
    const txt = await fsp.readFile(file,"utf8");
    return JSON.parse(txt);
  }catch{ 
    return fb; 
  }
}

/**
 * GET /api/leaderboard
 *
 * Öncelik sırası:
 *  1) MongoDB (season_totals koleksiyonu) – varsa
 *  2) totals.json – varsa
 *  3) leaderboard.json üzerinden elde edilen toplamlar (eski davranış)
 *
 * Çıktı:
 *  leaderboard: [
 *    { userId, total, played, penalties, avg }
 *  ]
 */
router.get("/", async (req,res)=>{
  const db = req.app?.locals?.db || null;

  // 1) 🔵 Mongo sezon toplamları
  if (db) {
    try {
      const col = db.collection("season_totals");
      const docs = await col
        .find({})
        .sort({ totalPoints: -1 })
        .toArray();

      if (docs && docs.length) {
        const rows = docs.map(d => {
          const total     = Number(d.totalPoints   || 0);
          const played    = Number(d.matches       || 0);
          const penalties = Number(d.totalPenalty  || 0);
          const avg       = played ? Math.round(total / played) : 0;

          return {
            userId: d.userId || d.userIdLower || "anon",
            total,
            played,
            penalties,
            avg
          };
        });

        const updatedAt =
          docs[0]?.updatedAt ||
          docs[0]?.lastAt ||
          new Date().toISOString();

        return res.json({
          ok: true,
          leaderboard: rows,
          updatedAt,
          source: "mongo_season_totals",
        });
      }
    } catch (e) {
      console.error("[leaderboard] Mongo read failed, falling back to files:", e);
      // Sessizce dosya moduna düşeceğiz
    }
  }

  // 2) 🟢 totals.json (yeni dosya tabanlı sezon toplamları)
  const totals = await readJson(TOTALS_FILE, null);
  if (totals && Array.isArray(totals.items) && totals.items.length) {
    const rows = totals.items
      .map(t => {
        const total     = Number(t.totalPoints   || 0);
        const played    = Number(t.matches       || 0);
        const penalties = Number(t.totalPenalty  || 0);
        const avg       = played ? Math.round(total / played) : 0;

        return {
          userId: t.userId,
          total,
          played,
          penalties,
          avg,
        };
      })
      .sort((a,b) => b.total - a.total);

    return res.json({
      ok: true,
      leaderboard: rows,
      updatedAt: totals.updatedAt || null,
      source: "totals_json",
    });
  }

  // 3) Eski davranış: leaderboard.json içinden kullanıcı bazlı toplama
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
    // Yeni settle2 şemasında penalty farklı alanlarda; eski kayıtlarda r.penalty varsa onu da toplar
    acc.penalties += Number(r.penalty  || 0);
  }

  const rows = Array.from(byUser.values())
    .map(r => ({
      ...r,
      avg: r.played ? Math.round(r.total / r.played) : 0
    }))
    .sort((a,b)=> b.total - a.total);

  return res.json({
    ok:true,
    leaderboard: rows,
    updatedAt: lb.updatedAt || null,
    source: "leaderboard_json_legacy",
  });
});

module.exports = router;
