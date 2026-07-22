"use strict";

const express = require("express");
const router = express.Router();
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

const BUILD = "settle2-2026-07-16-penalty20pct"; // ✅ ceza %20 orantılı
// NOT: Puanlama/ödül herkes için eşittir — premium'un maç başı avantajı YOK
// (rekabet adaleti). Premium avantajları LC ekonomisinde: bedava giriş +
// aylık kasa (bkz. lib/premium.cjs).

const DATA_DIR = path.join(__dirname, "..", "data");
const LIVE_DIR = path.join(DATA_DIR, "live");
const PREDS_FILE = path.join(DATA_DIR, "preds.json");
const TOTALS_FILE = path.join(DATA_DIR, "totals.json");
const LEADERBOARD_FILE = path.join(DATA_DIR, "leaderboard.json");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const BOT_PROFILES_PATH = path.join(DATA_DIR, "bot-profiles.json");
const WALLET_FILE = path.join(DATA_DIR, "lc-wallet.json");
const RESULTS_FILE = path.join(DATA_DIR, "results.json");
const FIXTURES_FILE = path.join(DATA_DIR, "fixtures.json");
const RT_LIVE_GS_FILE = path.join(DATA_DIR, "rt-live-gs.json");

// ✅ maç bazlı puan defteri (kalıcı history)
const MATCH_RESULTS_FILE = path.join(DATA_DIR, "match-results.json");

// 🔹 LigCoin parametreleri
const LC_START = 30;

// Bot userId set'i (LC ödülü verilmeyecek)
let BOT_USER_ID_SET = new Set();
try {
  // require cache sorunlarına rağmen bu dosya genelde sabit; sorun olursa readJson'a çeviririz
  const raw = require(BOT_PROFILES_PATH);
  if (Array.isArray(raw)) {
    BOT_USER_ID_SET = new Set(
      raw
        .map((p) => String(p.id || p.userId || "").trim().toLowerCase())
        .filter(Boolean)
    );
    console.log(`[settle2] loaded ${BOT_USER_ID_SET.size} bot ids from bot-profiles.json`);
  }
} catch (e) {
  console.log(
    "[settle2] bot-profiles.json not found or invalid; BOT_USER_ID_SET empty:",
    e && (e.message || e)
  );
}

async function readJson(file, fb = null) {
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
function stateFile(fid) {
  return path.join(LIVE_DIR, `${String(fid)}.json`);
}

async function fileExists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

function normFid(x) {
  return String(x || "").trim();
}

/* ======================
 * ✅ DEBUG ENDPOINTS
 * ====================== */

router.get("/__settle2_version", (req, res) => {
  res.json({
    ok: true,
    build: BUILD,
    dataDir: DATA_DIR,
    resultsFile: RESULTS_FILE,
    fixturesFile: FIXTURES_FILE,
    rtLiveGsFile: RT_LIVE_GS_FILE,
    matchResultsFile: MATCH_RESULTS_FILE,
    liveDir: LIVE_DIR,
    nowISO: new Date().toISOString(),
  });
});

router.get("/__settle2_debug", async (req, res) => {
  const fid = normFid(req.query.fixtureId);
  const out = {
    ok: true,
    build: BUILD,
    fixtureId: fid || null,
    files: {
      resultsExists: await fileExists(RESULTS_FILE),
      fixturesExists: await fileExists(FIXTURES_FILE),
      rtLiveGsExists: await fileExists(RT_LIVE_GS_FILE),
      matchResultsExists: await fileExists(MATCH_RESULTS_FILE),
      liveDirExists: await fileExists(LIVE_DIR),
      stateExists: fid ? await fileExists(stateFile(fid)) : false,
      statePath: fid ? stateFile(fid) : null,
    },
    sample: {},
  };

  // results.json içinde fid var mı?
  if (fid && out.files.resultsExists) {
    const results = await loadResultsList();
    const r = results.find((x) => normFid(x?.fixtureId ?? x?.id) === fid) || null;
    out.sample.resultsMatch = !!r;
    if (r) {
      out.sample.resultsRowKeys = Object.keys(r);
      out.sample.resultsScorePick = pickResultScore(r);
      out.sample.resultsMeta = r.meta || null;
    }
  }

  res.json(out);
});

/* ======================
 * ✅ STATE BOOTSTRAP
 * ====================== */

async function loadResultsList() {
  const raw = await readJson(RESULTS_FILE, null);
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.items)) return raw.items;
  if (raw && Array.isArray(raw.results)) return raw.results;
  return [];
}

async function loadFixturesList() {
  const raw = await readJson(FIXTURES_FILE, null);
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.fixtures)) return raw.fixtures;
  if (raw && Array.isArray(raw.items)) return raw.items;
  return [];
}

/**
 * ✅ results row'dan skoru çek:
 * - score.home/away
 * - scoreHome/scoreAway
 * - homeGoals/awayGoals
 * - goalsHome/goalsAway
 * - ✅ home/away (SENİN results.json formatın)
 */
function pickResultScore(r) {
  const h = r?.score?.home ?? r?.scoreHome ?? r?.homeGoals ?? r?.goalsHome ?? r?.home;
  const a = r?.score?.away ?? r?.scoreAway ?? r?.awayGoals ?? r?.goalsAway ?? r?.away;

  const hn = Number(h);
  const an = Number(a);
  if (Number.isFinite(hn) && Number.isFinite(an)) return { home: hn, away: an };
  return null;
}

function pickMetaFromFixture(fx) {
  return {
    kickoffISO: fx?.kickoffISO ?? fx?.dateISO ?? fx?.kickoff ?? null,
    country: fx?.country ?? null,
    league: fx?.league ?? null,
  };
}

async function bootstrapStateFromRtLiveGs(fid) {
  const fxid = normFid(fid);
  if (!fxid) return { ok: false, reason: "NO_FID" };

  const liveModel = await readJson(RT_LIVE_GS_FILE, null);
  const fx = liveModel && liveModel.fixtures ? liveModel.fixtures[fxid] : null;
  if (!fx) return { ok: false, reason: "NO_FIXTURE_IN_RT_LIVE_GS" };

  const scoreHome = Number(fx.homeGoals ?? fx.scoreHome ?? (fx.score && fx.score.home) ?? 0);
  const scoreAway = Number(fx.awayGoals ?? fx.scoreAway ?? (fx.score && fx.score.away) ?? 0);

  const htHome = fx.htScore?.home ?? fx.htHome ?? null;
  const htAway = fx.htScore?.away ?? fx.htAway ?? null;
  const hasHT = Number.isFinite(Number(htHome)) && Number.isFinite(Number(htAway));

  const st = {
    fixtureId: fxid,
    status: fx.status || "NS",
    minute: fx.minute ?? null,
    kickoffISO: fx.kickoffISO || null,

    country: fx.country || null,
    league: fx.league || null,

    score: {
      home: Number.isFinite(scoreHome) ? scoreHome : 0,
      away: Number.isFinite(scoreAway) ? scoreAway : 0,
    },

    firstGoal: fx.firstGoal || null,

    redHome: typeof fx.redHome === "boolean" ? fx.redHome : false,
    redAway: typeof fx.redAway === "boolean" ? fx.redAway : false,

    penaltyAny: typeof fx.penaltyAny === "boolean" ? fx.penaltyAny : false,
    penaltySide: fx.penaltySide || null,

    redEventAtISO: fx.redEventAtISO || null,
    redEventMinute: fx.redEventMinute ?? null,
    penEventAtISO: fx.penEventAtISO || null,
    penEventMinute: fx.penEventMinute ?? null,

    updatedAt: new Date().toISOString(),
    source: fx.source || "bootstrap_rt_live_gs",
  };

  if (hasHT) st.htScore = { home: Number(htHome), away: Number(htAway) };

  await writeJson(stateFile(fxid), st);
  return { ok: true, reason: "BOOTSTRAP_RT_LIVE_GS_OK" };
}

async function bootstrapStateFromResultsAndFixtures(fid) {
  const fxid = normFid(fid);
  if (!fxid) return { ok: false, reason: "NO_FID" };

  const results = await loadResultsList();
  const fixtures = await loadFixturesList();

  const r = results.find((x) => normFid(x?.fixtureId ?? x?.id) === fxid) || null;
  if (!r) return { ok: false, reason: "NO_FIXTURE_IN_RESULTS" };

  const score = pickResultScore(r);
  if (!score) return { ok: false, reason: "NO_SCORE_IN_RESULTS_ROW" };

  const fx = fixtures.find((x) => normFid(x?.fixtureId ?? x?.id) === fxid) || null;
  const metaFx = fx ? pickMetaFromFixture(fx) : {};

  const kickoffISO = metaFx.kickoffISO || r?.kickoffISO || r?.dateISO || null;
  const country = metaFx.country || r?.country || null;
  const league = metaFx.league || r?.league || null;

  const meta = r?.meta && typeof r.meta === "object" ? r.meta : {};
  const penaltyAny =
    typeof r?.penaltyAny === "boolean"
      ? r.penaltyAny
      : typeof meta.penaltyAny === "boolean"
      ? meta.penaltyAny
      : false;

  // redAny bilgi; taraf bilinmiyorsa redHome/redAway set etmiyoruz
  const redAnyInfo = typeof meta.redAny === "boolean" ? meta.redAny : false;

  const st = {
    fixtureId: fxid,
    status: "FT",
    minute: null,

    kickoffISO,
    country,
    league,

    score,

    htScore: r?.htScore || null,
    firstGoal: r?.firstGoal || null,

    redHome: false,
    redAway: false,

    penaltyAny,
    penaltySide: r?.penaltySide ?? meta.penaltySide ?? null,

    updatedAt: new Date().toISOString(),
    source: "bootstrap_results",
    bootstrapFrom: "results.json",
    resultsUpdatedAt: r?.updatedAt || null,
    resultsUpdatedBy: r?.updatedBy || null,
    resultsMetaRedAny: redAnyInfo,
  };

  await writeJson(stateFile(fxid), st);
  return { ok: true, reason: "BOOTSTRAP_RESULTS_OK" };
}

/* ======================
 * ✅ MATCH-RESULTS (HISTORY DEFTERİ)
 * ====================== */

async function loadMatchResultsBook() {
  const raw = await readJson(MATCH_RESULTS_FILE, { items: [], updatedAt: null });
  if (!raw || typeof raw !== "object") return { items: [], updatedAt: null };
  if (!Array.isArray(raw.items)) raw.items = [];
  return raw;
}

async function saveMatchResultsBook(book) {
  book.updatedAt = new Date().toISOString();
  await writeJson(MATCH_RESULTS_FILE, book);
}

async function buildFixtureMetaMap() {
  const fixtures = await loadFixturesList();
  const map = new Map();
  for (const fx of fixtures) {
    const fid = normFid(fx?.fixtureId ?? fx?.id);
    if (!fid) continue;
    map.set(fid, {
      fixtureId: fid,
      home: fx?.home ?? fx?.teamHome ?? fx?.homeTeam ?? null,
      away: fx?.away ?? fx?.teamAway ?? fx?.awayTeam ?? null,
      kickoffISO: fx?.kickoffISO ?? fx?.dateISO ?? fx?.kickoff ?? null,
      league: fx?.league ?? null,
      country: fx?.country ?? null,
    });
  }
  return map;
}

async function upsertMatchResultSnapshot({ fixtureId, finalScore, meta, rows }) {
  const nowISO = new Date().toISOString();
  const book = await loadMatchResultsBook();

  const snap = {
    fixtureId: normFid(fixtureId),
    computedAt: nowISO,
    finalScore: finalScore || null,
    meta: meta || null,
    rows: Array.isArray(rows) ? rows : [],
  };

  const idx = book.items.findIndex((x) => normFid(x?.fixtureId) === normFid(fixtureId));
  if (idx >= 0) book.items[idx] = snap;
  else book.items.push(snap);

  book.items.sort((a, b) => new Date(b.computedAt || 0) - new Date(a.computedAt || 0));
  await saveMatchResultsBook(book);

  return snap;
}

/* ======================
 *  SCORING
 * ====================== */

const SCORE_WEIGHTS = {
  Türkiye: 1.0,
  Turkey: 1.0,
  England: 1.05,
  Spain: 1.05,
  Germany: 1.05,
  Italy: 1.05,
  France: 1.05,
  Netherlands: 1.03,
  Belgium: 1.03,
  Greece: 1.03,
  Portugal: 1.03,
  Brazil: 1.03,
  Argentina: 1.03,
  Japan: 1.03,
  Russia: 1.03,
  Ukraine: 1.03,
  USA: 1.02,
  "United States": 1.02,
  "Saudi Arabia": 1.02,
  "Suudi Arabistan": 1.02,
};
function getScoreWeight(country) {
  const c = String(country || "").trim();
  return Object.prototype.hasOwnProperty.call(SCORE_WEIGHTS, c) ? SCORE_WEIGHTS[c] : 1.0;
}

// outcome(3) + exact(12) + FG(1) + HT(2) + redAny(1.5) + redSide(1) + penAny(1.5) + penSide(1) = 22
const MAX_BASE = 22;

function computeLcRewardFromDetail(detail) {
  const base = Number(detail && detail.base != null ? detail.base : 0);
  if (base >= 20) return 6;
  if (base >= 16) return 5;
  if (base >= 12) return 4;
  if (base >= 8) return 3;
  if (base >= 4) return 2;
  if (base > 0) return 1;
  return 0;
}

async function awardLcForRows(rows, db) {
  if (!rows || !rows.length) return;

  const nowISO = new Date().toISOString();

  const usersDataRaw = await readJson(USERS_FILE, { users: [], items: [] });

  // users.json: array | {users:[]} | {items:[]} toleransı
  let usersContainer = usersDataRaw;
  let usersItems = [];

  if (Array.isArray(usersDataRaw)) {
    usersContainer = { users: usersDataRaw, items: [] };
    usersItems = usersContainer.users;
  } else {
    const u1 = Array.isArray(usersDataRaw.users) ? usersDataRaw.users : [];
    const u2 = Array.isArray(usersDataRaw.items) ? usersDataRaw.items : [];
    // Öncelik: users doluysa users; değilse items
    usersItems = u1.length ? u1 : u2;
    // Eğer sadece items vardıysa, users'a da aynısını bağlayalım (tek kaynak)
    if (!u1.length && u2.length) {
      usersContainer.users = u2;
    } else if (u1.length) {
      usersContainer.users = u1;
    }
    usersContainer.items = usersContainer.users;
  }

  const walletState = (await readJson(WALLET_FILE, { users: [], ledger: [], updatedAt: null })) || {};
  const walletUsers = Array.isArray(walletState.users) ? walletState.users : [];
  if (!Array.isArray(walletState.ledger)) walletState.ledger = [];

  function ensureWalletUserRecord(uid) {
    let wu = walletUsers.find((x) => String(x.userId || "").trim().toLowerCase() === uid.toLowerCase());
    if (!wu) {
      wu = {
        userId: uid,
        balance: 0,
        createdAt: nowISO,
        updatedAt: nowISO,
        lastDailyAt: null,
        totalEarned: 0,
        totalSpent: 0,
      };
      walletUsers.push(wu);
    }
    if (typeof wu.balance !== "number") wu.balance = 0;
    if (typeof wu.totalEarned !== "number") wu.totalEarned = 0;
    if (typeof wu.totalSpent !== "number") wu.totalSpent = 0;
    return wu;
  }

  function addLedgerEntryFile({ userId, amount, reason, fixtureId }) {
    walletState.ledger.push({
      id: "tx_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8),
      userId,
      kind: "reward",
      amount,
      reason: reason || null,
      fixtureId: fixtureId || null,
      meta: null,
      createdAt: nowISO,
    });
  }

  let usersCol = null;
  let ledgerCol = null;
  if (db) {
    usersCol = db.collection("lc_wallet_users");
    ledgerCol = db.collection("lc_wallet_ledger");
  }
  const mongoUserOps = [];
  const mongoLedgerDocs = [];

  for (const r of rows) {
    const uidRaw = r.userId || r.user;
    const uid = String(uidRaw || "").trim();
    if (!uid) continue;

    const uidLower = uid.toLowerCase();
    if (BOT_USER_ID_SET.has(uidLower)) continue;

    const reward = computeLcRewardFromDetail(r.detail);
    if (reward <= 0) continue;

    let u = usersItems.find((x) => String(x.userId) === uid);
    if (!u) {
      u = { userId: uid, mainTeam: null, createdAt: nowISO, lc: LC_START + reward, lcLastDaily: null };
      usersItems.push(u);
    } else {
      if (typeof u.lc !== "number") u.lc = LC_START;
      u.lc = Number(u.lc || 0) + reward;
      u.lcUpdatedAt = nowISO;
      u.lcLastReason = "match_reward";
      u.lcLastAmount = reward;
    }

    const wu = ensureWalletUserRecord(uid);
    wu.balance += reward;
    wu.totalEarned += reward;
    wu.updatedAt = nowISO;

    addLedgerEntryFile({ userId: uid, amount: reward, reason: "match_reward", fixtureId: r.fixtureId });

    if (usersCol) {
      mongoUserOps.push({
        updateOne: {
          filter: { userIdLower: uidLower },
          update: {
            $set: { userId: uid, userIdLower: uidLower, updatedAt: nowISO },
            $setOnInsert: { createdAt: nowISO, lastDailyAt: null, totalSpent: 0, is1987: false },
            $inc: { balance: reward, totalEarned: reward },
          },
          upsert: true,
        },
      });
    }
    if (ledgerCol) {
      mongoLedgerDocs.push({
        id: "tx_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8),
        userId: uid,
        userIdLower: uidLower,
        kind: "reward",
        amount: reward,
        reason: "match_reward",
        fixtureId: r.fixtureId,
        meta: null,
        createdAt: nowISO,
      });
    }
  }

  await writeJson(USERS_FILE, {
    ...usersContainer,
    users: usersItems,
    items: usersItems,
  });
  walletState.users = walletUsers;
  walletState.updatedAt = nowISO;
  await writeJson(WALLET_FILE, walletState);

  if (usersCol && mongoUserOps.length) {
    try {
      await usersCol.bulkWrite(mongoUserOps, { ordered: false });
    } catch (e) {
      console.error("[settle2] Mongo wallet_users bulkWrite failed:", e);
    }
  }
  if (ledgerCol && mongoLedgerDocs.length) {
    try {
      await ledgerCol.insertMany(mongoLedgerDocs, { ordered: false });
    } catch (e) {
      console.error("[settle2] Mongo wallet_ledger insertMany failed:", e);
    }
  }
}

async function scoreFixture(fixtureId, { updateTotals = true, db = null, allowLive = false } = {}) {
  const fid = String(fixtureId || "");
  if (!fid) {
    const err = new Error("FIXTURE_REQUIRED");
    err.code = "FIXTURE_REQUIRED";
    err.httpStatus = 400;
    throw err;
  }

  const debug = {
    build: BUILD,
    fid,
    tried: [],
    files: {
      resultsExists: await fileExists(RESULTS_FILE),
      fixturesExists: await fileExists(FIXTURES_FILE),
      rtLiveGsExists: await fileExists(RT_LIVE_GS_FILE),
      matchResultsExists: await fileExists(MATCH_RESULTS_FILE),
      liveDirExists: await fileExists(LIVE_DIR),
      statePath: stateFile(fid),
      stateExistsBefore: await fileExists(stateFile(fid)),
    },
  };

  let st = await readJson(stateFile(fid), null);

  if (!st) {
    const r1 = await bootstrapStateFromRtLiveGs(fid);
    debug.tried.push({ step: "bootstrap_rt_live_gs", ...r1 });
    if (r1.ok) st = await readJson(stateFile(fid), null);
  }
  if (!st) {
    const r2 = await bootstrapStateFromResultsAndFixtures(fid);
    debug.tried.push({ step: "bootstrap_results", ...r2 });
    if (r2.ok) st = await readJson(stateFile(fid), null);
  }

  debug.files.stateExistsAfter = await fileExists(stateFile(fid));

  if (!st) {
    const err = new Error("STATE_NOT_FOUND");
    err.code = "STATE_NOT_FOUND";
    err.httpStatus = 404;
    err.detailObj = debug;
    throw err;
  }

  // allowLive: canlı eleme panosu (match-race) maç sürerken de anlık
  // puanlama ister; settle akışı (updateTotals:true) FT şartını korur.
  if (String(st.status) !== "FT" && !(allowLive && !updateTotals)) {
    const err = new Error("NOT_FINISHED");
    err.code = "NOT_FINISHED";
    err.httpStatus = 400;
    throw err;
  }

  // 🔹 Bu fixture'ın bağlı olduğu yarışmalar (competitionId listesi)
  let competitionIds = [];
  if (db) {
    try {
      const fcCol = db.collection("fixture_competitions");
      const fcDoc = await fcCol.findOne({ fixtureId: fid });
      if (fcDoc && Array.isArray(fcDoc.competitions)) {
        competitionIds = fcDoc.competitions
          .filter((c) => c && c.countsForPoints !== false)
          .map((c) => String(c.competitionId || "").trim())
          .filter(Boolean);
      }
    } catch (e) {
      console.error("[settle2] read fixture_competitions failed (will ignore competitions):", e);
    }
  }

  const predsRaw = await readJson(PREDS_FILE, []);
  const preds = Array.isArray(predsRaw) ? predsRaw : Array.isArray(predsRaw?.items) ? predsRaw.items : [];
  const list = preds.filter((p) => String(p.fixtureId) === fid);

  const h = Number(st.score?.home || 0);
  const a = Number(st.score?.away || 0);
  const outcome = h > a ? "H" : a > h ? "A" : "D";

  const htH = Number(st.htScore?.home ?? NaN);
  const htA = Number(st.htScore?.away ?? NaN);
  const hasHT = Number.isFinite(htH) && Number.isFinite(htA);
  const htOutcome = hasHT ? (htH > htA ? "H" : htA > htH ? "A" : "D") : null;

  const redHomeActual = !!st.redHome;
  const redAwayActual = !!st.redAway;
  const redAnyActual = redHomeActual || redAwayActual;
  const redSideActual = redHomeActual ? "H" : redAwayActual ? "A" : null;

  const fg = st.firstGoal || null;

  const penaltyAnyActual = typeof st.penaltyAny === "boolean" ? st.penaltyAny : false;
  const penaltySideActual = st.penaltySide || null;

  const w = getScoreWeight(st.country);

  // ── Topluluk çarpanları: nadir seçim daha fazla puan kazandırır ──────────
  // Sadece insan tahminleri kullanılır (botlar kitleyi eğitir, puanı etkilemez)
  const humanList = list.filter((p) => {
    const uid = String(p.userId || p.user || "").trim().toLowerCase();
    return !BOT_USER_ID_SET.has(uid);
  });
  const humanTotal = humanList.length;

  // Outcome dağılımı
  const oc3 = { H: 0, D: 0, A: 0 };
  for (const p of humanList) {
    const oc = String(p.outcome || "").toUpperCase();
    if (oc === "H" || oc === "D" || oc === "A") oc3[oc]++;
  }

  // Skor dağılımı
  const scorePickMap = new Map();
  for (const p of humanList) {
    if (
      p.home != null && p.away != null &&
      Number.isFinite(Number(p.home)) && Number.isFinite(Number(p.away))
    ) {
      const key = `${Number(p.home)}-${Number(p.away)}`;
      scorePickMap.set(key, (scorePickMap.get(key) || 0) + 1);
    }
  }

  /**
   * Outcome çarpanı (H/D/A):
   *  Herkes 1/3 seçse → 1.0x → 3 puan (baz)
   *  Çok popüler (70%) → ~0.48x → ~1.4 puan
   *  Nadir (5%)       → ~2.2x → ~6.7 puan  (max 4.0x → 12 puan)
   */
  function outcomeMultiplier(oc) {
    if (humanTotal < 5) return 1.0; // yeterli veri yok
    const n = oc3[oc] || 0;
    if (!n) return 4.0; // hiç seçen yok → max bonus
    const raw = (humanTotal / 3) / n;
    return Math.max(0.35, Math.min(4.0, raw));
  }

  /**
   * Skor çarpanı:
   *  "Adil pay" ≈ tahminlerin %5'i (20 yaygın skor varsayımı)
   *  %25 seçmişse  → 0.2x → capped 0.6x → ~7 puan
   *  %5 seçmişse   → 1.0x → 12 puan (baz)
   *  %1 seçmişse   → 5.0x → capped 2.0x → 24 puan
   *  Hiç seçmeyen  → 2.5x → 30 puan (ultra nadir)
   */
  function scoreMultiplier(sh, sa) {
    if (humanTotal < 5) return 1.0;
    const key = `${sh}-${sa}`;
    const n = scorePickMap.get(key) || 0;
    if (!n) return 2.5;
    const fairShare = humanTotal * 0.05;
    const raw = fairShare / n;
    return Math.max(0.6, Math.min(2.5, raw));
  }
  // ─────────────────────────────────────────────────────────────────────────

  const rows = [];

  for (const p of list) {
    const u = p.userId || p.user || "anon";
    let pts = 0;
    const detail = {};

    // 1) Sonuç (1X2): doğru = baz(3) × topluluk çarpanı, yanlış -1
    if (p.outcome && typeof p.outcome === "string") {
      const oc = p.outcome.toUpperCase();
      const ok = oc === outcome;
      const mult = outcomeMultiplier(oc);
      const earn = Math.round(3 * mult * 10) / 10;
      detail.outcome = ok ? earn : -1;
      detail.outcomeMultiplier = Math.round(mult * 100) / 100;
      pts += detail.outcome;
    }

    // 2) Skor: doğru = baz(12) × skor çarpanı, yanlış -0.1
    const hasScorePred =
      p.home !== null &&
      p.home !== undefined &&
      p.away !== null &&
      p.away !== undefined &&
      Number.isFinite(Number(p.home)) &&
      Number.isFinite(Number(p.away));

    if (hasScorePred) {
      const ph = Number(p.home);
      const pa = Number(p.away);
      const ok = ph === h && pa === a;
      const mult = scoreMultiplier(ph, pa);
      const earn = Math.round(12 * mult * 10) / 10;
      detail.exact = ok ? earn : -0.1;
      detail.scoreMultiplier = Math.round(mult * 100) / 100;
      pts += detail.exact;
    }

    // 3) İlk gol: doğru +1, yanlış -0.2
    if (p.firstGoal) {
      const ok = String(p.firstGoal).toUpperCase() === String(fg || "");
      detail.firstGoal = ok ? 1 : -0.2;
      pts += detail.firstGoal;
    }

    // 4) İlk yarı: doğru +2, yanlış -0.4
    if (hasHT && p.firstHalf) {
      const ok = String(p.firstHalf).toUpperCase() === htOutcome;
      detail.firstHalf = ok ? 2 : -0.4;
      pts += detail.firstHalf;
    }

    // 5) Kırmızı kart
    let redAnyPts = 0;
    let redSidePts = 0;
    let redSidePenalty = 0;

    let predRedAny = typeof p.redAny === "boolean" ? p.redAny : null;
    let predRedSide = p.redSide != null ? String(p.redSide).toUpperCase() : null;
    if (predRedSide !== "H" && predRedSide !== "A") predRedSide = null;

    // Eski şema fallback
    if (predRedAny === null && (typeof p.redHome === "boolean" || typeof p.redAway === "boolean")) {
      const legacyRedHome = !!p.redHome;
      const legacyRedAway = !!p.redAway;
      predRedAny = legacyRedHome || legacyRedAway;
      predRedSide = legacyRedHome ? "H" : legacyRedAway ? "A" : null;
    }

    if (predRedAny === true || predRedAny === false) {
      redAnyPts = predRedAny === redAnyActual ? 1.5 : -0.3;
    }

    if (predRedAny === true && predRedSide && redAnyActual === true) {
      const act = redSideActual ? String(redSideActual).toUpperCase() : null;
      if (act && predRedSide === act) redSidePts = 1;
      else redSidePenalty = -0.2;
    }

    detail.redAny = redAnyPts;
    detail.redSide = redSidePts;
    detail.redSidePenalty = redSidePenalty;
    pts += redAnyPts + redSidePts + redSidePenalty;

    // 6) Penaltı
    let penaltyAnyPts = 0;
    let penaltySidePts = 0;
    let penaltySidePenalty = 0;

    const predPenaltyAny = typeof p.penaltyAny === "boolean" ? p.penaltyAny : null;
    let predPenaltySide = p.penaltySide != null ? String(p.penaltySide).toUpperCase() : null;
    if (predPenaltySide !== "H" && predPenaltySide !== "A") predPenaltySide = null;

    if (predPenaltyAny === true || predPenaltyAny === false) {
      penaltyAnyPts = predPenaltyAny === penaltyAnyActual ? 1.5 : -0.3;
    }

    if (predPenaltyAny === true && predPenaltySide && penaltyAnyActual === true) {
      const act = penaltySideActual ? String(penaltySideActual).toUpperCase() : null;
      if (act && predPenaltySide === act) penaltySidePts = 1;
      else penaltySidePenalty = -0.2;
    }

    detail.penaltyAny = penaltyAnyPts;
    detail.penaltySide = penaltySidePts;
    detail.penaltySidePenalty = penaltySidePenalty;
    pts += penaltyAnyPts + penaltySidePts + penaltySidePenalty;

    detail.zeroPenalty = 0;

    // base: sadece pozitif puanlardan hesaplanır (LC ödülü için), cezalar ayrı
    const base =
      Math.max(0, Number(detail.outcome || 0)) +
      Math.max(0, Number(detail.exact || 0)) +
      Math.max(0, Number(detail.firstGoal || 0)) +
      Math.max(0, Number(detail.firstHalf || 0)) +
      Math.max(0, Number(detail.redAny || 0)) +
      Math.max(0, Number(detail.redSide || 0)) +
      Math.max(0, Number(detail.penaltyAny || 0)) +
      Math.max(0, Number(detail.penaltySide || 0));

    detail.base = Math.max(0, Number(base || 0)); // üst sınır kalktı: çarpanlar değeri artırabilir

    const weightedPoints = pts * w;

    rows.push({
      fixtureId: fid,
      userId: String(u),
      points: Number.isFinite(weightedPoints) ? weightedPoints : 0,
      detail,
    });
  }

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
      competitionIds,
    };
  }

  await awardLcForRows(rows, db);

  const nowISO = new Date().toISOString();

  await writeJson(LEADERBOARD_FILE, { items: rows, updatedAt: nowISO });

  // ✅ match-results snapshot (kalıcı maç bazlı kayıt)
  try {
    const fxMap = await buildFixtureMetaMap();
    const fxMeta = fxMap.get(fid) || {};

    await upsertMatchResultSnapshot({
      fixtureId: fid,
      finalScore: { home: h, away: a },
      meta: {
        fixtureId: fid,
        home: fxMeta.home || null,
        away: fxMeta.away || null,
        kickoffISO: fxMeta.kickoffISO || st.kickoffISO || null,
        league: fxMeta.league || st.league || null,
        country: fxMeta.country || st.country || null,
        status: st.status || "FT",
      },
      rows,
    });
  } catch (e) {
    console.error("[settle2] match-results snapshot write failed:", e);
  }

  const totalsRaw = await readJson(TOTALS_FILE, { items: [], updatedAt: null });

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
    const cur = map.get(key) || { userId: key, totalPoints: 0, totalPenalty: 0, matches: 0, lastAt: null };

    cur.totalPoints += Number(r.points || 0);
    cur.totalPenalty +=
      Number(r.detail?.zeroPenalty || 0) +
      Number(r.detail?.redSidePenalty || 0) +
      Number(r.detail?.penaltySidePenalty || 0);

    cur.matches += 1;
    cur.lastAt = nowISO;
    map.set(key, cur);
  }

  const outTotals = {
    items: Array.from(map.values()).map((x) => ({
      ...x,
      totalPoints: Math.round(x.totalPoints),
      totalPenalty: Math.round(x.totalPenalty),
    })),
    updatedAt: nowISO,
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
    competitionIds,
  };
}

/* ======================
 * TOURNAMENT AUTO-SETTLE
 * ====================== */

const TOURNAMENTS_FILE = path.join(DATA_DIR, "tournaments.json");

async function loadTournaments() {
  const raw = await readJson(TOURNAMENTS_FILE, { tournaments: [] });
  return Array.isArray(raw?.tournaments) ? raw.tournaments : [];
}

async function saveTournaments(list) {
  await writeJson(TOURNAMENTS_FILE, { tournaments: list });
}

async function getFixtureOutcome(fid) {
  const st = await readJson(stateFile(fid), null);
  if (!st || String(st.status) !== "FT") return null;
  const h = Number(st.score?.home ?? 0);
  const a = Number(st.score?.away ?? 0);
  return h > a ? "H" : a > h ? "A" : "D";
}

async function tryAutoSettleTournaments(settledFixtureId, settledOutcome, db) {
  try {
    const all = await loadTournaments();
    const open = all.filter(
      (t) => t.status === "open" && Array.isArray(t.fixtureIds) && t.fixtureIds.includes(settledFixtureId)
    );
    if (!open.length) return;

    const { calcOdds } = require("../services/odds-engine.cjs");
    const PAYOUT_TABLE = { 2: [0.70, 0.30], 3: [0.70, 0.30], 4: [0.60, 0.25, 0.15], 5: [0.60, 0.25, 0.15], 6: [0.60, 0.25, 0.15], 7: [0.60, 0.25, 0.15] };
    const PAYOUT_8PLUS = [0.50, 0.25, 0.15, 0.10];
    const nowISO = new Date().toISOString();

    for (const t of open) {
      // Check all fixtures have FT results
      const results = {};
      let allDone = true;
      for (const fid of t.fixtureIds) {
        const outcome = fid === settledFixtureId ? settledOutcome : await getFixtureOutcome(fid);
        if (!outcome) { allDone = false; break; }
        results[fid] = { outcome };
      }
      if (!allDone) continue;

      // Score participants
      for (const p of t.participants) {
        let score = 0;
        for (const fid of t.fixtureIds) {
          const pred = p.predictions[fid];
          if (!pred || !results[fid]) continue;
          const fx = (t.fixtures || []).find(f => f.fixtureId === fid);
          const odds = fx ? calcOdds(fx.home, fx.away) : { home: 2, draw: 3, away: 2 };
          const outcomeOdd = pred.outcome === "H" ? odds.home : pred.outcome === "D" ? odds.draw : odds.away;
          if (pred.outcome === results[fid].outcome) {
            score += Math.round(10 * outcomeOdd);
          }
        }
        p.totalScore = score;
      }

      const sorted = [...t.participants].sort((a, b) => b.totalScore - a.totalScore);
      const n = sorted.length;
      const table = n >= 8 ? PAYOUT_8PLUS : (PAYOUT_TABLE[n] || PAYOUT_TABLE[2]);

      t.payouts = table.map((pct, i) => {
        const user = sorted[i];
        if (!user) return null;
        return { rank: i + 1, userId: user.userId, score: user.totalScore, lcWon: Math.round(t.pool * pct), pct: Math.round(pct * 100) };
      }).filter(Boolean);

      t.status = "settled";
      t.settledAt = nowISO;

      // Credit winners' wallets
      const walletState = (await readJson(WALLET_FILE, { users: [], ledger: [], updatedAt: null })) || {};
      if (!Array.isArray(walletState.users)) walletState.users = [];
      if (!Array.isArray(walletState.ledger)) walletState.ledger = [];

      for (const payout of t.payouts) {
        if (!payout.lcWon || payout.lcWon <= 0) continue;
        const uid = payout.userId;
        const uidLower = uid.toLowerCase();
        let wu = walletState.users.find(x => String(x.userId || "").toLowerCase() === uidLower);
        if (!wu) {
          wu = { userId: uid, balance: 0, createdAt: nowISO, updatedAt: nowISO, lastDailyAt: null, totalEarned: 0, totalSpent: 0 };
          walletState.users.push(wu);
        }
        wu.balance = (wu.balance || 0) + payout.lcWon;
        wu.totalEarned = (wu.totalEarned || 0) + payout.lcWon;
        wu.updatedAt = nowISO;
        walletState.ledger.push({
          id: "tx_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8),
          userId: uid, kind: "reward", amount: payout.lcWon,
          reason: "tournament_payout", meta: { tournamentCode: t.code, rank: payout.rank },
          createdAt: nowISO,
        });

        if (db) {
          try {
            const col = db.collection("lc_wallet_users");
            await col.updateOne(
              { userIdLower: uidLower },
              { $inc: { balance: payout.lcWon, totalEarned: payout.lcWon }, $set: { updatedAt: nowISO }, $setOnInsert: { userId: uid, userIdLower: uidLower, createdAt: nowISO, lastDailyAt: null, totalSpent: 0 } },
              { upsert: true }
            );
            const ledgerCol = db.collection("lc_wallet_ledger");
            await ledgerCol.insertOne({ id: "tx_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8), userId: uid, userIdLower: uidLower, kind: "reward", amount: payout.lcWon, reason: "tournament_payout", meta: { tournamentCode: t.code, rank: payout.rank }, createdAt: nowISO });
          } catch (e) {
            console.error("[settle2] tournament payout mongo failed:", e);
          }
        }
      }

      walletState.updatedAt = nowISO;
      await writeJson(WALLET_FILE, walletState);
      console.log(`[settle2] auto-settled tournament ${t.code}: ${t.payouts.length} payouts`);
    }

    await saveTournaments(all);
  } catch (e) {
    console.error("[settle2] tryAutoSettleTournaments failed:", e);
  }
}

/**
 * POST /api/rt/settle2
 */
router.post("/settle2", async (req, res) => {
  try {
    const fixtureId = String(req.query.fixtureId || req.body?.fixtureId || "");
    const db = req.app?.locals?.db || null;

    const result = await scoreFixture(fixtureId, { updateTotals: true, db });

    // Fire-and-forget: tournaments that include this fixture
    tryAutoSettleTournaments(fixtureId, result.outcome, db).catch(() => {});

    return res.json({ ok: true, ...result });
  } catch (e) {
    console.error("SAFE_SETTLE2_FAILED", e);
    const status = e && e.httpStatus ? e.httpStatus : 500;
    const code = e && e.code ? e.code : "SAFE_SETTLE2_FAILED";

    const payload = {
      ok: false,
      error: code,
      detail: String(e && (e.message || e)),
    };

    if (e && e.code === "STATE_NOT_FOUND" && e.detailObj) {
      payload.debug = e.detailObj;
    }

    return res.status(status).json(payload);
  }
});

/**
 * GET /api/rt/pred/preview-match-board?fixtureId=...
 * ✅ yan etkisiz preview (history snapshot okumaz; anlık hesaplar)
 */
router.get("/pred/preview-match-board", async (req, res) => {
  try {
    const fixtureId = String(req.query.fixtureId || "");
    const result = await scoreFixture(fixtureId, { updateTotals: false, db: null });
    return res.json({ ok: true, ...result });
  } catch (e) {
    console.error("MATCH_BOARD_FAILED", e);
    const status = e && e.httpStatus ? e.httpStatus : 500;
    const code = e && e.code ? e.code : "MATCH_BOARD_FAILED";

    const payload = {
      ok: false,
      error: code,
      detail: String(e && (e.message || e)),
    };
    if (e && e.code === "STATE_NOT_FOUND" && e.detailObj) {
      payload.debug = e.detailObj;
    }

    return res.status(status).json(payload);
  }
});

/**
 * GET /api/rt/match-race?fixtureId=...&userId=...&top=50
 *
 * 🔥 Canlı eleme panosu: admin/af-sync maç durumunu her güncellediğinde
 * (dk 16, 0-1, kırmızı kart, penaltı...) TÜM tahminler anlık state'e göre
 * yeniden puanlanır. Dönen veri:
 *  - top: ilk N (herkese görünür liste)
 *  - me: isteği yapan kullanıcının ANLIK sırası (örn. 351.), puanı,
 *        tahmini hâlâ "tutuyor" mu (outcome == anlık outcome)
 *  - totalPlayers: maça tahmin giren toplam kişi
 *  - inRaceCount: tahmini şu anki skorla hâlâ tutan kişi (3000 -> 1200 -> 400)
 *  - state: dakika/skor/durum özeti
 * Yan etkisizdir (totals'a yazmaz). Az-sorgu modeliyle uyumlu: veri
 * data/live state dosyasından gelir; sağlayıcıya istek atmaz.
 */
router.get("/match-race", async (req, res) => {
  try {
    const fixtureId = String(req.query.fixtureId || "").trim();
    const userId = String(req.query.userId || "").trim();
    const topN = Math.max(1, Math.min(100, Number(req.query.top || 50)));
    if (!fixtureId) return res.status(400).json({ ok: false, error: "FIXTURE_ID_REQUIRED" });

    const result = await scoreFixture(fixtureId, { updateTotals: false, db: null, allowLive: true });
    const st = await readJson(stateFile(fixtureId), null);

    const rows = (result.leaderboard || [])
      .slice()
      .sort((a, b) => (b.points || 0) - (a.points || 0) || String(a.userId).localeCompare(String(b.userId)));

    // "Tutuyor" = kullanıcının 1X2 tahmini şu anki outcome ile aynı
    const currentOutcome = result.outcome || null;
    const predsRaw = await readJson(PREDS_FILE, []);
    const predsAll = Array.isArray(predsRaw) ? predsRaw : predsRaw.items || [];
    const outcomeByUser = new Map();
    for (const p of predsAll) {
      if (String(p.fixtureId) !== fixtureId) continue;
      const uid = String(p.userId || p.user || "").trim().toLowerCase();
      if (uid) outcomeByUser.set(uid, String(p.outcome || "").toUpperCase() || null);
    }

    let inRaceCount = 0;
    const decorated = rows.map((r, ix) => {
      const uidLower = String(r.userId || "").toLowerCase();
      const pick = outcomeByUser.get(uidLower) || null;
      const inRace = !!(pick && currentOutcome && pick === currentOutcome);
      if (inRace) inRaceCount++;
      return {
        rank: ix + 1,
        userId: r.userId,
        points: Math.round((r.points || 0) * 100) / 100,
        inRace,
      };
    });

    let me = null;
    if (userId) {
      const mine = decorated.find((r) => String(r.userId).toLowerCase() === userId.toLowerCase());
      if (mine) me = mine;
    }

    return res.json({
      ok: true,
      fixtureId,
      state: {
        status: st?.status || "NS",
        minute: st?.minute ?? null,
        score: st?.score || result.finalScore || null,
        home: st?.home || null,
        away: st?.away || null,
        firstGoal: result.firstGoal || null,
        redAny: result.redAny || false,
        penaltyAny: result.penaltyAny || false,
        updatedAt: st?.updatedAt || null,
      },
      totalPlayers: decorated.length,
      inRaceCount,
      top: decorated.slice(0, topN),
      me,
    });
  } catch (e) {
    const status = e && e.httpStatus ? e.httpStatus : 500;
    return res.status(status).json({
      ok: false,
      error: (e && e.code) || "MATCH_RACE_FAILED",
      detail: String(e && (e.message || e)),
    });
  }
});

/**
 * GET /api/rt/pred/history?userId=...&limit=50
 * ✅ Kullanıcının maç bazlı puan geçmişi (match-results.json)
 */
router.get("/pred/history", async (req, res) => {
  try {
    const userId = String(req.query.userId || "").trim();
    const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));

    if (!userId) return res.status(400).json({ ok: false, error: "USER_ID_REQUIRED" });

    const book = await loadMatchResultsBook();
    const uidLower = userId.toLowerCase();

    const out = [];
    for (const snap of book.items || []) {
      const rows = Array.isArray(snap.rows) ? snap.rows : [];
      const mine = rows.find((r) => String(r.userId || "").trim().toLowerCase() === uidLower);
      if (!mine) continue;

      out.push({
        fixtureId: snap.fixtureId,
        computedAt: snap.computedAt || null,
        points: mine.points ?? 0,
        detail: mine.detail || null,
        finalScore: snap.finalScore || null,
        meta: snap.meta || null,
      });

      if (out.length >= limit) break;
    }

    return res.json({ ok: true, userId, count: out.length, items: out });
  } catch (e) {
    return res
      .status(500)
      .json({ ok: false, error: "PRED_HISTORY_FAILED", detail: String(e && (e.message || e)) });
  }
});

/**
 * GET /api/rt/pred/history/detail?userId=...&fixtureId=...
 * ✅ Tek maç detayı: tahmin + gerçek + puan kırılımı
 */
router.get("/pred/history/detail", async (req, res) => {
  try {
    const userId = String(req.query.userId || "").trim();
    const fixtureId = normFid(req.query.fixtureId);

    if (!userId) return res.status(400).json({ ok: false, error: "USER_ID_REQUIRED" });
    if (!fixtureId) return res.status(400).json({ ok: false, error: "FIXTURE_ID_REQUIRED" });

    const book = await loadMatchResultsBook();
    const snap = (book.items || []).find((x) => normFid(x?.fixtureId) === fixtureId) || null;
    if (!snap) return res.status(404).json({ ok: false, error: "MATCH_RESULT_NOT_FOUND" });

    const uidLower = userId.toLowerCase();
    const row =
      (Array.isArray(snap.rows) ? snap.rows : []).find(
        (r) => String(r.userId || "").trim().toLowerCase() === uidLower
      ) || null;

    // preds.json içinden benim tahminim (son kaydı tercih eder)
    const predsRaw = await readJson(PREDS_FILE, []);
    const preds = Array.isArray(predsRaw) ? predsRaw : Array.isArray(predsRaw?.items) ? predsRaw.items : [];
    const myPred =
      preds
        .slice()
        .reverse()
        .find(
          (p) =>
            String(p.fixtureId) === fixtureId &&
            String(p.userId || "").trim().toLowerCase() === uidLower
        ) || null;

    // state (varsa) — gerçek meta/FT kanıtı
    const st = await readJson(stateFile(fixtureId), null);

    return res.json({
      ok: true,
      userId,
      fixtureId,
      prediction: myPred || null,
      result: {
        finalScore: snap.finalScore || null,
        meta: snap.meta || null,
        state: st || null,
      },
      scoring: row ? { points: row.points ?? 0, detail: row.detail || null } : { points: 0, detail: null },
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: "PRED_HISTORY_DETAIL_FAILED",
      detail: String(e && (e.message || e)),
    });
  }
});

module.exports = router;
