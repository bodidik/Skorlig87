"use strict";

/**
 * af-sync: API-Football ücretsiz kotasına (100 istek/gün) sadık kalarak
 *  1) canlı skorları maç saatlerinde tek istekle (fixtures?live=all) çeker,
 *  2) biten maçların sonucunu (fixtures?ids=..., 20 maç/istek) alıp
 *     data/live/<fixtureId>.json state dosyasına yazar,
 *  3) istenirse settle2'yi tetikler (SKORLIG_AUTO_SETTLE=0 ile kapatılır).
 *
 * Kurallar:
 *  - Admin'in elle girdiği state'lere (source: "manual_state") ASLA dokunmaz.
 *  - settle2 idempotent olmadığı için her maç en fazla 1 kez settle edilir
 *    (state dosyasına settledAt yazılır) ve sadece af-sync'in kendi yazdığı
 *    state'ler otomatik settle edilir.
 *  - Günlük bütçe: quotas.AF.daily - DAILY_RESERVE; app'in kendi schedule
 *    istekleri için pay bırakılır.
 */

const path = require("path");
const fs = require("fs");
const fsp = fs.promises;

const DATA_DIR = path.join(__dirname, "..", "data");
const LIVE_DIR = path.join(DATA_DIR, "live");
const PROV_FILE = path.join(DATA_DIR, "providers.json");

const AF_BASE = process.env.AF_BASE || "https://v3.football.api-sports.io";
const AF_KEY = process.env.AF_KEY || "";
const AF_HDR = process.env.AF_HEADER_KEY || "x-apisports-key";
const TZ = "Europe/Istanbul";

const AUTO_SETTLE = process.env.SKORLIG_AUTO_SETTLE !== "0";

const DAILY_RESERVE = 10;                 // app'in schedule çağrıları için pay
const TICK_MS = 60 * 1000;                // ana döngü: 1 dk
const LIVE_POLL_MS = 3 * 60 * 1000;       // canlı skor: 3 dk'da bir (maç varsa)
const RESULT_POLL_MS = 20 * 60 * 1000;    // sonuç kontrolü: 20 dk'da bir
const LIVE_WINDOW_BEFORE_MS = 15 * 60 * 1000;   // kickoff -15dk
const LIVE_WINDOW_AFTER_MS = 150 * 60 * 1000;   // kickoff +150dk
const RESULT_AFTER_MS = 105 * 60 * 1000;        // kickoff +105dk sonrası "bitti" adayı

let _timer = null;
let _lastLivePoll = 0;
let _lastResultPoll = 0;
let _selfPort = null;

// ---------- json helpers ----------
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

function ymdInTZ(ms, tz) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(ms));
}

// ---------- kota bütçesi (providers.json ile aynı dosya) ----------
async function afBudget() {
  const m = (await readJson(PROV_FILE, null)) || {};
  const q = m.quotas && m.quotas.AF ? m.quotas.AF : { daily: 100, used: 0 };
  const today = new Date().toISOString().slice(0, 10);
  const used = m.quotaDay === today ? Number(q.used || 0) : 0;
  const daily = Number(q.daily || 100);
  return { ok: used < daily - DAILY_RESERVE, used, daily };
}

async function bumpAf(ok, ms) {
  try {
    const m = (await readJson(PROV_FILE, null)) || {};
    m.quotas ||= {};
    m.quotas.AF ||= { daily: 100, used: 0 };
    m.providers ||= {};
    m.providers.AF ||= { ok: 0, fail: 0, lastMs: 0, lastAt: null };
    const today = new Date().toISOString().slice(0, 10);
    if (m.quotaDay !== today) {
      m.quotaDay = today;
      for (const k of Object.keys(m.quotas)) if (m.quotas[k]) m.quotas[k].used = 0;
    }
    m.quotas.AF.used = Math.max(0, Number(m.quotas.AF.used || 0)) + 1;
    if (ok) m.providers.AF.ok = Number(m.providers.AF.ok || 0) + 1;
    else m.providers.AF.fail = Number(m.providers.AF.fail || 0) + 1;
    m.providers.AF.lastMs = Number(ms) || 0;
    m.providers.AF.lastAt = new Date().toISOString();
    m.updatedAt = new Date().toISOString();
    await writeJson(PROV_FILE, m);
  } catch (e) {
    console.warn("[af-sync] kota sayacı güncellenemedi:", e && e.message ? e.message : e);
  }
}

async function afGet(pathQs) {
  const t0 = Date.now();
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 15000);
    const r = await fetch(`${AF_BASE}${pathQs}`, {
      headers: { [AF_HDR]: AF_KEY, Accept: "application/json" },
      signal: ctrl.signal,
    });
    clearTimeout(tid);
    const j = await r.json();
    await bumpAf(true, Date.now() - t0);
    return Array.isArray(j && j.response) ? j.response : [];
  } catch (e) {
    await bumpAf(false, Date.now() - t0);
    console.warn("[af-sync] AF isteği başarısız:", e && e.message ? e.message : e);
    return [];
  }
}

// ---------- durum eşleme ----------
const FINISHED = new Set(["FT", "AET", "PEN"]);
const LIVE = new Set(["1H", "HT", "2H", "ET", "BT", "P", "LIVE", "INT"]);

function mapStatus(short) {
  const s = String(short || "NS").toUpperCase();
  if (FINISHED.has(s)) return "FT";
  return s;
}

// ---------- state dosyaları ----------
function stateFile(fid) {
  return path.join(LIVE_DIR, `${String(fid)}.json`);
}

async function readState(fid) {
  return await readJson(stateFile(fid), null);
}

/** Admin'in elle yazdığı state'e dokunma; FT olmuş af-sync state'ini de ezme. */
function canWriteState(existing) {
  if (!existing) return true;
  if (existing.source === "manual_state") return false;
  if (existing.status === "FT" && existing.score) return false;
  return true;
}

/** AF events -> firstGoal / kırmızı kart / penaltı alanları */
function detailsFromEvents(events, homeId, awayId) {
  const out = { firstGoal: null, redHome: false, redAway: false, penaltyAny: false, penaltySide: null };
  if (!Array.isArray(events)) return out;

  const sideOf = (ev) => {
    const tid = ev && ev.team ? ev.team.id : null;
    if (tid === homeId) return "H";
    if (tid === awayId) return "A";
    return null;
  };

  for (const ev of events) {
    const type = String(ev && ev.type || "");
    const detail = String(ev && ev.detail || "");
    let side = sideOf(ev);
    if (!side) continue;

    if (type === "Goal") {
      if (/own\s*goal/i.test(detail)) side = side === "H" ? "A" : "H"; // kendi kalesine: gol karşı tarafın
      if (!/missed/i.test(detail)) {
        if (!out.firstGoal) out.firstGoal = side;
      }
      if (/penalty/i.test(detail)) { // "Penalty" ve "Missed Penalty" ikisi de penaltı verildiği anlamına gelir
        out.penaltyAny = true;
        if (!out.penaltySide) out.penaltySide = sideOf(ev);
      }
    } else if (type === "Card" && /red/i.test(detail)) {
      if (side === "H") out.redHome = true;
      else out.redAway = true;
    }
  }
  return out;
}

function buildState(af, { withEvents = false } = {}) {
  const fx = af.fixture || {};
  const lg = af.league || {};
  const tm = af.teams || {};
  const goals = af.goals || {};
  const ht = af.score && af.score.halftime ? af.score.halftime : {};

  const st = {
    fixtureId: fx.id,
    kickoffISO: fx.date || null,
    status: mapStatus(fx.status && fx.status.short),
    minute: fx.status && Number.isFinite(fx.status.elapsed) ? fx.status.elapsed : null,
    score: {
      home: Number.isFinite(goals.home) ? goals.home : Number(goals.home || 0),
      away: Number.isFinite(goals.away) ? goals.away : Number(goals.away || 0),
    },
    league: lg.name || null,
    country: lg.country || null,
    home: tm.home ? tm.home.name : null,
    away: tm.away ? tm.away.name : null,
    source: "af-sync",
    updatedAt: new Date().toISOString(),
  };

  if (Number.isFinite(ht.home) && Number.isFinite(ht.away)) {
    st.htScore = { home: ht.home, away: ht.away };
  }

  if (withEvents) {
    const d = detailsFromEvents(af.events, tm.home && tm.home.id, tm.away && tm.away.id);
    st.firstGoal = d.firstGoal;
    st.redHome = d.redHome;
    st.redAway = d.redAway;
    st.penaltyAny = d.penaltyAny;
    st.penaltySide = d.penaltySide;
  }

  return st;
}

async function saveState(st, existing) {
  // af-sync'in daha önce yazdığı alanları (örn. settledAt) koru
  const merged = { ...(existing && existing.source !== "manual_state" ? existing : {}), ...st };
  await writeJson(stateFile(st.fixtureId), merged);
  return merged;
}

// ---------- settle ----------
async function autoSettle(fid) {
  if (!AUTO_SETTLE || !_selfPort) return;
  try {
    const st = await readState(fid);
    if (!st || st.source !== "af-sync" || st.settledAt || st.status !== "FT") return;

    const r = await fetch(`http://127.0.0.1:${_selfPort}/api/rt/settle2?fixtureId=${encodeURIComponent(fid)}`, {
      method: "POST",
    });
    const j = await r.json().catch(() => null);
    if (r.ok && j && j.ok !== false) {
      st.settledAt = new Date().toISOString();
      await writeJson(stateFile(fid), st);
      console.log(`[af-sync] settle OK: ${fid} (${st.home} ${st.score?.home}-${st.score?.away} ${st.away})`);
    } else {
      console.warn(`[af-sync] settle başarısız: ${fid}:`, j && (j.error || j.detail) || r.status);
    }
  } catch (e) {
    console.warn(`[af-sync] settle hatası (${fid}):`, e && e.message ? e.message : e);
  }
}

// ---------- ana döngü ----------
async function getTrackedFixtures() {
  // live2 ile aynı filtre + cache + kota yolu
  const { fixturesByDate } = require("../routes/live2.cjs");
  if (typeof fixturesByDate !== "function") return [];

  const now = Date.now();
  const d0 = ymdInTZ(now - 24 * 3600 * 1000, TZ); // dün (gece yarısını aşan maçlar)
  const d1 = ymdInTZ(now, TZ);                     // bugün

  const all = [];
  for (const d of [d0, d1]) {
    try {
      all.push(...(await fixturesByDate(d)));
    } catch (e) {
      console.warn(`[af-sync] fixturesByDate(${d}) hatası:`, e && e.message ? e.message : e);
    }
  }
  // sadece AF kaynaklı (sayısal id'li) maçlar senkronlanabilir
  return all.filter((f) => f.source === "AF" && Number.isFinite(Number(f.fixtureId)));
}

async function tick() {
  if (!AF_KEY) return;

  const budget = await afBudget();
  if (!budget.ok) return; // bütçe bitti: bugün sessiz kal

  let fixtures;
  try {
    fixtures = await getTrackedFixtures();
  } catch (e) {
    console.warn("[af-sync] fixture listesi alınamadı:", e && e.message ? e.message : e);
    return;
  }
  if (!fixtures.length) return;

  const now = Date.now();

  // --- 1) canlı skorlar ---
  if (now - _lastLivePoll >= LIVE_POLL_MS) {
    const liveCandidates = [];
    for (const f of fixtures) {
      const ko = new Date(f.kickoffISO || 0).getTime();
      if (!Number.isFinite(ko)) continue;
      if (now < ko - LIVE_WINDOW_BEFORE_MS || now > ko + LIVE_WINDOW_AFTER_MS) continue;
      const st = await readState(f.fixtureId);
      if (st && st.status === "FT") continue;
      liveCandidates.push(String(f.fixtureId));
    }

    if (liveCandidates.length) {
      _lastLivePoll = now;
      const wanted = new Set(liveCandidates);
      const live = await afGet(`/fixtures?live=all`);
      let updated = 0;
      for (const af of live) {
        const fid = String(af.fixture && af.fixture.id || "");
        if (!wanted.has(fid)) continue;
        const existing = await readState(fid);
        if (!canWriteState(existing)) continue;
        await saveState(buildState(af), existing);
        updated++;
      }
      if (updated) console.log(`[af-sync] canlı skor güncellendi: ${updated} maç (izlenen: ${liveCandidates.length})`);
    }
  }

  // --- 2) biten maçların sonuçları ---
  if (now - _lastResultPoll >= RESULT_POLL_MS) {
    const overdue = [];
    for (const f of fixtures) {
      const ko = new Date(f.kickoffISO || 0).getTime();
      if (!Number.isFinite(ko) || now < ko + RESULT_AFTER_MS) continue;
      const st = await readState(f.fixtureId);
      if (st && st.status === "FT" && st.score) {
        if (st.source === "af-sync" && !st.settledAt) await autoSettle(f.fixtureId);
        continue;
      }
      if (st && st.source === "manual_state") continue;
      overdue.push(String(f.fixtureId));
    }

    if (overdue.length) {
      _lastResultPoll = now;
      // Ücretsiz plan ids= (toplu) parametresini desteklemiyor; tek tek id= çekiyoruz.
      // (id= cevabı events içeriyor -> firstGoal / kırmızı kart / penaltı çıkarılabiliyor)
      for (const fid of overdue) {
        const b = await afBudget();
        if (!b.ok) break;
        const res = await afGet(`/fixtures?id=${encodeURIComponent(fid)}`);
        const af = res[0];
        if (!af) continue;
        const short = af.fixture && af.fixture.status ? af.fixture.status.short : "NS";
        if (!FINISHED.has(String(short).toUpperCase())) continue;
        const existing = await readState(fid);
        if (!canWriteState(existing)) continue;
        const st = await saveState(buildState(af, { withEvents: true }), existing);
        console.log(`[af-sync] sonuç yazıldı: ${fid} ${st.home} ${st.score.home}-${st.score.away} ${st.away}`);
        await autoSettle(fid);
      }
    }
  }
}

function start(port) {
  if (_timer) return;
  _selfPort = Number(port) || 4102;
  if (!AF_KEY) {
    console.log("[af-sync] AF_KEY yok, senkron devre dışı");
    return;
  }
  // İlk tick'i hemen değil 10sn sonra at (server tam otursun)
  setTimeout(() => { tick().catch((e) => console.warn("[af-sync] tick hatası:", e && e.message ? e.message : e)); }, 10000);
  _timer = setInterval(() => {
    tick().catch((e) => console.warn("[af-sync] tick hatası:", e && e.message ? e.message : e));
  }, TICK_MS);
  console.log(`[af-sync] başladı (canlı: ${LIVE_POLL_MS / 60000}dk, sonuç: ${RESULT_POLL_MS / 60000}dk, auto-settle: ${AUTO_SETTLE ? "açık" : "kapalı"})`);
}

function stop() {
  if (_timer) clearInterval(_timer);
  _timer = null;
}

module.exports = { start, stop, tick };
