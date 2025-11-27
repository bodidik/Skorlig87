"use strict";
const express = require("express");
const router  = express.Router();
const fs = require("fs"), fsp = fs.promises, path = require("path");

async function readJson(f, fb){ try{ return JSON.parse(await fsp.readFile(f,"utf8")); }catch{ return fb; } }
function outcomeOf(h,a){ return h>a? "H" : a>h? "A" : "D"; }

router.post("/recalc", async (req,res)=>{
  try{
    const DATA = path.join(__dirname,"..","data");
    const PRED = path.join(DATA,"preds.json");
    const LIVE = path.join(DATA,"live");
    const OUT  = path.join(DATA,"totals-penalized.json");

    const raw = await readJson(PRED, []);
    const preds = Array.isArray(raw)? raw : (Array.isArray(raw?.items)? raw.items : []);
    // tahminleri tarihe göre sırala
    preds.sort((a,b)=> new Date(a.at||0) - new Date(b.at||0));

    const totals = new Map(); // userId -> number
    const perUser = {};

    for(const p of preds){
      const uid = String(p.userId||p.user||"anon");
      const fid = String(p.fixtureId||"");
      if(!fid) continue;

      const st  = await readJson(path.join(LIVE, `${fid}.json`), null);
      if(!st || String(st.status)!=="FT") continue;
      const h = Number(st?.score?.home||0), a = Number(st?.score?.away||0);
      const finalOutcome = outcomeOf(h,a);

      let pts = 0;

      // temel kurallar: outcome(3), exact(12), firstGoal(1), firstHalf(2), red home/away (1+1)
      if (p.outcome) pts += (String(p.outcome).toUpperCase()===finalOutcome? 3:0);
      if (Number.isFinite(p.home)&&Number.isFinite(p.away)) pts += ((Number(p.home)===h && Number(p.away)===a)? 12:0);
      if (p.firstGoal) pts += (String(p.firstGoal).toUpperCase()===(st.firstGoal||"")? 1:0);

      const htH = Number(st?.htScore?.home ?? NaN), htA = Number(st?.htScore?.away ?? NaN);
      const hasHT = Number.isFinite(htH)&&Number.isFinite(htA);
      const htOut = hasHT? outcomeOf(htH,htA): null;
      if (hasHT && p.firstHalf) pts += (String(p.firstHalf).toUpperCase()===htOut? 2:0);

      if (typeof p.redHome!=="undefined") pts += ((!!p.redHome)===(!!st?.redHome)? 1:0);
      if (typeof p.redAway!=="undefined") pts += ((!!p.redAway)===(!!st?.redAway)? 1:0);

      const prev = totals.get(uid)||0;
      let next = prev + pts;

      // outcome yanlışsa %10 kesinti (anlık toplam üzerinden)
      const lost = p.outcome && String(p.outcome).toUpperCase()!==finalOutcome;
      if (lost) next = Math.floor(next * 0.90);

      totals.set(uid, next);
      perUser[uid] = next;
    }

    const out = { ok:true, updatedAt: new Date().toISOString(), totals: perUser };
    await fsp.mkdir(DATA, { recursive:true });
    await fsp.writeFile(OUT, JSON.stringify(out,null,2), "utf8");
    return res.json(out);
  }catch(e){
    res.status(500).json({ ok:false, error:"TOTALS_RECALC_FAILED", detail:String(e&&e.message||e) });
  }
});

router.get("/totals", async (req,res)=>{
  try{
    const DATA = path.join(__dirname,"..","data");
    const OUT  = path.join(DATA,"totals-penalized.json");
    const j = await readJson(OUT, null);
    if(!j) return res.json({ ok:true, totals:{} });
    res.json(j);
  }catch(e){
    res.status(500).json({ ok:false, error:"TOTALS_GET_FAILED", detail:String(e&&e.message||e) });
  }
});

module.exports = router;