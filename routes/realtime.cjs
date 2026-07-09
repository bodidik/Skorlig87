"use strict";

const express = require("express");
const router  = express.Router();

const fs   = require("fs");
const fsp  = fs.promises;
const path = require("path");

// DB helperlar (ileride kullanmak istersen diye bıraktım)
let getDbSafe = async () => null;
try {
  const { getDb } = require("../lib/db.cjs");
  if (typeof getDb === "function") {
    getDbSafe = getDb;
  }
} catch {}

/* === FLAGS / WEIGHTS === */
function flagOf(country){
  const m = {
    "Türkiye":"🇹🇷","Turkey":"🇹🇷",
    "England":"🇬🇧","Spain":"🇪🇸","Germany":"🇩🇪","Italy":"🇮🇹","France":"🇫🇷",
    "Netherlands":"🇳🇱","Belgium":"🇧🇪","Greece":"🇬🇷","Portugal":"🇵🇹",
    "Brazil":"🇧🇷","Argentina":"🇦🇷",
    "Japan":"🇯🇵","Russia":"🇷🇺","Ukraine":"🇺🇦",
    "USA":"🇺🇸","United States":"🇺🇸",
    "Saudi Arabia":"🇸🇦","Suudi Arabistan":"🇸🇦"
  };
  const c = String(country||"").trim();
  return Object.prototype.hasOwnProperty.call(m,c) ? m[c] : "🏳️";
}

const SCORE_WEIGHTS = {
  "Türkiye":1.00,"Turkey":1.00,
  "England":1.05,"Spain":1.05,"Germany":1.05,"Italy":1.05,"France":1.05,
  "Netherlands":1.03,"Belgium":1.03,"Greece":1.03,"Portugal":1.03,
  "Brazil":1.03,"Argentina":1.03,"Japan":1.03,"Russia":1.03,"Ukraine":1.03,
  "USA":1.02,"Saudi Arabia":1.02
};
const getScoreWeight = c => (SCORE_WEIGHTS[String(c||"").trim()] ?? 1.00);

/* === Maç bitmiş mi? (provider status'üne toleranslı) === */
function isFinishedState(st){
  const s = String(st?.status || "").trim().toUpperCase();

  // Provider ne derse desin bunlar maç bitmiş sinyali
  if ([
    "FT",          // full time
    "AET",         // after extra time
    "FT_PEN",
    "PEN",
    "FINISHED",
    "FULL_TIME"
  ].includes(s)) return true;

  // Açıkça "devam ediyor / başlamadı" olanlar
  if ([
    "NS", "LIVE", "1H", "2H", "HT", "ET"
  ].includes(s)) return false;

  // Ek sinyaller (ileride state genişlerse)
  if (st?.isFinished === true) return true;
  if (typeof st?.minute === "number" && st.minute >= 120 && st.isLive === false) return true;

  return false;
}
/* === küçük TTL cache === */
const __cache = (globalThis.__skCache instanceof Map)
  ? globalThis.__skCache
  : (globalThis.__skCache = new Map());

const cget = k => {
  const e = __cache.get(k);
  if (!e) return null;
  if (Date.now() > e.t) { __cache.delete(k); return null; }
  return e.v;
};
const cset = (k,v,ttl=1000) => { try{ __cache.set(k,{t:Date.now()+ttl,v}); }catch{} };

/* === DOSYA YOLLARI === */
const DATA_DIR         = path.join(__dirname,"..","data");
const LIVE_DIR         = path.join(DATA_DIR,"live");
const PREDS_FILE       = path.join(DATA_DIR,"preds.json");
const LEADERBOARD_FILE = path.join(DATA_DIR,"leaderboard.json");
const MAX_POLL         = Number(process.env.MAX_POLL_PER_MATCH || 10);

async function readJson(file, fb=null){
  try {
    const txt = await fsp.readFile(file,"utf8");
    return JSON.parse(txt);
  } catch { return fb; }
}
async function writeJson(file, data){
  await fsp.mkdir(path.dirname(file), { recursive:true });
  await fsp.writeFile(file, JSON.stringify(data,null,2), "utf8");
}
const stateFile = fid => path.join(LIVE_DIR, `${String(fid)}.json`);

/* === MODELLER (dosya veya DB) === */
const { getPredsForFixture, getMyLatestPred } = require("../models/preds.cjs");

/* =======================
 *   STATE & POLL
 * =======================*/

// ---- GET /api/rt/state
router.get("/state", async (req,res)=>{
  const { fixtureId } = req.query;
  if(!fixtureId) return res.status(400).json({ ok:false, error:"FIXTURE_REQUIRED" });
  const st = await readJson(stateFile(fixtureId), null);
  if(!st) return res.status(404).json({ ok:false, error:"STATE_NOT_FOUND" });
  return res.json({ ok:true, state: st });
});

// ---- POST /api/rt/poll
router.post("/poll", async (req,res)=>{
  const { fixtureId } = req.query;
  if(!fixtureId) return res.status(400).json({ ok:false, error:"FIXTURE_OR_TEAM_REQUIRED" });
  const file = stateFile(fixtureId);
  const st = await readJson(file, null);
  if(!st) return res.status(404).json({ ok:false, error:"STATE_NOT_FOUND" });
  if ((st.pollCount||0) >= MAX_POLL) {
    return res.json({ ok:true, limited:true, state:st, max:MAX_POLL });
  }
  st.pollCount   = (st.pollCount||0)+1;
  st.lastPolledAt = new Date().toISOString();
  await writeJson(file, st);
  return res.json({ ok:true, limited:false, state:st, max:MAX_POLL });
});

// ---- GET /api/rt/disabled
router.get("/disabled", async (req,res)=>{
  const { fixtureId } = req.query;
  if(!fixtureId) return res.status(400).json({ ok:false, error:"FIXTURE_REQUIRED" });
  const st = await readJson(stateFile(fixtureId), null);
  if(!st) return res.status(404).json({ ok:false, error:"STATE_NOT_FOUND" });

  const dis = {
    firstGoal: [],
    scoreFloor: {
      homeMin: st.score?.home||0,
      awayMin: st.score?.away||0
    }
  };
  if (st.firstGoal==="H") dis.firstGoal.push("A");
  if (st.firstGoal==="A") dis.firstGoal.push("H");

  res.json({
    ok:true,
    disabled: dis,
    minute: st.minute,
    score: st.score
  });
});

/* =======================
 *   SETTLE (puan yazımı)
 * =======================*/

// POST /api/rt/settle?fixtureId=...
router.post("/settle", async (req, res) => {
  try {
    const fixtureId = String(req.query.fixtureId || req.body?.fixtureId || "").trim();
    if (!fixtureId) {
      return res.status(400).json({ ok:false, error:"FIXTURE_REQUIRED" });
    }

    const st = await readJson(stateFile(fixtureId), null);
if (!st) {
  return res.status(404).json({ ok:false, error:"STATE_NOT_FOUND" });
}

// Status'u normalize edelim
const statusRaw = String(st.status || "").trim().toUpperCase();
const isFT = (
  statusRaw === "FT" ||
  statusRaw === "FINISHED" ||
  statusRaw === "MATCH_FINISHED" ||
  statusRaw === "FULLTIME"
);

if (!isFT) {
  return res.status(400).json({ ok:false, error:"NOT_FINISHED", status: statusRaw });
}


    // Tahmin listesi (önce DB, sonra dosya fallback)
    let preds = [];
    try {
      preds = await getPredsForFixture(fixtureId);
    } catch {}
    if (!preds.length) {
      const raw = await readJson(PREDS_FILE, []);
      preds = Array.isArray(raw)
        ? raw
        : Array.isArray(raw?.items)
        ? raw.items
        : [];
      preds = preds.filter(x => String(x.fixtureId) === fixtureId);
    }

    const h = Number(st.score?.home || 0);
    const a = Number(st.score?.away || 0);
    const outcome = h > a ? "H" : a > h ? "A" : "D";
    const fg = st.firstGoal || null;

    const htH = Number(st.htScore?.home ?? NaN);
    const htA = Number(st.htScore?.away ?? NaN);
    const hasHT = Number.isFinite(htH) && Number.isFinite(htA);
    const htOutcome = hasHT
      ? htH > htA
        ? "H"
        : htA > htH
        ? "A"
        : "D"
      : null;

    const redHomeActual = !!st.redHome;
    const redAwayActual = !!st.redAway;

    const rows = [];

    for (const p of preds) {
      const u = p.userId || p.user || "anon";
      let pts = 0;
      const detail = {};

      // 1) Sonuç
      if (p.outcome && typeof p.outcome === "string") {
        const ok = p.outcome.toUpperCase() === outcome;
        detail.outcome = ok ? 3 : 0;
        pts += detail.outcome;
      }

      // 2) Tam skor
      if (Number.isFinite(Number(p.home)) && Number.isFinite(Number(p.away))) {
        const ok = Number(p.home) === h && Number(p.away) === a;
        detail.exact = ok ? 12 : 0;
        pts += detail.exact;
      }
	      // 3) İlk gol
      // Sadece GERÇEKTEN gol atan bir taraf varsa puanla.
      // Maç 0-0 bittiyse (fg=null) hiç kimseye avantaj/dezavantaj yok.
      if (fg && p.firstGoal) {
        const ok = String(p.firstGoal).toUpperCase() === String(fg);
        detail.firstGoal = ok ? 1 : 0;
        pts += detail.firstGoal;
      } else {
        // Gol yoksa veya kullanıcı bu opsiyonu boş bıraktıysa
        detail.firstGoal = 0;
      }

      // 4) İlk yarı
      if (hasHT && p.firstHalf) {
        const ok = String(p.firstHalf).toUpperCase() === htOutcome;
        detail.firstHalf = ok ? 2 : 0;
        pts += detail.firstHalf;
      }

      // 5) Kırmızılar
      if (typeof p.redHome !== "undefined") {
        const ok = !!p.redHome === redHomeActual;
        detail.redHome = ok ? 1 : 0;
        pts += detail.redHome;
      }
      if (typeof p.redAway !== "undefined") {
        const ok = !!p.redAway === redAwayActual;
        detail.redAway = ok ? 1 : 0;
        pts += detail.redAway;
      }

      // Ülke ağırlığı
      const w = getScoreWeight(st.country);
      detail.weight = w;

      const baseMax = 3 + 12 + 1 + 2 + 1 + 1; // 20
      const maxWeighted = Math.round(baseMax * w);

      let final   = Math.round(pts * w);
      let penalty = 0;

      // %10 kayıp (bu tahminden puan alamazsa)
      if (final <= 0) {
        penalty = Math.max(1, Math.floor(maxWeighted * 0.1));
        final  -= penalty;
      }

      detail.penalty    = penalty;
      detail.basePoints = pts;

      rows.push({
        fixtureId,
        userId: u,
        points: final,
        basePoints: pts,
        penalty,
        country: st.country || "Türkiye",
        detail
      });
    }

    rows.sort((a,b)=> b.points - a.points);

    // Mevcut dosya + bu maçın satırlarını birleştir
    const lb = await readJson(LEADERBOARD_FILE, { items: [], totals: {} });
    const items = Array.isArray(lb.items) ? lb.items : [];
    const oldFiltered = items.filter(r => String(r.fixtureId) !== fixtureId);
    const merged = oldFiltered.concat(rows);

    // Kullanıcı bazlı totals
    const totals = {};
    for (const r of merged) {
      const uid = r.userId || "anon";
      if (!totals[uid]) {
        totals[uid] = { userId: uid, total: 0, played: 0, penalties: 0 };
      }
      totals[uid].total     += Number(r.points   || 0);
      totals[uid].played    += 1;
      totals[uid].penalties += Number(r.penalty  || 0);
    }

    const out = {
      items: merged,
      totals,
      updatedAt: new Date().toISOString()
    };
    await writeJson(LEADERBOARD_FILE, out);

    // (opsiyonel) Mongo snapshot
    try {
      const db = await getDbSafe();
      if (db) {
        await db.collection("leaderboard").updateOne(
          { fixtureId: String(fixtureId) },
          { $set: { fixtureId:String(fixtureId), items:rows, updatedAt:new Date() } },
          { upsert:true }
        );
      }
    } catch(e) {
      console.error("LEADERBOARD_SNAPSHOT_DB_FAIL", e);
    }

    return res.json({
      ok: true,
      fixtureId,
      outcome,
      firstGoal: fg,
      leaderboard: rows
    });
  } catch (e) {
    console.error("SETTLE_FAILED", e);
    return res.status(500).json({
      ok: false,
      error: "SETTLE_FAILED",
      detail: String(e && (e.message || e)),
    });
  }
});

/* =======================
 *   BOARD
 * =======================*/

// ---- GET /api/rt/board
router.get("/board", async (req,res)=>{
  const { fixtureId } = req.query;

  const lb = await readJson(LEADERBOARD_FILE, { items: [], totals: {} });
  const items = Array.isArray(lb.items) ? lb.items : [];
  let rows = items;

  if (fixtureId) {
    rows = items.filter(r => String(r.fixtureId) === String(fixtureId));
  }

  const country = rows[0]?.country || "Türkiye";
  const flag    = flagOf(country);

  const enriched = rows.map(x => ({
    ...x,
    country: x.country || country,
    flag: flagOf(x.country || country)
  }));

  return res.json({
    ok: true,
    leaderboard: enriched,
    updatedAt: lb.updatedAt || null,
    country,
    flag
  });
});

/* =======================
 *   SCORE (skor bazlı alive)  ✅ TEK ELEME KRİTERİ: SKOR TAHMİNİ
 * =======================*/

// ---- GET /api/rt/score
router.get("/score", async (req,res)=>{
  const fixtureId = String(req.query.fixtureId||"").trim();
  if(!fixtureId) return res.status(400).json({ ok:false, error:"FIXTURE_REQUIRED" });

  const ck = `score:${fixtureId}`;
  const hit = cget(ck);
  if (hit) return res.json(hit);

  const st = await readJson(stateFile(fixtureId), null);
  if (!st) return res.status(404).json({ ok:false, error:"STATE_NOT_FOUND" });

  const ch = Number(st?.score?.home||0);
  const ca = Number(st?.score?.away||0);

  const statusRaw = String(st?.status||"NS").trim();
  const finished  = isFinishedState(st);

  let preds = [];
  try { preds = await getPredsForFixture(fixtureId); } catch {}
  if (!preds.length){
    const raw = await readJson(PREDS_FILE, []);
    preds = Array.isArray(raw)? raw : (Array.isArray(raw?.items)? raw.items : []);
    preds = preds.filter(p=> String(p.fixtureId)===fixtureId);
  }

  // ✅ SADECE SKOR TAHMİNİ OLANLAR (home/away sayısal) bu oyunda yer alır
  const rows = preds
    .filter(p=> Number.isFinite(Number(p.home)) && Number.isFinite(Number(p.away)))
    .map(p=>{
      const ph = Number(p.home);
      const pa = Number(p.away);

      // ✅ ELEME: yalnız skor tahmininin mevcut skordan geri kalmaması (maç sürerken),
      // maç bitince sadece tam skor.
      const alive = finished
        ? (ph === ch && pa === ca)
        : (ph >= ch) && (pa >= ca);

      const win = finished && (ph === ch && pa === ca);

      return {
        userId:     p.userId||p.user||"anon",
        home:       ph,
        away:       pa,
        alive,
        eliminated: !alive,
        win,
        at:         p.at
      };
    })
    .sort((a,b)=>{
      if(a.alive!==b.alive) return a.alive? -1: 1;
      const da = Math.abs(a.home - ch) + Math.abs(a.away - ca);
      const db = Math.abs(b.home - ch) + Math.abs(b.away - ca);
      return da - db;
    });

  const out = {
    ok:true,
    status: statusRaw,
    finished,
    score:{home:ch,away:ca},
    count: rows.length,
    items: rows
  };

  cset(ck, out, 2000);
  return res.json(out);
});

// ---- GET /api/rt/my
router.get("/my", async (req,res)=>{
  const fixtureId = String(req.query.fixtureId||"").trim();
  const userId    = String(req.query.userId||"").trim();
  if(!fixtureId || !userId) {
    return res.status(400).json({ ok:false, error:"REQUIRED" });
  }

  const st = await readJson(stateFile(fixtureId), null);
  if (!st) return res.status(404).json({ ok:false, error:"STATE_NOT_FOUND" });

  const ch = Number(st?.score?.home || 0);
  const ca = Number(st?.score?.away || 0);

  const statusRaw = String(st?.status || "NS").trim();
  const finished  = isFinishedState(st);
  const status    = statusRaw;

  let mine = null;
  try { mine = await getMyLatestPred(fixtureId, userId); } catch {}
  if(!mine){
    const raw  = await readJson(PREDS_FILE, []);
    const list = Array.isArray(raw)? raw : (Array.isArray(raw?.items)? raw.items : []);
    mine = list
      .filter(p=> String(p.fixtureId)===fixtureId &&
                  String(p.userId||p.user||"anon").trim().toLowerCase()===userId.toLowerCase())
      .slice(-1)[0] || null;

    if(!mine) return res.json({ ok:true, has:false });
  }

  const mhNum = Number(mine.home);
  const maNum = Number(mine.away);
  const hasScore = Number.isFinite(mhNum) && Number.isFinite(maNum);

  // ✅ ELEME / ALIVE: SADECE SKOR (exact)
  // skor tahmini yoksa bu oyuna dahil değil -> exact: null
  const aliveExact = !hasScore
    ? null
    : finished
      ? (mhNum === ch && maNum === ca)
      : (mhNum >= ch && maNum >= ca);

  return res.json({
    ok:true,
    has:true,
    status,
    finished,
    score:{home:ch,away:ca},
    mine:{
      outcome:     mine.outcome   ?? null,
      home:        hasScore ? mhNum : null,
      away:        hasScore ? maNum : null,
      firstGoal:   mine.firstGoal ?? null,
      firstHalf:   mine.firstHalf ?? null,
      redHome:     (typeof mine.redHome === "boolean") ? mine.redHome : null,
      redAway:     (typeof mine.redAway === "boolean") ? mine.redAway : null,
      penaltySide: mine.penaltySide ?? null,
      at:          mine.at
    },
    alive:{
      // ✅ Tek eleme kriteri
      exact: aliveExact,

      // ⚠️ Geriye uyum: bu alanları "elemez" mantığında asla false yapmıyoruz.
      // (settle sonunda puana yansıyacak; eliminasyon değil)
      firstGoal: true,
      firstHalf: true,
      redHome:   true,
      redAway:   true,
      penalty:   true
    },
    finalScore: (finished ? { home:ch, away:ca } : null)
  });
});

module.exports = router;


