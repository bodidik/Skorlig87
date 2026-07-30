"use strict";

const express = require("express");
const router = express.Router();
const fs = require("fs");
const fsp = fs.promises;

const Moderation = require("../lib/moderation-store.cjs");

function normUserId(v) {
  return String(v || "").trim().toLowerCase();
}



// Admin ve yasak listeleri Mongo birincil — bkz. lib/moderation-store.cjs.
// Dosyada tutulurken her deploy siliniyordu: yönetici hakları sıfırlanıyor,
// YASAKLAR SESSİZCE KALKIYORDU (verifyToken dosya okunamayınca boş küme
// kullanıyor, yani fail-open bir güvenlik kontrolü).
async function getList(db) {
  const items = await Moderation.listAdmins(db || null);
  return { items, updatedAt: null };
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

  const { items } = await getList(req.app?.locals?.db || null);
  return res.json({ ok: true, userId: uid, isAdmin: items.includes(uid), source: "store" });
});

/**
 * GET /api/admin/admin-users
 * Token zorunlu: admin listesini döner
 */
router.get("/admin-users", async (req, res) => {
  if (!requireAdminToken(req, res)) return;
  const j = await getList(req.app?.locals?.db || null);
  res.json({ ok: true, ...j, source: "store" });
});

/**
 * POST /api/admin/admin-users/add { userId }
 */
router.post("/admin-users/add", async (req, res) => {
  if (!requireAdminToken(req, res)) return;

  const uid = normUserId(req.body && req.body.userId);
  if (!uid) return res.status(400).json({ ok: false, error: "BAD_USERID" });

  await Moderation.addAdmin(uid, req.app?.locals?.db || null);
  const next = await Moderation.listAdmins(req.app?.locals?.db || null);
  res.json({ ok: true, items: next, updatedAt: new Date().toISOString() });
});

/**
 * POST /api/admin/admin-users/remove { userId }
 */
router.post("/admin-users/remove", async (req, res) => {
  if (!requireAdminToken(req, res)) return;

  const uid = normUserId(req.body && req.body.userId);
  if (!uid) return res.status(400).json({ ok: false, error: "BAD_USERID" });

  await Moderation.removeAdmin(uid, req.app?.locals?.db || null);
  const next = await Moderation.listAdmins(req.app?.locals?.db || null);
  res.json({ ok: true, items: next, updatedAt: new Date().toISOString() });
});

// ─── Ban yönetimi ────────────────────────────────────────────────────────────

async function getBanned(db) {
  return Moderation.listBanned(db || null);
}

/**
 * GET /api/admin/banned
 * Engellenen kullanıcıların listesi.
 */
router.get("/banned", async (req, res) => {
  if (!requireAdminToken(req, res)) return;
  const items = await getBanned(req.app?.locals?.db || null);
  res.json({ ok: true, count: items.length, items });
});

/**
 * POST /api/admin/ban   { userId, reason? }
 * Kullanıcıyı engelle.
 */
router.post("/ban", async (req, res) => {
  if (!requireAdminToken(req, res)) return;
  const userId = String(req.body?.userId || "").trim();
  const reason = String(req.body?.reason || "").trim() || null;
  if (!userId) return res.status(400).json({ ok: false, error: "BAD_USERID" });

  const oncekiler = await getBanned(req.app?.locals?.db || null);
  const already = oncekiler.some(x => String(x.userId || "").toLowerCase() === userId.toLowerCase());
  // upsert idempotent: zaten yasaklıysa yalnızca sebep güncellenir.
  await Moderation.ban(userId, { reason }, req.app?.locals?.db || null);
  const items = await getBanned(req.app?.locals?.db || null);
  res.json({ ok: true, userId, already, count: items.length });
});

/**
 * POST /api/admin/unban   { userId }
 * Engeli kaldır.
 */
router.post("/unban", async (req, res) => {
  if (!requireAdminToken(req, res)) return;
  const userId = String(req.body?.userId || "").trim();
  if (!userId) return res.status(400).json({ ok: false, error: "BAD_USERID" });

  const oncekiler = await getBanned(req.app?.locals?.db || null);
  await Moderation.unban(userId, req.app?.locals?.db || null);
  const next = await getBanned(req.app?.locals?.db || null);
  res.json({ ok: true, userId, removed: oncekiler.length - next.length, count: next.length });
});

module.exports = router;
