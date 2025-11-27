"use strict";
const express = require("express");
const router  = express.Router();
const fs = require("fs"), fsp = fs.promises, path = require("path");

async function readJson(f, fb){ try{ return JSON.parse(await fsp.readFile(f,"utf8")); }catch{ return fb; } }

router.get("/fav", async (req,res)=>{
  try{
    const userId = String(req.query.userId||"demo1");
    const DATA = path.join(__dirname,"..","data");
    const users = await readJson(path.join(DATA,"users.json"),{users:{}});
    const team  = users.users?.[userId]?.team || "Galatasaray";

    // kaynak: fixtures.json + live klasörü
    const fixtures = await readJson(path.join(DATA,"fixtures.json"),[]);
    const arr = Array.isArray(fixtures)? fixtures : (fixtures.fixtures||[]);
    const liveDir = path.join(DATA,"live");
    const now = Date.now(), from = now - 72*3600*1000, to = now + 72*3600*1000;

    const rows = [];
    for(const fx of arr){
      const dt = new Date(fx.kickoffISO||fx.date||fx.kickoff||0).getTime();
      if(!Number.isFinite(dt)) continue;
      const home = fx.home||fx.homeTeam||"", away = fx.away||fx.awayTeam||"";
      const hasTeam = [home,away].some(n=> String(n||"").toLowerCase().includes(String(team).toLowerCase()));
      if(!hasTeam) continue;
      if(dt<from || dt>to) continue;

      let status="NS", score={home:0,away:0};
      try{
        const st = await readJson(path.join(liveDir, `${fx.fixtureId||fx.id}.json`), null);
        if(st){ status=st.status||status; score={ home:Number(st?.score?.home||0), away:Number(st?.score?.away||0) }; }
      }catch{}

      rows.push({
        fixtureId: String(fx.fixtureId||fx.id||""),
        kickoffISO: new Date(dt).toISOString(),
        league: fx.league||fx.leagueName||null,
        country: fx.country||null,
        home, away, status, score
      });
    }

    rows.sort((a,b)=> new Date(a.kickoffISO)-new Date(b.kickoffISO));
    res.json({ ok:true, team, count: rows.length, fixtures: rows });
  }catch(e){
    res.status(500).json({ ok:false, error:"FAV_FAILED", detail:String(e&&e.message||e) });
  }
});

module.exports = router;