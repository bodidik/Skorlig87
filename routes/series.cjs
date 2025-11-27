const express = require("express");
const path = require("path");
const fs = require("fs");

const router = express.Router();

const DATA_PATH = process.env.PREDS_PATH || path.resolve(__dirname, "../data/preds.json");

/**
 * Demo puanlama:
 *  - Tam skor: 3
 *  - Sonuç doğru (1X2): 1
 *  - Aksi: 0
 *  - Tiebreak: |predHome-realHome| + |predAway-realAway|
 */
function outcome(h, a) {
  return h === a ? "D" : h > a ? "H" : "A";
}
function scoreOne(pred, real) {
  if (pred.home === real.home && pred.away === real.away) return { pts: 3, tb: 0 };
  const ok = outcome(pred.home, pred.away) === outcome(real.home, real.away);
  const tb = Math.abs(pred.home - real.home) + Math.abs(pred.away - real.away);
  return { pts: ok ? 1 : 0, tb };
}

/**
 * GET /api/series/:sid/leaderboard?size=5&finished=1
 * - size: son N maç (varsayılan 5, max 20)
 * - finished=1: yalnız FT olan maçlar
 */
router.get("/:sid/leaderboard", (req, res) => {
  try {
    const sid = String(req.params.sid || "").trim();
    if (!sid) return res.status(400).json({ ok:false, error:"BAD_SID" });

    const sizeQ = Math.max(1, Math.min(20, Number(req.query.size || 5)));
    const finishedOnly = String(req.query.finished || "1") === "1";

    const raw = fs.existsSync(DATA_PATH) ? fs.readFileSync(DATA_PATH, "utf-8") : "{}";
    const db = JSON.parse(raw || "{}");
    const matches = Array.isArray(db.matches) ? db.matches : [];
    const preds   = Array.isArray(db.preds)   ? db.preds   : [];

    // 1) Seriye ait maçlar
    let serieMatches = matches.filter(m => (m.seriesId || "").toLowerCase() === sid.toLowerCase());
    // Bitmiş filtre
    if (finishedOnly) {
      serieMatches = serieMatches.filter(m => (m.status || "").toUpperCase() === "FT");
    }
    // En yeniye göre sırala -> son N
    serieMatches.sort((a,b) => (b.ts || 0) - (a.ts || 0));
    const take = serieMatches.slice(0, sizeQ);

    // 2) Kullanıcı bazında puan topla
    const users = new Map(); // userId -> { name, pts, tiebreak }
    for (const m of take) {
      const real = { home: Number(m.home?.score ?? m.h ?? 0), away: Number(m.away?.score ?? m.a ?? 0) };
      const mpreds = preds.filter(p => p.matchId === m.id && p.locked); // yalnız locked
      for (const p of mpreds) {
        const key = p.userId;
        const up = users.get(key) || { userId: key, name: p.name || key, pts: 0, tiebreak: 0 };
        const pred = { home: Number(p.pred?.home ?? p.h ?? 0), away: Number(p.pred?.away ?? p.a ?? 0) };
        const { pts, tb } = scoreOne(pred, real);
        up.pts += pts;
        up.tiebreak += tb;
        users.set(key, up);
      }
    }

    const leaderboard = Array.from(users.values())
      .sort((x,y) => (y.pts - x.pts) || (x.tiebreak - y.tiebreak) || (x.name.localeCompare(y.name)));

    return res.json({ ok:true, size: take.length, requested: sizeQ, finished: finishedOnly, leaderboard });
  } catch (e) {
    return res.status(500).json({ ok:false, error:"SERVER", message: String(e.message || e) });
  }
});

module.exports = router;


