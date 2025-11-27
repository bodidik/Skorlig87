"use strict";

const express = require("express");
const router  = express.Router();
const fs      = require("fs");
const fsp     = fs.promises;
const path    = require("path");

const DATA_DIR    = path.join(__dirname, "..", "data");
const LIVE_DIR    = path.join(DATA_DIR, "live");
const PREDS_FILE  = path.join(DATA_DIR, "preds.json");
const TOTALS_FILE = path.join(DATA_DIR, "totals.json");
const LEADERBOARD_FILE = path.join(DATA_DIR, "leaderboard.json");

async function readJson(file, fb=null){
  try {
    const txt = await fsp.readFile(file,"utf8");
    return JSON.parse(txt);
  } catch {
    return fb;
  }
}
async function writeJson(file, data){
  await fsp.mkdir(path.dirname(file), { recursive:true });
  await fsp.writeFile(file, JSON.stringify(data,null,2),"utf8");
}
function stateFile(fid){ return path.join(LIVE_DIR, `${String(fid)}.json`); }

const SCORE_WEIGHTS = {
  "Türkiye":1.00,"Turkey":1.00,
  "England":1.05,"Spain":1.05,"Germany":1.05,"Italy":1.05,"France":1.05,
  "Netherlands":1.03,"Belgium":1.03,"Greece":1.03,"Portugal":1.03,
  "Brazil":1.03,"Argentina":1.03,"Japan":1.03,"Russia":1.03,"Ukraine":1.03,
  "USA":1.02,"United States":1.02,"Saudi Arabia":1.02,"Suudi Arabistan":1.02
};
function getScoreWeight(country){
  const c = String(country||"").trim();
  return Object.prototype.hasOwnProperty.call(SCORE_WEIGHTS,c)
    ? SCORE_WEIGHTS[c]
    : 1.00;
}

// outcome(3) + exact(12) + FG(1) + HT(2) + redH(1) + redA(1) + penAny(1.5) + penSide(1.5) = 22
const MAX_BASE = 22;

/**
 * Aynı fixture için puan hesaplamasını yapan yardımcı fonksiyon.
 * updateTotals = true ise eski davranış (leaderboard + totals dosyalarını yazar).
 * updateTotals = false ise sadece hesaplayıp JSON döner (match-board için).
 */
async function scoreFixture(fixtureId, { updateTotals = true } = {}) {
  const fid = String(fixtureId || "");
  if (!fid) {
    const err = new Error("FIXTURE_REQUIRED");
    err.code = "FIXTURE_REQUIRED";
    err.httpStatus = 400;
    throw err;
  }

  const st = await readJson(stateFile(fid), null);
  if (!st) {
    const err = new Error("STATE_NOT_FOUND");
    err.code = "STATE_NOT_FOUND";
    err.httpStatus = 404;
    throw err;
  }
  if (String(st.status) !== "FT") {
    const err = new Error("NOT_FINISHED");
    err.code = "NOT_FINISHED";
    err.httpStatus = 400;
    throw err;
  }

  const predsRaw = await readJson(PREDS_FILE, []);
  const preds = Array.isArray(predsRaw)
    ? predsRaw
    : Array.isArray(predsRaw?.items)
    ? predsRaw.items
    : [];
  const list = preds.filter((p) => String(p.fixtureId) === fid);

  const h = Number(st.score?.home || 0);
  const a = Number(st.score?.away || 0);
  const outcome = h > a ? "H" : a > h ? "A" : "D";

  const htH = Number(st.htScore?.home ?? NaN);
  const htA = Number(st.htScore?.away ?? NaN);
  const hasHT = Number.isFinite(htH) && Number.isFinite(htA);
  const htOutcome = hasHT ? (htH > htA ? "H" : htA > htH ? "A" : "D") : null;

  // Gerçek kırmızı / penaltı
  const redHomeActual = !!st.redHome;
  const redAwayActual = !!st.redAway;
  const redAnyActual = redHomeActual || redAwayActual; // en az bir kırmızı var mı?
  const redSideActual = redHomeActual ? "H" : redAwayActual ? "A" : null;

  const fg = st.firstGoal || null;

  const penaltyAnyActual =
    typeof st.penaltyAny === "boolean" ? st.penaltyAny : false;
  const penaltySideActual = st.penaltySide || null;

  const w = getScoreWeight(st.country);

  const rows = [];

  for (const p of list) {
    const u = p.userId || p.user || "anon";
    let pts = 0;
    const detail = {};

    // 1) Maç sonucu 3
    if (p.outcome && typeof p.outcome === "string") {
      const ok = p.outcome.toUpperCase() === outcome;
      detail.outcome = ok ? 3 : 0;
      pts += detail.outcome;
    }

    // 2) Tam skor 12 (isteğe bağlı)
    //    home/away null veya undefined ise hiç puan verilmez
    const hasScorePred =
      p.home !== null &&
      p.home !== undefined &&
      p.away !== null &&
      p.away !== undefined &&
      Number.isFinite(Number(p.home)) &&
      Number.isFinite(Number(p.away));

    if (hasScorePred) {
      const ok = Number(p.home) === h && Number(p.away) === a;
      detail.exact = ok ? 12 : 0;
      pts += detail.exact;
    }

    // 3) İlk gol 1
    if (p.firstGoal) {
      const ok =
        String(p.firstGoal).toUpperCase() === String(fg || "");
      detail.firstGoal = ok ? 1 : 0;
      pts += detail.firstGoal;
    }

    // 4) İlk yarı 2
    if (hasHT && p.firstHalf) {
      const ok = String(p.firstHalf).toUpperCase() === htOutcome;
      detail.firstHalf = ok ? 2 : 0;
      pts += detail.firstHalf;
    }

    // 5) Kırmızı – yeni iki aşamalı model
    //    redAny: 1.5 puan (var / yok)
    //    redSide: doğru taraf +1; yanlış taraf -0.05 (o ekstra 1 puanın %5'i)
    let redAnyPts = 0;
    let redSidePts = 0;
    let redSidePenalty = 0;

    // Giriş: önce yeni alanları oku; yoksa eski redHome/redAway’den türet
    const predRedAny =
      typeof p.redAny === "boolean"
        ? p.redAny
        : !!p.redHome || !!p.redAway;

    const predRedSide =
      p.redSide || (p.redHome ? "H" : p.redAway ? "A" : null);

    if (typeof predRedAny === "boolean") {
      if (predRedAny === redAnyActual) {
        redAnyPts = 1.5;
      }
    }
    if (predRedSide) {
      const guess = String(predRedSide).toUpperCase();
      const act = redSideActual
        ? String(redSideActual).toUpperCase()
        : null;
      if (act && guess === act) {
        redSidePts = 1;
      } else {
        redSidePenalty = -0.05;
      }
    }

    detail.redAny = redAnyPts;
    detail.redSide = redSidePts;
    detail.redSidePenalty = redSidePenalty;
    pts += redAnyPts + redSidePts + redSidePenalty;

    // 6) Penaltı – önce VAR/YOK 1.5, sonra taraf +1 / -0.05
    let penAnyPts = 0;
    let penSidePts = 0;
    let penSidePenalty = 0;

    if (typeof p.penaltyAny === "boolean") {
      if (p.penaltyAny === penaltyAnyActual) penAnyPts = 1.5;
    }
    if (p.penaltySide) {
      const guess = String(p.penaltySide).toUpperCase();
      const act = penaltySideActual
        ? String(penaltySideActual).toUpperCase()
        : null;
      if (act && guess === act) {
        penSidePts = 1;
      } else {
        penSidePenalty = -0.05;
      }
    }

    detail.penaltyAny = penAnyPts;
    detail.penaltySide = penSidePts;
    detail.penaltySidePenalty = penSidePenalty;
    pts += penAnyPts + penSidePts + penSidePenalty;

    // Ağırlık
    const weighted = pts * w;

    // Hiç puan yoksa %10 ceza (MAX_BASE üzerinden)
    const penalty = weighted === 0 ? -(MAX_BASE * w * 0.1) : 0;

    detail.weight = w;
    detail.base = pts;
    detail.weighted = weighted;
    detail.zeroPenalty = penalty;

    const total = weighted + penalty;

    rows.push({
      fixtureId: fid,
      userId: u,
      points: total,
      detail,
    });
  }

  rows.sort((a, b) => b.points - a.points);

  // updateTotals false ise dosyaya yazma, sadece sonucu dön
  if (!updateTotals) {
    return {
      fixtureId: fid,
      finalScore: { home: h, away: a },
      outcome,
      firstGoal: fg,
      redAny: redAnyActual,
      redSide: redSideActual,
      penaltyAny: penaltyAnyActual,
      penaltySide: penaltySideActual,
      leaderboard: rows,
    };
  }

  // == Eski davranış: leaderboard + totals.json yaz ==
  await writeJson(LEADERBOARD_FILE, {
    items: rows,
    updatedAt: new Date().toISOString(),
  });

  // totals.json güncelleme (toplam puan + ceza)
  const totalsRaw = await readJson(TOTALS_FILE, {
    items: [],
    updatedAt: null,
  });
  const map = new Map();
  for (const it of totalsRaw.items || []) {
    map.set(String(it.userId), {
      userId: String(it.userId),
      totalPoints: Number(it.totalPoints || 0),
      totalPenalty: Number(it.totalPenalty || 0),
      matches: Number(it.matches || 0),
      lastAt: it.lastAt || null,
    });
  }

  for (const r of rows) {
    const key = String(r.userId);
    const cur =
      map.get(key) || {
        userId: key,
        totalPoints: 0,
        totalPenalty: 0,
        matches: 0,
        lastAt: null,
      };
    cur.totalPoints += Number(r.points || 0);
    cur.totalPenalty +=
      Number(r.detail?.zeroPenalty || 0) +
      Number(r.detail?.redSidePenalty || 0) +
      Number(r.detail?.penaltySidePenalty || 0);
    cur.matches += 1;
    cur.lastAt = new Date().toISOString();
    map.set(key, cur);
  }

  const outTotals = {
    items: Array.from(map.values()).map((x) => ({
      ...x,
      totalPoints: Math.round(x.totalPoints),
      totalPenalty: Math.round(x.totalPenalty),
    })),
    updatedAt: new Date().toISOString(),
  };
  await writeJson(TOTALS_FILE, outTotals);

  return {
    fixtureId: fid,
    finalScore: { home: h, away: a },
    outcome,
    firstGoal: fg,
    redAny: redAnyActual,
    redSide: redSideActual,
    penaltyAny: penaltyAnyActual,
    penaltySide: penaltySideActual,
    leaderboard: rows,
  };
}

/**
 * POST /api/settle2
 * – Eski davranış: maçı kapatır, puanları hesaplar ve totals/leaderboard dosyalarını günceller.
 */
router.post("/settle2", async (req, res) => {
  try {
    const fixtureId =
      String(req.query.fixtureId || req.body?.fixtureId || "");

    const result = await scoreFixture(fixtureId, { updateTotals: true });

    return res.json({
      ok: true,
      ...result,
    });
  } catch (e) {
    console.error("SAFE_SETTLE2_FAILED", e);
    const status = e && e.httpStatus ? e.httpStatus : 500;
    const code = e && e.code ? e.code : "SAFE_SETTLE2_FAILED";
    return res
      .status(status)
      .json({ ok: false, error: code, detail: String(e && (e.message || e)) });
  }
});

/**
 * GET /api/pred/match-board?fixtureId=...
 * – Maç bazında, BEN + botlar için mikropuan tablosu döner.
 * – Dosyaları güncellemez; sadece hesaplama yapar ve JSON verir.
 */
router.get("/pred/match-board", async (req, res) => {
  try {
    const fixtureId = String(req.query.fixtureId || "");
    const result = await scoreFixture(fixtureId, {
      updateTotals: false,
    });

    return res.json({
      ok: true,
      ...result,
    });
  } catch (e) {
    console.error("MATCH_BOARD_FAILED", e);
    const status = e && e.httpStatus ? e.httpStatus : 500;
    const code = e && e.code ? e.code : "MATCH_BOARD_FAILED";
    return res
      .status(status)
      .json({ ok: false, error: code, detail: String(e && (e.message || e)) });
  }
});

module.exports = router;
