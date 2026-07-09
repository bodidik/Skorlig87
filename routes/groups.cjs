"use strict";

const express = require("express");
const router  = express.Router();
const fs      = require("fs");
const fsp     = fs.promises;
const path    = require("path");
const crypto  = require("crypto");

const DATA   = path.join(__dirname,"..","data");
const GROUPS = path.join(DATA,"groups.json");  // { CODE: { name, ownerId, members:[userId], opts:{ userId:{ includeInTotal } } } }
const USERS  = path.join(DATA,"users.json");   // { userId: { name, flag, ... } }  (map)
const TOTALS = path.join(DATA,"totals.json");  // { items: [ { userId, totalPoints, ...}, ... ], updatedAt }

async function readJson(file, fb){ try{ return JSON.parse(await fsp.readFile(file,"utf8")); }catch{ return fb; } }
async function writeJson(file, data){
  await fsp.mkdir(path.dirname(file), { recursive:true });
  await fsp.writeFile(file, JSON.stringify(data,null,2), "utf8");
}

function code6(){
  return crypto.randomBytes(4).toString("base64url").slice(0,6).toUpperCase();
}

/* =========================
   HANDLERS (tek gerçek)
   ========================= */

async function handleCreate(req,res){
  try{
    const { name, ownerId } = req.body || {};
    if (!name || !ownerId) {
      return res.status(400).json({ ok:false, error:"NAME_OWNER_REQUIRED" });
    }

    const store = await readJson(GROUPS, {});
    let code;
    do { code = code6(); } while (store[code]);

    store[code] = {
      name:   String(name),
      ownerId:String(ownerId),
      members:[ String(ownerId) ],
      opts: {}
    };

    await writeJson(GROUPS, store);
    res.json({ ok:true, code, group: store[code] });
  }catch(e){
    res.status(500).json({ ok:false, error:"GROUP_CREATE_FAILED", detail:String(e && (e.message||e)) });
  }
}

async function handleJoin(req,res){
  try{
    const { code, userId } = req.body || {};
    const store = await readJson(GROUPS, {});
    const g = store[String(code||"").toUpperCase()];
    if (!g) return res.status(404).json({ ok:false, error:"GROUP_NOT_FOUND" });

    const uid = String(userId||"").trim();
    if (!uid) return res.status(400).json({ ok:false, error:"USER_REQUIRED" });

    if (!Array.isArray(g.members)) g.members = [];
    if (!g.members.includes(uid)) g.members.push(uid);

    await writeJson(GROUPS, store);
    res.json({ ok:true, group:{ code:String(code||"").toUpperCase(), name:g.name, size:g.members.length } });
  }catch(e){
    res.status(500).json({ ok:false, error:"GROUP_JOIN_FAILED", detail:String(e && (e.message||e)) });
  }
}

async function handleBoard(req,res){
  try{
    const code = String(req.params.code || "").toUpperCase();
    const store  = await readJson(GROUPS, {});
    const users  = await readJson(USERS, {});
    const totals = await readJson(TOTALS, { items:[] });

    const g = store[code];
    if (!g) return res.status(404).json({ ok:false, error:"GROUP_NOT_FOUND" });

    const itemsTotals = Array.isArray(totals.items) ? totals.items : [];

    const items = (g.members || []).map(uid=>{
      const u = users[uid] || {};
      const t = itemsTotals.find(x => String(x.userId) === String(uid)) || {};
      return {
        userId: uid,
        name: u.name || uid,
        flag: u.flag || null,
        includeInTotal: (g.opts?.[uid]?.includeInTotal ?? u.includeInTotal ?? true),
        points: Number(t.totalPoints || 0)
      };
    }).sort((a,b)=> b.points - a.points);

    res.json({
      ok:true,
      code,
      name:g.name,
      size:(g.members||[]).length,
      items
    });
  }catch(e){
    res.status(500).json({ ok:false, error:"GROUP_BOARD_FAILED", detail:String(e && (e.message||e)) });
  }
}

async function handleOpt(req,res){
  try{
    const code = String(req.params.code || "").toUpperCase();
    const { userId, includeInTotal } = req.body || {};
    if (!userId || typeof includeInTotal !== "boolean") {
      return res.status(400).json({ ok:false, error:"REQ" });
    }

    const store = await readJson(GROUPS, {});
    const g = store[code];
    if (!g) return res.status(404).json({ ok:false, error:"GROUP_NOT_FOUND" });

    g.opts = g.opts || {};
    g.opts[String(userId)] = { includeInTotal: !!includeInTotal };

    await writeJson(GROUPS, store);
    res.json({ ok:true });
  }catch(e){
    res.status(500).json({ ok:false, error:"GROUP_OPT_FAILED", detail:String(e && (e.message||e)) });
  }
}

/* =========================
   ROUTES (legacy + alias)
   ========================= */

// CREATE
router.post("/groups/create", express.json(), handleCreate); // legacy
router.post("/create",        express.json(), handleCreate); // alias

// JOIN
router.post("/groups/join", express.json(), handleJoin); // legacy
router.post("/join",        express.json(), handleJoin); // alias

// BOARD
router.get("/groups/:code/board", handleBoard); // legacy
router.get("/:code/board",        handleBoard); // alias

// OPT
router.post("/groups/:code/opt", express.json(), handleOpt); // legacy
router.post("/:code/opt",        express.json(), handleOpt); // alias

// DIAG (aynı)
router.get("/diag", async (req,res)=>{
  try{
    const store = await readJson(GROUPS, {});
    const codes = Object.keys(store);
    res.json({ ok:true, codes, groups: store });
  }catch(e){
    res.status(500).json({ ok:false, error:"GROUP_DIAG_FAILED", detail:String(e && (e.message||e)) });
  }
});

module.exports = router;
