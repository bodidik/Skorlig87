"use strict";
const express = require("express");
const router  = express.Router();
const fs      = require("fs");
const fsp     = fs.promises;
const path    = require("path");

const DATA_DIR    = path.join(__dirname,"..","data");
const USERS_FILE  = path.join(DATA_DIR,"users.json");
const GROUPS_FILE = path.join(DATA_DIR,"groups.json");
const TOTALS_FILE  = path.join(DATA_DIR,"totals.json");

async function readJson(file, fb){
  try{ return JSON.parse(await fsp.readFile(file,"utf8")); }
  catch{ return fb; }
}
async function writeJson(file, data){
  await fsp.mkdir(path.dirname(file),{recursive:true});
  await fsp.writeFile(file, JSON.stringify(data,null,2),"utf8");
}

async function ensureUser(userId){
  const uid = String(userId||"").trim();
  if(!uid) throw new Error("USER_REQUIRED");
  const data = await readJson(USERS_FILE, { items: [] });
  const items = Array.isArray(data.items) ? data.items : [];
  let u = items.find(x => String(x.userId) === uid);
  if(!u){
    u = { userId: uid, mainTeam: null, createdAt: new Date().toISOString() };
    items.push(u);
    await writeJson(USERS_FILE, { items });
  }
  return u;
}

// GET /api/users/profile?userId=...
router.get("/profile", async (req,res)=>{
  try{
    const userId = String(req.query.userId||"").trim();
    if(!userId) return res.status(400).json({ ok:false, error:"USER_REQUIRED" });

    const u = await ensureUser(userId);
    const profile = {
      userId,
      mainTeam: u.mainTeam || null,
      // totals: gerçek toplam puan için /api/rt/totals kullanıyoruz;
      // burada sadece 0 ya da kaydedilmiş bir değer dönüyoruz.
      totals: Number(u.totals || 0)
    };
    return res.json({ ok:true, profile });
  }catch(e){
    console.error("USER_PROFILE_ERR", e);
    return res.status(500).json({ ok:false, error:"USER_PROFILE_ERR", detail:String(e && (e.message||e)) });
  }
});

// POST /api/users/set-main-team { userId, team }
router.post("/set-main-team", express.json(), async (req,res)=>{
  try{
    const userId = String(req.body?.userId||"").trim();
    const team   = String(req.body?.team||"").trim();
    if(!userId || !team) return res.status(400).json({ ok:false, error:"USER_OR_TEAM_MISSING" });

    const data = await readJson(USERS_FILE, { items: [] });
    const items = Array.isArray(data.items) ? data.items : [];
    let u = items.find(x => String(x.userId) === userId);
    if(!u){
      u = { userId, mainTeam: team, createdAt: new Date().toISOString() };
      items.push(u);
    }else{
      u.mainTeam = team;
      u.updatedAt = new Date().toISOString();
    }
    await writeJson(USERS_FILE, { items });

    return res.json({ ok:true, userId, mainTeam: team });
  }catch(e){
    console.error("SET_MAIN_TEAM_ERR", e);
    return res.status(500).json({ ok:false, error:"SET_MAIN_TEAM_ERR", detail:String(e && (e.message||e)) });
  }
});

// GET /api/users/favorite?userId=...
router.get("/favorite", async (req,res)=>{
  try{
    const userId = String(req.query.userId||"").trim();
    if(!userId) return res.status(400).json({ ok:false, error:"USER_REQUIRED" });
    const data = await readJson(USERS_FILE, { items: [] });
    const items = Array.isArray(data.items) ? data.items : [];
    const u = items.find(x => String(x.userId) === userId);
    const favoriteTeam = u?.mainTeam || null;
    return res.json({ ok:true, favoriteTeam });
  }catch(e){
    console.error("FAVORITE_ERR", e);
    return res.status(500).json({ ok:false, error:"FAVORITE_ERR", detail:String(e && (e.message||e)) });
  }
});

// GET /api/users/groups/list?userId=...
router.get("/groups/list", async (req,res)=>{
  try{
    const userId = String(req.query.userId||"").trim();
    if(!userId) return res.status(400).json({ ok:false, error:"USER_REQUIRED" });

    const data = await readJson(GROUPS_FILE, { items: [] });
    const items = Array.isArray(data.items) ? data.items : [];
    const list = items.filter(g =>
      String(g.ownerId||"") === userId ||
      (Array.isArray(g.members) && g.members.includes(userId))
    );
    return res.json({ ok:true, items: list });
  }catch(e){
    console.error("GROUP_LIST_ERR", e);
    return res.status(500).json({ ok:false, error:"GROUP_LIST_ERR", detail:String(e && (e.message||e)) });
  }
});

// POST /api/users/groups/create { ownerId, name }
router.post("/groups/create", express.json(), async (req,res)=>{
  try{
    const ownerId = String(req.body?.ownerId||"").trim();
    const name    = String(req.body?.name||"").trim();
    if(!ownerId || !name) return res.status(400).json({ ok:false, error:"OWNER_OR_NAME_MISSING" });

    await ensureUser(ownerId);

    const data = await readJson(GROUPS_FILE, { items: [] });
    const items = Array.isArray(data.items) ? data.items : [];

    const id = "grp_" + Math.random().toString(36).slice(2,10);
    const now = new Date().toISOString();
    const group = {
      id,
      ownerId,
      name,
      members: [ownerId],
      createdAt: now
    };
    items.push(group);
    await writeJson(GROUPS_FILE, { items });

    return res.json({ ok:true, group });
  }catch(e){
    console.error("GROUP_CREATE_ERR", e);
    return res.status(500).json({ ok:false, error:"GROUP_CREATE_ERR", detail:String(e && (e.message||e)) });
  }
});

// ---- 1987 ÖZEL: ÜYE LİSTESİ VE SEZON TABLOSU ----

// GET /api/users/1987
router.get("/1987", async (req,res)=>{
  try{
    const raw = await readJson(USERS_FILE, { users: [], items: [] });

    const listUsers = [];
    const pushUser = (u)=>{
      if(!u) return;
      const id = String(u.userId || u.id || "").trim();
      if(!id) return;
      listUsers.push(Object.assign({}, u, { userId:id }));
    };

    if(Array.isArray(raw.users)) raw.users.forEach(pushUser);
    if(Array.isArray(raw.items)) raw.items.forEach(pushUser);

    const byId = new Map();
    for(const u of listUsers){
      const id = u.userId;
      if(!id) continue;
      if(!byId.has(id)) byId.set(id, u);
    }

    const members = Array.from(byId.values()).filter(u=>{
      const seg = String(u.segment || "").toLowerCase();
      return u && (u.is1987 === true || seg === "1987");
    });

    return res.json({
      ok: true,
      count: members.length,
      users: members.map(u=>({
        userId:   u.userId,
        mainTeam: u.mainTeam || null,
        is1987:   !!u.is1987,
        createdAt: u.createdAt || null,
        updatedAt: u.updatedAt || null
      }))
    });
  }catch(e){
    console.error("USERS_1987_ERR", e);
    return res.status(500).json({ ok:false, error:"USERS_1987_ERR", detail:String(e && (e.message||e)) });
  }
});

// GET /api/users/1987/season
router.get("/1987/season", async (req,res)=>{
  try{
    const usersRaw  = await readJson(USERS_FILE,  { users: [], items: [] });
    const totalsRaw = await readJson(TOTALS_FILE, { items: [] });

    const listUsers = [];
    const pushUser = (u)=>{
      if(!u) return;
      const id = String(u.userId || u.id || "").trim();
      if(!id) return;
      listUsers.push(Object.assign({}, u, { userId:id }));
    };

    if(Array.isArray(usersRaw.users)) usersRaw.users.forEach(pushUser);
    if(Array.isArray(usersRaw.items)) usersRaw.items.forEach(pushUser);

    const byId = new Map();
    for(const u of listUsers){
      const id = u.userId;
      if(!id) continue;
      if(!byId.has(id)) byId.set(id, u);
    }

    const totalsItems = Array.isArray(totalsRaw.items) ? totalsRaw.items : [];
    const totalsByUser = new Map();
    for(const t of totalsItems){
      const id = String(t.userId || "").trim();
      if(!id) continue;
      totalsByUser.set(id, t);
    }

    const rows = [];
    for(const [id, u] of byId.entries()){
      const seg = String(u.segment || "").toLowerCase();
      const is1987 = (u.is1987 === true || seg === "1987");
      if(!is1987) continue;

      const t = totalsByUser.get(id) || {};
      const totalPoints = Number(t.totalPoints || t.total || 0);
      const matches     = Number(t.matches     || t.played || 0);

      rows.push({
        userId:     id,
        mainTeam:   u.mainTeam || null,
        totalPoints,
        matches,
        lastAt:     t.lastAt || null
      });
    }

    rows.sort((a,b)=>{
      if(b.totalPoints !== a.totalPoints) return b.totalPoints - a.totalPoints;
      if(b.matches     !== a.matches)     return b.matches - a.matches;
      return String(b.lastAt || "").localeCompare(String(a.lastAt || ""));
    });

    const season = rows.map((r,idx)=>Object.assign({}, r, { rank: idx+1 }));

    return res.json({
      ok: true,
      count: season.length,
      season
    });
  }catch(e){
    console.error("SEASON_1987_ERR", e);
    return res.status(500).json({ ok:false, error:"SEASON_1987_ERR", detail:String(e && (e.message||e)) });
  }
});
module.exports = router;
