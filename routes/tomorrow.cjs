const express = require("express");
const router = express.Router();

const AF_BASE = process.env.AF_BASE || "https://v3.football.api-sports.io";
const AF_KEY  = process.env.AF_KEY  || "";
const AF_HDR  = process.env.AF_HEADER_KEY || "x-apisports-key";

// mini fetch (node18+)
async function safeFetch(url, options={}, timeoutMs=10000){
  const ctl = new AbortController(); const id=setTimeout(()=>ctl.abort(),timeoutMs);
  try{ const r = await fetch(url,{...options,signal:ctl.signal}); clearTimeout(id); return r; } finally{ clearTimeout(id); }
}

function istTomorrowRange(){
  // Europe/Istanbul yarın 00:00–23:59
  const now   = new Date();
  const ist   = new Intl.DateTimeFormat("en-CA",{ timeZone:"Europe/Istanbul", year:"numeric", month:"2-digit", day:"2-digit"});
  const [y,m,d] = ist.format(now).split("-").map(Number);
  const istNow = new Date(Date.UTC(y, m-1, d, 0, 0, 0));
  const tmr = new Date(istNow.getTime() + 24*3600*1000);
  const tmrEnd = new Date(tmr.getTime() + 24*3600*1000 - 1);
  const toISO = (dt)=> new Date(dt).toISOString();
  return { startISO: toISO(tmr), endISO: toISO(tmrEnd) };
}

// Fallback TSDB
async function tsdbTomorrow(teamName){
  // geniş listelemek için “Galatasaray”la sınırlamayalım; bedava uçta günü daraltmak zor → basit yaklaşım:
  // Tek takım istersen '?team=' ile geç; yoksa boş döner.
  if(!teamName) return [];
  try{
    const rTeam = await safeFetch(`https://www.thesportsdb.com/api/v1/json/1/searchteams.php?t=${encodeURIComponent(teamName)}`, {}, 8000);
    const jt = await rTeam.json();
    const idTeam = jt?.teams?.[0]?.idTeam;
    if(!idTeam) return [];
    const rNext = await safeFetch(`https://www.thesportsdb.com/api/v1/json/1/eventsnext.php?id=${idTeam}`, {}, 8000);
    const jn = await rNext.json();
    return (jn?.events||[]).map(e=>({
      fixtureId: e.idEvent,
      kickoffISO: e.dateEvent && e.strTime ? `${e.dateEvent}T${e.strTime}:00Z` : e.dateEvent || null,
      league: e.strLeague || null, home: e.strHomeTeam, away: e.strAwayTeam, status: "NS", source:"theSportsDB"
    }));
  }catch{ return []; }
}

router.get("/tomorrow", async (req,res)=>{
  try{
    const team = String(req.query.team||"Galatasaray"); // genişletebiliriz
    const { startISO, endISO } = istTomorrowRange();

    let fixtures = [];

    // 1) AF dene (date/mindate? API: /fixtures?date=YYYY-MM-DD; time window için param yok → date bazlı alalım)
    if (AF_KEY){
      const tz = "Europe/Istanbul";
      const date = startISO.slice(0,10); // YYYY-MM-DD
      const url = `${AF_BASE}/fixtures?date=${date}&timezone=${encodeURIComponent(tz)}`;
      try{
        const r = await safeFetch(url, { headers: { [AF_HDR]:AF_KEY, Accept:"application/json" }}, 10000);
        const j = await r.json();
        fixtures = (j?.response||[]).map(x=>({
          fixtureId: x.fixture?.id,
          kickoffISO: x.fixture?.date,
          league: x.league?.name,
          home: x.teams?.home?.name,
          away: x.teams?.away?.name,
          status: x.fixture?.status?.short
        }));
      }catch{}
    }

    // 2) Fallback: TSDB (takım odaklı)
    if(!fixtures || fixtures.length===0){
      fixtures = await tsdbTomorrow(team);
    }

    // 3) Lokal seed varsa filtrele
    if(!fixtures || fixtures.length===0){
      try{
        const fs = require("fs"); const path = require("path");
        const f = path.join(__dirname,"..","data","fixtures.json");
        const list = JSON.parse(fs.readFileSync(f,"utf8"));
        fixtures = (Array.isArray(list)?list:(list?.fixtures||[])).filter(x=>{
          const t = x.kickoffISO ? Date.parse(x.kickoffISO) : NaN;
          return Number.isFinite(t) && t>=Date.parse(startISO) && t<=Date.parse(endISO);
        });
      }catch{}
    }

    return res.json({ ok:true, count:(fixtures||[]).length, fixtures });
  }catch(e){
    return res.status(500).json({ ok:false, error:"TOMORROW_FAILED", detail:String(e&&e.message||e) });
  }
});

module.exports = router;
