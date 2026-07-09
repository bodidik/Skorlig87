"use strict";

/**
 * routes/live1987.cjs
 *
 * 1987 modu (TEST DÖNEMİ):
 * - Sadece Galatasaray ve Fenerbahçe maçları
 * - AF + TSDB'den çekip filtreler
 * - /api/live1987/open      → şimdi .. +30 saat
 * - /api/live1987/schedule  → bugün, yarın, +1 gün
 */

const express = require("express");
const router  = express.Router();
const fs      = require("fs");
const fsp     = fs.promises;
const path    = require("path");

// ---- AF / TSDB ayarları ----
const AF_BASE = process.env.AF_BASE || "https://v3.football.api-sports.io";
const AF_KEY  = process.env.AF_KEY  || "";
const AF_HDR  = process.env.AF_HEADER_KEY || "x-apisports-key";
const TZ      = "Europe/Istanbul";

// ---- Providers state (ortak dosya) ----
const DATA_DIR  = path.join(__dirname, "..", "data");
const PROV_FILE = path.join(DATA_DIR, "providers.json");

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

// ---- 1987 için takip edilen takımlar (TEST: sadece GS & FB) ----
const TEAMS_1987 = [
  "Galatasaray",
  "Fenerbahce",
  "Fenerbahçe",
  // Test dönemi sonrası için tekrar açılabilir:
  // "Türkiye",
  // "Turkey",
];

// 1987 filtresi: sadece ilgili takımların maçları
function is1987Match(item) {
  const home = String(item.home || "").toLowerCase();
  const away = String(item.away || "").toLowerCase();
  return TEAMS_1987.some((name) => {
    const n = name.toLowerCase();
    return home.includes(n) || away.includes(n);
  });
}

// ---- Provider helper'ları (AF/TSDB) ----
function emptyProv() {
  return {
    providers: {
      AF:   { ok: 0, fail: 0, lastMs: 0, lastAt: null },
      TSDB: { ok: 0, fail: 0, lastMs: 0, lastAt: null }
    },
    quotas: {
      AF:   { daily: 100,  used: 0 },
      TSDB: { daily: 1000, used: 0 }
    },
    updatedAt: null
  };
}

async function loadProv() {
  return await readJson(PROV_FILE, emptyProv());
}

async function bumpProv(name, ok = true, ms = 0) {
  const m = await loadProv();
  m.providers[name] ||= { ok: 0, fail: 0, lastMs: 0, lastAt: null };
  if (ok) m.providers[name].ok++;
  else    m.providers[name].fail++;
  m.providers[name].lastMs = ms;
  m.providers[name].lastAt = new Date().toISOString();

  m.quotas[name] ||= { daily: 100, used: 0 };
  m.quotas[name].used = Math.max(0, (m.quotas[name].used || 0) + 1);
  m.updatedAt = new Date().toISOString();

  await writeJson(PROV_FILE, m);
}

function quota90(m, name) {
  const q = m.quotas?.[name];
  if (!q) return false;
  const daily = q.daily || 100;
  return (q.used || 0) >= 0.9 * daily;
}

// ---- Fetch helper ----
async function safeFetch(url, opts = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(tid);
    return r;
  } catch (e) {
    clearTimeout(tid);
    throw e;
  }
}

// ---- Normalizasyon ----
function normalizeAF(x) {
  return {
    fixtureId: x?.fixture?.id,
    kickoffISO: x?.fixture?.date || null,
    league: x?.league?.name || null,
    country: x?.league?.country || null,
    home: x?.teams?.home?.name || null,
    away: x?.teams?.away?.name || null,
    status: x?.fixture?.status?.short || "NS",
    source: "AF"
  };
}

function normalizeTS(e) {
  return {
    fixtureId: e.idEvent,
    kickoffISO:
      e.dateEvent && e.strTime
        ? `${e.dateEvent}T${e.strTime}:00Z`
        : e.dateEvent || null,
    league: e.strLeague || null,
    country: e.strCountry || null,
    home: e.strHomeTeam || null,
    away: e.strAwayTeam || null,
    status: "NS",
    source: "TSDB"
  };
}

// ---- AF: tarih bazlı ----
async function afByDate(isoDate) {
  const m = await loadProv();
  if (!AF_KEY || quota90(m, "AF")) return [];
  const t0 = Date.now();
  try {
    const qs = new URLSearchParams({ date: isoDate, timezone: TZ });
    const r = await safeFetch(`${AF_BASE}/fixtures?${qs}`, {
      headers: {
        [AF_HDR]: AF_KEY,
        Accept: "application/json"
      }
    }, 12000);

    const j = await r.json();
    const arr = Array.isArray(j?.response) ? j.response : [];
    const out = arr.map(normalizeAF).filter(is1987Match);
    await bumpProv("AF", true, Date.now() - t0);
    return out;
  } catch (e) {
    await bumpProv("AF", false, Date.now() - t0);
    return [];
  }
}

// ---- TSDB: tarih bazlı ----
async function tsdbByDate(isoDate) {
  const t0 = Date.now();
  try {
    const r = await safeFetch(
      `https://www.thesportsdb.com/api/v1/json/3/eventsonday.php?d=${encodeURIComponent(
        isoDate
      )}&s=Soccer`,
      {},
      12000
    );
    const j = await r.json();
    const arr = Array.isArray(j?.events) ? j.events : [];
    const out = arr.map(normalizeTS).filter(is1987Match);
    await bumpProv("TSDB", true, Date.now() - t0);
    return out;
  } catch (e) {
    await bumpProv("TSDB", false, Date.now() - t0);
    return [];
  }
}

// ---- Compose (TSDB → AF) ----
async function fixturesByDate(isoDate) {
  const res = [];
  try {
    const ts = await tsdbByDate(isoDate);
    res.push(...ts);
  } catch {}
  try {
    const af = await afByDate(isoDate);
    res.push(...af);
  } catch {}
  return dedupe(res);
}

function dedupe(arr) {
  const seen = new Set();
  const out = [];
  for (const it of arr) {
    const k = [
      it.country || "",
      it.league || "",
      it.home || "",
      it.away || "",
      it.kickoffISO || ""
    ].join("|");
    if (!seen.has(k)) {
      seen.add(k);
      out.push(it);
    }
  }
  return out;
}

// ---- Zaman helper'ları ----
function pad2(n) {
  return String(n).padStart(2, "0");
}

function toYMD(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function within(dtISO, fromMs, toMs) {
  const t = new Date(dtISO).getTime();
  return Number.isFinite(t) && t >= fromMs && t <= toMs;
}

// ---- Sabitler ----
const OPEN_1987_HOURS = 30; // şimdi..+30h

// ----------------------------------------------------
// GET /api/live1987/open : 1987 maçları, now..+30h
// ----------------------------------------------------
router.get("/open", async (req, res) => {
  try {
    const nowMs = Date.now();
    const toMs  = nowMs + OPEN_1987_HOURS * 3600 * 1000;

    const now = new Date(nowMs);
    const d0  = toYMD(now);
    const d1  = toYMD(new Date(nowMs + 24 * 3600 * 1000));
    const d2  = toYMD(new Date(nowMs + 48 * 3600 * 1000)); // buffer

    let base = [];
    try { base = base.concat(await fixturesByDate(d0)); } catch {}
    try { base = base.concat(await fixturesByDate(d1)); } catch {}
    try { base = base.concat(await fixturesByDate(d2)); } catch {}

    const windowed = base
      .filter((it) => !!it.kickoffISO)
      .filter((it) => within(it.kickoffISO, nowMs, toMs))
      .sort(
        (a, b) =>
          new Date(a.kickoffISO).getTime() -
          new Date(b.kickoffISO).getTime()
      );

    res.json({
      ok: true,
      mode: "1987",
      window: { fromISO: new Date(nowMs).toISOString(), hoursAhead: OPEN_1987_HOURS },
      count: windowed.length,
      fixtures: windowed,
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: "LIVE1987_OPEN_FAILED",
      detail: String(e && (e.message || e)),
    });
  }
});

// ----------------------------------------------------
// GET /api/live1987/schedule : bugün + yarın + +1 gün
// ----------------------------------------------------
router.get("/schedule", async (req, res) => {
  try {
    const nowMs = Date.now();
    const d0 = toYMD(new Date(nowMs));
    const d1 = toYMD(new Date(nowMs + 24 * 3600 * 1000));
    const d2 = toYMD(new Date(nowMs + 48 * 3600 * 1000));

    let base = [];
    try { base = base.concat(await fixturesByDate(d0)); } catch {}
    try { base = base.concat(await fixturesByDate(d1)); } catch {}
    try { base = base.concat(await fixturesByDate(d2)); } catch {}

    const list = base
      .filter((it) => !!it.kickoffISO)
      .sort(
        (a, b) =>
          new Date(a.kickoffISO).getTime() -
          new Date(b.kickoffISO).getTime()
      );

    res.json({
      ok: true,
      mode: "1987",
      rangeDays: [d0, d1, d2],
      count: list.length,
      fixtures: list,
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: "LIVE1987_SCHEDULE_FAILED",
      detail: String(e && (e.message || e)),
    });
  }
});

module.exports = router;
