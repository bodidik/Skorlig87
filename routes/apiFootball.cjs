const express = require("express");
require("dotenv").config();
const router = express.Router();

const BASE = process.env.AF_BASE;
const HOST = process.env.AF_HOST;
const KEY_HEADER = process.env.AF_HEADER_KEY || "x-rapidapi-key";
const KEY = process.env.AF_KEY;

function buildURL(path, query) {
  const url = new URL(path.startsWith("/")? path: `/${path}`, BASE);
  for (const [k,v] of Object.entries(query||{})) if (v!=null && v!=="") url.searchParams.set(k, v);
  return url.toString();
}

// minik cache
const cache = new Map();
const TTL_MS = 30*1000;

router.get("/:path*", async (req,res)=>{
  try {
    const upstream = buildURL(req.params.path + (req.params[0]||""), req.query);
    const now = Date.now();
    const c = cache.get(upstream);
    if (c && (now-c.t) < TTL_MS) return res.status(200).json(c.data);

    const r = await fetch(upstream, { headers: { [KEY_HEADER]: KEY, "x-rapidapi-host": HOST } });
    const data = await r.json();
    if (r.ok) cache.set(upstream, { t: now, data });
    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ error:"API_FOOTBALL_PROXY_ERROR", detail:String(e) });
  }
});

router.get("/", (_req,res)=> res.json({ ok:true, base:BASE, host:HOST }));
/* --- API-Football: GET <prefix>/fixtures?team=galatasaray veya ?teamId=641 --- */
const AF_BASE = process.env.AF_BASE;
const AF_KEY  = process.env.AF_KEY;
const AF_HDR  = process.env.AF_HEADER_KEY || "x-apisports-key";

async function __afFindTeamIdByName(name) {
  const q = new URLSearchParams({ search: String(name) });
  const r = await fetch(`${AF_BASE}/teams?${q}`, { headers: { [AF_HDR]: AF_KEY, Accept:"application/json" }});
  const j = await r.json();
  const hit = j?.response?.find(t => (t.team?.name || "").toLowerCase().includes(String(name).toLowerCase()));
  return hit?.team?.id;
}

router.get("/fixtures", async (req, res) => {
  try {
    if (!AF_BASE || !AF_KEY) return res.status(500).json({ ok:false, error:"AF_ENV_MISSING" });
    const { team, teamId, next = 5 } = req.query;

    let id = teamId;
    if (!id) {
      if (!team) return res.status(400).json({ ok:false, error:"TEAM_OR_ID_REQUIRED" });
      id = await __afFindTeamIdByName(team);
      if (!id) return res.status(404).json({ ok:false, error:"TEAM_NOT_FOUND", search: team });
    }

    const qs = new URLSearchParams({ team:String(id), next:String(next), timezone:"Europe/Istanbul" });
    const fx = await fetch(`${AF_BASE}/fixtures?${qs}`, { headers: { [AF_HDR]: AF_KEY, Accept:"application/json" }});
    const data = await fx.json();

    const fixtures = (data?.response || []).map(x => ({
      fixtureId: x.fixture?.id,
      kickoffISO: x.fixture?.date,
      league: x.league?.name,
      home: x.teams?.home?.name,
      away: x.teams?.away?.name,
      status: x.fixture?.status?.short,
      seriesId: "SERIE-TRIAL-5"
    }));

    res.json({ ok:true, teamId:id, count:fixtures.length, fixtures });
  } catch(err) {
    res.status(500).json({ ok:false, error:"AF_FIXTURES_ERROR", detail:String(err) });
  }
});
module.exports = router;



