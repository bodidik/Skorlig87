"use strict";

const express = require("express");
const { ensurePredIndexes } = require("../lib/preds-index.cjs");
const router = express.Router();

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { guvenliYol } = require("../lib/guvenli-dosya.cjs");

// ⚠️ SKORLIG_DATA_DIR OKUNUYOR. Sabit yol testleri GERÇEK data/ dizinine
// yazdırıyordu: bir entegrasyon testi 7 kaydı canlı preds.json'a düşürdü.
// Ayrıca settle2 bu değişkeni okuyup pred okumayınca aynı zincirdeki iki
// modül maç durum dosyasını FARKLI dizinlerde arıyordu.
const DATA_DIR = process.env.SKORLIG_DATA_DIR || path.join(__dirname, "..", "data");
const FixturesStore = require("../lib/fixtures-store.cjs");
// LC harcama: koşulu sorgunun içinde tutan tek atomik yol.
const WalletCredit = require("../lib/wallet-credit.cjs");
const PREDS_FILE = path.join(DATA_DIR, "preds.json");
const LIVE_DIR = path.join(DATA_DIR, "live"); // fixture state için
const LEADERBOARD_FILE = path.join(DATA_DIR, "leaderboard.json");
const WALLET_FILE = path.join(DATA_DIR, "lc-wallet.json");

// 🔹 Otomatik LC birikimi (token bitince bekle)
const { applyRegen } = require("../lib/lc-regen.cjs");
// 🔹 Premium ayrıcalıkları
const premium = require("../lib/premium.cjs");

/**
 * Yönetim ucu koruması — fail-closed: token tanımsızsa uç tamamen kapalı.
 *
 * ⚠️ JETON ADI TEK KAYNAKTAN. Burada yalnızca `SKORLIG_ADMIN_TOKEN`
 * okunuyordu; `middleware/requireAdmin.cjs beklenenToken()` ise ÜÇ ad kabul
 * ediyor (eski kurulumlar için `ADMIN_TOKEN` ve `EXPO_PUBLIC_ADMIN_TOKEN`).
 * Ayrışan listeler, aynı jetonun bir uçta çalışıp ötekinde 503 vermesi
 * demekti — bkz. routes/admin-runtime.cjs'teki ölçüm notu.
 */
const { beklenenToken: _beklenenAdminToken } = require("../middleware/requireAdmin.cjs");

function requireAdminToken(req, res, next) {
  const token = _beklenenAdminToken();
  if (!token) return res.status(503).json({ ok: false, error: "ADMIN_TOKEN_NOT_CONFIGURED" });
  const got = String(req.headers["x-admin-token"] || "").trim() || String(req.query.token || "").trim();
  if (got && got === token) return next();
  return res.status(401).json({ ok: false, error: "ADMIN_TOKEN_REQUIRED" });
}
const UsersStore = require("../lib/users-store.cjs");
// 🔹 Atomik yazma + dosya kilidi (race önleme)
const { withFileLock, writeJsonAtomic } = require("../lib/fileLock.cjs");
const { verifyToken } = require("../middleware/verifyToken.cjs");
const { isInternalCaller } = require("../lib/internal-caller.cjs");

// 🔹 LigCoin / cüzdan parametreleri
// lc-wallet.cjs ile SENKRON tutulmalı
// ⚠️ Tek kaynak: lib/ekonomi.cjs. Bu üç sabit dört dosyada, açılış bakiyesi
// iki ayrı adla (LC_START / INITIAL_DEFAULT) tanımlıydı — elle senkron
// gerektiren her sabit, sapmayı bekleyen bir hatadır.
const { INITIAL_DEFAULT, INITIAL_1987, LC_MATCH_COST } = require("../lib/ekonomi.cjs");

// 🔹 Ölçeklenme: Mongo primary olduğunda preds.json'a yazmak 17MB'lık dosyayı
// her submit'te baştan yazar — 500k kullanıcıda çöker. Bu bayrak açıkken
// (geçiş dönemi) dosya mirror'ı korunur; production'da SKORLIG_PREDS_FILE_MIRROR=0
// ile kapatılıp yalnızca MongoDB kullanılır.
const PREDS_FILE_MIRROR = String(process.env.SKORLIG_PREDS_FILE_MIRROR ?? "1") !== "0";

/* ======================
 *  BOT DOLULUK POLİTİKASI
 *
 *  Botlar kalıcı nüfus değil, DOLULUK YEDEĞİdir: amaç, gerçek tahminci azken
 *  kullanıcının maçta/sıralamada/canlı yarışta yalnız kalmamasıdır. Gerçek
 *  kullanıcı geldikçe bot ihtiyacı azalmalıdır.
 *
 *  Formül:  bot_sayısı = max(0, HEDEF − gerçek_tahminci)
 *  Böylece hedefe ulaşan maça hiç bot girmez; sistem büyüdükçe botlar
 *  kendiliğinden sahneden çekilir.
 *
 *  Ülke eşleştirme: önce maçın ülkesinden botlar seçilir (Türkiye ligi maçına
 *  İngiliz botu doldurmak hem gerçekçi değil hem ülke sıralamasını bozar),
 *  eksik kalırsa global/diğer botlarla tamamlanır.
 * ====================== */
const BOT_TARGET_PREDICTORS = Number(process.env.SKORLIG_BOT_TARGET || 40);

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
  return guvenliYol(LIVE_DIR, String(fid), ".json");
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

/**
 * 1987 üyeliği — kullanıcı deposundan (Mongo varsa Mongo).
 * Dosyadan okumak, profil verisi taşındıktan sonra herkesi "üye değil"
 * yapardı: 1987 üyesi ücretsiz maç girişini kaybederdi.
 */
async function isUser1987Member(userId, db) {
  const uid = String(userId || "").trim().toLowerCase();
  if (!uid) return false;

  const map = await UsersStore.getUsersByIdsLower([uid], db);
  const u = map[uid];
  if (!u) return false;

  // Tek kaynak: lib/premium.cjs uyeMi1987 (kural bes yerde kopyalanmisti).
  return require("../lib/premium.cjs").uyeMi1987(u);
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
    const is1987 = await isUser1987Member(uid, null) /* dosya modu */;
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

  // Bu fonksiyon DOSYA modudur; yalnızca db yokken çağrılır (Mongo sürümünün
  // yedeği). Bu yüzden premium sorgusu da dosyadan gider — db burada zaten null.
  const isPrem = await premium.isPremium(uid, null);

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
    const is1987 = await isUser1987Member(uid, db);
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

  // Kullanıcı dokümanı garanti olsun (yoksa açılış bakiyesiyle yaratılır)
  const user = await ensureWalletUserMongo(db, uid);

  // İkinci / üçüncü düzeltmelerde veya cost <= 0'da hiç kesme
  if (alreadyPredicted || cost <= 0) {
    return { ok: true, lc: Number(user.balance || 0), charged: false, matchCost: 0 };
  }

  // ⚠️ EL YAZMASI İYİMSER KİLİT KALDIRILDI. Eski akış: bakiyeyi oku →
  // `{balance: current}` filtresiyle kes → eşleşmezse TAZE OKU ve KOŞULSUZ kes.
  // O ikinci kesmede bakiye koruması yoktu: taze okuma ile yazma arasına giren
  // bir istek bakiyeyi boşaltırsa bakiye EKSİYE düşüyordu. Yarışı tespit edip
  // ardından korumasız yazmak, yarışı çözmek değil geciktirmekti.
  //
  // WalletCredit.spendLc koşulu (`balance: { $gte: tutar }`) sorgunun içinde
  // tutuyor: kontrol ve yazma tek atomik işlem, yeniden denemeye gerek yok.
  // Defter kaydını da kendisi düşüyor.
  const r = await WalletCredit.spendLc(db, uid, cost, "match_pred", {
    fixtureId,
    type: "pred_submit",
  });

  if (!r.ok) {
    if (r.reason === "INSUFFICIENT") {
      return { ok: false, error: "LC_NOT_ENOUGH", lc: r.lc, needed: cost };
    }
    // NO_DB / ERROR — yazılamadı; tahmin ücretsiz geçmesin.
    return { ok: false, error: "LC_SPEND_FAILED", lc: Number(user.balance || 0), needed: cost };
  }

  return { ok: true, lc: r.lc, charged: true, matchCost: cost };
}

// ----------------- BOT PROFİLLERİ + RNG -----------------

/**
 * Yeni sistem:
 * - data/bot-profiles.json içinden bot profilleri okunur.
 *   Şema: [{ id, club, segment, tier }, ...]
 * - Buradan BOT_PROFILES, BOT_USER_ID_SET ve BOT_PROFILE_MAP üretilir.
 */
// Bot kimlikleri — tek kaynak (lib/botIds.cjs).
//  BOT_PROFILES    : aktif kadro — tahmin ÜRETEN botlar (bot-profiles.json)
//  BOT_USER_ID_SET : kimlik kümesi — aktif + emekli (bot-legacy-ids.json dahil)
// Emekli botlar yeni tahmin üretmez ama "bot" olarak tanınır; aksi halde
// puanlama/LC/topluluk çarpanı onları insan sayar.
const {
  BOT_PROFILES,
  BOT_PROFILE_MAP,
  BOT_ID_SET: BOT_USER_ID_SET,
} = require("../lib/botIds.cjs");

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
  // ⚠️ İNDEKS ONARIMI: tahmin YAZMA yolu da `models/preds.cjs`'i kullanmıyor.
  // Onarım tek yerde asılı kalınca en çok sorgulanan koleksiyon indekssiz
  // kalıyordu (bkz. lib/preds-index.cjs).
  await ensurePredIndexes(db);
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

// Belirli fixture+user için tahmin var mı? (Mongo primary — alreadyPredicted)
async function predExistsMongo(db, fixtureId, userId) {
  if (!db) return false;
  const uidLower = String(userId || "").trim().toLowerCase();
  if (!uidLower) return false;
  const col = db.collection("predictions");
  const doc = await col.findOne(
    { fixtureId: String(fixtureId), userIdLower: uidLower },
    { projection: { _id: 1 } }
  );
  return !!doc;
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

/**
 * ⚠️ ARTIK KAPALI BAŞARISIZLIK. Önceki hâli üç yerde açık bırakıyordu
 * ("yanlış bloklamayalım" gerekçesiyle): durum dosyası yoksa, başlama saati
 * yoksa, başlama saati bozuksa → kilitli değil.
 *
 * `data/live/*.json` Render'da KALICI DEĞİL — her deploy siliniyor. Deploy
 * sonrası tüm maçların durum dosyası yok, yani hepsi tahmine açık görünüyordu.
 * En riskli pencere: maç BİTMİŞ ama henüz settle edilmemişken (settle
 * zamanlayıcıyla çalışır) sonucu bilinen maça tahmin girilebilirdi.
 *
 * Artık durum dosyası yoksa FİKSTÜR DEPOSU (Mongo birincil, deploy'dan
 * etkilenmez) yetkili kaynak; maç orada da yoksa kilitli sayılıyor.
 * Aynı düzeltme routes/duels.cjs `isFixtureLocked` içinde de yapıldı.
 */
async function computePredLock(fixtureId, db = null) {
  const fx = String(fixtureId || "").trim();
  if (!fx) return { locked: true, reason: "FIXTURE_ID_REQUIRED", lock: null };

  // state dosyası varsa oradan oku
  let st = await readJson(stateFile(fx), null);
  if (!st || typeof st !== "object") {
    try {
      // Indeksli tekil arama (bkz. fixtures-store.getOne): bu yol her tahmin
      // gonderiminde calisiyor ve eskiden tum listeyi cekiyordu.
      const f = await FixturesStore.getOne(fx, db);
      if (!f) return { locked: true, reason: "FIXTURE_NOT_FOUND", lock: null };
      st = { status: f.status || "NS", kickoffISO: f.kickoffISO || f.kickoff || null };
    } catch (e) {
      console.error("[pred] fikstur dogrulanamadi, kilitli sayiliyor:", e?.message || e);
      return { locked: true, reason: "FIXTURE_CHECK_FAILED", lock: null };
    }
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
    // Başlama saati bilinmiyorsa karar veremeyiz → kilitli (bkz. fonksiyon notu).
    return { locked: true, reason: "NO_KICKOFF", lock: { status, kickoffISO: null, lockAtISO: null } };
  }

  const koMs = new Date(String(kickoffISO)).getTime();
  if (!Number.isFinite(koMs)) {
    return { locked: true, reason: "BAD_KICKOFF", lock: { status, kickoffISO: String(kickoffISO), lockAtISO: null } };
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

async function assertPredNotLocked(fixtureId, db = null) {
  // ⚠️ `db` GEÇİLMELİ: durum dosyası yoksa kilit fikstür deposuna bakıyor.
  // Geçilmezse depo kendi bağlantısını kurar (yavaş) ya da bulamayıp
  // fixtureId'yi bilinmeyen sayar — yani meşru tahmin reddedilir.
  return computePredLock(fixtureId, db);
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

    // 🔒 Kickoff kilidi: maç başladıktan sonra tahmin gönderilemez / değiştirilemez
    // (aksi halde skoru görüp tahmin değiştirerek her maçı doğru bilmek mümkün olur)
    const lockRes = await assertPredNotLocked(fx, getDb(req));
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

    // Mevcut tahmin listesini oku — yalnızca dosya moduna düşülecekse.
    // Mongo primary'de 17MB dosyayı okumak/yazmak ölçekte çöker.
    const needFile = !db || PREDS_FILE_MIRROR;
    let list = [];
    let wrap = null;
    if (needFile) {
      const loaded = await loadPredList();
      list = loaded.list;
      wrap = loaded.wrap;
    }

    // Aynı fixture + user için daha önce tahmin var mı?
    const uidLower_forCheck = uid.toLowerCase();
    const alreadyPredicted = db
      ? await predExistsMongo(db, fx, uid)
      : list.some((p) => {
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
    const isPrem  = await premium.isPremium(uid, getDb(req));
    const is1987  = await isUser1987Member(uid, getDb(req));
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
    const nowISO = new Date().toISOString();

    // Skor girilmişse outcome'u otomatik türet
    let derivedOutcome = outcome || null;
    if (h != null && a != null) {
      derivedOutcome = h > a ? "H" : h === a ? "D" : "A";
    }

    const rec = {
      fixtureId: fx,
      userId: uid,
      outcome: derivedOutcome,
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

    // 🔵 Mongo primary yazma (varsa) — upsert, önceki kaydı ezer
    if (db) {
      await upsertPredictionMongo(db, rec, { source: "user" });
    }

    // 🟢 Dosya yazma — yalnızca dosya modunda veya geçiş mirror'ı açıkken.
    // (Mongo primary + mirror kapalı → 17MB dosyaya hiç dokunulmaz.)
    if (needFile) {
      const filtered = list.filter((p) => {
        const sameFx = String(p.fixtureId || "").trim() === fx;
        const pidLower = String(p.userId || p.user || "").trim().toLowerCase();
        return !(sameFx && pidLower === uidLower);
      });
      filtered.push(rec);
      if (wrap) {
        wrap.items = filtered;
        await writeJson(PREDS_FILE, wrap);
      } else {
        await writeJson(PREDS_FILE, filtered);
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
function apply1987Logic(botId, rng, homeTeam, awayTeam, country, segment) {
  const id = String(botId || "").toLowerCase();

  // Kimlikte 1987/GS efsanelerine gönderme var mı?
  // "87" tek başına çok geniş: rastgele numara aralığı 17-99 olduğu için
  // Liverpool/Barcelona/Bayern botlarına da denk geliyordu.
  const nostalgicName =
    id.includes("87") ||
    id.includes("1987") ||
    id.includes("prekazi") ||
    id.includes("hagi") ||
    id.includes("cimbom") ||
    id.includes("aslan") ||
    id.includes("sami") ||
    id.includes("metin");

  // ⚠️ Segment şartı ŞART: bu mantık skor tahminini Galatasaray lehine büker.
  // Tek başına ada bakmak YNWA87 (Liverpool), CampNou87 (Barcelona),
  // Bayern87, Interista87, LaBanda87 (River Plate) gibi botları da
  // "1987 GS romantiği" sayıyordu — rakip takım taraftarı botlar GS lehine
  // tahmin ediyordu. Nostalji kadrosu yalnızca GS segmentinden çıkabilir.
  const isGsBot = String(segment || "").toUpperCase() === "GS";

  if (!isGsBot || !nostalgicName) return null;

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

  // 1987GS özel mantığı — segment de geçilir, yoksa rakip takım botları da
  // GS lehine tahmin eder (bkz. apply1987Logic içindeki not).
  const special = apply1987Logic(
    bot.userId,
    rng,
    homeTeam,
    awayTeam,
    country,
    bot.segment
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
 * Bir fixture'daki GERÇEK (bot olmayan) tahminci sayısı.
 * Doluluk hesabının tabanı — botlar bu sayıyı hedefe tamamlar.
 */
async function countRealPredictors(fixtureId, db) {
  const fx = String(fixtureId);

  if (db) {
    // isBot alanına güvenmek yerine kimlik kümesiyle de doğrula: eski
    // kayıtlarda isBot yazılmamış olabilir.
    const docs = await db
      .collection("predictions")
      .find({ fixtureId: fx }, { projection: { userIdLower: 1, _id: 0 } })
      .toArray();
    let n = 0;
    for (const d of docs) {
      if (!BOT_USER_ID_SET.has(String(d.userIdLower || ""))) n++;
    }
    return n;
  }

  const { list } = await loadPredList();
  let n = 0;
  for (const p of list) {
    if (String(p.fixtureId || "") !== fx) continue;
    const uid = String(p.userId || p.user || "").trim().toLowerCase();
    if (uid && !BOT_USER_ID_SET.has(uid)) n++;
  }
  return n;
}

/**
 * Doldurulacak bot kadrosunu seçer.
 *
 * - Önce maçın ülkesinden botlar (ülke sıralaması tutarlı kalsın)
 * - Yetmezse geri kalan kadrodan tamamlanır
 * - Seçim fixtureId ile tohumlanır: aynı maç için tekrar çalıştırıldığında
 *   aynı kadro gelir (tahminler zaten deterministik üretiliyor).
 */
function pickBotsForFixture(fixtureId, needed, fixtureCountry) {
  if (needed <= 0) return [];

  const { countryOfSegment } = require("../lib/bot-countries.cjs");
  const wanted = String(fixtureCountry || "").trim();

  const local = [];
  const rest  = [];
  for (const bot of BOT_PROFILES) {
    const c = countryOfSegment(bot.segment);
    if (wanted && c === wanted) local.push(bot);
    else rest.push(bot);
  }

  // Deterministik karıştırma (Fisher-Yates + tohumlu rng)
  const shuffle = (arr, seed) => {
    const rng = makeSeededRng(seed);
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  const picked = shuffle(local, `${fixtureId}::local`).slice(0, needed);
  if (picked.length < needed) {
    picked.push(
      ...shuffle(rest, `${fixtureId}::rest`).slice(0, needed - picked.length)
    );
  }
  return picked;
}

/**
 * POST /api/pred/bots-generate
 * body: { fixtureId: "..." }
 *
 * - Aynı fixture için mevcut bot tahminlerini siler
 * - bot-profiles.json'daki tüm botlar için deterministik tahmin üretir
 * - preds.json'a yazar
 */
/**
 * ⚠️ YÖNETİM UCU — admin token zorunlu.
 * Bot tahmini üretiyor: sıralamayı ve havuz dağılımını doğrudan etkiliyor.
 * Yetkisiz bırakıldığında herkes istediği maça istediği kadar bot tahmini
 * bastırabilirdi.
 */
router.post("/pred/bots-generate", requireAdminToken, async (req, res) => {
  try {
    // 🔒 Yönetim ucu: kimlik istemiyordu — herkes herhangi bir maça bot
    // üretebiliyordu. Dosya modunda her çağrı 17MB okuma/yazma demek, yani
    // ucuz bir DoS; ayrıca maçta hangi botların görüneceği dışarıdan
    // değiştirilebiliyordu. settle2 ile aynı koruma uygulanır.
    //
    // ⚠️ BURADA "bot-filler loopback'ten çağırdığı için etkilenmez" YAZIYORDU
    // VE YANLIŞTI. Bu uçta İKİ muhafız var; yukarıdaki `requireAdminToken`
    // ara katmanı ÖNCE çalışıyor ve jetonsuz loopback isteğini reddediyor,
    // yani aşağıdaki `isInternalCaller` gevşemesine hiç sıra gelmiyor.
    // Sonuç ölçüldü: bot doldurma her turda 25/25 ADMIN_TOKEN_REQUIRED ile
    // düşüyordu. bot-filler artık x-admin-token gönderiyor.
    // İki muhafız bilerek duruyor (derinlemesine savunma).
    if (!isInternalCaller(req)) {
      return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
    }
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
    const lockRes = await assertPredNotLocked(fx, getDb(req));
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
    const needFile = !db || PREDS_FILE_MIRROR;

    // Fixture meta (varsa)
    const meta = await readFixtureMeta(fx);

    // Doluluk hesabı: hedefi gerçek tahmincilerle karşıla, farkı bot doldursun.
    // İstek `target` gönderirse onu kullan (admin ayarı), yoksa varsayılan.
    const target = Math.max(
      0,
      Number(req.body?.target) || BOT_TARGET_PREDICTORS
    );
    const realCount = await countRealPredictors(fx, db);
    const needed = Math.max(0, target - realCount);

    const chosenBots = pickBotsForFixture(fx, needed, meta.country);

    // Her bot için deterministik RNG
    const newRecs = chosenBots.map((bot) => {
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

    // 🔵 Mongo primary (varsa): bu fixture'ın eski bot tahminlerini sil, yenile
    if (db) {
      const col = db.collection("predictions");
      await col.deleteMany({ fixtureId: fx, isBot: true });
      await upsertManyPredictionsMongo(db, newRecs, { source: "bot" });
    }

    // 🟢 Dosya yazma — yalnızca dosya modunda veya mirror açıkken
    if (needFile) {
      const { list, wrap } = await loadPredList();
      const filtered = list.filter((p) => {
        const sameFixture = String(p.fixtureId || "") === fx;
        const uid = String(p.userId || "").trim().toLowerCase();
        const isBot = BOT_USER_ID_SET.has(uid);
        return !(sameFixture && isBot);
      });
      const finalList = filtered.concat(newRecs);
      if (wrap) {
        wrap.items = finalList;
        await writeJson(PREDS_FILE, wrap);
      } else {
        await writeJson(PREDS_FILE, finalList);
      }
    }

    return res.json({
      ok: true,
      fixtureId: fx,
      target,
      realPredictors: realCount,
      botCount: newRecs.length,
      country: meta.country || null,
      // Hedef zaten gerçek kullanıcılarla dolduysa bot üretilmez.
      note: needed === 0
        ? "Hedef gercek tahmincilerle doldu, bot eklenmedi."
        : undefined,
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

// ----------------- LİSTE -----------------
/**
 * GET /api/pred/list?fixtureId=...&userId=...
 *
 * `userId` verilirse: YALNIZCA o kullanıcının kayıtları — token gerekmez.
 * `userId` verilmezse: yönetici token'ı gerekir (aşağıdaki iki sebep).
 *
 * 1) SIZINTI. Uç hiçbir ara katmana sahip değildi ve `/api` altında herkese
 *    açıktı. `fixtureId` yoksa HER kullanıcının HER tahminini döküyordu —
 *    yerel veride 36.331 kayıt / 12,6 MB, her kayıtta `userId`. Yani tek
 *    kimlik doğrulamasız istekle kimin neyi tahmin ettiği dışarı çıkıyordu.
 *    `fixtureId` verildiğinde bile o maçtaki HERKESİN tahmini dönüyordu.
 *    Hemen altındaki `/pred/cancel` `verifyToken` kullanıyor; bu gözden kaçmış.
 *
 * 2) İSRAF. İki istemci ekranı da (predict.tsx, mystatus.tsx) tüm listeyi
 *    çekip `.find()` ile KENDİ kaydını arıyordu; gerisi atılıyordu. Bir maçta
 *    1280 bot tahmini varken bu, her ekran açılışında yüzlerce kilobayt.
 *    Artık sunucu süzüyor.
 *
 * ⚠️ Yanıt biçimi aynı kaldı (`{ok, count, items}`), istemciler yalnızca
 * `userId` eklendi — eski `.find()` mantığı tek elemanlı listede de çalışır.
 */
const LIST_MAX = 500;
router.get("/pred/list", async (req, res) => {
  try {
    const fx = String(req.query.fixtureId || "").trim();
    const uid = String(req.query.userId || "").trim();
    const uidLower = uid.toLowerCase();

    // ⚠️ BAŞKASININ KAYDI OKUNAMAZ. Eskiden `?userId=` ile istenen KİM olursa
    // olsun kaydı dönüyordu: `/pred/my` ile aynı sızıntının maç bazlı hâli.
    // Artık kimlik token'dan doğrulanır; `?userId=` yalnızca geriye uyumluluk
    // için kabul edilir ve token'daki kimlikle EŞLEŞMELİDİR.
    if (!uid) {
      return requireAdminToken(req, res, () => listeyiDondur(req, res, fx, ""));
    }
    return verifyToken(req, res, () => {
      const kendi = String(req.uid || "").trim().toLowerCase();
      if (!kendi) return res.status(401).json({ ok: false, error: "AUTH_REQUIRED" });
      if (uidLower !== kendi) {
        return res.status(403).json({ ok: false, error: "FORBIDDEN_OTHER_USER" });
      }
      return listeyiDondur(req, res, fx, kendi);
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: "PRED_LIST_FAILED",
      detail: String(e && (e.message || e)),
    });
  }
});

async function listeyiDondur(req, res, fx, uidLower) {
  try {
    const db = getDb(req);

    if (db) {
      const col = db.collection("predictions");
      const query = {};
      if (fx) query.fixtureId = fx;
      if (uidLower) query.userIdLower = uidLower;
      // Sınır her durumda: filtresiz sorgu tüm koleksiyonu belleğe alırdı.
      const items = await col.find(query, { projection: { _id: 0 } }).limit(LIST_MAX).toArray();
      return res.json({ ok: true, count: items.length, items, limited: items.length >= LIST_MAX });
    }

    // Dosya modu da aynı dökümü yapıyordu — aynı süzme ve sınır burada da.
    const { list } = await loadPredList();
    const filtered = list.filter((p) => {
      if (fx && String(p.fixtureId) !== fx) return false;
      if (uidLower && String(p.userId || p.user || "").toLowerCase() !== uidLower) return false;
      return true;
    });
    res.json({
      ok: true,
      count: Math.min(filtered.length, LIST_MAX),
      items: filtered.slice(0, LIST_MAX),
      limited: filtered.length > LIST_MAX,
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: "PRED_LIST_FAILED",
      detail: String(e && (e.message || e)),
    });
  }
}

// DELETE /api/pred/cancel — kullanıcının belirli bir maç tahmini sil
router.delete("/pred/cancel", verifyToken, express.json(), async (req, res) => {
  try {
    const { fixtureId } = req.body || {};
    const fx = String(fixtureId || "").trim();
    const uid = req.uid;
    if (!fx || !uid) return res.status(400).json({ ok: false, error: "FIXTURE_AND_USER_REQUIRED" });

    const db = getDb(req);
    const needFile = !db || PREDS_FILE_MIRROR;

    let deleted = 0;

    // 🔵 Mongo primary
    if (db) {
      const col = db.collection("predictions");
      const r = await col.deleteOne({ fixtureId: fx, userIdLower: uid.toLowerCase() });
      deleted = r.deletedCount || 0;
    }

    // 🟢 Dosya (dosya modu veya mirror açık)
    if (needFile) {
      await withFileLock(PREDS_FILE, async () => {
        const { list, wrap } = await loadPredList();
        const before = list.length;
        const filtered = list.filter((p) =>
          !(String(p.fixtureId || "") === fx && String(p.userId || p.user || "").toLowerCase() === uid.toLowerCase())
        );
        if (filtered.length !== before) {
          if (!db) deleted = before - filtered.length;
          await writeJson(PREDS_FILE, wrap ? { ...wrap, items: filtered } : filtered);
        }
      });
    }

    if (deleted === 0) return res.json({ ok: true, deleted: 0, message: "Tahmin bulunamadı" });
    res.json({ ok: true, deleted });
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
/**
 * ⚠️ KİMLİK TOKEN'DAN. `/pred/my` ile aynı sızıntının hafif hâliydi: hangi
 * maçlara tahmin verildiği başkası için de okunabiliyordu. İçerik dönmüyor
 * ama "iyi oyuncu şu an nerede oynuyor" bilgisini veriyordu.
 *
 * İstemcinin dört çağrı yerinin hepsi zaten KENDİ kimliğini gönderiyor
 * (live, kings, mystatus, me) — davranış değişmiyor.
 */
router.get("/pred/flags", verifyToken, async (req, res) => {
  try {
    const db = getDb(req);
    const uid = String(req.uid || "").trim();

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
/**
 * ⚠️ KİMLİK ARTIK TOKEN'DAN. Bu uç `?userId=` ile ÇAĞIRANIN belirlediği
 * kullanıcının tahminlerini döndürüyordu, hiçbir doğrulama yoktu:
 *
 *     GET /api/pred/my?userId=<baskasi>
 *       → o kişinin OYNANMAMIŞ maçlardaki tahminleri, tam içerikle
 *         (sonuç, kesin skor, ilk gol, ilk yarı)
 *
 * Ölçüldü: gerçek bir kullanıcının 3 açık tahmini kimliksiz okundu. Liderlik
 * tablosundan en iyi oyuncuyu bulup seçimlerini maç başlamadan kopyalamak
 * mümkündü — üstelik bedava, çünkü bakmak LC istemiyor. Oyunun rekabet
 * önermesi budur.
 *
 * `?userId=` yok sayılıyor; istemciler zaten kendi kimliğini gönderiyordu,
 * davranış değişmiyor.
 */
router.get("/pred/my", verifyToken, async (req, res) => {
  try {
    const db = getDb(req);
    const uid = String(req.uid || "").trim();
    if (!uid) return res.status(401).json({ ok: false, error: "AUTH_REQUIRED" });

    // 1) kullanıcının tüm fixtureId'leri
    const result = db
      ? await getPredFlagsFromMongo(db, uid, null)
      : await getPredFlagsFromFile(uid, null);

    const fidSet = new Set(result.fixtures);
    if (!fidSet.size) return res.json({ ok: true, count: 0, items: [] });

    // 2) maç meta verisi — Mongo birincil (bkz. lib/fixtures-store.cjs)
    const fxList = await FixturesStore.loadAll(req.app?.locals?.db || null);
    const fxMap = new Map(fxList.map((f) => [String(f.fixtureId || ""), f]));

    // 3) live state'den skor/status (data/live/<fixtureId>.json)
    async function getLiveState(fid) {
      try {
        const p = guvenliYol(LIVE_DIR, fid, ".json");
        return JSON.parse(await fsp.readFile(p, "utf8"));
      } catch { return null; }
    }

    // 4) pred detayı (ilk tahmin)
    const uidLower = uid.toLowerCase();

    // Mongo varsa kullanıcının tahminlerini tek sorguda al; yoksa dosyadan.
    let predByFixture = new Map();
    if (db) {
      const docs = await db.collection("predictions")
        .find({ userIdLower: uidLower, fixtureId: { $in: Array.from(fidSet) } })
        .toArray();
      predByFixture = new Map(docs.map((p) => [String(p.fixtureId || ""), p]));
    } else {
      const { list: predList } = await loadPredList();
      for (const p of predList) {
        if (String(p.userId || p.user || "").toLowerCase() !== uidLower) continue;
        predByFixture.set(String(p.fixtureId || ""), p);
      }
    }

    const items = [];
    for (const fid of fidSet) {
      const fx = fxMap.get(fid) || {};
      const live = await getLiveState(fid);
      const pred = predByFixture.get(fid) || null;

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

    // 1987 üyeleri — indeksli segment sorgusu (eskiden tüm kullanıcı dosyası
    // okunup her satır için doğrusal aranıyordu).
    const uyeler = await UsersStore.listSegment1987(getDb(req));
    const uyeSet = new Set(
      uyeler.map((u) => String(u.id || u.userId || "").trim().toLowerCase())
    );

    const is1987User = (uid) =>
      uyeSet.has(String(uid || "").trim().toLowerCase());

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
