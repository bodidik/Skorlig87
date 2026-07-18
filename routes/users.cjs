"use strict";

const express = require("express");
const router  = express.Router();
const fs      = require("fs");
const fsp     = fs.promises;
const path    = require("path");
const crypto  = require("crypto");
const { verifyToken } = require("../middleware/verifyToken.cjs");

function requireAdminToken(req, res, next) {
  const token = String(process.env.SKORLIG_ADMIN_TOKEN || "").trim();
  if (!token) return res.status(503).json({ ok: false, error: "ADMIN_TOKEN_NOT_CONFIGURED" });
  const got = String(req.headers["x-admin-token"] || "").trim() || String(req.query.token || "").trim();
  if (got && got === token) return next();
  return res.status(401).json({ ok: false, error: "ADMIN_TOKEN_REQUIRED" });
}

const DATA_DIR     = path.join(__dirname, "..", "data");
const USERS_FILE   = path.join(DATA_DIR, "users.json");
const GROUPS_FILE  = path.join(DATA_DIR, "groups.json");
const TOTALS_FILE  = path.join(DATA_DIR, "totals.json");

// 🔹 LigCoin başlangıç değeri (pred/settle2 ile uyumlu olmalı)
const LC_START = 30;

async function readJson(file, fb) {
  try { return JSON.parse(await fsp.readFile(file, "utf8")); }
  catch { return fb; }
}
async function writeJson(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(data, null, 2), "utf8");
}

// atomic write (tek process için yeterli stabilite)
async function writeJsonAtomic(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fsp.rename(tmp, file);
}

async function ensureUser(userId) {
  const uid = String(userId || "").trim();
  if (!uid) throw new Error("USER_REQUIRED");

  const data  = await readJson(USERS_FILE, { items: [] });
  const items = Array.isArray(data.items) ? data.items : [];

  let u = items.find(x => String(x.userId) === uid);
  const nowISO = new Date().toISOString();
  let changed = false;

  if (!u) {
    // yeni kullanıcı: mainTeam yok, LC başlat
    u = {
      userId: uid,
      mainTeam: null,
      createdAt: nowISO,
      lc: LC_START,
      lcLastDaily: null,
    };
    items.push(u);
    changed = true;
  } else {
    // eski kayıtlara LC sütununu ekle
    if (typeof u.lc !== "number") {
      u.lc = LC_START;
      changed = true;
    }
    if (!Object.prototype.hasOwnProperty.call(u, "lcLastDaily")) {
      u.lcLastDaily = null;
      changed = true;
    }
  }

  if (changed) {
    await writeJson(USERS_FILE, { items });
  }
  return u;
}

/* =========================================================
   GROUPS compat layer (users.cjs <-> routes/groups.cjs uyumu)
   =========================================================
   Tek hedef model (source of truth): Map format

   groups.json (Map):
   {
     "ABC123": { name, ownerId, members:[userId], opts:{ userId:{ includeInTotal } }, createdAt }
   }

   Legacy destek:
   { items:[ { id, ownerId, name, members, createdAt, ... } ] }  -> ilk load'da migrate edilir
*/

function code6() {
  return crypto.randomBytes(4).toString("base64url").slice(0, 6).toUpperCase();
}
function normCode(code) {
  return String(code || "").trim().toUpperCase();
}
function normUserId(userId) {
  return String(userId || "").trim();
}

async function loadGroupsStoreCompat() {
  const raw = await readJson(GROUPS_FILE, null);

  // 1) Map format (ideal)
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    // 2) Legacy wrapper: {items:[...]} -> migrate to map
    if (Array.isArray(raw.items)) {
      const map = {};
      for (const g of raw.items) {
        if (!g || typeof g !== "object") continue;

        const ownerId = normUserId(g.ownerId);
        const name    = String(g.name || "").trim();
        if (!ownerId || !name) continue;

        const membersRaw = Array.isArray(g.members) ? g.members : [];
        const members = membersRaw.map((x) => normUserId(x)).filter(Boolean);

        let code = normCode(g.code || "");
        if (!code) code = code6();
        while (map[code]) code = code6();

        map[code] = {
          name,
          ownerId,
          members: members.includes(ownerId) ? members : [ownerId, ...members],
          opts: (g.opts && typeof g.opts === "object") ? g.opts : {},
          createdAt: g.createdAt || null,
          legacyId: g.id || null,
        };
      }
      await writeJsonAtomic(GROUPS_FILE, map);
      return map;
    }

    // raw zaten map gibi; ama içeriği guardlayalım
    return raw;
  }

  // yoksa boş map
  return {};
}

async function saveGroupsStore(store) {
  await writeJsonAtomic(GROUPS_FILE, store || {});
}

function groupSummary(code, g) {
  const members = Array.isArray(g?.members) ? g.members : [];
  return {
    code,
    name: g?.name || null,
    ownerId: g?.ownerId || null,
    members,
    size: members.length,
    createdAt: g?.createdAt || null,
  };
}

// users.json’u her formattan map’e normalize et (groups.cjs ile aynı yaklaşım)
async function loadUsersMap() {
  const raw = await readJson(USERS_FILE, {});
  const map = {};

  const push = (u, forcedId) => {
    if (!u || typeof u !== "object") return;
    const id = normUserId(forcedId || u.userId || u.id);
    if (!id) return;
    if (!map[id]) map[id] = { ...u, userId: id };
  };

  if (Array.isArray(raw.items)) raw.items.forEach((u) => push(u));
  if (Array.isArray(raw.users)) raw.users.forEach((u) => push(u));

  // map format { userId: {...} }
  if (!Array.isArray(raw.items) && !Array.isArray(raw.users)) {
    for (const [id, u] of Object.entries(raw || {})) push(u, id);
  }

  return map;
}

async function loadTotalsItems() {
  const totals = await readJson(TOTALS_FILE, { items: [] });
  return Array.isArray(totals.items) ? totals.items : [];
}

/* =========================
   USERS ENDPOINTS
   ========================= */

// GET /api/users/profile?userId=...
router.get("/profile", async (req, res) => {
  try {
    const userId = String(req.query.userId || "").trim();
    if (!userId) return res.status(400).json({ ok: false, error: "USER_REQUIRED" });

    const u = await ensureUser(userId);
    const profile = {
      userId,
      mainTeam: u.mainTeam || null,
      country: u.country || null, // kullanıcının "yereli": maç listesi buna göre kişiselleşir
      // totals: gerçek toplam puan için /api/rt/totals kullanıyoruz;
      totals: Number(u.totals || 0),
      // LigCoin
      lc: typeof u.lc === "number" ? u.lc : null,
    };

    return res.json({ ok: true, profile });
  } catch (e) {
    console.error("USER_PROFILE_ERR", e);
    return res.status(500).json({
      ok: false,
      error: "USER_PROFILE_ERR",
      detail: String(e && (e.message || e)),
    });
  }
});

// POST /api/users/set-main-team { team }
router.post("/set-main-team", verifyToken, express.json(), async (req, res) => {
  try {
    const userId = req.uid;
    const team   = String(req.body?.team || "").trim();
    if (!userId || !team) return res.status(400).json({ ok: false, error: "USER_OR_TEAM_MISSING" });

    const data  = await readJson(USERS_FILE, { items: [] });
    const items = Array.isArray(data.items) ? data.items : [];
    const nowISO = new Date().toISOString();

    let u = items.find(x => String(x.userId) === userId);
    if (!u) {
      u = { userId, mainTeam: team, createdAt: nowISO, lc: LC_START, lcLastDaily: null };
      items.push(u);
    } else {
      u.mainTeam = team;
      u.updatedAt = nowISO;
      if (typeof u.lc !== "number") u.lc = LC_START;
      if (!Object.prototype.hasOwnProperty.call(u, "lcLastDaily")) u.lcLastDaily = null;
    }

    await writeJson(USERS_FILE, { items });
    return res.json({ ok: true, userId, mainTeam: team });
  } catch (e) {
    console.error("SET_MAIN_TEAM_ERR", e);
    return res.status(500).json({
      ok: false,
      error: "SET_MAIN_TEAM_ERR",
      detail: String(e && (e.message || e)),
    });
  }
});

// POST /api/users/set-country { country }
// Kullanıcının "yereli": maç listesi bu ülkenin üst ligi + global kupalar olur.
router.post("/set-country", verifyToken, express.json(), async (req, res) => {
  try {
    const userId  = req.uid;
    const rawCountry = String(req.body?.country || "").trim();
    if (!userId || !rawCountry) return res.status(400).json({ ok: false, error: "USER_OR_COUNTRY_MISSING" });

    // Kanonik ada çevir (aksan/encoding farkları eşleşmeyi bozmasın)
    const { canonicalCountry } = require("./live2.cjs");
    const country = canonicalCountry(rawCountry);
    if (!country) return res.status(400).json({ ok: false, error: "COUNTRY_NOT_SUPPORTED", detail: rawCountry });

    const data  = await readJson(USERS_FILE, { items: [] });
    const items = Array.isArray(data.items) ? data.items : [];
    const nowISO = new Date().toISOString();

    let u = items.find(x => String(x.userId) === userId);
    if (!u) {
      u = { userId, mainTeam: null, country, createdAt: nowISO, lc: LC_START, lcLastDaily: null };
      items.push(u);
    } else {
      u.country = country;
      u.updatedAt = nowISO;
    }

    await writeJson(USERS_FILE, { items });
    return res.json({ ok: true, userId, country });
  } catch (e) {
    console.error("SET_COUNTRY_ERR", e);
    return res.status(500).json({
      ok: false,
      error: "SET_COUNTRY_ERR",
      detail: String(e && (e.message || e)),
    });
  }
});

// GET /api/users/favorite?userId=...
router.get("/favorite", async (req, res) => {
  try {
    const userId = String(req.query.userId || "").trim();
    if (!userId) return res.status(400).json({ ok: false, error: "USER_REQUIRED" });

    const data  = await readJson(USERS_FILE, { items: [] });
    const items = Array.isArray(data.items) ? data.items : [];
    const u = items.find(x => String(x.userId) === userId);

    return res.json({ ok: true, favoriteTeam: u?.mainTeam || null });
  } catch (e) {
    console.error("FAVORITE_ERR", e);
    return res.status(500).json({
      ok: false,
      error: "FAVORITE_ERR",
      detail: String(e && (e.message || e)),
    });
  }
});

/* =========================
   USERS → GROUPS (ALIAS)
   Aynı davranış: /api/groups/*
   ========================= */

/**
 * GET /api/users/groups/list?userId=...
 * → /api/groups/list?userId=... ile aynı sonuç hedeflenir (summary list)
 */
router.get("/groups/list", async (req, res) => {
  try {
    const userId = normUserId(req.query.userId);
    if (!userId) return res.status(400).json({ ok: false, error: "USER_REQUIRED" });

    const store = await loadGroupsStoreCompat(); // map
    const items = [];

    for (const [code, g] of Object.entries(store)) {
      if (!g || typeof g !== "object") continue;
      const ownerId = normUserId(g.ownerId);
      const members = Array.isArray(g.members) ? g.members.map(normUserId).filter(Boolean) : [];
      if (ownerId === userId || members.includes(userId)) {
        items.push(groupSummary(code, g));
      }
    }

    return res.json({ ok: true, items });
  } catch (e) {
    console.error("GROUP_LIST_ERR", e);
    return res.status(500).json({ ok: false, error: "GROUP_LIST_ERR", detail: String(e && (e.message || e)) });
  }
});

/**
 * POST /api/users/groups/create
 * body: { name, ownerId }
 * → /api/groups/create ile aynı davranış: { ok:true, code, group }
 */
router.post("/groups/create", verifyToken, express.json(), async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const ownerId = req.uid;
    if (!name || !ownerId) return res.status(400).json({ ok: false, error: "NAME_OWNER_REQUIRED" });

    await ensureUser(ownerId);

    const store = await loadGroupsStoreCompat();
    let code;
    do { code = code6(); } while (store[code]);

    const nowISO = new Date().toISOString();
    store[code] = { name, ownerId, members: [ownerId], opts: {}, createdAt: nowISO };

    await saveGroupsStore(store);
    return res.json({ ok: true, code, group: store[code] });
  } catch (e) {
    console.error("GROUP_CREATE_ERR", e);
    return res.status(500).json({ ok: false, error: "GROUP_CREATE_ERR", detail: String(e && (e.message || e)) });
  }
});

/**
 * POST /api/users/groups/join
 * body: { code, userId }
 * → /api/groups/join ile aynı davranış hedeflenir
 */
router.post("/groups/join", verifyToken, express.json(), async (req, res) => {
  try {
    const code = normCode(req.body?.code);
    const userId = req.uid;
    if (!code) return res.status(400).json({ ok: false, error: "CODE_REQUIRED" });
    if (!userId) return res.status(400).json({ ok: false, error: "USER_REQUIRED" });

    await ensureUser(userId);

    const store = await loadGroupsStoreCompat();
    const g = store[code];
    if (!g) return res.status(404).json({ ok: false, error: "GROUP_NOT_FOUND" });

    g.members = Array.isArray(g.members) ? g.members.map(normUserId).filter(Boolean) : [];
    if (!g.members.includes(userId)) g.members.push(userId);

    await saveGroupsStore(store);
    return res.json({ ok: true, group: { code, name: g.name, size: g.members.length } });
  } catch (e) {
    console.error("GROUP_JOIN_ERR", e);
    return res.status(500).json({ ok: false, error: "GROUP_JOIN_FAILED", detail: String(e && (e.message || e)) });
  }
});

/**
 * GET /api/users/groups/:code/board
 * Grup içi leaderboard (groups.cjs ile aynı mantık)
 */
router.get("/groups/:code/board", async (req, res) => {
  try {
    const code = normCode(req.params.code);
    const store = await loadGroupsStoreCompat();
    const g = store[code];
    if (!g) return res.status(404).json({ ok: false, error: "GROUP_NOT_FOUND" });

    const usersMap = await loadUsersMap();
    const totalsItems = await loadTotalsItems();

    const members = Array.isArray(g.members) ? g.members.map(normUserId).filter(Boolean) : [];
    const itemsTotals = Array.isArray(totalsItems) ? totalsItems : [];

    const items = members.map((uid) => {
      const u = usersMap[uid] || {};
      const t = itemsTotals.find(x => String(x.userId) === String(uid)) || {};
      return {
        userId: uid,
        name: u.name || uid,
        flag: u.flag || null,
        includeInTotal: (g.opts?.[uid]?.includeInTotal ?? u.includeInTotal ?? true),
        points: Number(t.totalPoints || 0),
      };
    }).sort((a,b) => b.points - a.points);

    return res.json({
      ok: true,
      code,
      name: g.name,
      size: members.length,
      items,
    });
  } catch (e) {
    console.error("GROUP_BOARD_ERR", e);
    return res.status(500).json({ ok: false, error: "GROUP_BOARD_FAILED", detail: String(e && (e.message || e)) });
  }
});

/**
 * POST /api/users/groups/:code/opt
 * body: { userId, includeInTotal:boolean }
 */
router.post("/groups/:code/opt", express.json(), async (req, res) => {
  try {
    const code = normCode(req.params.code);
    const userId = normUserId(req.body?.userId);
    const includeInTotal = req.body?.includeInTotal;

    if (!userId || typeof includeInTotal !== "boolean") {
      return res.status(400).json({ ok: false, error: "REQ" });
    }

    const store = await loadGroupsStoreCompat();
    const g = store[code];
    if (!g) return res.status(404).json({ ok: false, error: "GROUP_NOT_FOUND" });

    g.opts = g.opts && typeof g.opts === "object" ? g.opts : {};
    g.opts[userId] = { includeInTotal: !!includeInTotal };

    await saveGroupsStore(store);
    return res.json({ ok: true });
  } catch (e) {
    console.error("GROUP_OPT_ERR", e);
    return res.status(500).json({ ok: false, error: "GROUP_OPT_FAILED", detail: String(e && (e.message || e)) });
  }
});

/**
 * GET /api/users/groups/diag
 * küçük diag (groups.cjs ile benzer)
 */
router.get("/groups/diag", requireAdminToken, async (req, res) => {
  try {
    const store = await loadGroupsStoreCompat();
    const codes = Object.keys(store || {});
    return res.json({ ok: true, codes, groups: store });
  } catch (e) {
    console.error("GROUP_DIAG_ERR", e);
    return res.status(500).json({ ok: false, error: "GROUP_DIAG_FAILED", detail: String(e && (e.message || e)) });
  }
});

/* =========================
   1987 ÖZEL: ÜYE LİSTESİ VE SEZON TABLOSU
   ========================= */

// GET /api/users/1987
router.get("/1987", async (req, res) => {
  try {
    const raw = await readJson(USERS_FILE, { users: [], items: [] });

    const listUsers = [];
    const pushUser = (u) => {
      if (!u) return;
      const id = String(u.userId || u.id || "").trim();
      if (!id) return;
      listUsers.push({ ...u, userId: id });
    };

    if (Array.isArray(raw.users)) raw.users.forEach(pushUser);
    if (Array.isArray(raw.items)) raw.items.forEach(pushUser);

    const byId = new Map();
    for (const u of listUsers) {
      const id = u.userId;
      if (!id) continue;
      if (!byId.has(id)) byId.set(id, u);
    }

    const members = Array.from(byId.values()).filter((u) => {
      const seg = String(u.segment || "").toLowerCase();
      return u && (u.is1987 === true || seg === "1987");
    });

    return res.json({
      ok: true,
      count: members.length,
      users: members.map((u) => ({
        userId: u.userId,
        mainTeam: u.mainTeam || null,
        is1987: !!u.is1987,
        createdAt: u.createdAt || null,
        updatedAt: u.updatedAt || null,
      })),
    });
  } catch (e) {
    console.error("USERS_1987_ERR", e);
    return res.status(500).json({
      ok: false,
      error: "USERS_1987_ERR",
      detail: String(e && (e.message || e)),
    });
  }
});

/* =========================
   USERS → GROUPS ALIAS (compat)
   /api/users/groups/*  ->  /api/groups/*
   ========================= */

// POST /api/users/groups/join  body: { code, userId }
router.post("/groups/join", express.json(), async (req, res) => {
  try {
    const code   = String(req.body?.code || "").trim().toUpperCase();
    const userId = String(req.body?.userId || "").trim();

    if (!code || !userId) {
      return res.status(400).json({ ok: false, error: "CODE_USER_REQUIRED" });
    }

    // groups.json map store
    const store = await readJson(GROUPS_FILE, {});
    const g = store[code];
    if (!g) return res.status(404).json({ ok: false, error: "GROUP_NOT_FOUND" });

    g.members = Array.isArray(g.members) ? g.members.map(String) : [];
    if (!g.members.includes(userId)) g.members.push(userId);

    if (!g.opts || typeof g.opts !== "object") g.opts = {};

    await writeJson(GROUPS_FILE, store);

    return res.json({
      ok: true,
      group: { code, name: g.name || null, size: g.members.length },
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: "GROUP_JOIN_FAILED",
      detail: String(e && (e.message || e)),
    });
  }
});

// GET /api/users/groups/:code/board
router.get("/groups/:code/board", async (req, res) => {
  try {
    const code = String(req.params.code || "").trim().toUpperCase();
    if (!code) return res.status(400).json({ ok: false, error: "CODE_REQUIRED" });

    const store = await readJson(GROUPS_FILE, {});
    const g = store[code];
    if (!g) return res.status(404).json({ ok: false, error: "GROUP_NOT_FOUND" });

    // users.json normalize (users.cjs içinde ensureUser vs var; ama burada sadece isim/flag için okuyoruz)
    const usersRaw = await readJson(USERS_FILE, { users: [], items: [] });
    const usersList = [];
    const pushUser = (u, forcedId) => {
      if (!u) return;
      const id = String(forcedId || u.userId || u.id || "").trim();
      if (!id) return;
      usersList.push({ ...u, userId: id });
    };
    if (Array.isArray(usersRaw.users)) usersRaw.users.forEach((u) => pushUser(u));
    if (Array.isArray(usersRaw.items)) usersRaw.items.forEach((u) => pushUser(u));
    if (!Array.isArray(usersRaw.users) && !Array.isArray(usersRaw.items)) {
      Object.entries(usersRaw || {}).forEach(([id, u]) => {
        if (u && typeof u === "object") pushUser(u, id);
      });
    }

    const totalsRaw = await readJson(TOTALS_FILE, { items: [] });
    const totalsItems = Array.isArray(totalsRaw.items) ? totalsRaw.items : [];

    const findUser = (uid) =>
      usersList.find(
        (u) =>
          String(u.userId || "").trim().toLowerCase() ===
          String(uid || "").trim().toLowerCase()
      ) || {};

    const members = Array.isArray(g.members) ? g.members.map(String) : [];

    const items = members
      .map((uid) => {
        const u = findUser(uid);
        const t = totalsItems.find((x) => String(x.userId) === String(uid)) || {};
        const includeInTotal = (g.opts?.[uid]?.includeInTotal ?? u.includeInTotal ?? true);

        return {
          userId: uid,
          name: u.name || uid,
          flag: u.flag || null,
          includeInTotal,
          points: Number(t.totalPoints || 0),
        };
      })
      .sort((a, b) => b.points - a.points);

    return res.json({
      ok: true,
      code,
      name: g.name || null,
      ownerId: g.ownerId || null,
      size: members.length,
      items,
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: "GROUP_BOARD_FAILED",
      detail: String(e && (e.message || e)),
    });
  }
});

// GET /api/users/1987/season
router.get("/1987/season", async (req, res) => {
  try {
    const usersRaw  = await readJson(USERS_FILE,  { users: [], items: [] });
    const totalsRaw = await readJson(TOTALS_FILE, { items: [] });

    const listUsers = [];
    const pushUser = (u) => {
      if (!u) return;
      const id = String(u.userId || u.id || "").trim();
      if (!id) return;
      listUsers.push({ ...u, userId: id });
    };

    if (Array.isArray(usersRaw.users)) usersRaw.users.forEach(pushUser);
    if (Array.isArray(usersRaw.items)) usersRaw.items.forEach(pushUser);

    const byId = new Map();
    for (const u of listUsers) {
      const id = u.userId;
      if (!id) continue;
      if (!byId.has(id)) byId.set(id, u);
    }

    const totalsItems = Array.isArray(totalsRaw.items) ? totalsRaw.items : [];
    const totalsByUser = new Map();
    for (const t of totalsItems) {
      const id = String(t.userId || "").trim();
      if (!id) continue;
      totalsByUser.set(id, t);
    }

    const rows = [];
    for (const [id, u] of byId.entries()) {
      const seg = String(u.segment || "").toLowerCase();
      const is1987 = (u.is1987 === true || seg === "1987");
      if (!is1987) continue;

      const t = totalsByUser.get(id) || {};
      const totalPoints = Number(t.totalPoints || t.total || 0);
      const matches     = Number(t.matches || t.played || 0);

      rows.push({
        userId: id,
        mainTeam: u.mainTeam || null,
        totalPoints,
        matches,
        lastAt: t.lastAt || null,
      });
    }

    rows.sort((a, b) => {
      if (b.totalPoints !== a.totalPoints) return b.totalPoints - a.totalPoints;
      if (b.matches     !== a.matches)     return b.matches - a.matches;
      return String(b.lastAt || "").localeCompare(String(a.lastAt || ""));
    });

    const season = rows.map((r, idx) => ({ ...r, rank: idx + 1 }));

    return res.json({ ok: true, count: season.length, season });
  } catch (e) {
    console.error("SEASON_1987_ERR", e);
    return res.status(500).json({
      ok: false,
      error: "SEASON_1987_ERR",
      detail: String(e && (e.message || e)),
    });
  }
});


// DELETE /api/users/delete-account
// Kullanıcının tüm verilerini ve Firebase Auth kaydını siler.
router.delete("/delete-account", verifyToken, async (req, res) => {
  const uid = req.uid;
  if (!uid) return res.status(400).json({ ok: false, error: "USER_REQUIRED" });

  const DATA_FILES = {
    users:       path.join(DATA_DIR, "users.json"),
    preds:       path.join(DATA_DIR, "preds.json"),
    leaderboard: path.join(DATA_DIR, "leaderboard.json"),
    wallet:      path.join(DATA_DIR, "lc-wallet.json"),
    friends:     path.join(DATA_DIR, "friends.json"),
    groups:      path.join(DATA_DIR, "groups.json"),
    totals:      path.join(DATA_DIR, "totals.json"),
  };

  async function readJson(file) {
    try { return JSON.parse(await fsp.readFile(file, "utf8")); } catch { return null; }
  }
  async function writeJson(file, data) {
    await fsp.writeFile(file, JSON.stringify(data, null, 2), "utf8");
  }

  try {
    // 1. users.json — kaydı sil
    const users = await readJson(DATA_FILES.users);
    if (Array.isArray(users)) {
      await writeJson(DATA_FILES.users, users.filter(u => String(u.userId || u.id) !== uid));
    } else if (users && typeof users === "object") {
      delete users[uid];
      await writeJson(DATA_FILES.users, users);
    }

    // 2. preds.json — tahminleri sil
    const preds = await readJson(DATA_FILES.preds);
    if (preds && typeof preds === "object") {
      for (const fid of Object.keys(preds)) {
        if (Array.isArray(preds[fid])) {
          preds[fid] = preds[fid].filter(p => String(p.userId || p.uid) !== uid);
        }
      }
      await writeJson(DATA_FILES.preds, preds);
    }

    // 3. leaderboard.json
    const lb = await readJson(DATA_FILES.leaderboard);
    if (Array.isArray(lb)) {
      await writeJson(DATA_FILES.leaderboard, lb.filter(r => String(r.userId || r.uid) !== uid));
    } else if (lb && typeof lb === "object") {
      delete lb[uid];
      await writeJson(DATA_FILES.leaderboard, lb);
    }

    // 4. lc-wallet.json
    const wallet = await readJson(DATA_FILES.wallet);
    if (wallet && typeof wallet === "object") {
      delete wallet[uid];
      await writeJson(DATA_FILES.wallet, wallet);
    }

    // 5. friends.json — tüm arkadaşlık kayıtlarından çıkar
    const friends = await readJson(DATA_FILES.friends);
    if (friends && typeof friends === "object") {
      delete friends[uid];
      for (const k of Object.keys(friends)) {
        const f = friends[k];
        if (f && Array.isArray(f.friends)) f.friends = f.friends.filter(x => x !== uid);
        if (f && Array.isArray(f.pending)) f.pending = f.pending.filter(x => x !== uid);
        if (f && Array.isArray(f.blocked)) f.blocked = f.blocked.filter(x => x !== uid);
      }
      await writeJson(DATA_FILES.friends, friends);
    }

    // 6. groups.json — sahip olduğu grupları sil, üyelikten çıkar
    const groups = await readJson(DATA_FILES.groups);
    if (groups && typeof groups === "object") {
      for (const gid of Object.keys(groups)) {
        const g = groups[gid];
        if (String(g.ownerId) === uid) {
          delete groups[gid];
        } else if (Array.isArray(g.members)) {
          g.members = g.members.filter(m => m !== uid);
        }
      }
      await writeJson(DATA_FILES.groups, groups);
    }

    // 7. totals.json
    const totals = await readJson(DATA_FILES.totals);
    if (Array.isArray(totals)) {
      await writeJson(DATA_FILES.totals, totals.filter(r => String(r.userId || r.uid) !== uid));
    } else if (totals && typeof totals === "object") {
      delete totals[uid];
      await writeJson(DATA_FILES.totals, totals);
    }

    // 8. Firebase Auth'tan sil
    try {
      const { getAuth } = require("firebase-admin/auth");
      await getAuth().deleteUser(uid);
    } catch (authErr) {
      console.warn("Firebase delete user warn:", authErr.message);
      // Firebase silme başarısız olsa bile yerel veri silindi, devam et
    }

    return res.json({ ok: true, deleted: uid });
  } catch (e) {
    console.error("DELETE_ACCOUNT_ERR", e);
    return res.status(500).json({ ok: false, error: "DELETE_ACCOUNT_ERR", detail: String(e.message || e) });
  }
});

module.exports = router;
