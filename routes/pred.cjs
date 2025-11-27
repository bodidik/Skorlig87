"use strict";

const express = require("express");
const router = express.Router();

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const PREDS_FILE = path.join(DATA_DIR, "preds.json");
const LIVE_DIR = path.join(DATA_DIR, "live"); // fixture state için
const LEADERBOARD_FILE = path.join(DATA_DIR, "leaderboard.json");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const BOT_PROFILES_PATH = path.join(DATA_DIR, "bot-profiles.json");

// ----------------- JSON HELPER'LAR -----------------
async function readJson(file, fb) {
  try {
    const txt = await fsp.readFile(file, "utf8");
    return JSON.parse(txt);
  } catch {
    return fb;
  }
}

async function writeJson(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(data, null, 2), "utf8");
}

// preds.json içindeki listeyi al (dizi veya {items:[]} ikisini de destekle)
async function loadPredList() {
  const raw = await readJson(PREDS_FILE, []);
  if (Array.isArray(raw)) return { list: raw, wrap: null };
  if (Array.isArray(raw.items)) return { list: raw.items, wrap: raw };
  return { list: [], wrap: null };
}

// Fixture state dosyası (settle2.cjs ile uyumlu)
function stateFile(fid) {
  return path.join(LIVE_DIR, `${String(fid)}.json`);
}

// ----------------- BOT PROFİLLERİ + RNG -----------------

/**
 * Yeni sistem:
 * - data/bot-profiles.json içinden 1000 bot profili okunur.
 *   Şema: [{ id, club, segment, tier }, ...]
 * - Buradan BOT_PROFILES, BOT_USER_ID_SET ve BOT_PROFILE_MAP üretilir.
 */
let BOT_PROFILES = [];
let BOT_USER_ID_SET = new Set();
let BOT_PROFILE_MAP = new Map();

try {
  // JSON yükle
  const rawProfiles = require(BOT_PROFILES_PATH);
  if (Array.isArray(rawProfiles)) {
    BOT_PROFILES = rawProfiles
      .map((p) => {
        const userId = String(p.id || p.userId || "").trim();
        if (!userId) return null;
        return {
          userId,
          favTeam: p.club || null,
          segment: p.segment || null,
          tier: p.tier || null,
        };
      })
      .filter(Boolean);

    BOT_USER_ID_SET = new Set(
      BOT_PROFILES.map((b) => b.userId.toLowerCase())
    );
    BOT_PROFILE_MAP = new Map(
      BOT_PROFILES.map((b) => [b.userId.toLowerCase(), b])
    );

    console.log(
      `[pred] loaded ${BOT_PROFILES.length} bot profiles from bot-profiles.json`
    );
  } else {
    console.log(
      "[pred] bot-profiles.json did not contain an array; BOT_PROFILES empty."
    );
  }
} catch (e) {
  console.log(
    "[pred] bot-profiles.json not found or invalid; BOT_PROFILES empty:",
    e && (e.message || e)
  );
}

/**
 * Deterministik random (fixtureId + userId → her çağrıda aynı tahmin)
 */
function makeSeededRng(seed) {
  let h = 0;
  const s = String(seed || "");
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return function () {
    h = (h * 1664525 + 1013904223) >>> 0;
    return (h >>> 0) / 0xffffffff;
  };
}

function pickWeighted(rng, items) {
  // items: [{value, w}]
  const total = items.reduce((acc, it) => acc + (it.w || 0), 0);
  if (!total) return items[0]?.value ?? null;
  let r = rng() * total;
  for (const it of items) {
    r -= it.w || 0;
    if (r <= 0) return it.value;
  }
  return items[items.length - 1].value;
}

// Botun skor tahmini (basit, ama favori takıma bias veriyor)
function botScoreGuess(rng, favOnHome, favOnAway) {
  // Baz setler
  const baseScores = [
    { h: 1, a: 0, w: 3 },
    { h: 2, a: 1, w: 3 },
    { h: 2, a: 0, w: 2 },
    { h: 1, a: 1, w: 2 },
    { h: 3, a: 1, w: 1.5 },
    { h: 0, a: 0, w: 1 },
    { h: 0, a: 1, w: 1 },
    { h: 1, a: 2, w: 1 },
    { h: 0, a: 2, w: 0.7 },
  ];

  const arr = baseScores.map((s) => {
    let w = s.w;
    if (favOnHome && s.h > s.a) w *= 1.4;
    if (favOnAway && s.a > s.h) w *= 1.4;
    return { ...s, w };
  });

  const totalW = arr.reduce((acc, s) => acc + s.w, 0);
  let r = rng() * totalW;
  for (const s of arr) {
    r -= s.w;
    if (r <= 0) return { home: s.h, away: s.a };
  }
  const last = arr[arr.length - 1];
  return { home: last.h, away: last.a };
}

// ----------------- ANA ROUTE: HUMAN SUBMIT -----------------

/**
 * POST /api/pred/submit
 *
 * Artık skor isteğe bağlı:
 * - Eğer body.home/body.away yoksa → home/away null olarak kaydedilir.
 * - outcome (H/D/A) ve yan tahminler (firstGoal, firstHalf, red/pen) normal gider.
 */
router.post("/pred/submit", async (req, res) => {
  try {
    const {
      fixtureId,
      userId,
      outcome,
      home,
      away,
      firstGoal,
      firstHalf,
      // yeni iki aşamalı alanlar:
      redAny,
      redSide,
      penaltyAny,
      penaltySide,
    } = req.body || {};

    const fx = String(fixtureId || "").trim();
    const uid = String(userId || "").trim();
    if (!fx || !uid) {
      return res
        .status(400)
        .json({ ok: false, error: "FIXTURE_AND_USER_REQUIRED" });
    }

    // Skor isteğe bağlı:
    let h = null;
    let a = null;

    const hasHome = req.body.hasOwnProperty("home");
    const hasAway = req.body.hasOwnProperty("away");

    if (hasHome || hasAway) {
      const hh = Number(home);
      const aa = Number(away);
      if (!Number.isFinite(hh) || !Number.isFinite(aa)) {
        return res
          .status(400)
          .json({ ok: false, error: "SCORE_MUST_BE_NUMBERS" });
      }
      h = hh;
      a = aa;
    }

    // Kırmızı kart alanlarını hem eski şemaya hem yeni şemaya uyduralım
    const redAnyBool = typeof redAny === "boolean" ? redAny : null;
    const redSideNorm = redSide === "H" || redSide === "A" ? redSide : null;

    let redHome = undefined;
    let redAway = undefined;

    if (redAnyBool === false) {
      // "kırmızı yok" → ikisi de false
      redHome = false;
      redAway = false;
    } else if (redAnyBool === true && redSideNorm === "H") {
      redHome = true;
      redAway = false;
    } else if (redAnyBool === true && redSideNorm === "A") {
      redHome = false;
      redAway = true;
    }

    // Penaltı tarafı
    const penaltySideNorm =
      penaltySide === "H" || penaltySide === "A" ? penaltySide : null;

    // Mevcut listeyi oku
    const { list, wrap } = await loadPredList();

    // Aynı kullanıcı + fixture için son tahmini yazsın (eski kaydı temizle)
    const filtered = list.filter(
      (p) =>
        !(
          String(p.fixtureId || "") === fx &&
          String(p.userId || p.user || "") === uid
        )
    );

    const nowISO = new Date().toISOString();

    const rec = {
      fixtureId: fx,
      userId: uid,
      outcome: outcome || null,
      home: h,
      away: a,
      firstGoal: firstGoal || null,
      firstHalf: firstHalf || null,

      // eski alanlarla uyum
      redHome,
      redAway,

      // yeni alanları da saklayalım
      redAny: redAnyBool,
      redSide: redSideNorm,

      penaltySide: penaltySideNorm,
      penaltyAny: typeof penaltyAny === "boolean" ? penaltyAny : null,

      at: nowISO,
    };

    filtered.push(rec);

    if (wrap) {
      wrap.items = filtered;
      await writeJson(PREDS_FILE, wrap);
    } else {
      await writeJson(PREDS_FILE, filtered);
    }

    return res.json({ ok: true, pred: rec });
  } catch (e) {
    console.error("PRED_SUBMIT_FAILED", e);
    return res.status(500).json({
      ok: false,
      error: "PRED_SUBMIT_FAILED",
      detail: String(e && (e.message || e)),
    });
  }
});

// ----------------- BOT TAHMİN ÜRETİMİ -----------------

// Fixture state'den ev / dep takımlarını çekmeye çalış
async function readFixtureMeta(fixtureId) {
  try {
    const st = await readJson(stateFile(fixtureId), null);
    if (!st) return { homeTeam: null, awayTeam: null, country: null };

    const homeTeam = st.homeTeam || st.home || (st.teams && st.teams.home) || null;
    const awayTeam = st.awayTeam || st.away || (st.teams && st.teams.away) || null;
    const country = st.country || null;

    return { homeTeam, awayTeam, country };
  } catch {
    return { homeTeam: null, awayTeam: null, country: null };
  }
}

// ---- 1987GS Nostalji Bot Davranış Motoru ----
function apply1987Logic(botId, rng, homeTeam, awayTeam, country) {
  const id = String(botId || "").toLowerCase();

  const is1987 =
    id.includes("87") ||
    id.includes("1987") ||
    id.includes("prekazi") ||
    id.includes("hagi") ||
    id.includes("cimbom") ||
    id.includes("aslan") ||
    id.includes("sami") ||
    id.includes("metin");

  if (!is1987) return null;  // normal bot döner

  const lowerHome = String(homeTeam || "").toLowerCase();
  const lowerAway = String(awayTeam || "").toLowerCase();

  const gsHome = lowerHome.includes("galatasaray");
  const gsAway = lowerAway.includes("galatasaray");

  // ---- SCORE ----
  // romantik GS skor ağırlıkları
  const base = [
    { h: 1, a: 0, w: gsHome ? 4 : 2 },
    { h: 2, a: 1, w: gsHome ? 4 : 2 },
    { h: 2, a: 0, w: gsHome ? 3 : 1.5 },
    { h: 1, a: 1, w: 2 },
    { h: 0, a: 0, w: 1 },
    { h: 1, a: 2, w: gsAway ? 2 : 0.5 },
    { h: 0, a: 1, w: gsAway ? 2 : 0.5 },
    { h: 3, a: 1, w: gsHome ? 1 : 0.3 },
  ];

  // ekstra Avrupa güçlendirmesi
  if (country && String(country).toLowerCase().includes("europe")) {
    base.forEach(s => { if (s.h > s.a && gsHome) s.w *= 1.4 });
  }

  const total = base.reduce((a, x) => a + x.w, 0);
  let r = rng() * total;
  let score = base[0];
  for (const s of base) {
    r -= s.w;
    if (r <= 0) { score = s; break; }
  }

  // ---- OUTCOME ----
  let outcome = "D";
  if (score.h > score.a) outcome = "H";
  if (score.a > score.h) outcome = "A";

  // ---- FIRST GOAL ----
  const fg = rng() < (gsHome ? 0.65 : 0.57) ? "H" : "A";

  // ---- FIRST HALF ----
  const fhTable = gsHome
    ? [ {v:"H",w:3}, {v:"D",w:2}, {v:"A",w:1} ]
    : [ {v:"H",w:1}, {v:"D",w:2}, {v:"A",w:2} ];

  let fh = "D";
  let rt = rng() * (fhTable[0].w + fhTable[1].w + fhTable[2].w);
  for (const x of fhTable) {
    rt -= x.w;
    if (rt <= 0) { fh = x.v; break; }
  }

  // ---- RED CARD ----
  let redAny = null;
  const rc = rng();
  if (rc < 0.28) redAny = true;
  else if (rc < 0.68) redAny = false;

  let redSide = null;
  if (redAny === true) redSide = rng() < 0.5 ? "H" : "A";

  // ---- PENALTY ----
  let penaltyAny = null;
  const pc = rng();
  if (pc < 0.32) penaltyAny = true;
  else if (pc < 0.65) penaltyAny = false;

  let penaltySide = null;
  if (penaltyAny === true) penaltySide = rng() < 0.5 ? "H" : "A";

  return {
    score,
    outcome,
    firstGoal: fg,
    firstHalf: fh,
    redAny,
    redSide,
    penaltyAny,
    penaltySide,
    is1987: true,
  };
}

// ---- 1987GS Nostalji Bot Davranış Motoru ----
function apply1987Logic(botId, rng, homeTeam, awayTeam, country) {
  const id = String(botId || "").toLowerCase();

  const is1987 =
    id.includes("87") ||
    id.includes("1987") ||
    id.includes("prekazi") ||
    id.includes("hagi") ||
    id.includes("cimbom") ||
    id.includes("aslan") ||
    id.includes("sami") ||
    id.includes("metin");

  if (!is1987) return null;

  const lowerHome = String(homeTeam || "").toLowerCase();
  const lowerAway = String(awayTeam || "").toLowerCase();

  const gsHome = lowerHome.includes("galatasaray");
  const gsAway = lowerAway.includes("galatasaray");

  // Romantik GS skor ağırlıkları
  const scoreOptions = [
    { h: 1, a: 0, w: gsHome ? 4 : 2 },
    { h: 2, a: 1, w: gsHome ? 4 : 2 },
    { h: 2, a: 0, w: gsHome ? 3 : 1.5 },
    { h: 1, a: 1, w: 2 },
    { h: 0, a: 0, w: 1 },
    { h: 1, a: 2, w: gsAway ? 2 : 0.5 },
    { h: 0, a: 1, w: gsAway ? 2 : 0.5 },
    { h: 3, a: 1, w: gsHome ? 1 : 0.3 },
  ];

  if (country && String(country).toLowerCase().includes("europe")) {
    scoreOptions.forEach((s) => {
      if (gsHome && s.h > s.a) s.w *= 1.4;
    });
  }

  const scoreTotal = scoreOptions.reduce((acc, s) => acc + s.w, 0);
  let rr = rng() * scoreTotal;
  let chosen = scoreOptions[0];
  for (const s of scoreOptions) {
    rr -= s.w;
    if (rr <= 0) {
      chosen = s;
      break;
    }
  }

  let outcome = "D";
  if (chosen.h > chosen.a) outcome = "H";
  else if (chosen.a > chosen.h) outcome = "A";

  const firstGoal =
    rng() < (gsHome ? 0.65 : gsAway ? 0.57 : 0.55) ? "H" : "A";

  const fhTable = gsHome
    ? [
        { value: "H", w: 3 },
        { value: "D", w: 2 },
        { value: "A", w: 1 },
      ]
    : [
        { value: "H", w: 1 },
        { value: "D", w: 2 },
        { value: "A", w: 2 },
      ];

  const fhTotal = fhTable.reduce((acc, x) => acc + x.w, 0);
  let rr2 = rng() * fhTotal;
  let firstHalf = "D";
  for (const x of fhTable) {
    rr2 -= x.w;
    if (rr2 <= 0) {
      firstHalf = x.value;
      break;
    }
  }

  // Red card
  let redAny = null;
  const rc = rng();
  if (rc < 0.28) redAny = true;
  else if (rc < 0.68) redAny = false;

  let redSide = null;
  if (redAny === true) {
    redSide = rng() < 0.5 ? "H" : "A";
  }

  // Penalty
  let penaltyAny = null;
  const pc = rng();
  if (pc < 0.32) penaltyAny = true;
  else if (pc < 0.65) penaltyAny = false;

  let penaltySide = null;
  if (penaltyAny === true) {
    penaltySide = rng() < 0.5 ? "H" : "A";
  }

  return {
    score: { h: chosen.h, a: chosen.a },
    outcome,
    firstGoal,
    firstHalf,
    redAny,
    redSide,
    penaltyAny,
    penaltySide,
    is1987: true,
  };
}
// Tek bir bot için tahmin kaydı üret
function buildBotPrediction({
  fixtureId,
  bot,
  rng,
  homeTeam,
  awayTeam,
  country,
}) {
  const nowISO = new Date().toISOString();

  // 1987GS özel mantığı
  const special = apply1987Logic(
    bot.userId,
    rng,
    homeTeam,
    awayTeam,
    country
  );
  if (special && special.score) {
    // Eski settle2 şemasına uyacak alanlar
    let redHome = undefined;
    let redAway = undefined;
    if (special.redAny === false) {
      redHome = false;
      redAway = false;
    } else if (special.redAny === true && special.redSide === "H") {
      redHome = true;
      redAway = false;
    } else if (special.redAny === true && special.redSide === "A") {
      redHome = false;
      redAway = true;
    }

    return {
      fixtureId,
      userId: bot.userId,
      outcome: special.outcome,
      home: special.score.h,
      away: special.score.a,
      firstGoal: special.firstGoal,
      firstHalf: special.firstHalf,

      redHome,
      redAway,
      redAny: special.redAny,
      redSide: special.redSide,

      penaltyAny: special.penaltyAny,
      penaltySide: special.penaltySide,

      at: nowISO,
      isBot: true,
      tag: "1987GS bot",
    };
  }

  const homeName = String(homeTeam || "").toLowerCase();
  const awayName = String(awayTeam || "").toLowerCase();
  const fav = bot.favTeam ? String(bot.favTeam).toLowerCase() : null;

  const favOnHome = fav && homeName.includes(fav);
  const favOnAway = fav && awayName.includes(fav);

  const score = botScoreGuess(rng, favOnHome, favOnAway);
  const h = score.home;
  const a = score.away;

  // Maç sonucu
  let outcome = null;
  if (h > a) outcome = "H";
  else if (a > h) outcome = "A";
  else outcome = "D";

  // İlk gol (favoriye hafif bias)
  const fg = pickWeighted(rng, [
    { value: "H", w: favOnHome ? 3 : 2 },
    { value: "A", w: favOnAway ? 3 : 2 },
  ]);

  // İlk yarı sonucu (sonuçla kabaca uyumlu)
  const firstHalf = pickWeighted(rng, [
    { value: "H", w: outcome === "H" ? 3 : 1 },
    { value: "D", w: 2 },
    { value: "A", w: outcome === "A" ? 3 : 1 },
  ]);

  // Kırmızı kart: %25 ihtimalle "var" desin
  const redAny =
    rng() < 0.25
      ? true
      : rng() < 0.15
      ? false
      : null; // bazen hiç tahmin etmesin

  let redSide = null;
  if (redAny === true) {
    redSide = pickWeighted(rng, [
      { value: "H", w: 1 },
      { value: "A", w: 1 },
    ]);
  }

  // Penaltı: %30 ihtimalle "var"
  const penaltyAny =
    rng() < 0.3
      ? true
      : rng() < 0.2
      ? false
      : null;

  let penaltySide = null;
  if (penaltyAny === true) {
    penaltySide = pickWeighted(rng, [
      { value: "H", w: 1 },
      { value: "A", w: 1 },
    ]);
  }

  // Eski settle2 şemasına uyacak alanlar
  let redHome = undefined;
  let redAway = undefined;
  if (redAny === false) {
    redHome = false;
    redAway = false;
  } else if (redAny === true && redSide === "H") {
    redHome = true;
    redAway = false;
  } else if (redAny === true && redSide === "A") {
    redHome = false;
    redAway = true;
  }

  const uid = bot.userId;
  const profile = BOT_PROFILE_MAP.get(String(uid || "").toLowerCase());
  const club = profile?.favTeam || profile?.club || bot.favTeam || null;
  const segment = profile?.segment || null;

  const isGsBot =
    (club && String(club).toLowerCase() === "galatasaray") ||
    (segment && String(segment).toUpperCase() === "GS");

  return {
    fixtureId,
    userId: uid,
    outcome,
    home: h,
    away: a,
    firstGoal: fg,
    firstHalf,

    redHome,
    redAway,
    redAny,
    redSide,

    penaltyAny,
    penaltySide,

    at: nowISO,
    isBot: true,
    tag: isGsBot ? "1987GS bot" : "global bot",
  };
}

/**
 * POST /api/pred/bots-generate
 * body: { fixtureId: "..." }
 *
 * - Aynı fixture için mevcut bot tahminlerini siler
 * - bot-profiles.json'daki tüm botlar için deterministik tahmin üretir
 * - preds.json'a yazar
 */
router.post("/pred/bots-generate", async (req, res) => {
  try {
    const fx = String(req.body?.fixtureId || "").trim();
    if (!fx) {
      return res.status(400).json({
        ok: false,
        error: "FIXTURE_ID_REQUIRED",
      });
    }

    if (!BOT_PROFILES.length) {
      return res.status(500).json({
        ok: false,
        error: "NO_BOT_PROFILES",
      });
    }

    // Mevcut tahminler
    const { list, wrap } = await loadPredList();

    // Bu fixture + bot-profiles.json'dan gelen tüm bot userId'lerini temizle
    const filtered = list.filter((p) => {
      const sameFixture = String(p.fixtureId || "") === fx;
      const uid = String(p.userId || "").trim().toLowerCase();
      const isBot = BOT_USER_ID_SET.has(uid);
      return !(sameFixture && isBot);
    });

    // Fixture meta (varsa)
    const meta = await readFixtureMeta(fx);

    // Her bot için deterministik RNG
    const newRecs = BOT_PROFILES.map((bot) => {
      const rng = makeSeededRng(`${fx}::${bot.userId}`);
      return buildBotPrediction({
        fixtureId: fx,
        bot,
        rng,
        homeTeam: meta.homeTeam,
        awayTeam: meta.awayTeam,
        country: meta.country,
      });
    });

    const finalList = filtered.concat(newRecs);

    if (wrap) {
      wrap.items = finalList;
      await writeJson(PREDS_FILE, wrap);
    } else {
      await writeJson(PREDS_FILE, finalList);
    }

    return res.json({
      ok: true,
      fixtureId: fx,
      botCount: BOT_PROFILES.length,
    });
  } catch (e) {
    console.error("BOT_GENERATE_FAILED", e);
    return res.status(500).json({
      ok: false,
      error: "BOT_GENERATE_FAILED",
      detail: String(e && (e.message || e)),
    });
  }
});

// ----------------- DEBUG: LİSTE -----------------
// GET /api/pred/list?fixtureId=...
router.get("/pred/list", async (req, res) => {
  try {
    const { list } = await loadPredList();
    const fx = String(req.query.fixtureId || "").trim();
    const filtered = fx
      ? list.filter((p) => String(p.fixtureId) === fx)
      : list;
    res.json({ ok: true, count: filtered.length, items: filtered });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: "PRED_LIST_FAILED",
      detail: String(e && (e.message || e)),
    });
  }
});

// ----------------- MAÇ BAZLI MİKRO TABLO -----------------
/**
 * GET /api/pred/match-board?fixtureId=...&segment=1987|all
 *
 * - leaderboard.json içinden ilgili maçın satırlarını okur.
 * - Botları ve kullanıcıları puanlarına göre sıralar.
 * - segment=1987 ise:
 *   - tüm botlar (özellikle Galatasaray botları) ve
 *   - users.json'da is1987:true olan kullanıcılar gösterilir.
 */
router.get("/pred/match-board", async (req, res) => {
  try {
    const fx = String(req.query.fixtureId || "").trim();
    const segment = String(req.query.segment || "all").toLowerCase();

    if (!fx) {
      return res
        .status(400)
        .json({ ok: false, error: "FIXTURE_ID_REQUIRED" });
    }

    const lb =
      (await readJson(LEADERBOARD_FILE, {
        items: [],
        updatedAt: null,
      })) || {};
    const items = Array.isArray(lb.items) ? lb.items : [];

    // Kullanıcı bilgileri (1987 üyeleri)
    const usersData =
      (await readJson(USERS_FILE, { users: [], updatedAt: null })) || {};
    const users = Array.isArray(usersData.users)
      ? usersData.users
      : [];

    const is1987User = (uid) => {
      const u = users.find(
        (x) =>
          String(x.id || x.userId || "")
            .trim()
            .toLowerCase() ===
          String(uid || "").trim().toLowerCase()
      );
      return !!(u && u.is1987);
    };

    const rowsForFixture = items.filter(
      (r) => String(r.fixtureId || "") === fx
    );

    // Segment filtresi
    const filteredRows = rowsForFixture.filter((r) => {
      const uid = String(r.userId || r.user || "").trim();
      const uidLower = uid.toLowerCase();
      const isBot = BOT_USER_ID_SET.has(uidLower);
      if (segment === "1987") {
        // 1987 segment: tüm botlar + 1987 üyeleri
        return isBot || is1987User(uid);
      }
      // all: hepsi
      return true;
    });

    // Puan ve rank
    const sorted = filteredRows
      .slice()
      .sort((a, b) => Number(b.points || 0) - Number(a.points || 0))
      .map((r, idx) => {
        const uid = String(r.userId || r.user || "").trim();
        const uidLower = uid.toLowerCase();
        const isBot = BOT_USER_ID_SET.has(uidLower);
        const profile = BOT_PROFILE_MAP.get(uidLower);

        const club = profile?.favTeam || profile?.club || null;
        const segmentCode = profile?.segment || null;

        const isGsBot =
          isBot &&
          ((club && String(club).toLowerCase() === "galatasaray") ||
            (segmentCode && String(segmentCode).toUpperCase() === "GS"));

        const baseTag = isGsBot
          ? "1987GS bot"
          : isBot
          ? "global bot"
          : is1987User(uid)
          ? "1987 üyesi"
          : null;

        return {
          userId: uid,
          label: uid,
          tag: baseTag,
          isBot,
          points: Number(r.points || 0),
          rank: idx + 1,
        };
      });

    res.json({
      ok: true,
      fixtureId: fx,
      updatedAt: lb.updatedAt || null,
      segment: segment || "all",
      count: sorted.length,
      items: sorted,
    });
  } catch (e) {
    console.error("MATCH_BOARD_FAILED", e);
    res.status(500).json({
      ok: false,
      error: "MATCH_BOARD_FAILED",
      detail: String(e && (e.message || e)),
    });
  }
});

// ----------------- DEBUG PING -----------------
// GET /api/pred/debug-ping
router.get("/pred/debug-ping", (req, res) => {
  res.json({ ok: true, where: "pred-router-alive" });
});

module.exports = router;


