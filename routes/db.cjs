"use strict";

const express = require("express");
const router  = express.Router();
const { pingDb } = require("../lib/db.cjs");

router.get("/ping", async (req, res) => {
  try {
    const r = await pingDb();
    return res.json({
      ok: true,
      result: r,
      at: new Date().toISOString(),
    });
  } catch (e) {
    console.error("DB_PING_ERROR", e);
    return res.status(500).json({
      ok: false,
      error: String(e && (e.message || e)),
    });
  }
});

module.exports = router;
