"use strict";

const express = require("express");
const router  = express.Router();
const fs = require("fs").promises;
const path = require("path");

const DATA = path.join(__dirname, "..", "data");
const PREDS = path.join(DATA, "preds.json");
const LIVE  = path.join(DATA, "live");

async function readJson(file, fb){ try{ return JSON.parse(await fs.readFile(file,"utf8")); }catch{ return fb; } }

/** === /api/rt/score?fixtureId=... ===
 * Skor tahmini yaşayan/elenen tablo (sadece skor oyunu için) */
router.get("/score", async (req,res)=>{
  try{
    const fixtureId = String(req.query.fixtureId||"");
    if(!fixtureId) return res.status(400).json({ ok:false, error:"FIXTURE_REQUIRED" });

    const st    = await readJson(path.join(LIVE, `${fixtureId}.json`), null);
    const raw   = await readJson(PREDS, []);
    const preds = Array.isArray(raw)? raw : (Array.isArray(raw?.items)? raw.items : []);

    const ch = Number(st?.score?.home||0), ca = Number(st?.score?.away||0);
    const status = String(st?.status||"NS");
    const isFT = status==="FT";

    const rows = preds
      .filter(p=> String(p.fixtureId)===fixtureId && Number.isFinite(p.home) && Number.isFinite(p.away))
      .map(p=>{
        const alive = (Number(p.home)>=ch) && (Number(p.away)>=ca);
        const win   = isFT && Number(p.home)===ch && Number(p.away)===ca;
        return { userId: p.userId||p.user||"anon", home:Number(p.home), away:Number(p.away), alive, eliminated:!alive, win, at:p.at };
      })
      .sort((a,b)=>{
        if(a.alive!==b.alive) return a.alive? -1: 1;
        const da = Math.abs(a.home - ch) + Math.abs(a.away - ca);
        const db = Math.abs(b.home - ch) + Math.abs(b.away - ca);
        return da - db;
      });

    res.json({ ok:true, status, score:{home:ch,away:ca}, items: rows });
  }catch(e){
    res.status(500).json({ ok:false, error:"SCORE_BOARD_FAILED", detail:String(e&&e.message||e) });
  }
});

/** === /api/rt/my?fixtureId=...&userId=... ===
 * Kullanıcının (son) tahmini ve hâlâ yaşayıp yaşamadığı */
router.get("/my", async (req,res)=>{
  try{
    const fixtureId = String(req.query.fixtureId||"");
    const userId    = String(req.query.userId||"");
    if(!fixtureId || !userId) return res.status(400).json({ ok:false, error:"REQUIRED" });

    const st    = await readJson(path.join(LIVE, `${fixtureId}.json`), null);
    const raw   = await readJson(PREDS, []);
    const preds = Array.isArray(raw)? raw : (Array.isArray(raw?.items)? raw.items : []);
    const mine  = preds.filter(p=> String(p.fixtureId)===fixtureId && String(p.userId||p.user||"anon")===userId).slice(-1)[0];
    if(!mine) return res.json({ ok:true, has:false });

    const ch = Number(st?.score?.home||0), ca = Number(st?.score?.away||0);
    const status = String(st?.status||"NS");
    const htH = Number(st?.htScore?.home ?? NaN), htA = Number(st?.htScore?.away ?? NaN);
    const hasHT = Number.isFinite(htH) && Number.isFinite(htA);

    const aliveExact = (Number(mine.home) >= ch) && (Number(mine.away) >= ca);
    const aliveFG    = (st?.firstGoal==null);
    const aliveHT    = hasHT ? false : !!mine.firstHalf;
    const aliveRH    = (typeof mine.redHome==="boolean") ? (typeof st?.redHome === "undefined") : false;
    const aliveRA    = (typeof mine.redAway==="boolean") ? (typeof st?.redAway === "undefined") : false;

    res.json({ ok:true, has:true, status, score:{home:ch,away:ca},
      mine:{ outcome:mine.outcome??null, home:Number(mine.home), away:Number(mine.away),
             firstGoal:mine.firstGoal??null, firstHalf:mine.firstHalf??null, redHome:!!mine.redHome, redAway:!!mine.redAway, at:mine.at },
      alive:{ exact:aliveExact, firstGoal:aliveFG, firstHalf:aliveHT, redHome:aliveRH, redAway:aliveRA },
      finalScore:(status==="FT"? { home:ch, away:ca } : null)
    });
  }catch(e){
    res.status(500).json({ ok:false, error:"MY_STATUS_FAILED", detail:String(e&&e.message||e) });
  }
});

module.exports = router;
