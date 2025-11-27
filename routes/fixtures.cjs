/**
 * fixtures.cjs
 * /api/live/fixtures  ve  /api/fixtures
 * - Birincil: TheSportsDB (free)
 * - İkincil:  API-FOOTBALL (AF)  (AF_KEY varsa)
 * - Kota yöneticisi: %90 dolunca sıradaki sağlayıcıya geç
 * - Takım bazlı öğrenme: İlk başarılı sağlayıcıyı provider-map.json’a yaz
 * - Basit TTL cache (60 sn)
 */
"use strict";

const express = require("express");
const fetch   = globalThis.fetch || require("node-fetch");
const router  = express.Router();
const fs      = require("fs");
const fsp     = fs.promises;
const path    = require("path");

// === ENV / CONFIG ===
const AF_BASE = process.env.AF_BASE || "https://v3.football.api-sports.io";
const AF_KEY  = process.env.AF_KEY  || "";
const AF_HDR  = process.env.AF_HEADER_KEY || "x-apisports-key";
const LIVE_CACHE_TTL = Number(process.env.LIVE_CACHE_TTL || 60_000);

const DATA_DIR = path.join(__dirname, "..", "data");
const MAP_FILE = path.join(DATA_DIR, "provider-map.json");

// === tiny cache (in-memory) ===
const _cache = new Map(); // key -> { t, v }
const cacheGet = (k)=>{ const o=_cache.get(k); if(!o) return null; if(Date.now()>o.t){ _cache.delete(k); return null; } return o.v; };
const cacheSet = (k,v,ttl=LIVE_CACHE_TTL)=>{ _cache.set(k,{ t: Date.now()+ttl, v }); };

// === provider map (team -> providerName) persist ===
async function readJson(file, fb){ try{ return JSON.parse(await fsp.readFile(file,"utf8")); }catch{ return fb; } }
async function writeJson(file, data){ await fsp.mkdir(path.dirname(file),{recursive:true}); await fsp.writeFile(file, JSON.stringify(data,null,2), "utf8"); }

async function loadMap(){ return await readJson(MAP_FILE, {}); }
async function saveMap(obj){ await writeJson(MAP_FILE, obj||{}); }

// === helpers ===
function normItem({ id, dateISO, league, home, away, status, country, source }){
  return {
    fixtureId: id,
    kickoffISO: dateISO,
    league: league || null,
    home: home || null,
    away: away || null,
    status: status || "NS",
    country: country || null,
    source
  };
}
async function safeFetch(url, options={}, timeoutMs=12000){
  const controller = new AbortController();
  const tid = setTimeout(()=>controller.abort(), timeoutMs);
  try{
    const r = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(tid);
    return r;
  }catch(e){ clearTimeout(tid); throw e; }
}

// === Provider: TheSportsDB (FREE) ===
async function tsdbFindTeamIdByName(name){
  const r = await safeFetch(`https://www.thesportsdb.com/api/v1/json/1/searchteams.php?t=${encodeURIComponent(name)}`);
  const j = await r.json();
  const idTeam = j?.teams?.[0]?.idTeam || null;
  return { idTeam, teamName: j?.teams?.[0]?.strTeam || name };
}
async function tsdbNextFixturesByTeamName(teamName, limit=5){
  const { idTeam } = await tsdbFindTeamIdByName(teamName);
  if(!idTeam) return [];
  const r = await safeFetch(`https://www.thesportsdb.com/api/v1/json/1/eventsnext.php?id=${idTeam}`);
  const j = await r.json();
  const arr = Array.isArray(j?.events)? j.events : [];
  return arr.slice(0, limit).map(e => normItem({
    id: e.idEvent,
    dateISO: (e.dateEvent && e.strTime) ? `${e.dateEvent}T${e.strTime}:00Z` : (e.dateEvent ? `${e.dateEvent}T00:00:00Z` : null),
    league: e.strLeague,
    home: e.strHomeTeam,
    away: e.strAwayTeam,
    status: "NS",
    country: e.strCountry || null,
    source: "theSportsDB"
  }));
}

// === Provider: API-FOOTBALL ===
async function afFindTeamIdByName(name){
  const qs = new URLSearchParams({ search: String(name) });
  const r  = await safeFetch(`${AF_BASE}/teams?${qs}`, { headers: { [AF_HDR]: AF_KEY, Accept: "application/json" }});
  const j  = await r.json();
  const hit = (j?.response || []).find(t => (t.team?.name||"").toLowerCase().includes(String(name).toLowerCase()));
  return hit?.team?.id || null;
}
async function afNextFixturesByTeam({ teamId, teamName, next=5 }){
  let id = teamId;
  if(!id && teamName){ id = await afFindTeamIdByName(teamName); }
  if(!id) return { items: [], headers: {} };

  const qs = new URLSearchParams({ team: String(id), next: String(next), timezone: "Europe/Istanbul" });
  const r  = await safeFetch(`${AF_BASE}/fixtures?${qs}`, { headers: { [AF_HDR]: AF_KEY, Accept: "application/json" }});
  const headers = {
    limit:   r.headers.get("x-ratelimit-limit") || r.headers.get("x-ratelimit") || null,
    remain:  r.headers.get("x-ratelimit-requests-remaining") || r.headers.get("x-ratelimit-remaining") || null,
    reset:   r.headers.get("x-ratelimit-reset") || null
  };
  const j  = await r.json();
  const arr = Array.isArray(j?.response) ? j.response : [];
  const items = arr.map(x => normItem({
    id: x?.fixture?.id,
    dateISO: x?.fixture?.date,
    league: x?.league?.name,
    home: x?.teams?.home?.name,
    away: x?.teams?.away?.name,
    status: x?.fixture?.status?.short,
    country: x?.league?.country || null,
    source: "api-football"
  }));
  return { items, headers };
}

// === Budget Manager (çok basit, günlük tahmini limitler) ===
// Free plan ~100/gün varsayımı (gerçek limit planınıza göre değiştirilebilir)
const PROVIDERS = [
  { name: "TSDB", type:"free",  dailyCap: 100 },
  { name: "AF",   type:"paid",  dailyCap: 100000 }
];
const _budget = new Map(); // name -> { used, dateKey }
function todayKey(){ return new Date().toISOString().slice(0,10); }
function getBudget(name){
  const bk = _budget.get(name) || { used:0, dateKey: todayKey() };
  if (bk.dateKey !== todayKey()) { bk.used = 0; bk.dateKey = todayKey(); }
  return bk;
}
function bumpBudget(name, used=1){ const bk = getBudget(name); bk.used += used; _budget.set(name, bk); }
function ratio(name){
  const p = PROVIDERS.find(x=>x.name===name);
  if(!p) return 1;
  const bk = getBudget(name);
  return bk.used / (p.dailyCap || 100);
}

// === Guarded fetch (team-based, provider-map ile öğrenme) ===
async function guardedFixtures({ teamName, teamId, next=5 }){
  const map = await loadMap();
  const key = String(teamId || teamName || "").trim();
  let order = [];

  // Daha önce hangi sağlayıcı başarılı olduysa onu öne al
  if (key && map[key]) {
    order = map[key] === "TSDB" ? ["TSDB","AF"] : ["AF","TSDB"];
  } else {
    order = ["TSDB","AF"]; // ücretsiz önce
  }

  let lastErr = null;
  for (const name of order){
    // %90 dolduysa sıradaki
    if (ratio(name) >= 0.90) continue;

    try{
      if (name === "TSDB") {
        if (!teamName) continue; // TSDB doğrudan teamId ile çalışmıyor
        const items = await tsdbNextFixturesByTeamName(teamName, next);
        bumpBudget("TSDB", 1);
        if (items.length>0) {
          if (key) { map[key] = "TSDB"; await saveMap(map); }
          return { items, provider:"TSDB" };
        }
      } else if (name === "AF" && AF_KEY) {
        const { items, headers } = await afNextFixturesByTeam({ teamId, teamName, next });
        // Header varsa “used” yerine kalan/limit okuyup normalize edebilirdik; basitçe +1 say
        bumpBudget("AF", 1);
        if (items.length>0) {
          if (key) { map[key] = "AF"; await saveMap(map); }
          return { items, provider:"AF", headers };
        }
      }
    }catch(e){ lastErr = e; continue; }
  }
  if (lastErr) throw lastErr;
  return { items: [], provider: null };
}

// === Route handler ===
async function handleFixtures(req, res){
  try{
    const team   = (req.query.team || "").toString().trim();
    const teamId = (req.query.teamId || "").toString().trim() || null;
    const next   = Number(req.query.next || 5);

    if (!team && !teamId) {
      // küçük bir örnek: varsayılan Galatasaray
      // production’da burada 400 dönebilir veya favori takıma bakılabilir
    }

    const cacheKey = `fix:${team||""}:${teamId||""}:${next}`;
    const hit = cacheGet(cacheKey);
    if (hit) return res.json(hit);

    const { items, provider } = await guardedFixtures({ teamName: team || null, teamId, next });
    const out = { ok:true, provider: provider || null, count: items.length, fixtures: items };
    cacheSet(cacheKey, out, LIVE_CACHE_TTL);
    return res.json(out);
  }catch(e){
    return res.status(500).json({ ok:false, error:"LIVE_FIXTURES_ERROR", detail:String(e&&e.message||e) });
  }
}

// === DIAG (opsiyonel): bütçe ve provider-map durumu
router.get("/provider/diag", async (req,res)=>{
  const map = await loadMap();
  const diag = PROVIDERS.map(p=>({ name:p.name, used: getBudget(p.name).used, cap:p.dailyCap, ratio: Number((ratio(p.name)*100).toFixed(1))+"%" }));
  res.json({ ok:true, budget: diag, learned: map });
});

// === Routes ===
router.get("/fixtures", handleFixtures);
// ekstra mount: /api/live altında da çalışacak (server.cjs böyle mount ediyor)
module.exports = router;