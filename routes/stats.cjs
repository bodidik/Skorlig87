"use strict";

const express = require("express");
const router  = express.Router();
const path    = require("path");
const fs      = require("fs");
const fsp     = fs.promises;

const DATA_DIR         = path.join(__dirname, "..", "data");
const TOTALS_FILE      = path.join(DATA_DIR, "totals.json");
const LEADERBOARD_FILE = path.join(DATA_DIR, "leaderboard.json");
const WALLET_FILE      = path.join(DATA_DIR, "lc-wallet.json");

async function readJson(file, fb = null) {
  try {
    const txt = await fsp.readFile(file, "utf8");
    return JSON.parse(txt);
  } catch {
    return fb;
  }
}

/**
 * Basit ping:
 * GET /api/stats
 */
router.get("/", (req, res) => {
  res.json({ ok: true, where: "stats-router-alive" });
});

/**
 * Core helper:
 *  - Mongo varsa: season_totals + leaderboard + lc_wallet_* koleksiyonlarını kullanır
 *  - Mongo yoksa: totals.json + leaderboard.json + lc-wallet.json kullanır
 *
 * Dönüş:
 * {
 *   userId,
 *   source: "mongo" | "files",
 *   season: { userId, total, played, penalties, avg, lastAt },
 *   recentMatches: [{ fixtureId, points, detail, updatedAt }],
 *   wallet: { ... } | null,
 *   walletLedger: [...]
 * }
 */
async function loadUserStatsCore(req, userId) {
  const uid = String(userId || "").trim();
  if (!uid) {
    const err = new Error("USER_ID_REQUIRED");
    err.code = "USER_ID_REQUIRED";
    err.httpStatus = 400;
    throw err;
  }

  const db = req.app?.locals?.db || null;
  const uidLower = uid.toLowerCase();

  // ======================
  // 1) Mongo modu
  // ======================
  if (db) {
    const seasonCol   = db.collection("season_totals");
    const lbCol       = db.collection("leaderboard");
    const walletUsers = db.collection("lc_wallet_users");
    const ledgerCol   = db.collection("lc_wallet_ledger");

    // Sezon toplamları
    const seasonDoc = await seasonCol.findOne({ userIdLower: uidLower });

    const season = seasonDoc
      ? {
          userId: seasonDoc.userId || uid,
          total: Number(seasonDoc.totalPoints || 0),
          played: Number(seasonDoc.matches || 0),
          penalties: Number(seasonDoc.totalPenalty || 0),
          avg: seasonDoc.matches
            ? Math.round(
                Number(seasonDoc.totalPoints || 0) /
                  Number(seasonDoc.matches || 1)
              )
            : 0,
          lastAt: seasonDoc.lastAt || null,
        }
      : {
          userId: uid,
          total: 0,
          played: 0,
          penalties: 0,
          avg: 0,
          lastAt: null,
        };

    // Son maçlar (leaderboard koleksiyonundan)
    const recentMatchesRaw = await lbCol
      .find({ userIdLower: uidLower })
      .sort({ updatedAt: -1, createdAt: -1 })
      .limit(20)
      .toArray();

    const recentMatches = recentMatchesRaw.map((m) => ({
      fixtureId: m.fixtureId || null,
      points: Number(m.points || 0),
      detail: m.detail || null,
      updatedAt: m.updatedAt || m.createdAt || null,
    }));

    // LC cüzdan kullanıcı kaydı
    const walletUser = await walletUsers.findOne({ userIdLower: uidLower });

    const wallet = walletUser
      ? {
          userId: walletUser.userId || uid,
          balance: walletUser.balance || 0,
          totalEarned: walletUser.totalEarned || 0,
          totalSpent: walletUser.totalSpent || 0,
          lastDailyAt: walletUser.lastDailyAt || null,
          updatedAt: walletUser.updatedAt || null,
          is1987: !!walletUser.is1987,
        }
      : null;

    // LC ledger son hareketler
    const ledgerItems = await ledgerCol
      .find({ userIdLower: uidLower })
      .sort({ createdAt: -1 })
      .limit(20)
      .toArray();

    const walletLedger = ledgerItems.map((tx) => ({
      id: tx.id || null,
      kind: tx.kind || null,
      amount: tx.amount || 0,
      reason: tx.reason || null,
      fixtureId: tx.fixtureId || null,
      createdAt: tx.createdAt || null,
    }));

    return {
      userId: uid,
      source: "mongo",
      season,
      recentMatches,
      wallet,
      walletLedger,
    };
  }

  // ======================
  // 2) Dosya modu
  // ======================

  // 2.1) totals.json → sezon özeti
  const totals = await readJson(TOTALS_FILE, {
    items: [],
    updatedAt: null,
  });

  let season = {
    userId: uid,
    total: 0,
    played: 0,
    penalties: 0,
    avg: 0,
    lastAt: null,
  };

  if (totals && Array.isArray(totals.items)) {
    const t = totals.items.find(
      (x) =>
        String(x.userId || "")
          .trim()
          .toLowerCase() === uidLower
    );
    if (t) {
      const total = Number(t.totalPoints || 0);
      const played = Number(t.matches || 0);
      const penalties = Number(t.totalPenalty || 0);
      season = {
        userId: t.userId || uid,
        total,
        played,
        penalties,
        avg: played ? Math.round(total / played) : 0,
        lastAt: t.lastAt || null,
      };
    }
  }

  // 2.2) leaderboard.json → son settle edilen maçtaki satırlar
  const lb = await readJson(LEADERBOARD_FILE, {
    items: [],
    updatedAt: null,
  });
  const items = Array.isArray(lb.items) ? lb.items : [];

  const recentMatches = items
    .filter(
      (r) =>
        String(r.userId || r.user || "")
          .trim()
          .toLowerCase() === uidLower
    )
    .map((r) => ({
      fixtureId: r.fixtureId || null,
      points: Number(r.points || 0),
      detail: r.detail || null,
      updatedAt: lb.updatedAt || null,
    }));

  // 2.3) lc-wallet.json → cüzdan + ledger
  const walletState =
    (await readJson(WALLET_FILE, {
      users: [],
      ledger: [],
      updatedAt: null,
    })) || {};

  const usersArr = Array.isArray(walletState.users)
    ? walletState.users
    : [];
  const ledgerArr = Array.isArray(walletState.ledger)
    ? walletState.ledger
    : [];

  const wu = usersArr.find(
    (x) =>
      String(x.userId || "")
        .trim()
        .toLowerCase() === uidLower
  );

  const wallet = wu
    ? {
        userId: wu.userId,
        balance: wu.balance || 0,
        totalEarned: wu.totalEarned || 0,
        totalSpent: wu.totalSpent || 0,
        lastDailyAt: wu.lastDailyAt || null,
        updatedAt: wu.updatedAt || walletState.updatedAt || null,
        is1987: !!wu.is1987,
      }
    : null;

  const walletLedger = ledgerArr
    .filter(
      (tx) =>
        String(tx.userId || "")
          .trim()
          .toLowerCase() === uidLower
    )
    .sort(
      (a, b) =>
        new Date(b.createdAt || 0).getTime() -
        new Date(a.createdAt || 0).getTime()
    )
    .slice(0, 20)
    .map((tx) => ({
      id: tx.id || null,
      kind: tx.kind || null,
      amount: tx.amount || 0,
      reason: tx.reason || null,
      fixtureId: tx.fixtureId || null,
      createdAt: tx.createdAt || null,
    }));

  return {
    userId: uid,
    source: "files",
    season,
    recentMatches,
    wallet,
    walletLedger,
  };
}

/**
 * GET /api/stats/user?userId=...
 *
 * Full JSON:
 *  { ok, userId, source, season, recentMatches, wallet, walletLedger }
 */
router.get("/user", async (req, res) => {
  try {
    const userId = String(req.query.userId || "").trim();
    if (!userId) {
      return res
        .status(400)
        .json({ ok: false, error: "USER_ID_REQUIRED" });
    }

    const core = await loadUserStatsCore(req, userId);

    return res.json({
      ok: true,
      ...core,
    });
  } catch (e) {
    console.error("STATS_USER_FAILED", e);
    const status = e && e.httpStatus ? e.httpStatus : 500;
    const code = e && e.code ? e.code : "STATS_USER_FAILED";
    return res.status(status).json({
      ok: false,
      error: code,
      detail: String(e && (e.message || e)),
    });
  }
});

/**
 * GET /api/stats/me?userId=...
 *
 * Eski MeStats şemasına uyumlu cevap döner:
 *  {
 *    ok,
 *    userId,
 *    favTeam: null | string,
 *    team: null | { team, rank, count, myTeamTotal },
 *    totalPoints,
 *    played,
 *    avg,
 *    lastAt,
 *    form: number[],                // recentMatches üzerinden
 *    wallet,
 *    walletLedger
 *  }
 *
 * Not:
 *  - Şu an favTeam / team alanlarını dolduracak veri kaynağı yok; ileride users.json / Mongo user profile bağlanabilir.
 */
router.get("/me", async (req, res) => {
  try {
    const userId = String(req.query.userId || "").trim();
    if (!userId) {
      return res
        .status(400)
        .json({ ok: false, error: "USER_ID_REQUIRED" });
    }

    const core = await loadUserStatsCore(req, userId);
    const season = core.season || {
      userId,
      total: 0,
      played: 0,
      penalties: 0,
      avg: 0,
      lastAt: null,
    };
    const recent = Array.isArray(core.recentMatches)
      ? core.recentMatches
      : [];

    // Form: son 10 maçın puanı (yeniden sırala: en eski → en yeni)
    const form = recent
      .slice()
      .sort((a, b) => {
        const ta = new Date(a.updatedAt || 0).getTime();
        const tb = new Date(b.updatedAt || 0).getTime();
        return ta - tb;
      })
      .map((m) => Number(m.points || 0))
      .slice(-10);

    return res.json({
      ok: true,
      userId: core.userId,
      // Şimdilik takım bilgilerini doldurmuyoruz,
      // frontend default olarak "Galatasaray" kullanmaya devam edecek.
      favTeam: null,
      team: null,
      totalPoints: season.total,
      played: season.played,
      avg: season.avg,
      lastAt: season.lastAt,
      form,
      wallet: core.wallet || null,
      walletLedger: core.walletLedger || [],
    });
  } catch (e) {
    console.error("STATS_ME_FAILED", e);
    const status = e && e.httpStatus ? e.httpStatus : 500;
    const code = e && e.code ? e.code : "STATS_ME_FAILED";
    return res.status(status).json({
      ok: false,
      error: code,
      detail: String(e && (e.message || e)),
    });
  }
});

module.exports = router;
