"use strict";
const express = require("express");
const router  = express.Router();
const fs      = require("fs");
const fsp     = fs.promises;
const path    = require("path");

const DATA_DIR       = path.join(__dirname, "..", "data");
const USERS_FILE     = path.join(DATA_DIR, "users.json");
const LEADER_FILE    = path.join(DATA_DIR, "leaderboard.json");
const FIXTURES_FILE  = path.join(DATA_DIR, "fixtures.json");

async function readJson(file, fb=null){
  try{ return JSON.parse(await fsp.readFile(file,"utf8")); }
  catch{ return fb; }
}

// Basit rozet mantığı
function badgeOf(userId, isBot){
  if (isBot) return { emoji:"✍️", label:"Bot yazar" };   // kalem
  const name = String(userId||"");
  if (/lion|aslan|gs/i.test(name))   return { emoji:"🦁", label:"Aslan" };
  if (/king|kral/i.test(name))       return { emoji:"👑", label:"Kral" };
  if (/goal|gol/i.test(name))        return { emoji:"🥅", label:"Golcü" };
  return { emoji:"🏃‍♂️", label:"Saha oyuncusu" };
}

// GET /api/team/members?team=Galatasaray
router.get("/members", async (req,res)=>{
  const team = String(req.query.team||"").trim();
  if(!team) return res.status(400).json({ ok:false, error:"TEAM_REQUIRED" });

  const users   = await readJson(USERS_FILE, []);
  const board   = await readJson(LEADER_FILE, { items:[], totals:{} });

  const totals  = board.totals || {};
  const list = [];

  const arr = Array.isArray(users) ? users : (Array.isArray(users?.items)? users.items:[]);
  for(const u of arr){
    const uid  = u.userId || u.id || null;
    const main = u.mainTeam || u.team || null;
    if(!uid || !main) continue;
    if(String(main).toLowerCase() !== team.toLowerCase()) continue;

    const t = totals[uid] || { total:0, played:0 };
    const isBot = /^bot_/i.test(uid);
    const badge = badgeOf(uid, isBot);

    list.push({
      userId: uid,
      name: u.name || uid,
      mainTeam: main,
      total: Number(t.total||0),
      played: Number(t.played||0),
      isBot,
      badge,
    });
  }

  const items = Array.isArray(board.items)? board.items: [];
  for(const r of items){
    const uid = r.userId || null;
    if(!uid) continue;
    if(list.find(x=> x.userId===uid)) continue;

    const teamHint = r.detail?.team || null;
    if(!teamHint) continue;
    if(String(teamHint).toLowerCase() !== team.toLowerCase()) continue;

    const isBot = /^bot_/i.test(uid);
    const badge = badgeOf(uid, isBot);

    list.push({
      userId: uid,
      name: uid,
      mainTeam: team,
      total: Number(r.points||0),
      played: 1,
      isBot,
      badge,
    });
  }

  list.sort((a,b)=> b.total - a.total);

  return res.json({ ok:true, team, members:list });
});

// GET /api/team/fixtures?team=Galatasaray
router.get("/fixtures", async (req,res)=>{
  const team = String(req.query.team||"").trim();
  if(!team) return res.status(400).json({ ok:false, error:"TEAM_REQUIRED" });

  const fxData = await readJson(FIXTURES_FILE, []);
  const arr = Array.isArray(fxData) ? fxData : (Array.isArray(fxData.fixtures)? fxData.fixtures : []);

  const list = arr.filter(fx=>{
    const h = String(fx.home||"").toLowerCase();
    const a = String(fx.away||"").toLowerCase();
    const t = team.toLowerCase();
    return h===t || a===t;
  }).map(fx=>({
    fixtureId: fx.fixtureId || fx.id || null,
    home: fx.home || "?",
    away: fx.away || "?",
    kickoffISO: fx.kickoffISO || null,
    league: fx.league || null,
    country: fx.country || null,
    status: fx.status || "NS"
  }));

  list.sort((a,b)=> String(a.kickoffISO||"").localeCompare(String(b.kickoffISO||"")));

  return res.json({ ok:true, team, fixtures:list });
});

module.exports = router;