"use strict";

/**
 * Türkiye Tahmin Ligi — Süper Lig'e paralel haftalık tahmin ligi.
 *
 * Kadro (hafta hafta artırılabilir): Trabzonspor, Galatasaray, Fenerbahçe,
 * Beşiktaş, Başakşehir, Samsunspor, Göztepe.
 *
 * Maçlar var olan fixturesByDate boru hattından gelir (AF date sorgusu
 * ücretsiz planda çalışır; league+season çalışmaz). Süper Lig (leagueId 203
 * ya da isim/ülke) + kadro takımı filtresiyle seçilir, ISO haftaya (Pzt-Paz)
 * gruplanır. Haftalık siralama settle2'nin match-results snapshot'larindaki
 * kullanici-basi puanlardan hesaplanir (dogru = arti, yanlis = ceza; settle2
 * zaten boyle puanliyor). Bir haftanin tum maclari settle olup hafta gecince
 * ilk 3'e LC token odulu verilir (bir kez, idempotent).
 */

const express = require("express");
const router = express.Router();

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = path.join(__dirname, "..", "data");
const RESULTS_FILE = path.join(DATA_DIR, "match-results.json");
const LIVE_DIR = path.join(DATA_DIR, "live");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const WALLET_FILE = path.join(DATA_DIR, "lc-wallet.json");
const STATE_FILE = path.join(DATA_DIR, "tr-league.json"); // sonuçlanmış haftalar + ödül kayıtları

const SUPER_LIG_ID = 203;

// Kadro — hafta hafta genişletmek için buraya takım eklemek yeterli.
// aliases: sağlayıcıların döndürebileceği isim varyantları (aksan/İng.).
const SQUAD = [
  { key: "trabzonspor",  name: "Trabzonspor",   aliases: ["trabzonspor", "trabzon"] },
  { key: "galatasaray",  name: "Galatasaray",   aliases: ["galatasaray", "galatasaray sk"] },
  { key: "fenerbahce",   name: "Fenerbahçe",    aliases: ["fenerbahce", "fenerbahçe", "fenerbahce sk"] },
  { key: "besiktas",     name: "Beşiktaş",      aliases: ["besiktas", "beşiktaş", "besiktas jk"] },
  { key: "basaksehir",   name: "Başakşehir",    aliases: ["basaksehir", "başakşehir", "istanbul basaksehir", "medipol basaksehir"] },
  { key: "samsunspor",   name: "Samsunspor",    aliases: ["samsunspor", "samsun"] },
  { key: "goztepe",      name: "Göztepe",       aliases: ["goztepe", "göztepe"] },
];

// Haftalık token ödülü: sıralamaya göre (beraberlikte hepsi tam ödül alır)
const WEEKLY_REWARDS = [
  Number(process.env.SKORLIG_TR_W1 || 30), // 1.
  Number(process.env.SKORLIG_TR_W2 || 15), // 2.
  Number(process.env.SKORLIG_TR_W3 || 10), // 3.
];

// ---------- helpers ----------
async function readJson(file, fb) {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"));
  } catch {
    return fb;
  }
}
async function writeJson(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(data, null, 2), "utf8");
}

function norm(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[�?]/g, "")
    .toLowerCase()
    .trim();
}

function squadTeamOf(name) {
  const n = norm(name);
  if (!n) return null;
  for (const t of SQUAD) {
    if (t.aliases.some((a) => n === norm(a) || n.includes(norm(a)))) return t;
  }
  return null;
}

function isSuperLigTR(fx) {
  if (fx.leagueId === SUPER_LIG_ID) return true;
  const c = norm(fx.country);
  const lg = norm(fx.league);
  return (c === "turkey" || c === "turkiye") && /super\s*lig|super\s*lig/.test(lg);
}

/** Bu fikstür TR ligine ait mi? (Süper Lig + en az bir kadro takımı) */
function isTrLeagueFixture(fx) {
  if (!isSuperLigTR(fx)) return false;
  return !!(squadTeamOf(fx.home) || squadTeamOf(fx.away));
}

// ISO hafta anahtarı (Pzt-Paz), örn "2026-W34"
function isoWeekKey(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7; // Pazar=7
  t.setUTCDate(t.getUTCDate() + 4 - day); // perşembeye çek
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function weekRange(weekKey) {
  // haftanın pazartesi 00:00Z ve pazar 23:59Z
  const m = /^(\d{4})-W(\d{2})$/.exec(weekKey || "");
  if (!m) return { fromMs: 0, toMs: 0 };
  const year = Number(m[1]);
  const week = Number(m[2]);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const day = jan4.getUTCDay() || 7;
  const week1Mon = new Date(jan4);
  week1Mon.setUTCDate(jan4.getUTCDate() - day + 1);
  const mon = new Date(week1Mon);
  mon.setUTCDate(week1Mon.getUTCDate() + (week - 1) * 7);
  const sun = new Date(mon);
  sun.setUTCDate(mon.getUTCDate() + 6);
  return {
    fromMs: mon.getTime(),
    toMs: sun.getTime() + (24 * 3600 - 1) * 1000,
    fromISO: mon.toISOString().slice(0, 10),
    toISO: sun.toISOString().slice(0, 10),
  };
}

const CACHE_DIR = path.join(DATA_DIR, "cache");

/**
 * Sadece mevcut disk cache'inden TR ligi fikstürlerini okur — sağlayıcı
 * çağrısı yapmaz, kota yakmaz. Geniş pencereli /weeks özeti için.
 */
async function collectFixturesFromCache() {
  let files = [];
  try {
    files = (await fsp.readdir(CACHE_DIR)).filter((f) => /^fx-\d{4}-\d{2}-\d{2}\.json$/.test(f));
  } catch {
    return [];
  }
  const seen = new Set();
  const out = [];
  for (const file of files) {
    const c = await readJson(path.join(CACHE_DIR, file), null);
    for (const fx of (c && c.items) || []) {
      if (!isTrLeagueFixture(fx)) continue;
      const id = String(fx.fixtureId);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(fx);
    }
  }
  return out;
}

// ---------- fikstür toplama (birkaç haftalık pencere) ----------
async function collectFixtures(backDays, fwdDays) {
  const { fixturesByDate } = require("./live2.cjs");
  if (typeof fixturesByDate !== "function") return [];

  const ymd = (ms) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Istanbul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(ms));

  const now = Date.now();
  const days = [];
  for (let d = -backDays; d <= fwdDays; d++) days.push(ymd(now + d * 86400000));

  const seen = new Set();
  const out = [];
  for (const day of days) {
    let list = [];
    try {
      list = await fixturesByDate(day);
    } catch {
      list = [];
    }
    for (const fx of list) {
      if (!isTrLeagueFixture(fx)) continue;
      const id = String(fx.fixtureId);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(fx);
    }
  }
  return out;
}

// ---------- haftalık sıralama (match-results snapshot'larından) ----------
async function buildWeekBoard(weekFixtures) {
  const fixtureIds = weekFixtures.map((f) => String(f.fixtureId));
  const resultsRaw = await readJson(RESULTS_FILE, []);
  const arr = Array.isArray(resultsRaw) ? resultsRaw : resultsRaw.items || [];
  const byFixture = new Map(arr.map((r) => [String(r.fixtureId), r]));

  const totals = new Map(); // userId -> { points, matches }
  let settledCount = 0;

  const fixtureViews = [];
  for (const f of weekFixtures) {
    const fid = String(f.fixtureId);
    const snap = byFixture.get(fid);
    const st = await readJson(path.join(LIVE_DIR, `${fid}.json`), null);

    fixtureViews.push({
      fixtureId: fid,
      home: f.home,
      away: f.away,
      kickoffISO: f.kickoffISO,
      round: f.round || null,
      status: st?.status || (snap ? "FT" : "NS"),
      score: st?.score || snap?.finalScore || null,
      settled: !!snap,
    });

    if (!snap) continue;
    settledCount++;
    for (const row of snap.rows || []) {
      const uid = String(row.userId || "");
      if (!uid || uid.toLowerCase().startsWith("bot_")) continue;
      const cur = totals.get(uid) || { userId: uid, points: 0, matches: 0 };
      cur.points += Number(row.points || 0);
      cur.matches++;
      totals.set(uid, cur);
    }
  }

  const board = Array.from(totals.values())
    .map((x) => ({ ...x, points: Math.round(x.points * 100) / 100 }))
    .sort((a, b) => b.points - a.points || a.userId.localeCompare(b.userId));

  return { board, fixtureViews, settledCount, fixtureCount: fixtureIds.length };
}

// ---------- LC ödülü (settle2/mini ile aynı çift-yazım deseni) ----------
async function awardWeeklyLc(awards, weekKey) {
  // awards: [{ userId, amount }]
  const real = awards.filter((a) => a.userId && !String(a.userId).toLowerCase().startsWith("bot_") && a.amount > 0);
  if (!real.length) return;

  const nowISO = new Date().toISOString();
  const usersRaw = await readJson(USERS_FILE, { items: [] });
  const usersItems = Array.isArray(usersRaw) ? usersRaw : usersRaw.items || [];
  const wallet = (await readJson(WALLET_FILE, { users: [], ledger: [] })) || {};
  if (!Array.isArray(wallet.users)) wallet.users = [];
  if (!Array.isArray(wallet.ledger)) wallet.ledger = [];

  for (const { userId: uid, amount } of real) {
    let u = usersItems.find((x) => String(x.userId) === uid);
    if (!u) {
      u = { userId: uid, mainTeam: null, createdAt: nowISO, lc: amount, lcLastDaily: null };
      usersItems.push(u);
    } else {
      u.lc = Number(u.lc || 0) + amount;
    }
    u.lcUpdatedAt = nowISO;
    u.lcLastReason = "tr_league_weekly";
    u.lcLastAmount = amount;

    let wu = wallet.users.find((x) => String(x.userId || "").toLowerCase() === uid.toLowerCase());
    if (!wu) {
      wu = { userId: uid, balance: 0, createdAt: nowISO, updatedAt: nowISO, lastDailyAt: null, totalEarned: 0, totalSpent: 0 };
      wallet.users.push(wu);
    }
    wu.balance = Number(wu.balance || 0) + amount;
    wu.totalEarned = Number(wu.totalEarned || 0) + amount;
    wu.updatedAt = nowISO;

    wallet.ledger.push({
      id: "tx_" + Date.now().toString(36) + "_" + crypto.randomBytes(3).toString("hex"),
      userId: uid,
      kind: "reward",
      amount,
      reason: "tr_league_weekly",
      fixtureId: null,
      meta: { weekKey },
      createdAt: nowISO,
    });
  }

  await writeJson(USERS_FILE, Array.isArray(usersRaw) ? usersItems : { ...usersRaw, items: usersItems });
  wallet.updatedAt = nowISO;
  await writeJson(WALLET_FILE, wallet);
}

const _finalizingWeek = new Set();

/** Hafta bittiyse (tüm maçlar settle + hafta geçmiş) ilk 3'e ödül ver (bir kez). */
async function finalizeWeekIfDone(weekKey, board, settledCount, fixtureCount) {
  if (!fixtureCount || settledCount < fixtureCount) return null;

  const { toMs } = weekRange(weekKey);
  if (Date.now() < toMs) return null; // hafta henüz bitmedi

  const state = await readJson(STATE_FILE, { settledWeeks: {} });
  state.settledWeeks = state.settledWeeks || {};
  if (state.settledWeeks[weekKey]) return state.settledWeeks[weekKey]; // zaten ödüllendi

  if (_finalizingWeek.has(weekKey)) return null;
  _finalizingWeek.add(weekKey);
  try {
    // tekrar oku (yarış)
    const fresh = await readJson(STATE_FILE, { settledWeeks: {} });
    fresh.settledWeeks = fresh.settledWeeks || {};
    if (fresh.settledWeeks[weekKey]) return fresh.settledWeeks[weekKey];

    // sıralamaya göre ödül dağıt (beraberlikte aynı sıradakiler tam ödül)
    const awards = [];
    const winners = [];
    let rank = 0;
    let prevPoints = null;
    for (let i = 0; i < board.length; i++) {
      const row = board[i];
      if (row.points <= 0) break; // puansızlar ödül almaz
      if (prevPoints === null || row.points < prevPoints) {
        rank = i; // 0-index sıra (beraberlerde aynı rank korunur)
        prevPoints = row.points;
      }
      const reward = WEEKLY_REWARDS[rank];
      if (reward && reward > 0) {
        awards.push({ userId: row.userId, amount: reward });
        if (rank === 0) winners.push(row.userId);
      }
    }

    await awardWeeklyLc(awards, weekKey);

    const record = {
      weekKey,
      finishedAt: new Date().toISOString(),
      winners,
      rewards: awards,
      top: board.slice(0, 5),
    };
    fresh.settledWeeks[weekKey] = record;
    await writeJson(STATE_FILE, fresh);
    console.log(`[tr-league] hafta bitti ${weekKey} | kazanan: ${winners.join(", ") || "yok"} | ödül alan: ${awards.length}`);
    return record;
  } finally {
    _finalizingWeek.delete(weekKey);
  }
}

// ---------- fikstürleri haftaya grupla ----------
function groupByWeek(fixtures) {
  const weeks = new Map();
  for (const f of fixtures) {
    const wk = isoWeekKey(f.kickoffISO);
    if (!wk) continue;
    if (!weeks.has(wk)) weeks.set(wk, []);
    weeks.get(wk).push(f);
  }
  return weeks;
}

// ---------- ENDPOINTS ----------

// GET /api/tr-league/info : lig tanımı + kadro
router.get("/info", (req, res) => {
  res.json({
    ok: true,
    name: "Türkiye Tahmin Ligi",
    leagueId: SUPER_LIG_ID,
    squad: SQUAD.map((t) => ({ key: t.key, name: t.name })),
    weeklyRewards: WEEKLY_REWARDS,
  });
});

// GET /api/tr-league/current?userId= : içinde bulunulan haftanın maçları + sıralama
router.get("/current", async (req, res) => {
  try {
    const userId = String(req.query.userId || "").trim();
    const fixtures = await collectFixtures(3, 10);
    const weeks = groupByWeek(fixtures);

    const nowWk = isoWeekKey(new Date().toISOString());
    // Bu hafta maç yoksa, maçı olan en yakın gelecekteki haftaya geç
    let targetWk = nowWk;
    if (!weeks.has(nowWk) || !weeks.get(nowWk).length) {
      const future = [...weeks.keys()]
        .filter((wk) => weekRange(wk).toMs >= Date.now())
        .sort();
      targetWk = future[0] || [...weeks.keys()].sort().pop() || nowWk;
    }

    const wkFixtures = (weeks.get(targetWk) || []).sort(
      (a, b) => new Date(a.kickoffISO) - new Date(b.kickoffISO)
    );
    const { board, fixtureViews, settledCount, fixtureCount } = await buildWeekBoard(wkFixtures);
    const finalized = await finalizeWeekIfDone(targetWk, board, settledCount, fixtureCount);

    const myRank = userId
      ? (() => {
          const ix = board.findIndex((r) => r.userId.toLowerCase() === userId.toLowerCase());
          return ix >= 0 ? { rank: ix + 1, points: board[ix].points } : null;
        })()
      : null;

    const range = weekRange(targetWk);
    res.json({
      ok: true,
      weekKey: targetWk,
      weekRange: range,
      isCurrentWeek: targetWk === nowWk,
      fixtures: fixtureViews,
      board,
      settledCount,
      fixtureCount,
      finalized: finalized || null,
      myRank,
      totalWeeksAvailable: weeks.size,
    });
  } catch (e) {
    console.error("[tr-league] current error:", e);
    res.status(500).json({ ok: false, error: "TR_LEAGUE_CURRENT_FAILED", detail: String(e?.message || e) });
  }
});

// GET /api/tr-league/weeks : mevcut haftaların özeti (durum + kazanan)
router.get("/weeks", async (req, res) => {
  try {
    // Kota yakmamak için sadece cache'ten oku (taze fetch yok)
    const fixtures = await collectFixturesFromCache();
    const weeks = groupByWeek(fixtures);
    const state = await readJson(STATE_FILE, { settledWeeks: {} });

    const out = [...weeks.keys()]
      .sort()
      .map((wk) => {
        const fxs = weeks.get(wk);
        const range = weekRange(wk);
        const settled = state.settledWeeks?.[wk] || null;
        let status = "upcoming";
        if (settled) status = "settled";
        else if (Date.now() >= range.fromMs && Date.now() <= range.toMs) status = "live";
        else if (Date.now() > range.toMs) status = "pending"; // bitmiş ama henüz tüm sonuçlar/ödül yok
        return {
          weekKey: wk,
          fromISO: range.fromISO,
          toISO: range.toISO,
          matchCount: fxs.length,
          status,
          winners: settled?.winners || null,
        };
      });

    res.json({ ok: true, weeks: out });
  } catch (e) {
    res.status(500).json({ ok: false, error: "TR_LEAGUE_WEEKS_FAILED", detail: String(e?.message || e) });
  }
});

// GET /api/tr-league/week/:weekKey?userId= : belirli hafta detayı
router.get("/week/:weekKey", async (req, res) => {
  try {
    const weekKey = String(req.params.weekKey || "").trim();
    const userId = String(req.query.userId || "").trim();
    const range = weekRange(weekKey);
    if (!range.toMs) return res.status(400).json({ ok: false, error: "BAD_WEEK_KEY" });

    // Önce cache'ten (kota yakmaz); istenen hafta o an aktif/yakınsa taze çek
    let fixtures = (await collectFixturesFromCache()).filter(
      (f) => isoWeekKey(f.kickoffISO) === weekKey
    );
    const now = Date.now();
    const nearWindow = range.toMs >= now - 2 * 86400000 && range.fromMs <= now + 12 * 86400000;
    if (!fixtures.length && nearWindow) {
      const backDays = Math.max(0, Math.ceil((now - range.fromMs) / 86400000) + 2);
      const fwdDays = Math.max(0, Math.ceil((range.toMs - now) / 86400000) + 2);
      fixtures = (await collectFixtures(backDays, fwdDays)).filter(
        (f) => isoWeekKey(f.kickoffISO) === weekKey
      );
    }
    fixtures.sort((a, b) => new Date(a.kickoffISO) - new Date(b.kickoffISO));

    const { board, fixtureViews, settledCount, fixtureCount } = await buildWeekBoard(fixtures);
    const finalized = await finalizeWeekIfDone(weekKey, board, settledCount, fixtureCount);

    const myRank = userId
      ? (() => {
          const ix = board.findIndex((r) => r.userId.toLowerCase() === userId.toLowerCase());
          return ix >= 0 ? { rank: ix + 1, points: board[ix].points } : null;
        })()
      : null;

    res.json({
      ok: true,
      weekKey,
      weekRange: range,
      fixtures: fixtureViews,
      board,
      settledCount,
      fixtureCount,
      finalized: finalized || null,
      myRank,
    });
  } catch (e) {
    console.error("[tr-league] week error:", e);
    res.status(500).json({ ok: false, error: "TR_LEAGUE_WEEK_FAILED", detail: String(e?.message || e) });
  }
});

module.exports = router;
