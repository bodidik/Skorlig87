"use strict";

const express = require("express");
const router  = express.Router();
const fs      = require("fs");
const fsp     = fs.promises;
const path    = require("path");

const DATA   = path.join(__dirname,"..","data");

function requireAdminToken(req, res, next) {
  const token = String(process.env.SKORLIG_ADMIN_TOKEN || "").trim();
  if (!token) return res.status(503).json({ ok: false, error: "ADMIN_TOKEN_NOT_CONFIGURED" });
  const got = String(req.headers["x-admin-token"] || "").trim() || String(req.query.token || "").trim();
  if (got && got === token) return next();
  return res.status(401).json({ ok: false, error: "ADMIN_TOKEN_REQUIRED" });
}
// Gruplar Mongo birincil — bkz. lib/social-store.cjs. Dosyada tutulurken
// Render'da her deploy siliyordu; kullanıcının kurduğu grup ve üyelikler
// hiçbir kaynaktan geri gelmiyordu.
const SocialStore = require("../lib/social-store.cjs");  // { CODE: { name, ownerId, members:[userId], opts:{ userId:{ includeInTotal } } } }
const UsersStore = require("../lib/users-store.cjs");
const TOTALS = path.join(DATA,"totals.json");  // { items: [ { userId, totalPoints, ...}, ... ], updatedAt }
const SeasonTotals = require("../lib/season-totals.cjs");



/* =========================
   HANDLERS (tek gerçek)
   ========================= */

async function handleCreate(req,res){
  try{
    const { name, ownerId } = req.body || {};
    if (!name || !ownerId) {
      return res.status(400).json({ ok:false, error:"NAME_OWNER_REQUIRED" });
    }

    // Atomik: kod çakışmasına benzersiz indeks karar verir. Eski
    // `do{code=code6()}while(store[code])` kendisi yarışlıydı — iki eşzamanlı
    // kurulum aynı kodu boş görüp ikisi de alabilirdi.
    const { code, group } = await SocialStore.createGroup(
      { name, ownerId },
      req.app?.locals?.db || null
    );
    res.json({ ok:true, code, group });
  }catch(e){
    res.status(500).json({ ok:false, error:"GROUP_CREATE_FAILED", detail:String(e && (e.message||e)) });
  }
}

async function handleJoin(req,res){
  try{
    const { code, userId } = req.body || {};
    const uid = String(userId||"").trim();
    if (!uid) return res.status(400).json({ ok:false, error:"USER_REQUIRED" });

    // Atomik: $addToSet hem yarışı hem mükerrer üyeliği kendisi engelliyor.
    const g = await SocialStore.joinGroup(code, uid, req.app?.locals?.db || null);
    if (!g) return res.status(404).json({ ok:false, error:"GROUP_NOT_FOUND" });
    res.json({ ok:true, group:{ code:String(code||"").toUpperCase(), name:g.name, size:g.members.length } });
  }catch(e){
    res.status(500).json({ ok:false, error:"GROUP_JOIN_FAILED", detail:String(e && (e.message||e)) });
  }
}

async function handleBoard(req,res){
  try{
    const code = String(req.params.code || "").toUpperCase();
    const store  = await SocialStore.loadGroups(req.app?.locals?.db || null);
    // Sezon toplamları Mongo öncelikli: totals.json Render'da her deploy'da
    // siliniyor ve settle2 artık season_totals'a yazıyor. bkz. lib/season-totals.cjs
    const totals = await SeasonTotals.loadTotals(req.app?.locals?.db || null);

    const g = store[code];
    if (!g) return res.status(404).json({ ok:false, error:"GROUP_NOT_FOUND" });

    // Yalnızca grubun ÜYELERİ çekilir — eskiden tüm kullanıcı dosyası
    // yükleniyordu (20 kişilik tablo için 500.000 kaydın tamamı).
    const users = await UsersStore.getUsersByIds(
      g.members || [],
      req.app?.locals?.db || null
    );

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

    // Atomik: nokta yolu ile yalnızca bu üyenin seçeneği yazılır, tüm
    // grup belgesi yeniden yazılmaz — başka üyenin eşzamanlı değişikliği
    // ezilmez.
    const oldu = await SocialStore.setGroupOpt(
      code, userId, includeInTotal, req.app?.locals?.db || null
    );
    if (!oldu) return res.status(404).json({ ok:false, error:"GROUP_NOT_FOUND" });
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
router.get("/diag", requireAdminToken, async (req,res)=>{
  try{
    const store = await SocialStore.loadGroups(req.app?.locals?.db || null);
    const codes = Object.keys(store);
    res.json({ ok:true, codes, groups: store });
  }catch(e){
    res.status(500).json({ ok:false, error:"GROUP_DIAG_FAILED", detail:String(e && (e.message||e)) });
  }
});

module.exports = router;
