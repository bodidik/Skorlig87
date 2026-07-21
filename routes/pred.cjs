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
const WALLET_FILE = path.join(DATA_DIR, "lc-wallet.json");

// 🔹 Otomatik LC birikimi (token bitince bekle)
const { applyRegen } = require("../lib/lc-regen.cjs");
// 🔹 Premium ayrıcalıkları
const premium = require("../lib/premium.cjs");
// 🔹 Atomik yazma + dosya kilidi (race önleme)
const { withFileLock, writeJsonAtomic } = require("../lib/fileLock.cjs");
const { verifyToken } = require("../middleware/verifyToken.cjs");

// 🔹 LigCoin / cüzdan parametreleri
// lc-wallet.cjs ile SENKRON tutulmalı
const DAILY_LC = 5;
const INITIAL_DEFAULT = 30;
const INITIAL_1987 = 60;
const LC_MATCH_COST = 3; // matchEntryCost – hem backend hem frontend bu rakamla uyumlu

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
  // Atomik yazma (tmp + rename) — yarım/bozuk dosya oluşmaz.
  await writeJsonAtomic(file, data);
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

/* ======================
 *  WALLET HELPER'LARI – DOSYA MODU
 *  (lc-wallet.cjs ile uyumlu, fallback)
 * ====================== */

async function loadWalletState() {
  const fb = { users: [], ledger: [], updatedAt: null };
  const state = (await readJson(WALLET_FILE, fb)) || fb;
  if (!Array.isArray(state.users)) state.users = [];
  if (!Array.isArray(state.ledger)) state.ledger = [];
  return state;
}

async function saveWalletState(state) {
  state.updatedAt = new Date().toISOString();
  await writeJson(WALLET_FILE, state);
}

function addLedgerEntryFile(state, { userId, kind, amount, reason, fixtureId, meta }) {
  const nowISO = new Date().toISOString();
  state.ledger.push({
    id:
      "tx_" +
      Date.now().toString(36) +
      "_" +
      Math.random().toString(36).slice(2, 8),
    userId,
    kind,
    amount,
    reason: reason || null,
    fixtureId: fixtureId || null,
    meta: meta || null,
    createdAt: nowISO,
  });
}

async function isUser1987Member(userId) {
  const uid = String(userId || "").trim();
  if (!uid) return false;

  const raw = (await readJson(USERS_FILE, { users: [], items: [] })) || {};

  const list = [];
  const pushUser = (u) => {
    if (!u) return;
    const id = String(u.userId || u.id || "").trim();
    if (!id) return;
    list.push({ ...u, userId: id });
  };

  if (Array.isArray(raw.users)) raw.users.forEach(pushUser);
  if (Array.isArray(raw.items)) raw.items.forEach(pushUser);

  const u = list.find(
    (u) =>
      String(u.userId || "")
        .trim()
        .toLowerCase() === uid.toLowerCase()
  );
  if (!u) return false;

  const seg = String(u.segment || "").toLowerCase();
  return u.is1987 === true || seg === "1987";
}

async function ensureWalletUserFile(userId) {
  const uid = String(userId || "").trim();
  if (!uid) throw new Error("USER_REQUIRED");

  const state = await loadWalletState();

  let u = state.users.find(
    (x) =>
      String(x.userId || "")
        .trim()
        .toLowerCase() === uid.toLowerCase()
  );

  if (!u) {
    const is1987 = await isUser1987Member(uid);
    const initialBalance = is1987 ? INITIAL_1987 : INITIAL_DEFAULT;
    const nowISO = new Date().toISOString();
    u = {
      userId: uid,
      balance: initialBalance,
      createdAt: nowISO,
      updatedAt: nowISO,
      lastDailyAt: null,
      totalEarned: initialBalance,
      totalSpent: 0,
    };
    state.users.push(u);

    addLedgerEntryFile(state, {
      userId: uid,
      kind: "init",
      amount: initialBalance,
      reason: is1987 ? "initial_1987" : "initial_default",
    });

    await saveWalletState(state);
  }

  return { state, user: u };
}

/**
 * Maç başı LC harcama – DOSYA MODU:
 *  - alreadyPredicted = true ise kesinti yapmaz.
 *  - cost <= 0 ise kesinti yok.
 *  - Yetersiz LC varsa ok:false döner, preds yazılmaz.
 *  - Tüm hareketler lc-wallet.json / ledger üzerinden takip edilir.
 */
async function spendLcMatchIfNeededFile(userId, fixtureId, cost, alreadyPredicted) {
  const uid = String(userId || "").trim();
  if (!uid) throw new Error("USER_REQUIRED");

  const isPrem = await premium.isPremium(uid);

  // Cüzdan read-modify-write — kilitli (lost update / çift-harcama önlenir)
  return withFileLock(WALLET_FILE, async () => {
    const { state, user } = await ensureWalletUserFile(uid);

    // Otomatik birikim: bakiye düşükse bekleyen tokenler burada işlenir,
    // böylece "tokeni biten" kullanıcı süre dolunca tekrar tahmin girebilir.
    const regenEarned = applyRegen(user, Date.now(), premium.regenParams(isPrem));

    // İlk tahmin dışındakilerde veya cost <= 0 ise kesinti yok, sadece bakiye döner
    if (alreadyPredicted || cost <= 0) {
      if (regenEarned > 0) await saveWalletState(state);
      return {
        ok: true,
        lc: Number(user.balance || 0),
        charged: false,
        matchCost: 0,
      };
    }

    const current = Number(user.balance || 0);
    if (current < cost) {
      if (regenEarned > 0) await saveWalletState(state);
      return {
        ok: false,
        error: "LC_NOT_ENOUGH",
        lc: current,
        needed: cost,
      };
    }

    const nowISO = new Date().toISOString();
    user.balance = current - cost;
    user.totalSpent = (user.totalSpent || 0) + cost;
    user.updatedAt = nowISO;

    addLedgerEntryFile(state, {
      userId: uid,
      kind: "spend",
      amount: -cost,
      reason: "match_pred", // <─ ledger ekranıyla uyumlu
      fixtureId,
      meta: { type: "pred_submit" },
    });

    await saveWalletState(state);

    return {
      ok: true,
      lc: Number(user.balance || 0),
      charged: true,
      matchCost: cost,
    };
  });
}

/* ======================
 *  Mongo helper’lar
 * ====================== */

function getDb(req) {
  return req?.app?.locals?.db || null;
}

async function addLedgerEntryMongo(db, { userId, kind, amount, reason, fixtureId, meta }) {
  const uid = String(userId || "").trim();
  if (!db || !uid) return;

  const ledgerCol = db.collection("lc_wallet_ledger");
  const nowISO = new Date().toISOString();

  await ledgerCol.insertOne({
    id:
      "tx_" +
      Date.now().toString(36) +
      "_" +
      Math.random().toString(36).slice(2, 8),
    userId: uid,
    userIdLower: uid.toLowerCase(),
    kind,
    amount,
    reason: reason || null,
    fixtureId: fixtureId || null,
    meta: meta || null,
    createdAt: nowISO,
  });
}

async function ensureWalletUserMongo(db, userId) {
  const uid = String(userId || "").trim();
  if (!db || !uid) throw new Error("USER_REQUIRED");

  const col = db.collection("lc_wallet_users");
  const uidLower = uid.toLowerCase();
   
  let user = await col.findOne({ userIdLower: uidLower });
  if (!user) {
    // 1987 üyeliğini şimdilik USERS_FILE üzerinden okuyoruz (lc-wallet.cjs’yle uyumlu).
    const is1987 = await isUser1987Member(uid);
    const initialBalance = is1987 ? INITIAL_1987 : INITIAL_DEFAULT;
    const nowISO = new Date().toISOString();

    const doc = {
      userId: uid,
      userIdLower: uidLower,
      balance: initialBalance,
      createdAt: nowISO,
      updatedAt: nowISO,
      lastDailyAt: null,
      totalEarned: initialBalance,
      totalSpent: 0,
      is1987: !!is1987,
    };

    await col.insertOne(doc);

    await addLedgerEntryMongo(db, {
      userId: uid,
      kind: "init",
      amount: initialBalance,
      reason: is1987 ? "initial_1987" : "initial_default",
    });

    user = doc;
  }

  return user;
}

/**
 * Maç başı LC harcama – MONGO MODU:
 *  - alreadyPredicted = true → kesinti yok, sadece bakiye döner.
 *  - cost <= 0 → kesinti yok.
 *  - Yetersiz LC → ok:false, preds yazılmaz.
 *  - updateOne ile yarış koşullarına dayanıklı, atomic update.
 */
async function spendLcMatchIfNeededMongo(db, userId, fixtureId, cost, alreadyPredicted) {
  if (!db) {
    // Güvenlik için; normalde buraya gelmemeli.
    return spendLcMatchIfNeededFile(userId, fixtureId, cost, alreadyPredicted);
  }

  const uid = String(userId || "").trim();
  if (!uid) throw new Error("USER_REQUIRED");

  const col = db.collection("lc_wallet_users");
  const uidLower = uid.toLowerCase();

  // Kullanıcı dokümanı garanti olsun
  let user = await ensureWalletUserMongo(db, uid);

  // İkinci / üçüncü düzeltmelerde veya cost <= 0’da hiç kesme
  if (alreadyPredicted || cost <= 0) {
    return {
      ok: true,
      lc: Number(user.balance || 0),
      charged: false,
      matchCost: 0,
    };
  }

  const current = Number(user.balance || 0);
  if (current < cost) {
    return {
      ok: false,
      error: "LC_NOT_ENOUGH",
      lc: current,
      needed: cost,
    };
  }

  const nowISO = new Date().toISOString();

  // Optimistic concurrency: mevcut balance'a göre kes
  const result = await col.updateOne(
    { userIdLower: uidLower, balance: current },
    {
      $inc: {
        balance: -cost,
        totalSpent: cost,
      },
      $set: {
        updatedAt: nowISO,
      },
    }
  );

  if (!result.matchedCount) {
    // Yarış durumu: bakiyeyi taze oku, tekrar değerlendirmeyi dene
    const fresh = await col.findOne({ userIdLower: uidLower });
    const freshBalance = Number(fresh?.balance || 0);

    if (freshBalance < cost) {
      return {
        ok: false,
        error: "LC_NOT_ENOUGH",
        lc: freshBalance,
        needed: cost,
      };
    }

    const now2 = new Date().toISOString();
    await col.updateOne(
      { userIdLower: uidLower },
      {
        $inc: {
          balance: -cost,
          totalSpent: cost,
        },
        $set: {
          updatedAt: now2,
        },
      }
    );

    const finalUser = await col.findOne({ userIdLower: uidLower });
    const finalBalance = Number(finalUser?.balance || 0);

    await addLedgerEntryMongo(db, {
      userId: uid,
      kind: "spend",
      amount: -cost,
      reason: "match_pred",
      fixtureId,
      meta: { type: "pred_submit" },
    });

    return {
      ok: true,
      lc: finalBalance,
      charged: true,
      matchCost: cost,
    };
  }

  // İlk deneme başarılı
  const finalUser = await col.findOne({ userIdLower: uidLower });
  const finalBalance = Number(finalUser?.balance || current - cost);

  await addLedgerEntryMongo(db, {
    userId: uid,
    kind: "spend",
    amount: -cost,
    reason: "match_pred",
    fixtureId,
    meta: { type: "pred_submit" },
  });

  return {
    ok: true,
    lc: finalBalance,
    charged: true,
    matchCost: cost,
  };
}

// ----------------- BOT PROFİLLERİ + RNG -----------------

/**
 * Yeni sistem:
 * - data/bot-profiles.json içinden bot profilleri okunur.
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

// =====================
// Mongo helper – predictions mirror
// =====================

async function upsertPredictionMongo(db, rec, opts = {}) {
  if (!db || !rec) return;
  const col = db.collection("predictions");
  const uid = String(rec.userId || "").trim();
  if (!uid) return;
  const uidLower = uid.toLowerCase();

  const doc = {
    fixtureId: rec.fixtureId,
    userId: uid,
    userIdLower: uidLower,
    isBot: !!rec.isBot,
    outcome: rec.outcome ?? null,
    home:
      typeof rec.home === "number"
        ? rec.home
        : rec.home == null
        ? null
        : Number(rec.home),
    away:
      typeof rec.away === "number"
        ? rec.away
        : rec.away == null
        ? null
        : Number(rec.away),
    firstGoal: rec.firstGoal || null,
    firstHalf: rec.firstHalf || null,
    redAny: typeof rec.redAny === "boolean" ? rec.redAny : null,
    redSide: rec.redSide || null,
    redHome:
      typeof rec.redHome === "boolean" ? rec.redHome : null,
    redAway:
      typeof rec.redAway === "boolean" ? rec.redAway : null,
    penaltyAny:
      typeof rec.penaltyAny === "boolean" ? rec.penaltyAny : null,
    penaltySide: rec.penaltySide || null,
    at: rec.at || new Date().toISOString(),
    tag: rec.tag || null,
    source: opts.source || (rec.isBot ? "bot" : "user"),
  };

  await col.updateOne(
    { fixtureId: doc.fixtureId, userIdLower: uidLower },
    { $set: doc },
    { upsert: true }
  );
}

async function upsertManyPredictionsMongo(db, recs, opts = {}) {
  if (!db || !Array.isArray(recs) || !recs.length) return;
  const col = db.collection("predictions");
  const ops = [];

  for (const rec of recs) {
    if (!rec) continue;
    const uid = String(rec.userId || "").trim();
    if (!uid) continue;
    const uidLower = uid.toLowerCase();

    const doc = {
      fixtureId: rec.fixtureId,
      userId: uid,
      userIdLower: uidLower,
      isBot: !!rec.isBot,
      outcome: rec.outcome ?? null,
      home:
        typeof rec.home === "number"
          ? rec.home
          : rec.home == null
          ? null
          : Number(rec.home),
      away:
        typeof rec.away === "number"
          ? rec.away
          : rec.away == null
          ? null
          : Number(rec.away),
      firstGoal: rec.firstGoal || null,
      firstHalf: rec.firstHalf || null,
      redAny: typeof rec.redAny === "boolean" ? rec.redAny : null,
      redSide: rec.redSide || null,
      redHome:
        typeof rec.redHome === "boolean" ? rec.redHome : null,
      redAway:
        typeof rec.redAway === "boolean" ? rec.redAway : null,
      penaltyAny:
        typeof rec.penaltyAny === "boolean"
          ? rec.penaltyAny
          : null,
      penaltySide: rec.penaltySide || null,
      at: rec.at || new Date().toISOString(),
      tag: rec.tag || null,
      source: opts.source || (rec.isBot ? "bot" : "user"),
    };

    ops.push({
      updateOne: {
        filter: { fixtureId: doc.fixtureId, userIdLower: uidLower },
        update: { $set: doc },
        upsert: true,
      },
    });
  }

  if (!ops.length) return;
  await col.bulkWrite(ops, { ordered: false });
}

// =====================
//  PRED FLAGS HELPER'LARI
// =====================

/**
 * Belirli bir kullanıcı için, tahmin yaptığı fixtureId listesini
 * DOSYA MODU üzerinden çıkarır.
 *
 * fixtureIdsFilter: null ise tüm fixture'lar,
 * Set(...) ise sadece o set içinde olanlar.
 */
async function getPredFlagsFromFile(userId, fixtureIdsFilter) {
  const uid = String(userId || "").trim();
  if (!uid) return { fixtures: [], count: 0 };

  const { list } = await loadPredList();
  const uidLower = uid.toLowerCase();
  const set = new Set();

  for (const p of list) {
    const pid = String(p.userId || p.user || "").trim().toLowerCase();
    if (pid !== uidLower) continue;

    const fx = String(p.fixtureId || "").trim();
    if (!fx) continue;

    if (fixtureIdsFilter && !fixtureIdsFilter.has(fx)) continue;

    set.add(fx);
  }

  const fixtures = Array.from(set);
  return { fixtures, count: fixtures.length };
}

/**
 * Belirli bir kullanıcı için, tahmin yaptığı fixtureId listesini
 * MONGO MODU (predictions koleksiyonu) üzerinden çıkarır.
 *
 * fixtureIdsFilter: null ise tüm fixture'lar,
 * Set(...) ise sadece o set içinde olanlar.
 */
async function getPredFlagsFromMongo(db, userId, fixtureIdsFilter) {
  const uid = String(userId || "").trim();
  if (!db || !uid) return { fixtures: [], count: 0 };

  const col = db.collection("predictions");
  const uidLower = uid.toLowerCase();

  const query = { userIdLower: uidLower };
  if (fixtureIdsFilter && fixtureIdsFilter.size > 0) {
    query.fixtureId = { $in: Array.from(fixtureIdsFilter) };
  }

  const docs = await col
    .find(query, { projection: { fixtureId: 1, _id: 0 } })
    .toArray();

  const set = new Set();
  for (const d of docs) {
    const fx = String(d.fixtureId || "").trim();
    if (!fx) continue;
    if (fixtureIdsFilter && !fixtureIdsFilter.has(fx)) continue;
    set.add(fx);
  }

  const fixtures = Array.from(set);
  return { fixtures, count: fixtures.length };
}
// =====================
// PRED LOCK (server-side)
// =====================

// kickoff'tan kaç dakika önce kilitleyelim?
const PRED_LOCK_BEFORE_MIN = 10;

async function computePredLock(fixtureId) {
  const fx = String(fixtureId || "").trim();
  if (!fx) return { locked: false, reason: "FIXTURE_ID_REQUIRED", lock: null };

  // state dosyası varsa oradan oku
  const st = await readJson(stateFile(fx), null);
  if (!st || typeof st !== "object") {
    // state yoksa kilitleme yapma (yanlış bloklamayalım)
    return { locked: false, reason: "NO_STATE", lock: null };
  }

  const status = String(st.status || "").toUpperCase();
  const kickoffISO = st.kickoffISO || st.kickoff || null;

  // status FT vb ise zaten kilit say
  if (status && status !== "NS") {
    return {
      locked: true,
      reason: "MATCH_ALREADY_STARTED",
      lock: { status, kickoffISO: kickoffISO || null, lockAtISO: null },
    };
  }

  if (!kickoffISO) {
    // kickoff yoksa kilitleme yapma
    return { locked: false, reason: "NO_KICKOFF", lock: { status, kickoffISO: null, lockAtISO: null } };
  }

  const koMs = new Date(String(kickoffISO)).getTime();
  if (!Number.isFinite(koMs)) {
    return { locked: false, reason: "BAD_KICKOFF", lock: { status, kickoffISO: String(kickoffISO), lockAtISO: null } };
  }

  const lockAt = koMs - PRED_LOCK_BEFORE_MIN * 60 * 1000;
  const nowMs = Date.now();
  const locked = nowMs >= lockAt;

  return {
    locked,
    reason: locked ? "PRED_LOCKED_BEFORE_KICKOFF" : null,
    lock: {
      status: status || "NS",
      kickoffISO: String(kickoffISO),
      lockAtISO: new Date(lockAt).toISOString(),
    },
  };
}

async function assertPredNotLocked(fixtureId) {
  return computePredLock(fixtureId);
}

// ----------------- ANA ROUTE: HUMAN SUBMIT -----------------

/**
 * POST /api/pred/submit
 *
 * - Skor isteğe bağlı:
 *   home/away gelmezse null kaydedilir.
 * - Aynı fixture + user için İLK tahminde LC_MATCH_COST kadar LC keser.
 *   Sonraki düzeltmelerde LC kesmez.
 * - LC, Mongo varsa Mongo cüzdandan; yoksa lc-wallet.json üzerinden takip edilir.
 */
router.post("/pred/submit", verifyToken, async (req, res) => {
  try {
    // Tüm check→spend→write bütününü PREDS_FILE kilidine al:
    // eşzamanlı gönderimlerde tahmin kaybı / çift-harcama olmaz.
    // (Not: içeride cüzdan WALLET_FILE kilidi alınır — farklı anahtar,
    //  hep aynı sırada (PREDS→WALLET) alındığından deadlock olmaz.)
    await withFileLock(PREDS_FILE, async () => {
    const db = getDb(req);

    const {
      fixtureId,
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
    const uid = req.uid;
    if (!fx || !uid) {
      return res
        .status(400)
        .json({ ok: false, error: "FIXTURE_AND_USER_REQUIRED" });
    }
    // Mevcut tahmin listesini oku (hem LC için, hem yazmak için)
    const { list, wrap } = await loadPredList();

    // Aynı fixture + user için daha önce tahmin var mı?
    const uidLower_forCheck = uid.toLowerCase();
    const alreadyPredicted = list.some((p) => {
    const fxId = String(p.fixtureId || "").trim();
    const puid = String(p.userId || p.user || "").trim().toLowerCase();
    return fxId === fx && puid === uidLower_forCheck;
  });

        // --- HİLE ENGELİ: event sonrası mikro tahmin lock (minute bazlı + ISO fallback) ---
    const st = await readJson(stateFile(fx), null);

    // sadece kullanıcı bu alanları *gönderiyorsa* kontrol et
    const hasRedAny  = Object.prototype.hasOwnProperty.call(req.body, "redAny");
    const hasRedSide = Object.prototype.hasOwnProperty.call(req.body, "redSide");
    const hasPenAny  = Object.prototype.hasOwnProperty.call(req.body, "penaltyAny");
    const hasPenSide = Object.prototype.hasOwnProperty.call(req.body, "penaltySide");

    // Kullanıcının "tahmin anı" dakikası: request body minute gönderirse onu kullan,
    // yoksa live-state dakika (st.minute) varsa onu kullan.
    // (Expo tarafı minute göndermiyorsa bile, st.minute genelde mevcut olur.)
    const predMinuteRaw =
      Object.prototype.hasOwnProperty.call(req.body, "minute")
        ? req.body.minute
        : st?.minute;

    const predMinute =
      predMinuteRaw == null ? null : Number(predMinuteRaw);

    const nowMs = Date.now();

    // Kırmızı event sisteme girdiyse, artık redAny/redSide güncellenemez
    if (hasRedAny || hasRedSide) {
      const evMin =
        st?.redEventMinute == null ? null : Number(st.redEventMinute);

      // 1) Dakika bazlı kilit (daha güvenli)
      if (Number.isFinite(evMin) && Number.isFinite(predMinute) && predMinute >= evMin) {
        return res.status(409).json({
          ok: false,
          error: "MICRO_LOCKED_RED",
          fixtureId: fx,
          redEventAtISO: st?.redEventAtISO || null,
          redEventMinute: evMin,
          predMinute,
        });
      }

      // 2) Dakika yoksa ISO fallback
      if (!Number.isFinite(evMin) && st?.redEventAtISO) {
        const evMs = new Date(st.redEventAtISO).getTime();
        if (Number.isFinite(evMs) && nowMs > evMs) {
          return res.status(409).json({
            ok: false,
            error: "MICRO_LOCKED_RED",
            fixtureId: fx,
            redEventAtISO: st.redEventAtISO,
            redEventMinute: st?.redEventMinute ?? null,
            predMinute: Number.isFinite(predMinute) ? predMinute : null,
          });
        }
      }
    }

    // Penaltı event sisteme girdiyse, artık penaltyAny/penaltySide güncellenemez
    if (hasPenAny || hasPenSide) {
      const evMin =
        st?.penEventMinute == null ? null : Number(st.penEventMinute);

      // 1) Dakika bazlı kilit
      if (Number.isFinite(evMin) && Number.isFinite(predMinute) && predMinute >= evMin) {
        return res.status(409).json({
          ok: false,
          error: "MICRO_LOCKED_PENALTY",
          fixtureId: fx,
          penEventAtISO: st?.penEventAtISO || null,
          penEventMinute: evMin,
          predMinute,
        });
      }

      // 2) ISO fallback
      if (!Number.isFinite(evMin) && st?.penEventAtISO) {
        const evMs = new Date(st.penEventAtISO).getTime();
        if (Number.isFinite(evMs) && nowMs > evMs) {
          return res.status(409).json({
            ok: false,
            error: "MICRO_LOCKED_PENALTY",
            fixtureId: fx,
            penEventAtISO: st.penEventAtISO,
            penEventMinute: st?.penEventMinute ?? null,
            predMinute: Number.isFinite(predMinute) ? predMinute : null,
          });
        }
      }
    }



    // 🔹 LC harcaması (maç başı cost, ikinci/üçüncü düzeltmede kesilmez)
    // Premium ayrıcalığı: maç girişi bedava. 1987 üyeleri de bedava.
    const isPrem  = await premium.isPremium(uid);
    const is1987  = await isUser1987Member(uid);
    const effMatchCost = (isPrem || is1987) ? 0 : LC_MATCH_COST;
    const spendRes = db
      ? await spendLcMatchIfNeededMongo(
          db,
          uid,
          fx,
          effMatchCost,
          alreadyPredicted
        )
      : await spendLcMatchIfNeededFile(
          uid,
          fx,
          effMatchCost,
          alreadyPredicted
        );

    if (!spendRes.ok) {
      return res.status(400).json({
        ok: false,
        error: spendRes.error || "LC_SPEND_FAILED",
        lc: spendRes.lc,
        needed: spendRes.needed,
      });
    }

    // Skor isteğe bağlı:
    let h = null;
    let a = null;

    const hasHome = Object.prototype.hasOwnProperty.call(req.body, "home");
    const hasAway = Object.prototype.hasOwnProperty.call(req.body, "away");

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

    // Aynı kullanıcı + fixture için son tahmini yazsın (eski kaydı temizle)
    const uidLower = uid.toLowerCase();

    const filtered = list.filter((p) => {
      const sameFx = String(p.fixtureId || "").trim() === fx;
      const pidLower = String(p.userId || p.user || "").trim().toLowerCase();
      return !(sameFx && pidLower === uidLower);
    });

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

    // 🔵 Mongo mirror (varsa)
    if (db) {
      try {
        await upsertPredictionMongo(db, rec, { source: "user" });
      } catch (e) {
        console.error("[pred] Mongo mirror failed for submit:", e);
      }
    }

    return res.json({
      ok: true,
      pred: rec,
      lc: spendRes.lc,
      lcCharged: spendRes.charged,
      matchCost: spendRes.matchCost || 0,
    });
    }); // withFileLock(PREDS_FILE)
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

    const homeTeam =
      st.teamHome ||
      st.homeTeam ||
      st.home ||
      (st.teams && (st.teams.home || st.teams.Home)) ||
      null;

    const awayTeam =
      st.teamAway ||
      st.awayTeam ||
      st.away ||
      (st.teams && (st.teams.away || st.teams.Away)) ||
      null;

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
    // PREDS_FILE kilidi: /pred/submit ile aynı dosyaya yazdığından
    // eşzamanlı çalışırlarsa tahmin kaybı olmasın.
    await withFileLock(PREDS_FILE, async () => {
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
        // ✅ Botlar da aynı kilide tabi (oyun oturana kadar aynı kural)
    const lockRes = await assertPredNotLocked(fx);
    if (lockRes.locked) {
      return res.status(409).json({
        ok: false,
        error: lockRes.reason || "PRED_LOCKED",
        fixtureId: fx,
        status: lockRes.lock?.status || null,
        kickoffISO: lockRes.lock?.kickoffISO || null,
        lockAtISO: lockRes.lock?.lockAtISO || null,
      });
    }

    const db = getDb(req);

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

    // 🔵 Mongo mirror (varsa) – bot tahminleri
    if (db) {
      try {
        await upsertManyPredictionsMongo(db, newRecs, { source: "bot" });
      } catch (e) {
        console.error(
          "[pred] Mongo mirror failed for bots-generate:",
          e
        );
      }
    }

    return res.json({
      ok: true,
      fixtureId: fx,
      botCount: BOT_PROFILES.length,
    });
    }); // withFileLock(PREDS_FILE)
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

// DELETE /api/pred/cancel — kullanıcının belirli bir maç tahmini sil
router.delete("/pred/cancel", verifyToken, express.json(), async (req, res) => {
  try {
    const { fixtureId } = req.body || {};
    const fx = String(fixtureId || "").trim();
    const uid = req.uid;
    if (!fx || !uid) return res.status(400).json({ ok: false, error: "FIXTURE_AND_USER_REQUIRED" });

    const { list, wrap } = await loadPredList();
    const before = list.length;
    const filtered = list.filter((p) =>
      !(String(p.fixtureId || "") === fx && String(p.userId || p.user || "").toLowerCase() === uid.toLowerCase())
    );
    if (filtered.length === before) return res.json({ ok: true, deleted: 0, message: "Tahmin bulunamadı" });

    const toWrite = wrap ? { ...wrap, items: filtered } : filtered;
    await fsp.writeFile(PREDS_FILE, JSON.stringify(toWrite, null, 2), "utf8");
    res.json({ ok: true, deleted: before - filtered.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ----------------- FLAGS: BU KULLANICI HANGİ MAÇLARDA TAHMİN YAPMIŞ? -----------------
/**
 * GET /api/pred/flags?userId=demo1[&fixtureIds=FX1,FX2...]
 *
 * Amaç:
 *  - Belirli bir kullanıcı için, tahmin yaptığı fixtureId listesini verir.
 *  - Mongo varsa predictions koleksiyonundan, yoksa preds.json'dan okur.
 *  - fixtureIds query param'ı verilirse sadece o maçlar için filtreler.
 *
 * Response:
 *  {
 *    ok: true,
 *    userId: "demo1",
 *    fixtures: ["FX-1","FX-2"],
 *    count: 2
 *  }
 */
router.get("/pred/flags", async (req, res) => {
  try {
    const db = getDb(req);
    const uid = String(req.query.userId || "").trim();

    if (!uid) {
      return res
        .status(400)
        .json({ ok: false, error: "USER_ID_REQUIRED" });
    }

    // İsteğe bağlı: fixtureIds=FX1,FX2,FX3
    let fixtureIdsFilter = null;
    const rawFixtureIds = String(req.query.fixtureIds || "").trim();
    if (rawFixtureIds) {
      const parts = rawFixtureIds
        .split(",")
        .map((s) => String(s || "").trim())
        .filter(Boolean);
      if (parts.length) {
        fixtureIdsFilter = new Set(parts);
      }
    }

    const result = db
      ? await getPredFlagsFromMongo(db, uid, fixtureIdsFilter)
      : await getPredFlagsFromFile(uid, fixtureIdsFilter);

    return res.json({
      ok: true,
      userId: uid,
      fixtures: result.fixtures,
      count: result.count,
    });
  } catch (e) {
    console.error("PRED_FLAGS_FAILED", e);
    return res.status(500).json({
      ok: false,
      error: "PRED_FLAGS_FAILED",
      detail: String(e && (e.message || e)),
    });
  }
});

// ----------------- KULLANICININ TAHMİNLERİ -----------------
/**
 * GET /api/pred/my?userId=xxx
 * Kullanıcının tahmin yaptığı tüm maçları döndürür.
 * Her item: { fixtureId, home, away, kickoffISO, league, country, status, score, pred }
 */
router.get("/pred/my", async (req, res) => {
  try {
    const db = getDb(req);
    const uid = String(req.query.userId || "").trim();
    if (!uid) return res.status(400).json({ ok: false, error: "USER_ID_REQUIRED" });

    // 1) kullanıcının tüm fixtureId'leri
    const result = db
      ? await getPredFlagsFromMongo(db, uid, null)
      : await getPredFlagsFromFile(uid, null);

    const fidSet = new Set(result.fixtures);
    if (!fidSet.size) return res.json({ ok: true, count: 0, items: [] });

    // 2) fixtures.json'dan maç meta verisi
    const FIXTURES_FILE = path.join(DATA_DIR, "fixtures.json");
    let fixturesRaw = { fixtures: [] };
    try { fixturesRaw = JSON.parse(await fsp.readFile(FIXTURES_FILE, "utf8")); } catch { /* */ }
    const fxList = Array.isArray(fixturesRaw.fixtures) ? fixturesRaw.fixtures : [];
    const fxMap = new Map(fxList.map((f) => [String(f.fixtureId || ""), f]));

    // 3) live state'den skor/status (data/live/<fixtureId>.json)
    async function getLiveState(fid) {
      try {
        const p = path.join(LIVE_DIR, `${String(fid).replace(/[<>:"/\\|?*]/g, "_")}.json`);
        return JSON.parse(await fsp.readFile(p, "utf8"));
      } catch { return null; }
    }

    // 4) pred detayı (ilk tahmin)
    const { list: predList } = await loadPredList();
    const uidLower = uid.toLowerCase();

    const items = [];
    for (const fid of fidSet) {
      const fx = fxMap.get(fid) || {};
      const live = await getLiveState(fid);
      const pred = predList.find((p) =>
        String(p.fixtureId || "") === fid && String(p.userId || p.user || "").toLowerCase() === uidLower
      ) || null;

      items.push({
        fixtureId: fid,
        home: fx.home || live?.teamHome || null,
        away: fx.away || live?.teamAway || null,
        kickoffISO: fx.kickoffISO || live?.kickoffISO || null,
        league: fx.league || live?.league || null,
        country: fx.country || live?.country || null,
        status: live?.status || fx.status || "NS",
        score: live?.homeGoals != null ? { home: live.homeGoals, away: live.awayGoals } : (fx.score || null),
        pred: pred ? {
          outcome: pred.outcome ?? null,
          home: pred.home ?? null,
          away: pred.away ?? null,
          firstGoal: pred.firstGoal ?? null,
          firstHalf: pred.firstHalf ?? null,
          redAny: typeof pred.redAny === "boolean" ? pred.redAny : null,
          redSide: pred.redSide ?? null,
          penaltyAny: typeof pred.penaltyAny === "boolean" ? pred.penaltyAny : null,
          penaltySide: pred.penaltySide ?? null,
        } : null,
      });
    }

    // güncel / eski ayrımı: kickoff'tan 26 saat sonrasına kadar "güncel"
    const CURRENT_WINDOW_MS = 12 * 3600 * 1000;
    const nowMs = Date.now();
    const current = items
      .filter((it) => it.kickoffISO && (nowMs - new Date(it.kickoffISO).getTime()) < CURRENT_WINDOW_MS)
      .sort((a, b) => new Date(a.kickoffISO).getTime() - new Date(b.kickoffISO).getTime());
    const old = items
      .filter((it) => !it.kickoffISO || (nowMs - new Date(it.kickoffISO).getTime()) >= CURRENT_WINDOW_MS)
      .sort((a, b) => new Date(b.kickoffISO || 0).getTime() - new Date(a.kickoffISO || 0).getTime());

    return res.json({ ok: true, count: items.length, current, old });
  } catch (e) {
    console.error("PRED_MY_FAILED", e);
    return res.status(500).json({ ok: false, error: "PRED_MY_FAILED", detail: String(e?.message || e) });
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
      (await readJson(USERS_FILE, { users: [], updatedAt: null })) ||
      {};
    const users = Array.isArray(usersData.users) ? usersData.users : [];

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
