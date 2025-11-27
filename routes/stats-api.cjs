"use strict";

const express = require("express");
const router  = express.Router();
const fs      = require("fs");
const fsp     = fs.promises;
const path    = require("path");

const DATA_DIR          = path.join(__dirname, "..", "data");
const SNAP_DIR          = path.join(DATA_DIR, "rt-snapshots");
const USERS_FILE        = path.join(DATA_DIR, "users.json");
const LEADERBOARD_FILE  = path.join(DATA_DIR, "leaderboard.json");

/* Küçük JSON helper */
async function readJsonSafe(file, fallback) {
  try {
    const txt = await fsp.readFile(file, "utf8");
    return JSON.parse(txt);
  } catch {
    return fallback;
  }
}

/* users.json index’i: { userId: { userId, name, team, flag, ... }, ... } */
async function loadUsersIndex() {
  const raw = await readJsonSafe(USERS_FILE, {});
  if (raw && raw.users && typeof raw.users === "object") return raw.users;
  if (raw && !Array.isArray(raw) && typeof raw === "object") return raw;
  if (Array.isArray(raw)) {
    const map = {};
    for (const u of raw) {
      if (u && u.userId) map[String(u.userId)] = u;
    }
    return map;
  }
  return {};
}

/* === /api/stats/me ===
   Kullanıcıya ait:
   - toplam puan (son snapshot’lardan)
   - oynadığı maç sayısı
   - favori takımı / team içi rank (team, rank, count, myTeamTotal)
   - form (son 10 maç puanları, eski→yeni) */
router.get("/me", async (req, res) => {
  try {
    const userId = String(req.query.userId || "").trim();
    if (!userId) {
      return res.status(400).json({ ok:false, error:"USER_REQUIRED" });
    }

    const users   = await loadUsersIndex();
    const userRec = users[userId] || {};
    const favTeam = userRec.team || null;
    const favFlag = userRec.flag || null;

    // son 100 snapshot’ı tara
    const files = await (async () => {
      try {
        await fsp.mkdir(SNAP_DIR, { recursive: true });
        return (await fsp.readdir(SNAP_DIR))
          .filter((n) => n.endsWith(".json"))
          .sort()
          .slice(-100);
      } catch {
        return [];
      }
    })();

    const recent = [];
    const allRows = [];
    for (const f of files) {
      const snap = await readJsonSafe(path.join(SNAP_DIR, f), { items: [] });
      if (Array.isArray(snap.items)) {
        const mine = snap.items.find(
          (x) => String(x.userId || "") === userId
        );
        if (mine) {
          recent.push({
            fixture: f.replace(/\.json$/, ""),
            points: Number(mine.points || 0),
          });
        }
        allRows.push(...snap.items);
      }
    }

    const total = recent.reduce((acc, r) => acc + Number(r.points || 0), 0);
    const played = recent.length;

    // takım içi sıralama
    let teamRank = null;
    let teamCount = 0;
    let teamTotal = null;
    let teamName = favTeam;

    if (!teamName && userRec.team) {
      teamName = String(userRec.team);
    }

    if (teamName) {
      const tLower = String(teamName).toLowerCase();
      const byUserTotal = new Map();
      for (const r of allRows) {
        const uid = String(r.userId || "");
        const meta = users[uid] || {};
        const tname = String(meta.team || "").toLowerCase();
        if (tname === tLower) {
          byUserTotal.set(
            uid,
            (byUserTotal.get(uid) || 0) + Number(r.points || 0)
          );
        }
      }

      const board = Array.from(byUserTotal.entries())
        .map(([uid, t]) => ({ userId: uid, total: t }))
        .sort((a, b) => b.total - a.total);

      teamCount = board.length;
      const mineRow = board.find((x) => x.userId === userId) || null;
      teamTotal = mineRow ? mineRow.total : null;
      const idx = board.findIndex((x) => x.userId === userId);
      teamRank = idx >= 0 ? idx + 1 : null;
    }

    // form: son 10 maç, eski→yeni
    const formOrdered = recent
      .slice(-10)
      .reverse()
      .map((x) => Number(x.points || 0));

    return res.json({
      ok: true,
      userId,
      totalPoints: total,
      played,
      favTeam: favTeam,
      favFlag,
      team: teamName
        ? { team: teamName, rank: teamRank, count: teamCount, myTeamTotal: teamTotal }
        : null,
      form: formOrdered,
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: "ME_FAILED",
      detail: String(e && (e.message || e)),
    });
  }
});

/* === /api/stats/team-ranks?team=Galatasaray ===
   İlgili takımdaki (users.json.team) kullanıcıların toplam puanları. */
router.get("/team-ranks", async (req, res) => {
  try {
    const teamQ = String(req.query.team || "").trim();
    if (!teamQ) {
      return res.status(400).json({ ok:false, error:"TEAM_REQUIRED" });
    }

    const teamLower = teamQ.toLowerCase();
    const users = await loadUsersIndex();

    // leaderboard.json’dan toplu puan
    const lb = await readJsonSafe(LEADERBOARD_FILE, { items: [], totals: {} });

    // 1) totals varsa oradan
    const rows = [];
    if (lb.totals && typeof lb.totals === "object") {
      for (const [uid, obj] of Object.entries(lb.totals)) {
        const meta = users[uid] || {};
        const tname = String(meta.team || "").toLowerCase();
        if (tname === teamLower) {
          rows.push({
            userId: uid,
            total: Number(obj.total || 0),
            flag: meta.flag || null,
            team: meta.team || teamQ,
          });
        }
      }
    } else if (Array.isArray(lb.items)) {
      // 2) items üzerinden toplarsak (fallback)
      const acc = new Map();
      for (const r of lb.items) {
        const uid = String(r.userId || r.user || "");
        const meta = users[uid] || {};
        const tname = String(meta.team || "").toLowerCase();
        if (tname === teamLower) {
          acc.set(uid, (acc.get(uid) || 0) + Number(r.points || 0));
        }
      }
      for (const [uid, total] of acc.entries()) {
        const meta = users[uid] || {};
        rows.push({
          userId: uid,
          total,
          flag: meta.flag || null,
          team: meta.team || teamQ,
        });
      }
    }

    rows.sort((a, b) => b.total - a.total);

    return res.json({
      ok: true,
      team: teamQ,
      items: rows.slice(0, 100),
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: "TEAM_RANKS_FAILED",
      detail: String(e && (e.message || e)),
    });
  }
});

/* === /api/stats/board ===
   Global leaderboard + users.json’dan flag / team merge */
router.get("/board", async (req, res) => {
  try {
    const users = await loadUsersIndex();
    const board = await readJsonSafe(LEADERBOARD_FILE, {
      items: [],
      updatedAt: null,
    });

    const items = (board.items || []).map((x) => {
      const uid = String(x.userId || x.user || "");
      const meta = users[uid] || {};
      return {
        userId: uid,
        points: Number(x.points || 0),
        detail: x.detail || {},
        flag: meta.flag || null,
        team: meta.team || null,
      };
    });

    items.sort((a, b) => b.points - a.points);

    return res.json({
      ok: true,
      items,
      updatedAt: board.updatedAt || null,
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: "BOARD_ENRICH_FAILED",
      detail: String(e && (e.message || e)),
    });
  }
});

module.exports = router;
