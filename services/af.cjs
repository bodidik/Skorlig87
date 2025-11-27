/**
 * af.cjs
 * Çok katmanlı veri kaynağı zinciri:
 * 1. API-Football (AF_KEY mevcutsa)
 * 2. TheSportsDB RapidAPI mirror (ücretsiz)
 * 3. OpenFootball (GitHub JSON)
 */

const AF_BASE = process.env.AF_BASE || "https://v3.football.api-sports.io";
const AF_KEY  = process.env.AF_KEY  || "";
const AF_HDR  = process.env.AF_HEADER_KEY || "x-apisports-key";
const RAPID_KEY = process.env.RAPID_KEY || ""; // isteğe bağlı
const RAPID_HOST = "thesportsdb.p.rapidapi.com";

async function safeFetch(url, options={}, timeoutMs=10000){
  const c = new AbortController();
  const id = setTimeout(()=>c.abort(), timeoutMs);
  try { const r = await fetch(url, { ...options, signal:c.signal }); clearTimeout(id); return r; }
  catch(e){ clearTimeout(id); throw e; }
}

/* --- 1) API-Football --- */
async function findByTeams_AF(home, away){
  if(!AF_KEY) return null;
  try{
    const q = new URLSearchParams({ search: String(home) });
    const tr = await safeFetch(`${AF_BASE}/teams?${q}`, { headers:{ [AF_HDR]:AF_KEY, Accept:"application/json" }});
    const tj = await tr.json();
    const hit = (tj?.response||[]).find(t => (t.team?.name||"").toLowerCase().includes(String(home).toLowerCase()));
    const teamId = hit?.team?.id;
    if(!teamId) return null;
    const fx = await safeFetch(`${AF_BASE}/fixtures?${new URLSearchParams({ team:String(teamId), timezone:"Europe/Istanbul" })}`,
      { headers:{ [AF_HDR]:AF_KEY, Accept:"application/json" }});
    const fj = await fx.json();
    const match = (fj?.response||[]).find(x =>
      (x.teams?.home?.name||"").toLowerCase().includes(home.toLowerCase()) &&
      (x.teams?.away?.name||"").toLowerCase().includes(away.toLowerCase()));
    if(!match) return null;
    return {
      fixtureId: match.fixture?.id,
      kickoffISO: match.fixture?.date,
      league: match.league?.name,
      home: match.teams?.home?.name,
      away: match.teams?.away?.name,
      status: match.fixture?.status?.short,
      source: "api-football"
    };
  }catch{ return null; }
}

/* --- 2) TheSportsDB RapidAPI mirror --- */
async function findByTeams_Rapid(home, away){
  if(!RAPID_KEY) return null;
  try{
    const opts = { headers:{ "X-RapidAPI-Key": RAPID_KEY, "X-RapidAPI-Host": RAPID_HOST } };
    const rTeam = await safeFetch(`https://${RAPID_HOST}/api/v1/json/3/searchteams.php?t=${encodeURIComponent(home)}`, opts);
    const jT = await rTeam.json();
    const idTeam = jT?.teams?.[0]?.idTeam;
    if(!idTeam) return null;
    const rFx = await safeFetch(`https://${RAPID_HOST}/api/v1/json/3/eventsnext.php?id=${idTeam}`, opts);
    const jF = await rFx.json();
    const match = (jF?.events||[]).find(e =>
      (e.strHomeTeam||"").toLowerCase().includes(home.toLowerCase()) &&
      (e.strAwayTeam||"").toLowerCase().includes(away.toLowerCase()));
    if(!match) return null;
    return {
      fixtureId: match.idEvent || `${idTeam}-RAPID`,
      kickoffISO: match.dateEvent && match.strTime ? `${match.dateEvent}T${match.strTime}:00Z` : match.dateEvent || null,
      league: match.strLeague,
      home: match.strHomeTeam,
      away: match.strAwayTeam,
      status: "NS",
      source: "thesportsdb-rapidapi"
    };
  }catch{ return null; }
}

/* --- 3) OpenFootball (GitHub raw) --- */
async function findByTeams_OpenFootball(home, away){
  try{
    const url = "https://raw.githubusercontent.com/openfootball/football.json/master/2025/tr.1.json";
    const r = await safeFetch(url);
    const j = await r.json();
    const match = (j?.matches||[]).find(m =>
      (m.team1||"").toLowerCase().includes(home.toLowerCase()) &&
      (m.team2||"").toLowerCase().includes(away.toLowerCase()));
    if(!match) return null;
    return {
      fixtureId: `${match.date}-${match.team1}-${match.team2}`,
      kickoffISO: `${match.date}T17:00:00+03:00`,
      league: "Süper Lig (OpenFootball)",
      home: match.team1,
      away: match.team2,
      status: "NS",
      source: "openfootball"
    };
  }catch{ return null; }
}

/* --- Zincir --- */
async function findByTeams(home, away){
  const af = await findByTeams_AF(home, away);
  if(af) return af;
  const rapid = await findByTeams_Rapid(home, away);
  if(rapid) return rapid;
  const open = await findByTeams_OpenFootball(home, away);
  if(open) return open;
  return null;
}

/* --- Tek maç detay (AF veya fallback) --- */
async function fetchLive(fixtureId){
  if(!AF_KEY) return null;
  try{
    const r = await safeFetch(`${AF_BASE}/fixtures?${new URLSearchParams({ id:String(fixtureId), timezone:"Europe/Istanbul" })}`,
      { headers:{ [AF_HDR]:AF_KEY, Accept:"application/json" }});
    const j = await r.json();
    const x = (j?.response||[])[0];
    if(!x) return null;
    return {
      fixtureId: x.fixture?.id,
      minute: x.fixture?.status?.elapsed || 0,
      status: x.fixture?.status?.short,
      home: x.teams?.home?.name,
      away: x.teams?.away?.name,
      score: { home: x.goals?.home ?? 0, away: x.goals?.away ?? 0 },
      firstGoal: (x.events||[]).find(e=>e.type==="Goal")?.team?.name
        ? (((x.events||[]).find(e=>e.type==="Goal").team.name===x.teams?.home?.name)?"H":"A") : null,
      source: "api-football"
    };
  }catch{ return null; }
}

module.exports = { findByTeams, fetchLive };
