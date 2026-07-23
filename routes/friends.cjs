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
const { verifyToken } = require("../middleware/verifyToken.cjs");
// {
//   links:    [ { a:"user1", b:"user2", createdAt:"..." } ],
//   requests: [ { from:"user1", to:"user2", createdAt:"..." } ],
//   blocks:   [ { by:"user1", target:"anyString", createdAt:"..." } ]
// }

async function readJson(file, fb){ try{ return JSON.parse(await fsp.readFile(file,"utf8")); }catch{ return fb; } }
async function writeJson(file, data){
  await fsp.mkdir(path.dirname(file), { recursive:true });
  await fsp.writeFile(file, JSON.stringify(data,null,2), "utf8");
}

function emptyFriends(){
  return { links: [], requests: [], blocks: [] };
}

function normId(x){ return String(x||"").trim(); }
function normLower(x){ return String(x||"").trim().toLowerCase(); }

function ensureBlocks(m){
  if (!m || typeof m !== "object") return;
  if (!Array.isArray(m.blocks)) m.blocks = [];
}

function isBlockedBy(m, by, target){
  ensureBlocks(m);
  const B = normId(by);
  const T = normId(target);
  return m.blocks.some(x => normId(x.by) === B && normId(x.target) === T);
}

function isBlockedEither(m, a, b){
  ensureBlocks(m);
  const A = normId(a);
  const B = normId(b);
  return m.blocks.some(x =>
    (normId(x.by) === A && normId(x.target) === B) ||
    (normId(x.by) === B && normId(x.target) === A)
  );
}

async function loadFriends(){
  const m = await readJson(FRIENDS, null);
  if (!m || typeof m !== "object") return emptyFriends();
  if (!Array.isArray(m.links))    m.links    = [];
  if (!Array.isArray(m.requests)) m.requests = [];
  ensureBlocks(m);
  return m;
}
async function saveFriends(m){ await writeJson(FRIENDS, m); }

// iki kullanıcı arasındaki arkadaşlık için canonical key
function pairKey(a,b){
  const x = String(a||"");
  const y = String(b||"");
  return [x,y].sort().join("::");
}

// users.json'u normalize ederek ortak liste çıkar
async function loadUsersList() {
  const raw = (await readJson(USERS, { users: [], items: [] })) || {};
  const list = [];
  const pushUser = (u, forcedId) => {
    if (!u) return;
    const id = String(forcedId || u.userId || u.id || "").trim();
    if (!id) return;
    list.push({ ...u, userId: id });
  };

  if (Array.isArray(raw.users)) raw.users.forEach(u => pushUser(u));
  if (Array.isArray(raw.items)) raw.items.forEach(u => pushUser(u));

  // Map formatını da destekle ( { userId: {...}, ... } )
  if (!Array.isArray(raw.users) && !Array.isArray(raw.items)) {
    Object.entries(raw).forEach(([id, u]) => {
      if (u && typeof u === "object") pushUser(u, id);
    });
  }

  // de-dup (case-insensitive)
  const seen = new Set();
  const out = [];
  for (const u of list) {
    const k = normLower(u.userId);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(u);
  }
  return out;
}

async function loadTotalsItems() {
  const totals = await readJson(TOTALS, { items: [] });
  return Array.isArray(totals.items) ? totals.items : [];
}

function clampInt(x, def, min, max){
  const n = Number.parseInt(String(x ?? ""), 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

/**
 * POST /api/friends/request
 * body: { fromUserId, toUserId }  veya  { fromId, toId }
 */
router.post("/request", verifyToken, express.json(), async (req,res)=>{
  try{
    const body = req.body || {};
    const from = req.uid;
    const to   = String(body.toUserId   ?? body.toId   ?? "").trim();

    if (!from || !to)   return res.status(400).json({ ok:false, error:"USERS_REQUIRED" });
    if (from === to)    return res.status(400).json({ ok:false, error:"SELF_NOT_ALLOWED" });

    const usersList = await loadUsersList();
    const hasFrom = usersList.some(u => String(u.userId).trim().toLowerCase() === from.toLowerCase());
    const hasTo   = usersList.some(u => String(u.userId).trim().toLowerCase() === to.toLowerCase());

    if (!hasFrom) return res.status(400).json({ ok:false, error:"FROM_NOT_REGISTERED" });
    if (!hasTo)   return res.status(400).json({ ok:false, error:"TO_NOT_REGISTERED" });

    const m = await loadFriends();

    // ✅ BLOCK enforcement
    if (isBlockedEither(m, from, to)) {
      return res.status(403).json({ ok:false, error:"BLOCKED" });
    }

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
      m.links.push({ a: from, b: to, createdAt: new Date().toISOString() });
      await saveFriends(m);
      return res.json({ ok:true, matched:true });
    }

    // aynı tarafa ait mevcut pending var mı?
    const alreadyReq = m.requests.find(r => r.from===from && r.to===to);
    if (!alreadyReq){
      m.requests.push({ from, to, createdAt: new Date().toISOString() });
      await saveFriends(m);
    }

    return res.json({ ok:true, requested:true });
  }catch(e){
    return res.status(500).json({ ok:false, error:"FRIEND_REQUEST_FAILED", detail:String(e && (e.message||e)) });
  }
});

/**
 * POST /api/friends/accept
 * body: { userId, fromUserId }
 */
router.post("/accept", verifyToken, express.json(), async (req,res)=>{
  try{
    const { fromUserId } = req.body || {};
    const me   = req.uid;
    const from = String(fromUserId || "").trim();
    if (!me || !from) return res.status(400).json({ ok:false, error:"REQ" });

    const m = await loadFriends();

    // ✅ BLOCK enforcement (idempotent şekilde)
    if (isBlockedEither(m, me, from)) {
      return res.json({ ok:true, blocked:true });
    }

    const k = pairKey(me, from);

    // 1️⃣ Zaten arkadaşlar mı?
    const already = m.links.find(l => pairKey(l.a, l.b) === k);
    if (already){
      return res.json({ ok:true, alreadyFriend:true });
    }

    // 2️⃣ Pending var mı?
    const idx = m.requests.findIndex(r => r.from===from && r.to===me);
    if (idx < 0){
      // idempotent no-op
      return res.json({ ok:true, noRequest:true });
    }

    // 3️⃣ Normal accept
    m.requests.splice(idx,1);
    m.links.push({ a: me, b: from, createdAt: new Date().toISOString() });

    await saveFriends(m);
    return res.json({ ok:true, accepted:true });

  }catch(e){
    return res.status(500).json({
      ok:false,
      error:"FRIEND_ACCEPT_FAILED",
      detail:String(e && (e.message||e))
    });
  }
});

/**
 * POST /api/friends/reject
 * body: { userId, fromUserId }
 */
router.post("/reject", verifyToken, express.json(), async (req,res)=>{
  try{
    const { fromUserId } = req.body || {};
    const me   = req.uid;
    const from = String(fromUserId || "").trim();
    if (!me || !from) return res.status(400).json({ ok:false, error:"REQ" });

    const m = await loadFriends();
    const before = m.requests.length;
    m.requests = m.requests.filter(r => !(r.from===from && r.to===me));
    const changed = m.requests.length !== before;
    await saveFriends(m);
    return res.json({ ok:true, rejected: changed });
  }catch(e){
    return res.status(500).json({ ok:false, error:"FRIEND_REJECT_FAILED", detail:String(e && (e.message||e)) });
  }
});

/**
 * POST /api/friends/unfriend
 * body: { userId, targetUserId }  veya { a, b }
 * - link'i kaldırır (idempotent)
 * - block gerektirmez; temizlik endpoint'i
 */
router.post("/unfriend", verifyToken, express.json(), async (req, res) => {
  try {
    const body = req.body || {};
    const a = req.uid;
    const b = String(body.targetUserId ?? body.b ?? "").trim();
    if (!a || !b) return res.status(400).json({ ok: false, error: "REQ" });
    if (a === b)  return res.status(400).json({ ok: false, error: "SELF_NOT_ALLOWED" });

    const m = await loadFriends();
    const k = pairKey(a, b);

    const before = (m.links || []).length;
    m.links = (m.links || []).filter(l => pairKey(l.a, l.b) !== k);
    const changed = m.links.length !== before;

    await saveFriends(m);
    return res.json({ ok: true, removed: changed });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "FRIEND_UNFRIEND_FAILED", detail: String(e && (e.message || e)) });
  }
});

/**
 * POST /api/friends/cancel
 * body: { fromUserId, toUserId }  veya { from, to }
 * - outgoing pending isteği iptal eder (idempotent)
 */
router.post("/cancel", verifyToken, express.json(), async (req, res) => {
  try {
    const body = req.body || {};
    const from = req.uid;
    const to   = String(body.toUserId   ?? body.to   ?? "").trim();
    if (!from || !to) return res.status(400).json({ ok: false, error: "REQ" });
    if (from === to)  return res.status(400).json({ ok: false, error: "SELF_NOT_ALLOWED" });

    const m = await loadFriends();

    const before = (m.requests || []).length;
    m.requests = (m.requests || []).filter(r => !(r.from === from && r.to === to));
    const changed = m.requests.length !== before;

    await saveFriends(m);
    return res.json({ ok: true, cancelled: changed });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "FRIEND_CANCEL_FAILED", detail: String(e && (e.message || e)) });
  }
});

/**
 * POST /api/friends/remove-request
 * body: { userId, otherUserId } veya { a, b }
 * - iki yön pending request'i temizler (idempotent)
 */
router.post("/remove-request", express.json(), async (req, res) => {
  try {
    const body = req.body || {};
    const a = String(body.userId ?? body.a ?? "").trim();
    const b = String(body.otherUserId ?? body.b ?? "").trim();
    if (!a || !b) return res.status(400).json({ ok: false, error: "REQ" });
    if (a === b)  return res.status(400).json({ ok: false, error: "SELF_NOT_ALLOWED" });

    const m = await loadFriends();
    const before = (m.requests || []).length;

    m.requests = (m.requests || []).filter(r =>
      !((r.from === a && r.to === b) || (r.from === b && r.to === a))
    );

    const changed = m.requests.length !== before;
    await saveFriends(m);

    return res.json({ ok: true, removed: changed });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "FRIEND_REMOVE_REQUEST_FAILED", detail: String(e && (e.message || e)) });
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

    const m           = await loadFriends();
    const usersList   = await loadUsersList();
    const totalsItems = await loadTotalsItems();

    const findUser = (uid) =>
      usersList.find(
        u => String(u.userId || "").trim().toLowerCase() === String(uid || "").trim().toLowerCase()
      ) || {};

    const friends = [];
    for (const l of m.links){
      if (l.a === userId || l.b === userId){
        const other = (l.a === userId) ? l.b : l.a;

        // ✅ BLOCK enforcement
        if (isBlockedEither(m, userId, other)) continue;

        const u = findUser(other);
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

    // ✅ pending listesinden de blocklananları düş
    const pendingIn  = m.requests.filter(r => r.to===userId && !isBlockedEither(m, userId, r.from));
    const pendingOut = m.requests.filter(r => r.from===userId && !isBlockedEither(m, userId, r.to));

    const findName = (uid) => {
      const u = findUser(uid);
      return u.name || uid;
    };

    return res.json({
      ok:true,
      userId,
      friends,
      pendingIn: pendingIn.map(r => ({
        fromUserId: r.from,
        createdAt:  r.createdAt,
        name: findName(r.from)
      })),
      pendingOut: pendingOut.map(r => ({
        toUserId: r.to,
        createdAt: r.createdAt,
        name: findName(r.to)
      }))
    });
  }catch(e){
    return res.status(500).json({ ok:false, error:"FRIEND_LIST_FAILED", detail:String(e && (e.message||e)) });
  }
});

/**
 * GET /api/friends/board/:userId
 * → Kişi + tüm arkadaşları için mini puan tablosu
 * (Me.tsx: FriendRow ile uyumlu)
 */
router.get("/board/:userId", async (req,res)=>{
  try{
    const userId = String(req.params.userId || "").trim();
    if (!userId) return res.status(400).json({ ok:false, error:"USER_REQUIRED" });

    const m           = await loadFriends();
    const usersList   = await loadUsersList();
    const totalsItems = await loadTotalsItems();

    const findUser = (uid) =>
      usersList.find(
        u => String(u.userId || "").trim().toLowerCase() === String(uid || "").trim().toLowerCase()
      ) || {};

    const ids = new Set();
    ids.add(userId);
    for (const l of m.links){
      if (l.a === userId) ids.add(l.b);
      if (l.b === userId) ids.add(l.a);
    }

    // ✅ BLOCK enforcement: board'dan blocklananları çıkar
    const filteredIds = Array.from(ids).filter(uid => !isBlockedEither(m, userId, uid));

    const items = filteredIds.map(uid=>{
      const u = findUser(uid);
      const t = totalsItems.find(x => String(x.userId) === uid) || {};
      return {
        userId: uid,
        name: u.name || uid,
        flag: u.flag || null,
        totalPoints: t.totalPoints || 0
      };
    }).sort((a,b)=> (b.totalPoints||0) - (a.totalPoints||0));

    return res.json({ ok:true, userId, items });
  }catch(e){
    return res.status(500).json({ ok:false, error:"FRIEND_BOARD_FAILED", detail:String(e && (e.message||e)) });
  }
});

/**
 * GET /api/friends/search?q=...&me=...&limit=...
 * - q: userId veya name içinde arama (case-insensitive)
 * - me (opsiyonel): verilirse block + relation flag'leri hesaplanır
 * - limit: default 20, max 50
 */
router.get("/search", async (req, res) => {
  try {
    const q  = String(req.query.q ?? req.query.query ?? req.query.term ?? "").trim();
    const me = String(req.query.me ?? "").trim();
    const limit = clampInt(req.query.limit, 20, 1, 50);

    if (!q) return res.status(400).json({ ok:false, error:"Q_REQUIRED" });

    const ql = q.toLowerCase();

    const usersList   = await loadUsersList();
    const totalsItems = await loadTotalsItems();

    // totals map (hız)
    const totalsByUser = new Map();
    for (const t of totalsItems) {
      const id = String(t?.userId ?? "").trim();
      if (!id) continue;
      totalsByUser.set(id, t);
    }

    const m = await loadFriends();

    // ilişkiler (opsiyonel)
    const friendSet = new Set();
    const pendingInSet = new Set();  // me'nin gelenleri: from
    const pendingOutSet = new Set(); // me'nin gidenleri: to

    if (me) {
      for (const l of (m.links || [])) {
        if (l.a === me) friendSet.add(l.b);
        else if (l.b === me) friendSet.add(l.a);
      }
      for (const r of (m.requests || [])) {
        if (r.to === me) pendingInSet.add(r.from);
        if (r.from === me) pendingOutSet.add(r.to);
      }
    }

    const out = [];
    for (const u of usersList) {
      const uid = String(u.userId || "").trim();
      if (!uid) continue;

      // kendisi
      if (me && uid === me) continue;

      const name = String(u.name || "").trim();

      // match
      const hit =
        uid.toLowerCase().includes(ql) ||
        name.toLowerCase().includes(ql);

      if (!hit) continue;

      // block filtresi (me varsa iki yön; me yoksa hiç filtrelemeyiz)
      let blockedByMe = false;
      let blockedMe   = false;
      if (me) {
        blockedByMe = isBlockedBy(m, me, uid);
        blockedMe   = isBlockedBy(m, uid, me);
        if (blockedByMe || blockedMe) continue;
      }

      const t = totalsByUser.get(uid) || {};
      out.push({
        userId: uid,
        name: name || uid,
        flag: u.flag || null,
        totalPoints: Number(t.totalPoints || 0),

        // relation flags (me varsa)
        isFriend: me ? friendSet.has(uid) : false,
        pendingIn: me ? pendingInSet.has(uid) : false,
        pendingOut: me ? pendingOutSet.has(uid) : false,

        blockedByMe,
        blockedMe,
      });

      if (out.length >= limit) break;
    }

    // default sıralama: totalPoints desc, sonra name
    out.sort((a,b) => {
      if ((b.totalPoints||0) !== (a.totalPoints||0)) return (b.totalPoints||0) - (a.totalPoints||0);
      return String(a.name||"").localeCompare(String(b.name||""), "tr");
    });

    return res.json({ ok:true, q, me: me || null, count: out.length, items: out });
  } catch (e) {
    return res.status(500).json({ ok:false, error:"FRIEND_SEARCH_FAILED", detail:String(e && (e.message||e)) });
  }
});

/**
 * POST /api/friends/block
 * body: { userId, targetUserId }  veya { by, target }
 * - target kayıtlı olmak zorunda değil (any name)
 * - block atınca: requests (iki yön) ve link kaldırılır
 */
router.post("/block", verifyToken, express.json(), async (req,res)=>{
  try{
    const body = req.body || {};
    const by = req.uid;
    const target = String(body.targetUserId ?? body.target ?? "").trim();

    if (!by || !target) return res.status(400).json({ ok:false, error:"REQ" });
    if (by === target)  return res.status(400).json({ ok:false, error:"SELF_NOT_ALLOWED" });

    const m = await loadFriends();
    ensureBlocks(m);

    if (!isBlockedBy(m, by, target)) {
      m.blocks.push({ by, target, createdAt: new Date().toISOString() });
    }

    // temizlik: link + requests kaldır
    const k = pairKey(by, target);
    m.links = (m.links || []).filter(l => pairKey(l.a,l.b) !== k);
    m.requests = (m.requests || []).filter(r =>
      !((r.from===by && r.to===target) || (r.from===target && r.to===by))
    );

    await saveFriends(m);
    return res.json({ ok:true, blocked:true, by, target });

  }catch(e){
    return res.status(500).json({ ok:false, error:"FRIEND_BLOCK_FAILED", detail:String(e && (e.message||e)) });
  }
});

/**
 * POST /api/friends/unblock
 * body: { userId, targetUserId }  veya { by, target }
 */
router.post("/unblock", express.json(), async (req,res)=>{
  try{
    const body = req.body || {};
    const by = String(body.userId ?? body.by ?? "").trim();
    const target = String(body.targetUserId ?? body.target ?? "").trim();

    if (!by || !target) return res.status(400).json({ ok:false, error:"REQ" });

    const m = await loadFriends();
    ensureBlocks(m);

    const before = m.blocks.length;
    m.blocks = m.blocks.filter(x => !(normId(x.by)===by && normId(x.target)===target));
    const changed = m.blocks.length !== before;

    await saveFriends(m);
    return res.json({ ok:true, unblocked: changed, by, target });

  }catch(e){
    return res.status(500).json({ ok:false, error:"FRIEND_UNBLOCK_FAILED", detail:String(e && (e.message||e)) });
  }
});

/**
 * GET /api/friends/blocks/:userId
 * - benim blockladıklarım
 */
router.get("/blocks/:userId", async (req,res)=>{
  try{
    const userId = String(req.params.userId||"").trim();
    if (!userId) return res.status(400).json({ ok:false, error:"USER_REQUIRED" });

    const m = await loadFriends();
    ensureBlocks(m);

    const items = m.blocks.filter(x => normId(x.by) === userId);
    return res.json({ ok:true, userId, count: items.length, items });

  }catch(e){
    return res.status(500).json({ ok:false, error:"FRIEND_BLOCKS_FAILED", detail:String(e && (e.message||e)) });
  }
});

// ─── DAVET SİSTEMİ ───────────────────────────────────────────────────────────
const crypto = require("crypto");
const WALLET_FILE = path.join(DATA, "lc-wallet.json");
const INVITE_REWARD = 15; // her ikisine de verilecek LC

async function loadWallet() {
  const w = await readJson(WALLET_FILE, { users: [], ledger: [] });
  if (!Array.isArray(w.users)) w.users = [];
  if (!Array.isArray(w.ledger)) w.ledger = [];
  return w;
}

async function addLc(wallet, userId, amount, reason, meta = {}) {
  let u = wallet.users.find((x) => String(x.userId).toLowerCase() === userId.toLowerCase());
  if (!u) {
    u = { userId, balance: 0, totalEarned: 0, totalSpent: 0, createdAt: new Date().toISOString() };
    wallet.users.push(u);
  }
  u.balance = Number(u.balance || 0) + amount;
  u.totalEarned = Number(u.totalEarned || 0) + amount;
  u.updatedAt = new Date().toISOString();
  wallet.ledger.push({
    id: "tx_" + Date.now().toString(36) + "_" + crypto.randomBytes(2).toString("hex"),
    userId, kind: "reward", amount, reason, meta, createdAt: new Date().toISOString(),
  });
}

async function getUsersData() {
  const raw = await readJson(USERS, { items: [] });
  const items = Array.isArray(raw) ? raw : (raw.items || raw.users || []);
  return { raw, items };
}

function saveUsersData(raw, items) {
  const out = Array.isArray(raw) ? items : { ...raw, items };
  return writeJson(USERS, out);
}

/**
 * GET /api/friends/invite-code?userId=
 * Kullanıcının davet kodunu döner (yoksa oluşturur).
 */
router.get("/invite-code", async (req, res) => {
  try {
    const userId = normId(req.query.userId);
    if (!userId) return res.status(400).json({ ok: false, error: "USER_REQUIRED" });

    const { raw, items } = await getUsersData();
    let user = items.find((u) => normLower(u.userId) === normLower(userId));
    if (!user) {
      user = { userId, createdAt: new Date().toISOString() };
      items.push(user);
    }
    if (!user.inviteCode) {
      const alpha = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      const existing = new Set(items.map((u) => u.inviteCode).filter(Boolean));
      let code = "";
      for (let t = 0; t < 50; t++) {
        code = Array.from({ length: 6 }, () => alpha[crypto.randomInt(alpha.length)]).join("");
        if (!existing.has(code)) break;
      }
      user.inviteCode = code;
      await saveUsersData(raw, items);
    }

    return res.json({ ok: true, userId, inviteCode: user.inviteCode, reward: INVITE_REWARD });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "INVITE_CODE_FAILED", detail: String(e?.message || e) });
  }
});

/**
 * POST /api/friends/use-invite  { userId, code }
 * Kodu kullanan kişi + kodu veren kişi arkadaş olur, ikisi de LC kazanır.
 */
router.post("/use-invite", verifyToken, express.json(), async (req, res) => {
  try {
    const userId = req.uid;
    const code = String(req.body?.code || "").trim().toUpperCase();
    if (!userId || !code) return res.status(400).json({ ok: false, error: "USER_AND_CODE_REQUIRED" });

    const { raw, items } = await getUsersData();
    const owner = items.find((u) => String(u.inviteCode || "").toUpperCase() === code);
    if (!owner) return res.status(404).json({ ok: false, error: "INVALID_CODE" });

    const ownerId = String(owner.userId);
    if (normLower(ownerId) === normLower(userId)) {
      return res.status(400).json({ ok: false, error: "CANNOT_USE_OWN_CODE" });
    }

    // Zaten arkadaş mı?
    const m = await loadFriends();
    if (m.links.some((l) =>
      (normLower(l.a) === normLower(userId) && normLower(l.b) === normLower(ownerId)) ||
      (normLower(l.a) === normLower(ownerId) && normLower(l.b) === normLower(userId))
    )) {
      return res.json({ ok: true, already: true, ownerId, message: "Zaten arkadaşsınız." });
    }

    // Arkadaşlık kur
    m.links.push({ a: ownerId, b: userId, createdAt: new Date().toISOString(), via: "invite_code" });
    // Bekleyen istek varsa temizle
    m.requests = (m.requests || []).filter((r) =>
      !(normLower(r.from) === normLower(userId) && normLower(r.to) === normLower(ownerId)) &&
      !(normLower(r.from) === normLower(ownerId) && normLower(r.to) === normLower(userId))
    );
    await writeJson(FRIENDS, m);

    // LC ödülü — ikisine de
    if (INVITE_REWARD > 0) {
      const wallet = await loadWallet();
      await addLc(wallet, ownerId, INVITE_REWARD, "invite_referral", { invitedUserId: userId });
      await addLc(wallet, userId, INVITE_REWARD, "invite_welcome", { referrerId: ownerId });
      wallet.updatedAt = new Date().toISOString();
      await writeJson(WALLET_FILE, wallet);
    }

    return res.json({
      ok: true,
      ownerId,
      message: `${ownerId} ile arkadaş oldunuz! İkiniz de +${INVITE_REWARD} LC kazandı. 🎉`,
      reward: INVITE_REWARD,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "USE_INVITE_FAILED", detail: String(e?.message || e) });
  }
});

module.exports = router;
