"use strict";

/**
 * PUSH BİLDİRİM UÇLARI
 *
 *   POST /api/push/register    { token, prefs? }   → cihazı kaydet
 *   POST /api/push/unregister  { token? }          → cihazı (veya hepsini) sök
 *   GET  /api/push/prefs                           → tercihleri oku
 *   POST /api/push/prefs       { matchStart, ... } → tercihleri yaz
 *   POST /api/push/test        (admin)             → deneme bildirimi
 *
 * Kimlik: verifyToken → req.uid. Kullanıcı yalnızca kendi kaydına dokunabilir;
 * userId gövdeden ALINMAZ, aksi halde başkasının cihazı sökülebilirdi.
 */

const express = require("express");
const router  = express.Router();

const { verifyToken } = require("../middleware/verifyToken.cjs");
const push = require("../services/push.cjs");

function requireAdminToken(req, res) {
  const expected = String(
    process.env.SKORLIG_ADMIN_TOKEN ||
    process.env.ADMIN_TOKEN ||
    ""
  ).trim();

  if (!expected) {
    res.status(503).json({ ok: false, error: "ADMIN_TOKEN_NOT_CONFIGURED" });
    return false;
  }
  const got = String(req.headers["x-admin-token"] || req.query.token || "").trim();
  if (got !== expected) {
    res.status(401).json({ ok: false, error: "ADMIN_TOKEN_REQUIRED" });
    return false;
  }
  return true;
}

router.post("/register", verifyToken, async (req, res) => {
  try {
    const { token, prefs } = req.body || {};
    const r = await push.registerToken(req.uid, token, prefs);
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.post("/unregister", verifyToken, async (req, res) => {
  try {
    const r = await push.unregisterToken(req.uid, req.body?.token);
    res.json(r);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.get("/prefs", verifyToken, async (req, res) => {
  try {
    const r = await push.getPrefs(req.uid);
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.post("/prefs", verifyToken, async (req, res) => {
  try {
    const r = await push.setPrefs(req.uid, req.body || {});
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/* ===== Admin: deneme gönderimi ve durum ===== */

router.post("/test", async (req, res) => {
  if (!requireAdminToken(req, res)) return;
  try {
    const { userId, title, body } = req.body || {};
    const payload = {
      title: title || "SkorLig",
      body:  body  || "Deneme bildirimi ✅",
      data:  { test: true },
    };
    const r = userId
      ? await push.sendToUsers([userId], payload)
      : await push.broadcast(payload);
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.get("/status", async (req, res) => {
  if (!requireAdminToken(req, res)) return;
  try {
    const store = await push.loadStore();
    const users = Object.entries(store.items);
    const devices = users.reduce((n, [, r]) => n + (r.tokens?.length || 0), 0);
    res.json({
      ok: true,
      enabled: process.env.SKORLIG_PUSH !== "0",
      users: users.length,
      devices,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

module.exports = router;
