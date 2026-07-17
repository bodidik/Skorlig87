/**
 * routes/config.cjs
 * GET  /api/config                 -> { features, scoring, runtimeMode }
 * POST /api/config/update          -> settings.json'a yazar (Basic Auth)
 * POST /api/config/admin/runtime-mode -> runtime-mode.json'a yazar (Admin Token)
 */
"use strict";

const express = require("express");
const router = express.Router();
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const SETTINGS = path.join(DATA_DIR, "settings.json");

// 🔹 Runtime mode entegrasyonu (4 takım / 30 takım / global vb.)
const { getRuntimeMode, setRuntimeMode } = require("../lib/runtime-mode.cjs");

async function readJson(file, fb = null) {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"));
  } catch (e) {
    return fb;
  }
}

async function writeJson(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fsp.rename(tmp, file);
}

// ---- Basic Auth (sadece POST /update için) ----
// Fail-closed: ADMIN_USER/ADMIN_PASS env ayarlı değilse endpoint kapalı.
// Sabit varsayılan ("admin"/"skorlig") kaldırıldı — prod'da tahmin edilemesin.
function _adminAuth(req, res, next) {
  const ADMIN_USER = String(process.env.ADMIN_USER || "").trim();
  const ADMIN_PASS = String(process.env.ADMIN_PASS || "").trim();
  if (!ADMIN_USER || !ADMIN_PASS) {
    return res.status(503).send("Admin credentials not configured");
  }
  const h = req.headers.authorization || "";
  if (!h.startsWith("Basic ")) {
    res.set("WWW-Authenticate", 'Basic realm="SkorLig Admin"');
    return res.status(401).send("Auth required");
  }
  const [u, p] = Buffer.from(h.slice(6), "base64")
    .toString("utf8")
    .split(":");
  if (u === ADMIN_USER && p === ADMIN_PASS) return next();
  res.set("WWW-Authenticate", 'Basic realm="SkorLig Admin"');
  return res.status(401).send("Bad credentials");
}

// ---- GET /api/config ----
router.get("/", async (req, res) => {
  const def = {
    features: {
      mode: "GS_ONLY",
      showProfile: true,
      showLeaderboard: true,
      enableCoupons: false,
    },
    scoring: {
      startBalance: 500,
      useProbabilityEngine: false,
      K_outcome: 3,
      epsilon: 0.05,
      unknownPenaltyPct: 0.1,
    },
  };

  const s = await readJson(SETTINGS, null);
  const out = s
    ? {
        features: s.features || def.features,
        scoring: s.scoring || def.scoring,
      }
    : def;

  // 🔹 Runtime mode bilgisi: runtime-mode.json → DEFAULT_MODE
  let runtimeMode = null;
  try {
    runtimeMode = await getRuntimeMode();
  } catch (e) {
    runtimeMode = null;
  }

  res.json({
    ok: true,
    config: out,
    runtimeMode, // { profile, maxTeams, maxLeagues, notes, updatedAt, updatedBy }
    from: s ? "settings.json" : "default",
  });
});

// ---- POST /api/config/update ----
router.post("/update", _adminAuth, express.json(), async (req, res) => {
  try {
    const body = req.body || {};
    const features = body.features || {};
    const scoring = body.scoring || {};

    const modes = new Set(["GS_ONLY", "MULTI_LEAGUE"]);
    if (features.mode && !modes.has(String(features.mode))) {
      return res.status(400).json({ ok: false, error: "INVALID_MODE" });
    }

    const out = {
      features: {
        mode: features.mode || "GS_ONLY",
        showProfile: features.showProfile !== false,
        showLeaderboard: features.showLeaderboard !== false,
        enableCoupons: !!features.enableCoupons,
      },
      scoring: {
        startBalance: Number(scoring.startBalance ?? 500),
        useProbabilityEngine: !!scoring.useProbabilityEngine,
        K_outcome: Number(scoring.K_outcome ?? 3),
        epsilon: Number(scoring.epsilon ?? 0.05),
        unknownPenaltyPct: Number(scoring.unknownPenaltyPct ?? 0.1),
      },
    };

    await writeJson(SETTINGS, out);
    return res.json({ ok: true, saved: out, file: "data/settings.json" });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

/**
 * ---- POST /api/config/admin/runtime-mode ----
 * Mobile içindeki gizli admin modal buraya POST atacak.
 * Header: x-admin-token: <SKORLIG_ADMIN_TOKEN>
 * Body:  { profile, maxTeams?, maxLeagues?, updatedBy? }
 */
router.post("/admin/runtime-mode", express.json(), async (req, res) => {
  try {
    const ADMIN_TOKEN = String(process.env.SKORLIG_ADMIN_TOKEN || "").trim();
    const headerToken = String(req.headers["x-admin-token"] || "").trim();

    // Fail-closed: token yapılandırılmamışsa endpoint kapalı.
    if (!ADMIN_TOKEN) {
      return res.status(503).json({ ok: false, error: "ADMIN_TOKEN_NOT_CONFIGURED" });
    }
    // Token tanımlı ama eşleşmiyorsa reddet.
    if (headerToken !== ADMIN_TOKEN) {
      return res.status(403).json({ ok: false, error: "ADMIN_AUTH_FAILED" });
    }

    const patch = req.body || {};

    const next = await setRuntimeMode({
      profile: patch.profile,
      maxTeams:
        typeof patch.maxTeams === "number" ? patch.maxTeams : undefined,
      maxLeagues:
        typeof patch.maxLeagues === "number" ? patch.maxLeagues : undefined,
      notes:
        patch.notes ||
        `Updated from mobile admin switch (${patch.updatedBy || "unknown"})`,
      updatedBy: patch.updatedBy || "mobile-admin",
    });

    return res.json({
      ok: true,
      runtimeMode: next,
    });
  } catch (e) {
    console.error("POST /api/config/admin/runtime-mode error:", e);
    return res.status(500).json({
      ok: false,
      error: "ADMIN_RUNTIME_MODE_ERROR",
    });
  }
});

module.exports = router;
