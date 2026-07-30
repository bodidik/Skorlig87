"use strict";

const express = require("express");
const router = express.Router();
const t = require("../services/tournament.cjs");
const { verifyToken } = require("../middleware/verifyToken.cjs");

// POST /api/tournaments/create
router.post("/create", verifyToken, async (req, res) => {
  try {
    const { name, entryLC, fixtureIds, fixtures } = req.body;
    // ⚠️ `db` ŞART: giriş ücreti onunla tahsil ediliyor. Geçilmezse servis
    // kendi çözmeye çalışır, o da olmazsa WALLET_UNAVAILABLE ile reddeder —
    // bedava katılıma düşmez (bkz. services/tournament.cjs başlığı).
    const tournament = await t.create({
      creatorId: req.uid,
      name,
      entryLC,
      fixtureIds,
      fixtures,
      db: req.app?.locals?.db || null,
    });
    res.json({ ok: true, tournament });
  } catch (e) {
    // Yetersiz bakiye kullanıcı hatasıdır (400) ama ayrı kod dönsün ki
    // istemci "LC yükle" diyebilsin; cüzdan erişilemiyorsa altyapı (503).
    const status = e.message === "WALLET_UNAVAILABLE" ? 503 : 400;
    res.status(status).json({ ok: false, error: e.message, balance: e.balance ?? undefined });
  }
});

// POST /api/tournaments/join
router.post("/join", verifyToken, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ ok: false, error: "CODE_REQUIRED" });
    const tournament = await t.join(code, req.uid, req.app?.locals?.db || null);
    res.json({ ok: true, tournament });
  } catch (e) {
    const status =
      e.message === "NOT_FOUND" ? 404 :
      e.message === "WALLET_UNAVAILABLE" ? 503 : 400;
    res.status(status).json({ ok: false, error: e.message, balance: e.balance ?? undefined });
  }
});

// POST /api/tournaments/predict
router.post("/predict", verifyToken, async (req, res) => {
  try {
    const { code, fixtureId, outcome } = req.body;
    if (!code || !fixtureId || !outcome) {
      return res.status(400).json({ ok: false, error: "MISSING_FIELDS" });
    }
    await t.predict(code, req.uid, fixtureId, outcome);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// GET /api/tournaments/:code
router.get("/:code", async (req, res) => {
  try {
    const tournament = await t.getByCode(req.params.code);
    if (!tournament) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    res.json({ ok: true, tournament });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/tournaments/settle/:code  (admin)
router.post("/settle/:code", verifyToken, async (req, res) => {
  try {
    const { results } = req.body; // { [fixtureId]: { outcome: "H"|"D"|"A" } }
    if (!results || typeof results !== "object") {
      return res.status(400).json({ ok: false, error: "RESULTS_REQUIRED" });
    }
    const tournament = await t.settle(req.params.code, results);
    res.json({ ok: true, tournament });
  } catch (e) {
    const status = e.message === "NOT_FOUND" ? 404 : 400;
    res.status(status).json({ ok: false, error: e.message });
  }
});

// GET /api/tournaments/user/my
router.get("/user/my", verifyToken, async (req, res) => {
  try {
    const list = await t.listByUser(req.uid);
    res.json({ ok: true, count: list.length, tournaments: list });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
