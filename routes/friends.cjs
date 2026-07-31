"use strict";

const express = require("express");
const router  = express.Router();
const fs      = require("fs");
const fsp     = fs.promises;
const path    = require("path");

const DATA    = path.join(__dirname,"..","data");
// users.json yalnızca ARKADAŞ LİSTESİ isimleri için okunuyor (aşağıdaki
// normalize edici). Profil verisi ve davet kodları lib/users-store.cjs
// üzerinden gider — orası Mongo varsa Mongo'yu kullanır.
const SeasonTotals = require("../lib/season-totals.cjs");
const SocialStore = require("../lib/social-store.cjs");
const WalletCredit = require("../lib/wallet-credit.cjs");
const DavetOdul = require("../lib/davet-odul-store.cjs");
const { verifyToken } = require("../middleware/verifyToken.cjs");
const { kimlikVeyaHata } = require("../lib/kimlik-kontrol.cjs");
const UsersStore = require("../lib/users-store.cjs");
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

// Arkadaşlıklar Mongo birincil — bkz. lib/social-store.cjs. Dosyada
// tutulurken Render'da her deploy siliyordu ve arkadaş listesi hiçbir
// kaynaktan geri gelmiyordu.
async function loadFriends(db){
  const m = await SocialStore.loadFriends(db || null);
  ensureBlocks(m);
  return m;
}

// iki kullanıcı arasındaki arkadaşlık için canonical key
function pairKey(a,b){
  const x = String(a||"");
  const y = String(b||"");
  return [x,y].sort().join("::");
}

// loadUsersList() kaldırıldı: tüm kullanıcı dosyasını belleğe alıyordu.
// Arkadaş listesi artık yalnızca ilgili kimlikleri (getUsersByIdsLower),
// arama ise sınırlı sorgu (searchUsers) kullanıyor.

// Sezon toplamları Mongo öncelikli: totals.json Render'da her deploy'da
// siliniyor ve settle2 artık season_totals'a yazıyor. bkz. lib/season-totals.cjs
async function loadTotalsItems(db) {
  const totals = await SeasonTotals.loadTotals(db || null);
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

    // Hedefli sorgu — eskiden yalnızca iki kimliğin varlığını doğrulamak için
    // tüm kullanıcı listesi yükleniyordu.
    const varMi = await UsersStore.getUsersByIdsLower(
      [from, to],
      req.app?.locals?.db || null
    );
    const hasFrom = !!varMi[from.toLowerCase()];
    const hasTo   = !!varMi[to.toLowerCase()];

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
      // Atomik: iki ayrı belge işlemi; tüm dosya yeniden yazılmıyor.
      await SocialStore.removeRequest(to, from, req.app?.locals?.db || null);
      await SocialStore.addLink(from, to, req.app?.locals?.db || null);
      return res.json({ ok:true, matched:true });
    }

    // aynı tarafa ait mevcut pending var mı?
    const alreadyReq = m.requests.find(r => r.from===from && r.to===to);
    if (!alreadyReq){
      // addRequest idempotent (yönlü anahtar benzersiz) — yarışta çift kayıt olmaz.
      await SocialStore.addRequest(from, to, req.app?.locals?.db || null);
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
    await SocialStore.removeRequest(from, me, req.app?.locals?.db || null);
    await SocialStore.addLink(me, from, req.app?.locals?.db || null);
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
    const changed = m.requests.some(r => r.from===from && r.to===me);
    if (changed) await SocialStore.removeRequest(from, me, req.app?.locals?.db || null);
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

    const changed = (m.links || []).some(l => pairKey(l.a, l.b) === k);
    if (changed) await SocialStore.removeLink(a, b, req.app?.locals?.db || null);
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

    const changed = (m.requests || []).some(r => r.from === from && r.to === to);
    if (changed) await SocialStore.removeRequest(from, to, req.app?.locals?.db || null);
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
// ⚠️ KİMLİK GÖVDEDEN ALINMIYOR ARTIK. Bu uç kimlik doğrulamasızdı ve
// `userId` gövdeden geliyordu — yani herkes BAŞKASININ adına işlem
// yapabiliyordu. Yetki denetimim bunu kaçırmıştı (kalıbım
// `express.json()` gibi parantezli ara katmanlarda eşleşmiyordu).
router.post("/remove-request", verifyToken, express.json(), async (req, res) => {
  try {
    const body = req.body || {};
    const a = String(req.uid || "").trim();
    const b = String(body.otherUserId ?? body.b ?? "").trim();
    if (!a || !b) return res.status(400).json({ ok: false, error: "REQ" });
    if (a === b)  return res.status(400).json({ ok: false, error: "SELF_NOT_ALLOWED" });

    const m = await loadFriends();
    const changed = (m.requests || []).some(r =>
      (r.from === a && r.to === b) || (r.from === b && r.to === a)
    );
    // ciftYonlu: iki yönü tek çağrıda siler.
    if (changed) await SocialStore.removeRequest(a, b, req.app?.locals?.db || null, true);

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
    const totalsItems = await loadTotalsItems(req.app?.locals?.db || null);

    // Yalnızca bu kullanıcının arkadaşları çekilir — eskiden tüm kullanıcı
    // listesi yüklenip her isim için doğrusal aranıyordu.
    const iliskiliIds = [];
    for (const l of m.links) {
      if (l.a === userId) iliskiliIds.push(l.b);
      else if (l.b === userId) iliskiliIds.push(l.a);
    }
    const usersMap = await UsersStore.getUsersByIdsLower(
      iliskiliIds,
      req.app?.locals?.db || null
    );
    const findUser = (uid) => usersMap[String(uid || "").trim().toLowerCase()] || {};

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
    const totalsItems = await loadTotalsItems(req.app?.locals?.db || null);

    const ids = new Set();
    ids.add(userId);
    for (const l of m.links){
      if (l.a === userId) ids.add(l.b);
      if (l.b === userId) ids.add(l.a);
    }

    // Yalnızca tablodaki kimlikler çekilir — eskiden tüm kullanıcı listesi
    // yüklenip her satır için doğrusal aranıyordu.
    const usersMap = await UsersStore.getUsersByIdsLower(
      Array.from(ids),
      req.app?.locals?.db || null
    );
    const findUser = (uid) => usersMap[String(uid || "").trim().toLowerCase()] || {};

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

    // Depoda arama — eskiden TÜM kullanıcılar belleğe alınıp JS'te süzülüyordu.
    // Sonuç sayısı sınırlı; aşağıdaki döngü ayrıca engelli/kendisi elemesi
    // yaptığı için biraz fazlasını çekiyoruz.
    const usersList = await UsersStore.searchUsers(
      q,
      Math.min(50, limit * 3),
      req.app?.locals?.db || null
    );
    const totalsItems = await loadTotalsItems(req.app?.locals?.db || null);

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

    // Üç atomik işlem. Sıra önemli: önce engel yazılır, sonra temizlik —
    // araya sıkışan bir istek de engelden SONRA gelmiş olur ve reddedilir.
    await SocialStore.addBlock(by, target, req.app?.locals?.db || null);
    await SocialStore.removeLink(by, target, req.app?.locals?.db || null);
    await SocialStore.removeRequest(by, target, req.app?.locals?.db || null, true);
    return res.json({ ok:true, blocked:true, by, target });

  }catch(e){
    return res.status(500).json({ ok:false, error:"FRIEND_BLOCK_FAILED", detail:String(e && (e.message||e)) });
  }
});

/**
 * POST /api/friends/unblock
 * body: { userId, targetUserId }  veya { by, target }
 */
// ⚠️ EN CİDDİSİ: kimlik gövdeden geldiği için ENGELLENEN KİŞİ kendini
// başkasının engel listesinden çıkarabiliyordu. Engelleme bir güvenlik
// aracı; onu hedefin kaldırabilmesi aracı işlevsiz kılar.
router.post("/unblock", verifyToken, express.json(), async (req,res)=>{
  try{
    const body = req.body || {};
    const by = String(req.uid || "").trim();
    const target = String(body.targetUserId ?? body.target ?? "").trim();

    if (!by || !target) return res.status(400).json({ ok:false, error:"REQ" });

    const m = await loadFriends();
    ensureBlocks(m);

    const changed = m.blocks.some(x => normId(x.by)===by && normId(x.target)===target);
    if (changed) await SocialStore.removeBlock(by, target, req.app?.locals?.db || null);
    return res.json({ ok:true, unblocked: changed, by, target });

  }catch(e){
    return res.status(500).json({ ok:false, error:"FRIEND_UNBLOCK_FAILED", detail:String(e && (e.message||e)) });
  }
});

/**
 * GET /api/friends/blocks/:userId
 * - benim blockladıklarım
 */
/**
 * GET /api/friends/blocks/:userId — YALNIZCA KENDİ engel listesi.
 *
 * ⚠️ KİMLİK DENETİMİ YOKTU: herkes herkesin engel listesini okuyabiliyordu.
 * Bu sıradan bir mahremiyet sızıntısı değil — taciz eden biri kurbanın kimleri
 * engellediğini ve kendisinin engellenip engellenmediğini öğrenebiliyordu.
 * Engellendiğini öğrenmek tırmandırmayı tetikleyen bilgidir.
 */
router.get("/blocks/:userId", verifyToken, async (req,res)=>{
  try{
    const _k = kimlikVeyaHata(req, res, req.params.userId);
    if (!_k) return;
    const userId = _k.uid;
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
const INVITE_REWARD = 15; // her ikisine de verilecek LC
/** Bir kullanicinin ODULLENDIRILEN davet sayisi ust siniri.
 *  Veren tarafta dogal sinir YOK: kod herkese acik paylasilabilir. */
const INVITE_ODUL_LIMIT = Number(process.env.SKORLIG_INVITE_ODUL_LIMIT || 10);



// getUsersData/saveUsersData kaldırıldı: davet kodları artık
// lib/users-store.cjs üzerinden okunup yazılıyor. Eski hâlinde bu dosya
// users.json'a DOĞRUDAN yazan ikinci bir yazardı; profil verisi Mongo'ya
// taşındıktan sonra iki kaynak ayrışır, kod aramaları tam tarama yapardı.

/**
 * GET /api/friends/invite-code?userId=
 * Kullanıcının davet kodunu döner (yoksa oluşturur).
 */
router.get("/invite-code", verifyToken, async (req, res) => {
  try {
    // ⚠️ SAHIPLİK: kimlik sorgudan geliyordu; denetim yoktu.
    // bkz. lib/kimlik-kontrol.cjs
    const _k = kimlikVeyaHata(req, res, req.query.userId);
    if (!_k) return;
    const userId = _k.uid;

    const db = req.app?.locals?.db || null;
    let user = await UsersStore.getUser(userId, db);

    if (!user?.inviteCode) {
      // Çakışma kontrolü indeksli sorguyla — eskiden TÜM kullanıcıların
      // kodları belleğe alınıp Set kuruluyordu.
      const alpha = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      let code = "";
      for (let t = 0; t < 50; t++) {
        code = Array.from({ length: 6 }, () => alpha[crypto.randomInt(alpha.length)]).join("");
        if (!(await UsersStore.isInviteCodeTaken(code, db))) break;
      }
      user = await UsersStore.updateUser(
        userId,
        { inviteCode: code },
        { mainTeam: null, lc: 0, lcLastDaily: null },
        db
      );
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

    // İndeksli kod araması — eskiden tüm kullanıcılar taranıyordu.
    const owner = await UsersStore.findByInviteCode(code, req.app?.locals?.db || null);
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

    /* ⚠️ ENGELLEME DENETİMİ — BU UÇTA YOKTU.
     *
     * Davet kodu doğrudan arkadaşlık KURUYOR. Kontrol olmadığı için
     * engellenen biri, engelleyenin kodunu kullanarak arkadaş olabiliyordu —
     * engelin tamamını atlayarak. Üstelik ikisine de LC yatıyordu, yani
     * engelleyen kişi istemediği bir arkadaşlığı bildirimle birlikte alıyordu.
     *
     * Kodlar PAYLAŞILMAK İÇİN ÜRETİLİYOR: engellenen kişi kodu ortak bir
     * arkadaştan ya da paylaşılmış bir gönderiden alabilir. Saldırı kuramsal değil.
     *
     * Yanıt `/request` ile AYNI (403 BLOCKED) — bu uçta farklı davranmak
     * engelin varlığını dolaylı olarak sızdırırdı. */
    if (isBlockedEither(m, userId, ownerId)) {
      return res.status(403).json({ ok: false, error: "BLOCKED" });
    }

    // Arkadaşlık kur
    await SocialStore.addLink(ownerId, userId, req.app?.locals?.db || null);
    // Bekleyen istek varsa temizle (iki yön)
    await SocialStore.removeRequest(userId, ownerId, req.app?.locals?.db || null, true);

    // LC ödülü — ikisine de
    /* UYARI: ODUL DOSYAYA YAZILIYORDU, KIMSE OKUMUYORDU.
     *
     * Eski kod `addLc(wallet, ...)` kullaniyordu: bellekteki nesneyi degistirip
     * `lc-wallet.json`a yaziyor, Mongo'ya HIC dokunmuyordu. Oysa bakiye
     * `lc_wallet_users` koleksiyonundan okunuyor. Sonuc: kullaniciya
     * "Ikiniz de +15 LC kazandi" deniyordu ama bakiyesi degismiyordu.
     *
     * Ayni sinif hata tr-lig'de de bulunmustu (routes/tr-league.cjs
     * awardWeeklyLc notu: "odul kimsenin okumadigi dosyaya dusuyor").
     *
     * UYARI: SINIR OLMADAN DUZELTMEK DAHA KOTU OLURDU. Odul calisir hale
     * gelince davet kodu SINIRSIZ bir LC muslugu olurdu: kodunu herkese acik
     * paylasan biri her kullanimda 15 LC bastirir (acilis bakiyesi 30 LC).
     * Kullanan tarafta dogal sinir var (bir kisi bir kez arkadas olur), veren
     * tarafta yoktu. Odullendirilen davet sayisi DEFTERDEN sayiliyor; ayri bir
     * sayac alani cuzdanla ayrisabilecek ikinci bir dogruluk kaynagi olurdu. */
    let odulVerildi = false;
    if (INVITE_REWARD > 0) {
      const dbW = req.app?.locals?.db || null;
      let kotaDoldu = true;
      if (dbW) {
        try {
          const oncekiler = await dbW.collection("lc_wallet_ledger").countDocuments({
            userIdLower: normLower(ownerId),
            reason: "invite_referral",
          });
          kotaDoldu = oncekiler >= INVITE_ODUL_LIMIT;
        } catch (e) {
          // Sayilamiyorsa ODUL VERME (fail-closed): ters varsayim, veritabani
          // sorunluyken sinirsiz LC basmak olurdu.
          console.error("[friends] davet kotasi okunamadi, odul atlaniyor:", e?.message || e);
        }
      }

      /* UYARI: MUHUR ODEMEDEN ONCE. "Zaten arkadas misiniz" kontrolu ATOMIK
       * DEGIL: iki eszamanli istek ikisi de "degiller" gorur, ikisi de odul
       * oder (30 yerine 60 LC). `addLink` bunu cozemez, HER ZAMAN true doner.
       * bkz. lib/davet-odul-store.cjs */
      const muhur = !kotaDoldu && (await DavetOdul.odulMuhurle(userId, dbW));

      if (muhur) {
        /* UYARI: DAVETLININ CUZDANI ONCE KURULUR.
         *
         * Davet linkiyle gelen kullanici uygulamayi ILK kez aciyor olabilir ve
         * `applyPendingRef` acilista bu ucu cagiriyor. `creditLc` cuzdani
         * yalnizca KREDI TUTARIYLA yaratiyor; acilis bakiyesini veren yollar
         * ise "belge var mi" diye bakip atliyor. Olculdu: davetli 45 yerine
         * 15 LC ile basliyordu — davet ozelliginin GETIRDIGI kullanici.
         * bkz. lib/wallet-credit.cjs cuzdanKur */
        await WalletCredit.cuzdanKur(dbW, userId);
        await WalletCredit.cuzdanKur(dbW, ownerId);

        const a = await WalletCredit.creditLc(dbW, ownerId, INVITE_REWARD, "invite_referral", { invitedUserId: userId });
        const b = await WalletCredit.creditLc(dbW, userId, INVITE_REWARD, "invite_welcome", { referrerId: ownerId });
        odulVerildi = !!(a && b);
        if (!odulVerildi) {
          console.error(`[friends] DAVET ODULU EKSIK odendi owner=${ownerId} davetli=${userId}`);
          /* ⚠️ MÜHÜR ZATEN ATILDI (`odulMuhurle` yukarıda) — bu ödül BİR DAHA
           * denenmez. Eskiden tek iz bu log satırıydı; Render'da akıp gider ve
           * `GET /api/health` sayacı 0 kalır, yani operatör borcu göremezdi. */
          const eksik = [];
          if (!a) eksik.push({ userIdLower: normLower(ownerId), tutar: INVITE_REWARD, rol: "davet_eden" });
          if (!b) eksik.push({ userIdLower: normLower(userId), tutar: INVITE_REWARD, rol: "davetli" });
          await WalletCredit.kayipOdulKaydet(dbW, {
            kaynak: "invite_referral",
            ownerId, invitedUserId: userId,
            odemeler: eksik, beklenen: 2, eksik: eksik.length,
          });
        }
      }
    }

    return res.json({
      ok: true,
      ownerId,
      odulVerildi,
      message: odulVerildi
        ? `${ownerId} ile arkadaş oldunuz! İkiniz de +${INVITE_REWARD} LC kazandı. 🎉`
        : `${ownerId} ile arkadaş oldunuz!`,
      reward: odulVerildi ? INVITE_REWARD : 0,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "USE_INVITE_FAILED", detail: String(e?.message || e) });
  }
});

module.exports = router;
