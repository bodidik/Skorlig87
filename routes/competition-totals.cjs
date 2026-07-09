"use strict";

const express = require("express");
const router  = express.Router();
const fs      = require("fs");
const fsp     = fs.promises;
const path    = require("path");

const DATA_DIR            = path.join(__dirname, "..", "data");
const LEADERBOARD_FILE    = path.join(DATA_DIR, "leaderboard.json");
const FIXTURE_COMP_FILE   = path.join(DATA_DIR, "fixture-competitions.json");

// JSON helper
async function readJson(file, fb = null) {
  try {
    const txt = await fsp.readFile(file, "utf8");
    return JSON.parse(txt);
  } catch {
    return fb;
  }
}

function getDb(req) {
  return req?.app?.locals?.db || null;
}

function normUserId(u) {
  return String(u || "").trim().toLowerCase();
}

/**
 * Küçük helper: leaderboard satırından penalty toplamı (detaylardan)
 */
function extractPenaltyFromDetail(detail) {
  if (!detail) return 0;
  const zp  = Number(detail.zeroPenalty || 0);
  const rsp = Number(detail.redSidePenalty || 0);
  const psp = Number(detail.penaltySidePenalty || 0);
  return zp + rsp + psp;
}

/**
 * GET /api/rt/competition-totals?competitionId=...&userId=...
 *
 * Çıktı:
 * {
 *   ok: true,
 *   competitionId: "...",
 *   items: [
 *     { userId, totalPoints, matches, totalPenalty, avg, lastAt? }
 *   ],
 *   updatedAt,
 *   count,              // oyuncu sayısı
 *   me: {               // opsiyonel: aktif kullanıcının satırı
 *     userId,
 *     totalPoints,
 *     matches,
 *     totalPenalty,
 *     avg,
 *     lastAt,
 *     rank              // 1-based
 *   } | null,
 *   source: "mongo_competition_totals" | "mongo_agg" | "file_agg"
 * }
 */
router.get("/competition-totals", async (req, res) => {
  try {
    const competitionId = String(req.query.competitionId || "").trim();
    const userIdRaw     = String(req.query.userId || "").trim();
    const userIdLower   = userIdRaw ? normUserId(userIdRaw) : null;

    if (!competitionId) {
      return res
        .status(400)
        .json({ ok: false, error: "COMPETITION_ID_REQUIRED" });
    }

    const db = getDb(req);

    // helper: items içinden me + count çıkar
    function pickMeAndCount(items) {
      const count = Array.isArray(items) ? items.length : 0;
      let me = null;

      if (userIdLower && count > 0) {
        const idx = items.findIndex(
          (r) => normUserId(r.userId) === userIdLower
        );
        if (idx !== -1) {
          const row = items[idx];
          me = {
            userId: row.userId,
            totalPoints: Number(row.totalPoints || 0),
            matches: Number(row.matches || 0),
            totalPenalty: Number(row.totalPenalty || 0),
            avg: row.matches
              ? Math.round(Number(row.totalPoints || 0) / Number(row.matches || 1))
              : 0,
            lastAt: row.lastAt || null,
            rank: idx + 1,
          };
        }
      }

      return { me, count };
    }

    // 1) 🔵 Mongo + competition_totals koleksiyonu varsa direkt kullan
    if (db) {
      try {
        const totalsCol = db.collection("competition_totals");
        const docs = await totalsCol
          .find({ competitionId })
          .sort({ totalPoints: -1 })
          .toArray();

        if (docs && docs.length) {
          const items = docs.map((d) => {
            const totalPoints  = Number(d.totalPoints || 0);
            const matches      = Number(d.matches     || 0);
            const totalPenalty = Number(d.totalPenalty || 0);
            const avg          = matches
              ? Math.round(totalPoints / matches)
              : 0;

            return {
              userId: d.userId || d.userIdLower || "anon",
              totalPoints,
              matches,
              totalPenalty,
              avg,
              lastAt: d.lastAt || d.updatedAt || d.createdAt || null,
            };
          });

          // items zaten totalPoints'e göre sort edilmiş durumda
          const updatedAt =
            docs[0]?.updatedAt ||
            docs[0]?.lastAt ||
            new Date().toISOString();

          const { me, count } = pickMeAndCount(items);

          return res.json({
            ok: true,
            competitionId,
            items,
            updatedAt,
            count,
            me,
            source: "mongo_competition_totals",
          });
        }
      } catch (e) {
        console.error(
          "[competition-totals] mongo competition_totals read failed, will fallback:",
          e
        );
        // sessizce fallback'e geçeceğiz
      }
    }

    // 2) 🔵 Mongo var ama competition_totals boşsa:
    //    fixture_competitions + leaderboard üzerinden hesapla
    if (db) {
      try {
        const fcCol = db.collection("fixture_competitions");
        const lbCol = db.collection("leaderboard");

        // Bu kupaya bağlanmış ve countsForPoints:true olan fixtureId'ler
        const fcDocs = await fcCol
          .find({
            competitions: {
              $elemMatch: {
                competitionId,
                countsForPoints: true,
              },
            },
          })
          .toArray();

        const fixtureIds = fcDocs
          .map((d) => String(d.fixtureId || "").trim())
          .filter(Boolean);

        if (!fixtureIds.length) {
          return res.json({
            ok: true,
            competitionId,
            items: [],
            updatedAt: null,
            count: 0,
            me: null,
            source: "mongo_agg",
          });
        }

        const lbDocs = await lbCol
          .find({ fixtureId: { $in: fixtureIds } })
          .toArray();

        const byUser = new Map();

        for (const r of lbDocs) {
          const uid =
            String(r.userId || r.userIdLower || "").trim() || "anon";
          if (!byUser.has(uid)) {
            byUser.set(uid, {
              userId: uid,
              totalPoints: 0,
              matches: 0,
              totalPenalty: 0,
              lastAt: null,
            });
          }
          const acc = byUser.get(uid);
          const pts = Number(r.points || 0);
          const pen = extractPenaltyFromDetail(r.detail);

          acc.totalPoints  += pts;
          acc.matches      += 1;
          acc.totalPenalty += pen;

          const ts = r.updatedAt || r.createdAt || null;
          if (ts) {
            if (!acc.lastAt || new Date(ts) > new Date(acc.lastAt)) {
              acc.lastAt = ts;
            }
          }
        }

        const items = Array.from(byUser.values())
          .map((r) => ({
            ...r,
            avg: r.matches
              ? Math.round(r.totalPoints / r.matches)
              : 0,
          }))
          .sort((a, b) => b.totalPoints - a.totalPoints);

        const latest = items.reduce(
          (acc, it) =>
            !acc || (it.lastAt && new Date(it.lastAt) > new Date(acc))
              ? it.lastAt
              : acc,
          null
        );

        const { me, count } = pickMeAndCount(items);

        return res.json({
          ok: true,
          competitionId,
          items,
          updatedAt: latest,
          count,
          me,
          source: "mongo_agg",
        });
      } catch (e) {
        console.error(
          "[competition-totals] mongo aggregate failed, will fallback to files:",
          e
        );
        // continue to file fallback
      }
    }

    // 3) 🟢 Dosya modu: fixture-competitions.json + leaderboard.json
    const fcData =
      (await readJson(FIXTURE_COMP_FILE, { items: [], updatedAt: null })) ||
      { items: [] };
    const fcItems = Array.isArray(fcData.items) ? fcData.items : [];

    const fixtureIdsFile = fcItems
      .filter((rec) =>
        Array.isArray(rec.competitions)
          ? rec.competitions.some(
              (c) =>
                String(c.competitionId || "").trim() === competitionId &&
                (c.countsForPoints !== false) // default: true
            )
          : false
      )
      .map((rec) => String(rec.fixtureId || "").trim())
      .filter(Boolean);

    const lb =
      (await readJson(LEADERBOARD_FILE, {
        items: [],
        updatedAt: null,
      })) || {};
    const lbItems = Array.isArray(lb.items) ? lb.items : [];

    const byUserFile = new Map();

    for (const r of lbItems) {
      const fid = String(r.fixtureId || "").trim();
      if (!fixtureIdsFile.includes(fid)) continue;

      const uid =
        String(r.userId || r.user || "").trim() || "anon";
      if (!byUserFile.has(uid)) {
        byUserFile.set(uid, {
          userId: uid,
          totalPoints: 0,
          matches: 0,
          totalPenalty: 0,
          lastAt: null,
        });
      }
      const acc = byUserFile.get(uid);
      const pts = Number(r.points || 0);
      const pen =
        extractPenaltyFromDetail(r.detail) +
        Number(r.penalty || 0); // eski kayıt desteği

      acc.totalPoints  += pts;
      acc.matches      += 1;
      acc.totalPenalty += pen;

      const ts = lb.updatedAt || null;
      if (ts) {
        if (!acc.lastAt || new Date(ts) > new Date(acc.lastAt)) {
          acc.lastAt = ts;
        }
      }
    }

    const itemsFile = Array.from(byUserFile.values())
      .map((r) => ({
        ...r,
        avg: r.matches
          ? Math.round(r.totalPoints / r.matches)
          : 0,
      }))
      .sort((a, b) => b.totalPoints - a.totalPoints);

    const latestFile = itemsFile.reduce(
      (acc, it) =>
        !acc || (it.lastAt && new Date(it.lastAt) > new Date(acc))
          ? it.lastAt
          : acc,
      null
    );

    const { me, count } = pickMeAndCount(itemsFile);

    return res.json({
      ok: true,
      competitionId,
      items: itemsFile,
      updatedAt: latestFile,
      count,
      me,
      source: "file_agg",
    });
  } catch (e) {
    console.error("COMPETITION_TOTALS_FAILED", e);
    return res.status(500).json({
      ok: false,
      error: "COMPETITION_TOTALS_FAILED",
      detail: String(e && (e.message || e)),
    });
  }
});

module.exports = router;
