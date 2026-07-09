"use strict";

const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");
const fsp = fs.promises;

const DATA_DIR = path.join(__dirname, "..", "data");
const FILE = path.join(DATA_DIR, "admin-users.json");

function normUserId(v) {
  return String(v || "").trim().toLowerCase();
}

async function readJson(file, fb) {
  try {
    const txt = await fsp.readFile(file, "utf8");
    return JSON.parse(txt);
  } catch {
    return fb;
  }
}

async function writeJsonAtomic(file, obj) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(obj, null, 2), "utf8");
  await fsp.rename(tmp, file);
}

async function getList() {
  const j = await readJson(FILE, { items: [], updatedAt: null });
  const items = Array.isArray(j.items) ? j.items : [];
  const clean = items.map(normUserId).filter(Boolean);
  const uniq = Array.from(new Set(clean));
  return { items: uniq, updatedAt: j.updatedAt || null };
}

function requireAdminToken(req, res) {
  const expected = String(
  process.env.SKORLIG_ADMIN_TOKEN ||
  process.env.ADMIN_TOKEN ||
  process.env.EXPO_PUBLIC_ADMIN_TOKEN ||
  ""
).trim();
  const got = String(req.headers["x-admin-token"] || "").trim();

  // token yoksa güvenlik adına kapat
  if (!expected) {
    res.status(503).json({ ok: false, error: "ADMIN_TOKEN_NOT_CONFIGURED" });
    return false;
  }
  if (!got || got !== expected) {
    res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
    return false;
  }
  return true;
}

/**
 * GET /api/admin/is-admin?userId=
 * Token gerekmez: sadece boolean döner, listeyi sızdırmaz.
 */
router.get("/is-admin", async (req, res) => {
  const uid = normUserId(req.query.userId);
  if (!uid) return res.json({ ok: true, userId: "", isAdmin: false });

  // hızlı varsayılanlar
  if (uid === "admin" || uid === "demo_admin") {
    return res.json({ ok: true, userId: uid, isAdmin: true, source: "builtin" });
  }

  const { items } = await getList();
  return res.json({ ok: true, userId: uid, isAdmin: items.includes(uid), source: "file" });
});

/**
 * GET /api/admin/admin-users
 * Token zorunlu: admin listesini döner
 */
router.get("/admin-users", async (req, res) => {
  if (!requireAdminToken(req, res)) return;
  const j = await getList();
  res.json({ ok: true, ...j, source: "file" });
});

/**
 * POST /api/admin/admin-users/add { userId }
 */
router.post("/admin-users/add", async (req, res) => {
  if (!requireAdminToken(req, res)) return;

  const uid = normUserId(req.body && req.body.userId);
  if (!uid) return res.status(400).json({ ok: false, error: "BAD_USERID" });

  const cur = await getList();
  const next = Array.from(new Set([...(cur.items || []), uid]));

  const out = { items: next, updatedAt: new Date().toISOString() };
  await writeJsonAtomic(FILE, out);
  res.json({ ok: true, ...out });
});

/**
 * POST /api/admin/admin-users/remove { userId }
 */
router.post("/admin-users/remove", async (req, res) => {
  if (!requireAdminToken(req, res)) return;

  const uid = normUserId(req.body && req.body.userId);
  if (!uid) return res.status(400).json({ ok: false, error: "BAD_USERID" });

  const cur = await getList();
  const next = (cur.items || []).filter((x) => x !== uid);

  const out = { items: next, updatedAt: new Date().toISOString() };
  await writeJsonAtomic(FILE, out);
  res.json({ ok: true, ...out });
});

module.exports = router;
