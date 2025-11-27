"use strict";
const express = require("express");
const router  = express.Router();
const fs      = require("fs");
const fsp     = fs.promises;
const path    = require("path");

const DATA    = path.join(__dirname,"..","data");
const USERS   = path.join(DATA,"users.json");
const TOTALS  = path.join(DATA,"totals.json");
const FRIENDS = path.join(DATA,"friends.json"); 
// {
//   links:    [ { a:"user1", b:"user2", createdAt:"..." } ],
//   requests: [ { from:"user1", to:"user2", createdAt:"..." } ]
// }

async function readJson(file, fb){ try{ return JSON.parse(await fsp.readFile(file,"utf8")); }catch{ return fb; } }
async function writeJson(file, data){
  await fsp.mkdir(path.dirname(file), { recursive:true });
  await fsp.writeFile(file, JSON.stringify(data,null,2), "utf8");
}

function emptyFriends(){
  return { links: [], requests: [] };
}

async function loadFriends(){
  const m = await readJson(FRIENDS, null);
  if (!m || typeof m !== "object") return emptyFriends();
  if (!Array.isArray(m.links))    m.links    = [];
  if (!Array.isArray(m.requests)) m.requests = [];
  return m;
}
async function saveFriends(m){ await writeJson(FRIENDS, m); }

// iki kullanıcı arasındaki arkadaşlık için canonical key
function pairKey(a,b){
  const x = String(a||"");
  const y = String(b||"");
  return [x,y].sort().join("::");
}

/**
 * POST /api/friends/request
 * body: { fromUserId, toUserId }
 */
router.post("/request", express.json(), async (req,res)=>{
  try{
    const { fromUserId, toUserId } = req.body || {};
    const from = String(fromUserId || "").trim();
    const to   = String(toUserId   || "").trim();

    if (!from || !to)   return res.status(400).json({ ok:false, error:"USERS_REQUIRED" });
    if (from === to)    return res.status(400).json({ ok:false, error:"SELF_NOT_ALLOWED" });

    const users = await readJson(USERS, {});
    if (!users[from]) return res.status(400).json({ ok:false, error:"FROM_NOT_REGISTERED" });
    if (!users[to])   return res.status(400).json({ ok:false, error:"TO_NOT_REGISTERED" });

    const m = await loadFriends();
    const k = pairKey(from,to);

    // zaten arkadaşlar mı?
    const already = m.links.find(l => pairKey(l.a,l.b) === k);
    if (already){
      return res.json({ ok:true, alreadyFriend:true });
    }

    // karşıdan gelen bekleyen istek var mı? (to → from)
    const idxOpp = m.requests.findIndex(r => r.from===to && r.to===from);
    if (idxOpp >= 0){
      // karşılıklı oldu → arkadaş yap, pending'i sil
      m.requests.splice(idxOpp,1);
      m.links.push({
        a: from,
        b: to,
        createdAt: new Date().toISOString()
      });
      await saveFriends(m);
      return res.json({ ok:true, matched:true });
    }

    // aynı tarafa ait mevcut pending var mı?
    const alreadyReq = m.requests.find(r => r.from===from && r.to===to);
    if (!alreadyReq){
      m.requests.push({
        from,
        to,
        createdAt: new Date().toISOString()
      });
      await saveFriends(m);
    }

    res.json({ ok:true, requested:true });
  }catch(e){
    res.status(500).json({ ok:false, error:"FRIEND_REQUEST_FAILED", detail:String(e && (e.message||e)) });
  }
});

/**
 * POST /api/friends/accept
 * body: { userId, fromUserId }
 */
router.post("/accept", express.json(), async (req,res)=>{
  try{
    const { userId, fromUserId } = req.body || {};
    const me   = String(userId     || "").trim();
    const from = String(fromUserId || "").trim();
    if (!me || !from) return res.status(400).json({ ok:false, error:"REQ" });

    const m = await loadFriends();
    const idx = m.requests.findIndex(r => r.from===from && r.to===me);
    if (idx < 0) return res.status(404).json({ ok:false, error:"REQUEST_NOT_FOUND" });

    m.requests.splice(idx,1);
    const k = pairKey(me,from);
    if (!m.links.find(l => pairKey(l.a,l.b) === k)){
      m.links.push({ a: me, b: from, createdAt:new Date().toISOString() });
    }
    await saveFriends(m);
    res.json({ ok:true, accepted:true });
  }catch(e){
    res.status(500).json({ ok:false, error:"FRIEND_ACCEPT_FAILED", detail:String(e && (e.message||e)) });
  }
});

/**
 * POST /api/friends/reject
 * body: { userId, fromUserId }
 */
router.post("/reject", express.json(), async (req,res)=>{
  try{
    const { userId, fromUserId } = req.body || {};
    const me   = String(userId     || "").trim();
    const from = String(fromUserId || "").trim();
    if (!me || !from) return res.status(400).json({ ok:false, error:"REQ" });

    const m = await loadFriends();
    const before = m.requests.length;
    m.requests = m.requests.filter(r => !(r.from===from && r.to===me));
    const changed = m.requests.length !== before;
    await saveFriends(m);
    res.json({ ok:true, rejected: changed });
  }catch(e){
    res.status(500).json({ ok:false, error:"FRIEND_REJECT_FAILED", detail:String(e && (e.message||e)) });
  }
});

/**
 * GET /api/friends/list/:userId
 * Arkadaş listesi + bekleyen istekler
 */
router.get("/list/:userId", async (req,res)=>{
  try{
    const userId = String(req.params.userId || "").trim();
    if (!userId) return res.status(400).json({ ok:false, error:"USER_REQUIRED" });

    const m     = await loadFriends();
    const users = await readJson(USERS, {});
    const totals = await readJson(TOTALS, { items:[] });
    const totalsItems = Array.isArray(totals.items) ? totals.items : [];

    const friends = [];
    for (const l of m.links){
      if (l.a === userId || l.b === userId){
        const other = (l.a === userId) ? l.b : l.a;
        const u = users[other] || {};
        const t = totalsItems.find(x => String(x.userId) === other) || {};
        friends.push({
          userId: other,
          name: u.name || other,
          flag: u.flag || null,
          totalPoints: t.totalPoints || 0,
          since: l.createdAt
        });
      }
    }
    friends.sort((a,b)=> (b.totalPoints||0) - (a.totalPoints||0));

    const pendingIn  = m.requests.filter(r => r.to===userId);
    const pendingOut = m.requests.filter(r => r.from===userId);

    res.json({
      ok:true,
      userId,
      friends,
      pendingIn: pendingIn.map(r => ({
        fromUserId: r.from,
        createdAt:  r.createdAt,
        name: users[r.from]?.name || r.from
      })),
      pendingOut: pendingOut.map(r => ({
        toUserId: r.to,
        createdAt: r.createdAt,
        name: users[r.to]?.name || r.to
      }))
    });
  }catch(e){
    res.status(500).json({ ok:false, error:"FRIEND_LIST_FAILED", detail:String(e && (e.message||e)) });
  }
});

/**
 * GET /api/friends/board/:userId
 * → Kişi + tüm arkadaşları için mini puan tablosu
 */
router.get("/board/:userId", async (req,res)=>{
  try{
    const userId = String(req.params.userId || "").trim();
    if (!userId) return res.status(400).json({ ok:false, error:"USER_REQUIRED" });

    const m      = await loadFriends();
    const users  = await readJson(USERS, {});
    const totals = await readJson(TOTALS, { items:[] });
    const totalsItems = Array.isArray(totals.items) ? totals.items : [];

    const ids = new Set();
    ids.add(userId);
    for (const l of m.links){
      if (l.a === userId) ids.add(l.b);
      if (l.b === userId) ids.add(l.a);
    }

    const items = Array.from(ids).map(uid=>{
      const u = users[uid] || {};
      const t = totalsItems.find(x => String(x.userId) === uid) || {};
      return {
        userId: uid,
        name: u.name || uid,
        flag: u.flag || null,
        totalPoints: t.totalPoints || 0
      };
    }).sort((a,b)=> (b.totalPoints||0) - (a.totalPoints||0));

    res.json({ ok:true, userId, items });
  }catch(e){
    res.status(500).json({ ok:false, error:"FRIEND_BOARD_FAILED", detail:String(e && (e.message||e)) });
  }
});

module.exports = router;
