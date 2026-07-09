"use strict";

const express = require("express");
const router = express.Router();

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

// Node 18+ için global fetch vardır; yoksa node-fetch kullan
const fetch = globalThis.fetch || require("node-fetch");

// 🔹 Runtime mode
const { getRuntimeMode } = require("../lib/runtime-mode.cjs");

// ========= ENV / SABİTLER =========

const AF_BASE = process.env.AF_BASE || "https://v3.football.api-sports.io";
const AF_KEY = process.env.AF_KEY || "";
const AF_HDR = process.env.AF_HEADER_KEY || "x-apisports-key";

const FDO_BASE = process.env.FDO_BASE || "https://api.football-data.org/v4";
const FDO_KEY = process.env.FDO_TOKEN || process.env.FDO_KEY || "";
const FDO_HDR = process.env.FDO_HEADER_KEY || "X-Auth-Token";

const TZ = "Europe/Istanbul";
function ymdInTZ(ms, timeZone = TZ) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

const DATA_DIR = path.join(__dirname, "..", "data");
const PROV_FILE = path.join(DATA_DIR, "providers.json"); // provider.js ile aynı dosya
const FAV_FILE = path.join(DATA_DIR, "users.json"); // { users:[{id, mainTeam}] }
const MANUAL_FIXTURES_FILE = path.join(DATA_DIR, "fixtures.json");
const ADMIN_ALERTS_FILE = path.join(DATA_DIR, "admin-alerts.json");
const LIVE_DIR = path.join(DATA_DIR, "live"); // fixture state için (score, status vs.)
// Manuel listeleme: ileri kaç gün gösterelim (test dönemi)
const MANUAL_LIST_AHEAD_DAYS = 60;

// Tahmin penceresi: ileri maksimum kaç saat içinde tahmin açılacak
const PREDICT_OPEN_AHEAD_HOURS = 96;

// Ülke başına maksimum maç (runtime ile artırılabilir)
const COUNTRY_CAP_DEFAULT = 4;

// Open penceresi
const LOCK_BEFORE_MIN = 5;
// NOT: Open window artık query ile override edilebiliyor.
// Defaults: geçmiş -48h, gelecek +36h (runtime ile DEV_4_TEAMS'te otomatik genişler)
const OPEN_WINDOW_HOURS = 36; // ileri (default)
const BACK_WINDOW_HOURS = 48; // geri (–48h)

// Test dönemi Big-4 takımları: GS, FB, BJK, TS
const DERBY_WINDOW_HOURS = 72;
const DEFAULT_WINDOW_HOURS = 72;
// Not: MANUAL_LIST_AHEAD_DAYS ve PREDICT_OPEN_AHEAD_HOURS zaten yukarıda tanımlı

// ========= LİG / ÜLKE FİLTRELERİ =========

const ALLOWED = {
  // Türkiye
  Türkiye: [/super\s*lig/i, /süper\s*lig/i],
  Turkey: [/super\s*lig/i, /süper\s*lig/i],

  England: [/premier\s*league/i],
  Spain: [/la\s*liga/i, /^laliga/i],
  Germany: [/bundesliga$/i],
  Italy: [/serie\s*a$/i],
  France: [/ligue\s*1$/i],
  Netherlands: [/eredivisie/i],
  Belgium: [/pro\s*league/i, /jupiler/i],
  Greece: [/super\s*league/i],
  Portugal: [/primeira/i, /liga\s*n?sagres/i],
  Brazil: [/serie\s*a$/i, /brasileirao/i],
  Argentina: [/liga\s*professional/i, /primera\s*division/i],
  Japan: [/j1\s*league/i],
  Russia: [/premier\s*liga/i],
  Ukraine: [/premier\s*liga/i],
  USA: [/mls/i],
  "Saudi Arabia": [/pro\s*league/i],

  // Avrupa / Dünya kupaları
  World: [/champions\s*league/i, /europa\s*league/i, /conference\s*league/i, /uefa/i],
  Europe: [/champions\s*league/i, /europa\s*league/i, /conference\s*league/i, /uefa/i],
  International: [
    /champions\s*league/i,
    /europa\s*league/i,
    /conference\s*league/i,
    /nations\s*league/i,
    /world\s*cup/i,
    /euro\s*20\d{2}/i,
  ],
};

// Global kupalar (ülke filtresine bakmadan geçecek ligler)
const GLOBAL_LEAGUES = [
  /champions\s*league/i,
  /uefa\s*champions/i,
  /europa\s*league/i,
  /conference\s*league/i,
];

function isGlobalLeagueName(league) {
  const n = String(league || "");
  return GLOBAL_LEAGUES.some((rx) => rx.test(n));
}

function allowedCountry(c) {
  return !!ALLOWED[c];
}

function isTopLeague(country, league) {
  const pats = ALLOWED[country];
  if (!pats) return false;
  const n = String(league || "");
  return pats.some((rx) => rx.test(n));
}

// ========= JSON HELPER =========

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

function parseKickoffMs(item) {
  const iso = String(item?.kickoffISO || "").trim();
  if (iso) {
    const t = new Date(iso).getTime();
    if (Number.isFinite(t)) return t;
  }

  const d = String(item?.kickoffDate || "").trim(); // YYYY-MM-DD
  if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
    // Saat belirsizse günü temsil etmek için "öğlen"e sabitle (listeleme/sıralama/pencere için)
    const t2 = new Date(`${d}T12:00:00+03:00`).getTime();
    if (Number.isFinite(t2)) return t2;
  }
  return null;
}

function kickoffComparableISO(item) {
  // UI/çıktı için: kickoffISO varsa onu, yoksa kickoffDate’i döndür (saat belirsizse)
  const iso = String(item?.kickoffISO || "").trim();
  if (iso) return iso;
  const d = String(item?.kickoffDate || "").trim();
  return d || null;
}

// ========= TARİH / PENCERE / LOCK =========

function within(dtOrItem, fromMs, toMs) {
  // Geriye dönük: string verildiyse eski davranış
  if (typeof dtOrItem === "string") {
    const t = new Date(dtOrItem).getTime();
    return Number.isFinite(t) && t >= fromMs && t <= toMs;
  }

  // Yeni: item (kickoffISO veya kickoffDate ile)
  const t = parseKickoffMs(dtOrItem);
  return Number.isFinite(t) && t >= fromMs && t <= toMs;
}

// ========= RUNTIME MODE (filtre seçimi) =========

async function getRuntimeSafe() {
  try {
    const m = await getRuntimeMode();
    const profile = String(m?.profile || "DEV_4_TEAMS").toUpperCase();
    return { ...m, profile };
  } catch {
    return { profile: "DEV_4_TEAMS", maxTeams: 4, maxLeagues: 1 };
  }
}

function isBig4TeamName(name) {
  const t = String(name || "").toUpperCase();
  return (
    t.includes("GALATASARAY") ||
    t.includes("FENERBAH") ||
    t.includes("BEŞİKTAŞ") ||
    t.includes("BESIKTAS") ||
    t.includes("TRABZONSPOR") ||
    t.includes("TRABZON") ||
    t.includes("REAL MADRID") ||
    t.includes("MANCHESTER CITY") ||
    t.includes("MAN CITY") ||
    t.includes("M.CITY") ||
    t.includes("BAYERN") ||
    t.includes("BARCELONA") ||
    t.includes("LIVERPOOL")
  );
}

// Test modu: sadece Big-4 içeren maçlar
function isBig4Fixture(it) {
  const h = String(it.home || "").toUpperCase();
  const a = String(it.away || "").toUpperCase();

  return (
    h.includes("GALATASARAY") || a.includes("GALATASARAY") ||
    h.includes("FENERBAH")    || a.includes("FENERBAH")    ||
    h.includes("BEŞİKTAŞ")    || a.includes("BEŞİKTAŞ")    ||
    h.includes("BESIKTAS")    || a.includes("BESIKTAS")    ||
    h.includes("TRABZON")     || a.includes("TRABZON")     ||

    h.includes("REAL MADRID")     || a.includes("REAL MADRID")     ||
    h.includes("MANCHESTER CITY") || a.includes("MANCHESTER CITY") ||
    h.includes("MAN CITY")        || a.includes("MAN CITY")        ||
    h.includes("M.CITY")          || a.includes("M.CITY")          ||
    h.includes("BAYERN")          || a.includes("BAYERN")          ||
    h.includes("BARCELONA")       || a.includes("BARCELONA")       ||
    h.includes("LIVERPOOL")       || a.includes("LIVERPOOL")
  );
}

// TR modu: Türkiye Süper Lig (+ global UEFA kupaları)
function isTRModeFixture(it) {
  if (isGlobalLeagueName(it.league)) return true;
  const c = String(it.country || "");
  if (!c) return false;
  if (c !== "Turkey" && c !== "Türkiye") return false;
  return isTopLeague(c, it.league);
}

function runtimeCountryCap(mode) {
  const p = String(mode?.profile || "").toUpperCase();
  if (p === "DEV_4_TEAMS") return 50; // 2 aylık big-4 listesi kırpılmasın
  if (p === "TR_30_TEAMS") return 8;
  if (p === "GLOBAL_456_TEAMS") return 10;
  return COUNTRY_CAP_DEFAULT;
}

function applyRuntimeFilter(list, mode) {
  const p = String(mode?.profile || "").toUpperCase();

  if (p === "DEV_4_TEAMS") return list.filter(isBig4Fixture);

  if (p === "TR_30_TEAMS") return list.filter(isTRModeFixture);

  // GLOBAL_* : Big-4 filtresi yok; fixturesByDate zaten ALLOWED + global league filtreliyor
  return list;
}

// ========= PROVIDER MODELİ (providers.json) =========

function baseProvModel() {
  return {
    providers: {
      AF: { ok: 0, fail: 0, lastMs: 0, lastAt: null, weight: 1.0 },
      TSDB: { ok: 0, fail: 0, lastMs: 0, lastAt: null, weight: 1.0 },
      FDO: { ok: 0, fail: 0, lastMs: 0, lastAt: null, weight: 1.0 },
    },
    quotas: {
      AF: { daily: 100, used: 0, warn: 90 },
      TSDB: { daily: 1000, used: 0, warn: 900 },
      FDO: { daily: 1000, used: 0, warn: 900 },
    },
    teamPref: {},
    primary: {},
    teamPrimary: {},
    settings: { autoPrimary: true },
    updatedAt: new Date().toISOString(),
  };
}

function ensureProvStruct(input) {
  const base = baseProvModel();
  const m = input && typeof input === "object" ? input : {};

  m.providers = m.providers && typeof m.providers === "object" ? m.providers : {};
  for (const [name, defVal] of Object.entries(base.providers)) {
    if (!m.providers[name]) {
      m.providers[name] = { ...defVal };
    } else {
      const p = m.providers[name];
      p.ok = Number(p.ok || 0);
      p.fail = Number(p.fail || 0);
      p.lastMs = Number(p.lastMs || 0);
      p.lastAt = p.lastAt || null;
      p.weight = Number.isFinite(p.weight) ? p.weight : 1.0;
    }
  }

  m.quotas = m.quotas && typeof m.quotas === "object" ? m.quotas : {};
  for (const [name, defVal] of Object.entries(base.quotas)) {
    if (!m.quotas[name]) {
      m.quotas[name] = { ...defVal };
    } else {
      const q = m.quotas[name];
      q.daily = Number(q.daily || defVal.daily);
      q.used = Number(q.used || 0);
      q.warn = Number.isFinite(q.warn) ? Number(q.warn) : Number(defVal.warn);
    }
  }

  m.teamPref = m.teamPref && typeof m.teamPref === "object" ? m.teamPref : {};
  m.primary = m.primary && typeof m.primary === "object" ? m.primary : {};
  m.teamPrimary = m.teamPrimary && typeof m.teamPrimary === "object" ? m.teamPrimary : {};

  for (const [team, prov] of Object.entries(m.primary)) {
    const k = String(team || "").toUpperCase().trim();
    if (!k) continue;
    if (!m.teamPref[k] && typeof prov === "string") {
      m.teamPref[k] = prov.toUpperCase();
    }
  }
  for (const [team, prov] of Object.entries(m.teamPrimary)) {
    const k = String(team || "").toUpperCase().trim();
    if (!k) continue;
    if (!m.teamPref[k] && typeof prov === "string") {
      m.teamPref[k] = prov.toUpperCase();
    }
  }

  m.settings = m.settings && typeof m.settings === "object" ? m.settings : {};
  m.settings.autoPrimary = typeof m.settings.autoPrimary === "boolean" ? m.settings.autoPrimary : true;

  m.updatedAt = new Date().toISOString();
  return m;
}

async function loadProv() {
  const raw = await readJson(PROV_FILE, null);
  const m = ensureProvStruct(raw || {});
  await writeJson(PROV_FILE, m);
  return m;
}

async function saveProv(m) {
  m.updatedAt = new Date().toISOString();
  await writeJson(PROV_FILE, m);
}

function teamKeyUpper(name) {
  return String(name || "").trim().toUpperCase();
}

function quotaRatio(q) {
  const daily = Math.max(1, Number(q.daily || 0) || 1);
  const used = Number(q.used || 0);
  return used / daily;
}

async function bumpProv(name, ok = true, ms = 0) {
  const m = await loadProv();
  const key = String(name || "").toUpperCase();

  if (!m.providers[key]) {
    m.providers[key] = { ok: 0, fail: 0, lastMs: 0, lastAt: null, weight: 1.0 };
  }
  if (!m.quotas[key]) {
    m.quotas[key] = { daily: 1000, used: 0, warn: 900 };
  }

  const p = m.providers[key];
  const q = m.quotas[key];

  if (ok) p.ok++;
  else p.fail++;

  p.lastMs = ms;
  p.lastAt = new Date().toISOString();
  q.used = Math.max(0, Number(q.used || 0) + 1);

  await saveProv(m);
}

function quota90(m, name) {
  const key = String(name || "").toUpperCase();
  const q = m.quotas?.[key];
  if (!q) return false;
  return quotaRatio(q) >= 0.9;
}

async function getTeamPref(team) {
  const m = await loadProv();
  const k = teamKeyUpper(team);
  return m.teamPref && m.teamPref[k] ? m.teamPref[k] : null;
}

async function setTeamPref(team, provider) {
  const m = await loadProv();
  const k = teamKeyUpper(team);
  const p = String(provider || "").toUpperCase();
  m.teamPref ||= {};
  m.teamPref[k] = p;

  m.primary ||= {};
  m.primary[k] = p;
  m.teamPrimary ||= {};
  m.teamPrimary[k] = p;

  await saveProv(m);
}

// ========= SAFE FETCH =========

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

// TSDB bazen HTML/Cloudflare/404 döndürüyor → JSON yerine <DOCTYPE geliyor.
// Bu helper, HTML gelirse patlamadan null döndürür.
async function safeFetchJsonOrNull(url, opts = {}, timeoutMs = 12000) {
  const r = await safeFetch(url, opts, timeoutMs);
  const ct = String(r.headers.get("content-type") || "");
  const text = await r.text();

  const head = String(text || "").slice(0, 240).replace(/\s+/g, " ");
  const looksHtml =
    head.startsWith("<!DOCTYPE") ||
    head.startsWith("<html") ||
    head.startsWith("<HTML") ||
    ct.includes("text/html");

  if (!r.ok || looksHtml) return null;

  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

// ========= NORMALİZERS =========

function normalizeAF(x) {
  return {
    fixtureId: x?.fixture?.id,
    kickoffISO: x?.fixture?.date,
    league: x?.league?.name || null,
    country: x?.league?.country || null,
    home: x?.teams?.home?.name || null,
    away: x?.teams?.away?.name || null,
    status: x?.fixture?.status?.short || "NS",
    source: "AF",
  };
}

function normalizeTS(e) {
  return {
    fixtureId: e.idEvent,
    kickoffISO:
      e.dateEvent && e.strTime ? `${e.dateEvent}T${e.strTime}:00Z` : e.dateEvent || null,
    league: e.strLeague || null,
    country: e.strCountry || null,
    home: e.strHomeTeam,
    away: e.strAwayTeam,
    status: "NS",
    source: "TSDB",
  };
}

// ========= TARİH BAZLI (SCHEDULE / OPEN) =========

async function afByDate(isoDate) {
  const m = await loadProv();
  if (!AF_KEY || quota90(m, "AF")) return [];
  const t0 = Date.now();
  try {
    const qs = new URLSearchParams({ date: isoDate, timezone: TZ });
    const r = await safeFetch(
      `${AF_BASE}/fixtures?${qs}`,
      { headers: { [AF_HDR]: AF_KEY, Accept: "application/json" } },
      12000
    );
    const j = await r.json();
    const arr = Array.isArray(j?.response) ? j.response : [];
    const out = arr
      .map(normalizeAF)
      .filter((it) => {
        if (isGlobalLeagueName(it.league)) return true;
        return it.country && allowedCountry(it.country) && isTopLeague(it.country, it.league);
      });
    await bumpProv("AF", true, Date.now() - t0);
    return out;
  } catch (e) {
    await bumpProv("AF", false, Date.now() - t0);
    return [];
  }
}

async function tsdbByDate(isoDate) {
  const t0 = Date.now();
  try {
    const j = await safeFetchJsonOrNull(
      `https://www.thesportsdb.com/api/v1/json/3/eventsonday.php?d=${encodeURIComponent(
        isoDate
      )}&s=Soccer`,
      {},
      12000
    );
    if (!j) {
      await bumpProv("TSDB", false, Date.now() - t0);
      return [];
    }

    const arr = Array.isArray(j?.events) ? j.events : [];
    const out = arr
      .map(normalizeTS)
      .filter((it) => {
        if (isGlobalLeagueName(it.league)) return true;
        return it.country && allowedCountry(it.country) && isTopLeague(it.country, it.league);
      });

    await bumpProv("TSDB", true, Date.now() - t0);
    return out;
  } catch (e) {
    await bumpProv("TSDB", false, Date.now() - t0);
    return [];
  }
}

// TSDB → AF kompozit
async function fixturesByDate(isoDate) {
  const res = [];
  try {
    res.push(...(await tsdbByDate(isoDate)));
  } catch (e) {
    console.warn(`[live2] tsdbByDate(${isoDate}) failed:`, e && e.message ? e.message : e);
  }
  try {
    res.push(...(await afByDate(isoDate)));
  } catch (e) {
    console.warn(`[live2] afByDate(${isoDate}) failed:`, e && e.message ? e.message : e);
  }
  return dedupeFixtures(res);
}

function dedupeFixtures(arr) {
  const seen = new Set();
  const out = [];
  for (const it of arr) {
    const k = `${it.country || ""}|${it.league || ""}|${it.home || ""}|${it.away || ""}|${
      it.kickoffISO || ""
    }`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(it);
    }
  }
  return out;
}

// ========= TAKIM BAZLI (fav) =========

function getWindowHoursForTeam(teamName) {
  // Test dönemi: Big-4 için tahmin penceresi ile aynı (96 saat)
  // Diğer takımlar için varsayılan pencere
  return isBig4TeamName(teamName) ? PREDICT_OPEN_AHEAD_HOURS : DEFAULT_WINDOW_HOURS;
}

// TSDB team → eventsnext
async function tsdbFindTeamIdByName(name) {
  const j = await safeFetchJsonOrNull(
    `https://www.thesportsdb.com/api/v1/json/3/searchteams.php?t=${encodeURIComponent(name)}`,
    {},
    12000
  );
  if (!j) return { idTeam: null, teamName: name };

  const team = j?.teams?.[0] || null;
  return { idTeam: team?.idTeam || null, teamName: team?.strTeam || name };
}

async function tsdbNextFixturesByTeamName(teamName, limit = 10) {
  const { idTeam } = await tsdbFindTeamIdByName(teamName);
  if (!idTeam) return [];

  const j = await safeFetchJsonOrNull(
    `https://www.thesportsdb.com/api/v1/json/3/eventsnext.php?id=${encodeURIComponent(idTeam)}`,
    {},
    12000
  );
  if (!j) return [];

  const arr = Array.isArray(j?.events) ? j.events : [];

  return arr
    .slice(0, limit)
    .map(normalizeTS)
    .filter((it) =>
      isGlobalLeagueName(it.league)
        ? true
        : it.country
        ? allowedCountry(it.country) && isTopLeague(it.country, it.league)
        : true
    );
}

// AF team → fixtures next (Free plan'de next param hatalı olabilir → from/to fallback)
function guessSeasonUTC() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  // futbol sezonu genel yaklaşım: Temmuz öncesi -> geçen yıl, Temmuz+ -> bu yıl
  return m < 7 ? y - 1 : y;
}
function isoDateUTC(d) {
  return new Date(d).toISOString().slice(0, 10);
}
function addDaysUTC(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

async function afFindTeamIdByName(name) {
  if (!AF_KEY) return null;
  const qs = new URLSearchParams({ search: String(name) });
  const r = await safeFetch(
    `${AF_BASE}/teams?${qs}`,
    { headers: { [AF_HDR]: AF_KEY, Accept: "application/json" } },
    12000
  );
  const j = await r.json();
  const hit = (j?.response || []).find((t) =>
    (t.team?.name || "").toLowerCase().includes(String(name).toLowerCase())
  );
  return hit?.team?.id || null;
}

async function afNextFixturesByTeam(teamName, next = 10) {
  const m = await loadProv();
  if (!AF_KEY || quota90(m, "AF")) return [];

  const id = await afFindTeamIdByName(teamName);
  if (!id) return [];

  const t0 = Date.now();

  // 1) Önce next ile dene
  try {
    const qs = new URLSearchParams({
      team: String(id),
      next: String(next),
      timezone: TZ,
    });
    const r = await safeFetch(
      `${AF_BASE}/fixtures?${qs}`,
      { headers: { [AF_HDR]: AF_KEY, Accept: "application/json" } },
      12000
    );
    const j = await r.json();

    // API-Football errors bloğu 200 ile de gelebiliyor
    const errorsObj = j?.errors || null;
    const hasErrors =
      errorsObj && typeof errorsObj === "object" && Object.keys(errorsObj).length > 0;

    if (!r.ok || hasErrors) {
      const errText = hasErrors ? JSON.stringify(errorsObj) : JSON.stringify(j);
      throw new Error(`AF_FIXTURES_ERRORS: ${errText}`);
    }

    const arr = Array.isArray(j?.response) ? j.response : [];
    const out = arr.map(normalizeAF);

    await bumpProv("AF", true, Date.now() - t0);
    return out;
  } catch (e) {
    const msg = String(e && (e.message || e));

    // 2) Free plan: "Next parameter" yok → from/to pencere fallback
    if (msg.includes("Next parameter") || msg.includes("do not have access")) {
      try {
        const season = guessSeasonUTC();
        const from = isoDateUTC(new Date());
        const to = isoDateUTC(addDaysUTC(30));
        const qs2 = new URLSearchParams({
          team: String(id),
          season: String(season),
          from,
          to,
          timezone: TZ,
        });

        const r2 = await safeFetch(
          `${AF_BASE}/fixtures?${qs2}`,
          { headers: { [AF_HDR]: AF_KEY, Accept: "application/json" } },
          12000
        );
        const j2 = await r2.json();

        const errorsObj2 = j2?.errors || null;
        const hasErrors2 =
          errorsObj2 && typeof errorsObj2 === "object" && Object.keys(errorsObj2).length > 0;

        if (!r2.ok || hasErrors2) {
          const errText2 = hasErrors2 ? JSON.stringify(errorsObj2) : JSON.stringify(j2);
          throw new Error(`AF_FIXTURES_ERRORS_FALLBACK: ${errText2}`);
        }

        const arr2 = Array.isArray(j2?.response) ? j2.response : [];
        const out2 = arr2.map(normalizeAF);

        await bumpProv("AF", true, Date.now() - t0);
        return out2;
      } catch {
        await bumpProv("AF", false, Date.now() - t0);
        return [];
      }
    }

    await bumpProv("AF", false, Date.now() - t0);
    return [];
  }
}

// Tercihli kompozit (fav için) + pencere filtresi
async function fixturesByTeamWithPreference(team) {
  const name = String(team || "").trim();
  if (!name) return [];

  const pref = await getTeamPref(name); // "AF" | "TSDB" | null
  const windowHours = getWindowHoursForTeam(name);

  async function filterByWindow(list) {
    const nowMs = Date.now();
    const toMs = nowMs + windowHours * 3600 * 1000;
    return list
      .filter((it) => within(it.kickoffISO, nowMs, toMs))
      .sort((a, b) => new Date(a.kickoffISO).getTime() - new Date(b.kickoffISO).getTime());
  }

  if (!pref) {
    const ts = await tsdbNextFixturesByTeamName(name, 12);
    if (ts.length > 0) {
      await setTeamPref(name, "TSDB");
      return filterByWindow(ts);
    }
    const af = await afNextFixturesByTeam(name, 12);
    if (af.length > 0) {
      await setTeamPref(name, "AF");
      return filterByWindow(af);
    }
    return [];
  }

  if (pref === "AF") {
    const af = await afNextFixturesByTeam(name, 12);
    if (af.length > 0) return filterByWindow(af);

    const ts = await tsdbNextFixturesByTeamName(name, 12);
    if (ts.length > 0) {
      await setTeamPref(name, "TSDB");
      return filterByWindow(ts);
    }
    return [];
  }

  const ts = await tsdbNextFixturesByTeamName(name, 12);
  if (ts.length > 0) return filterByWindow(ts);

  const af = await afNextFixturesByTeam(name, 12);
  if (af.length > 0) {
    await setTeamPref(name, "AF");
    return filterByWindow(af);
  }

  return [];
}
// ========= MANUEL FİKSTÜR VE ADMIN ALERT =========
//
// Manuel fixtures.json artık iki formatı da destekler:
// 1) kickoffISO: "2025-12-21T20:00:00+03:00"  (saat belli)
// 2) kickoffDate: "2025-01-13"                (saat belirsiz)
//
// Not: Saat belirsizse UI yanlış yönlenmesin diye "20:00" gibi sahte saat basmıyoruz.
// Pencere/sıralama için parseKickoffMs(item) içinde o günü "12:00 +03:00" ile temsil ediyoruz.
// API çıktısında kickoffISO alanını "kickoffISO varsa ISO, yoksa kickoffDate" şeklinde döndürüyoruz.
// ===== Patch-1: status from live state + kickoff (no redeclare) =====
function stateFile(fid) {
  return path.join(LIVE_DIR, `${String(fid)}.json`);
}

/**
 * 1) data/live/<fixtureId>.json varsa status'u oradan al (ör: FT)
 * 2) state yoksa kickoff geçmişse "OVERDUE_NO_STATE" de (NS kalmasın)
 * 3) aksi halde mevcut item.status (default NS)
 */
async function effectiveStatusForFixture(it) {
  const fid = String(it?.fixtureId || "").trim();
  const koMs = parseKickoffMs(it);
  const nowMs = Date.now();

  // 1) state check
  if (fid) {
    const st = await readJson(stateFile(fid), null);
    if (st && typeof st === "object") {
      const stStatus = String(st.status || "").trim().toUpperCase();
      if (stStatus) return stStatus;
    }
  }

  // 2) kickoff geçmiş ama state yok → NS kalmasın
  if (Number.isFinite(koMs) && nowMs > koMs) {
    return "OVERDUE_NO_STATE";
  }

  // 3) fallback
  return String(it?.status || "NS").trim().toUpperCase();
}

async function loadManualFixtures() {
  const raw = await readJson(MANUAL_FIXTURES_FILE, { fixtures: [] });
  const list = Array.isArray(raw?.fixtures) ? raw.fixtures : [];

  return list
    .map((f) => {
      const kickoffISO = f.kickoffISO || f.dateISO || null;
      const kickoffDate = f.kickoffDate || null; // YYYY-MM-DD (opsiyonel)

      return {
        fixtureId: f.fixtureId || f.id || null,
        kickoffISO,
        kickoffDate,
        league: f.league || null,
        home: f.home || null,
        away: f.away || null,
        country: f.country || "Turkey",
        status: f.status || "NS",
        source: "MANUAL",
        seriesId: f.seriesId || null,
      };
    })
    .filter((f) => {
      if (!f.fixtureId || !f.home || !f.away) return false;
      // kickoffISO veya kickoffDate zorunlu (ikisi birden de olabilir)
      if (f.kickoffISO) return true;
      return !!(f.kickoffDate && /^\d{4}-\d{2}-\d{2}$/.test(String(f.kickoffDate)));
    });
}

async function appendAdminAlert(kind, scope, message, meta) {
  const fb = { items: [] };
  const raw = (await readJson(ADMIN_ALERTS_FILE, fb)) || fb;
  const items = Array.isArray(raw.items) ? raw.items : [];
  const nowISO = new Date().toISOString();

  items.push({
    id: "alert_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8),
    kind,
    scope,
    message,
    meta: meta || null,
    createdAt: nowISO,
  });

  await writeJson(ADMIN_ALERTS_FILE, { items });
}

// Open listesinde kilit: kickoffISO varsa gerçek lock uygula.
// kickoffDate-only (saat belirsiz) için: lock false (yanlış kilitleme yapmayalım).
function withLockFlag(item, nowMs) {
  const koMs = parseKickoffMs(item);
  const hasRealISO = !!String(item?.kickoffISO || "").trim();

  if (!Number.isFinite(koMs) || !hasRealISO) {
    return { ...item, lock: false, lockAtISO: null };
  }

  const lockAt = koMs - LOCK_BEFORE_MIN * 60 * 1000;
  const locked = nowMs >= lockAt || (item.status && item.status !== "NS");

  return {
    ...item,
    lock: locked,
    lockAtISO: Number.isFinite(lockAt) ? new Date(lockAt).toISOString() : null,
  };
}

function sameFixtureKey(it) {
  // kickoffISO yoksa kickoffDate bazlı anahtar
  const ko = kickoffComparableISO(it) || "";
  return [
    String(it.fixtureId || ""),
    String(it.home || "").toUpperCase(),
    String(it.away || "").toUpperCase(),
    String(ko),
  ].join("|");
}

function mergeWithManualFixtures(providerList, manualList) {
  const seen = new Set(providerList.map(sameFixtureKey));
  const merged = providerList.slice();
  for (const m of manualList) {
    const key = sameFixtureKey(m);
    if (!seen.has(key)) {
      merged.push(m);
      seen.add(key);
    }
  }
  return merged;
}

function finalizeFixtureForOutput(it) {
  // API output: kickoffISO alanında "ISO varsa ISO, yoksa kickoffDate" döner.
  // kickoffDate alanını da koruyoruz (mobile isterse ayrıca gösterebilir).
  return {
    ...it,
    kickoffISO: kickoffComparableISO(it),
  };
}

async function manualFixturesWithinWindow(fromMs, toMs) {
  const all = await loadManualFixtures();
  return all.filter((f) => within(f, fromMs, toMs));
}

async function manualFixturesForTeamWithinWindow(teamName) {
  const windowHours = getWindowHoursForTeam(teamName);
  const nowMs = Date.now();
  const toMs = nowMs + windowHours * 3600 * 1000;

  const all = await loadManualFixtures();
  const upper = teamKeyUpper(teamName);

  return all.filter((f) => {
    const h = teamKeyUpper(f.home);
    const a = teamKeyUpper(f.away);
    const involveTeam = h === upper || a === upper;
    return involveTeam && within(f, nowMs, toMs);
  });
}

// ========= QUERY HELPERS (open penceresi override) =========

function intOrNull(v) {
  if (v == null) return null;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}
function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}
function pickOpenWindowHours(runtimeMode, req) {
  const p = String(runtimeMode?.profile || "").toUpperCase();

  // UI'dan gelen override: /open?fwdH=96&backH=48
  const qFwd = intOrNull(req.query.fwdH);
  const qBack = intOrNull(req.query.backH);

  // güvenli sınırlar
  const fwdH =
    qFwd != null
      ? clamp(qFwd, 6, 240)
      : p === "DEV_4_TEAMS"
      ? 96
      : OPEN_WINDOW_HOURS;

  const backH = qBack != null ? clamp(qBack, 6, 240) : BACK_WINDOW_HOURS;

  return { fwdH, backH };
}

// ========= ROUTES =========
//
// Kural:
// - schedule: listeleme için (manuel +60 gün gösterir; query ile override)
// - open: tahmine açık pencere için (ileri maksimum 96 saat)

router.get("/schedule", async (req, res) => {
  try {
    const runtimeMode = await getRuntimeSafe();
    const cap = runtimeCountryCap(runtimeMode);

    const pad = (n) => String(n).padStart(2, "0");

    // Query: /schedule?backDays=2&fwdDays=60
    const qBackDays = intOrNull(req.query.backDays);
    const qFwdDays = intOrNull(req.query.fwdDays);

    // güvenli sınırlar
    const backDays = qBackDays != null ? clamp(qBackDays, 0, 14) : 1; // default: 1 gün geri
    const fwdDays =
      qFwdDays != null ? clamp(qFwdDays, 1, 90) : MANUAL_LIST_AHEAD_DAYS; // default: 60 gün ileri

    // Provider tarafı: dün / bugün / yarın (Europe/Istanbul'a göre)
    const nowMsTZ = Date.now();
    const today = ymdInTZ(nowMsTZ, TZ);
    const tomorrow = ymdInTZ(nowMsTZ + 24 * 3600 * 1000, TZ);
    const yesterday = ymdInTZ(nowMsTZ - 24 * 3600 * 1000, TZ);

    let list = [];
    try { list = list.concat(await fixturesByDate(yesterday)); } catch (e) { console.warn(`[live2/schedule] fixturesByDate(${yesterday}) failed:`, e && e.message ? e.message : e); }
    try { list = list.concat(await fixturesByDate(today)); } catch (e) { console.warn(`[live2/schedule] fixturesByDate(${today}) failed:`, e && e.message ? e.message : e); }
    try { list = list.concat(await fixturesByDate(tomorrow)); } catch (e) { console.warn(`[live2/schedule] fixturesByDate(${tomorrow}) failed:`, e && e.message ? e.message : e); }

    const filtered = applyRuntimeFilter(list, runtimeMode);

    // Manuel fixtures: gün sınırları ile now-backDays 00:00Z .. now+fwdDays 23:59Z
    const nowMs = Date.now();

    const fromDay = new Date(nowMs - backDays * 24 * 3600 * 1000);
    const fromISO = `${fromDay.getUTCFullYear()}-${pad(fromDay.getUTCMonth() + 1)}-${pad(fromDay.getUTCDate())}`;
    const fromMs = new Date(fromISO + "T00:00:00Z").getTime();

    const toDay = new Date(nowMs + fwdDays * 24 * 3600 * 1000);
    const toISO = `${toDay.getUTCFullYear()}-${pad(toDay.getUTCMonth() + 1)}-${pad(toDay.getUTCDate())}`;
    const toMs = new Date(toISO + "T23:59:59Z").getTime();

    const manual = await manualFixturesWithinWindow(fromMs, toMs);
    const manualFiltered = applyRuntimeFilter(manual, runtimeMode);
    const merged = mergeWithManualFixtures(filtered, manualFiltered);

    // Admin uyarısı: manuel olup provider’da olmayanlar
    for (const mf of manualFiltered) {
      const key = sameFixtureKey(mf);
      const providerHas = filtered.some((p) => sameFixtureKey(p) === key);
      if (!providerHas) {
        await appendAdminAlert(
          "provider_missing_schedule",
          "schedule",
          `Maç schedule penceresinde provider'dan gelmedi; manuel listeden alındı. (fixtureId=${mf.fixtureId}, ${mf.home} - ${mf.away})`,
          {
            fixtureId: mf.fixtureId,
            home: mf.home,
            away: mf.away,
            kickoffISO: kickoffComparableISO(mf),
            profile: runtimeMode.profile,
          }
        );
      }
    }

    // CAP + sıralama
    const per = new Map();
    const capped = [];
    for (const it of merged.sort((a, b) => (parseKickoffMs(a) ?? 0) - (parseKickoffMs(b) ?? 0))) {
      const key = it.country || "Other";
      const c = per.get(key) || 0;
      if (c < cap) {
        const effStatus = await effectiveStatusForFixture(it);
        capped.push(finalizeFixtureForOutput({ ...it, status: effStatus }));

        per.set(key, c + 1);
      }
    }

    res.json({
      ok: true,
      count: capped.length,
      fixtures: capped,
      runtimeMode,
      cap,
      windowDays: { backDays, fwdDays, fromISO, toISO },
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: "SCHEDULE_FAILED",
      detail: String((e && e.message) || e),
    });
  }
});

router.get("/open", async (req, res) => {
  try {
    const runtimeMode = await getRuntimeSafe();
    const cap = runtimeCountryCap(runtimeMode);

    // helper: query override + defaultlar
    const { fwdH, backH } = pickOpenWindowHours(runtimeMode, req);

    // ✅ Test kuralı: tahmine açık pencere ileri max 96 saat
    const fwdH_eff = Math.min(fwdH, PREDICT_OPEN_AHEAD_HOURS);

    const nowMs = Date.now();
    const fromMs = nowMs - backH * 3600 * 1000;
    const toMs = nowMs + fwdH_eff * 3600 * 1000;

    const today = ymdInTZ(nowMs, TZ);
    const tomorrow = ymdInTZ(nowMs + 24 * 3600 * 1000, TZ);
    const yesterday = ymdInTZ(nowMs - 24 * 3600 * 1000, TZ);

    let base = [];
    try { base = base.concat(await fixturesByDate(yesterday)); } catch (e) { console.warn(`[live2/open] fixturesByDate(${yesterday}) failed:`, e && e.message ? e.message : e); }
    try { base = base.concat(await fixturesByDate(today)); } catch (e) { console.warn(`[live2/open] fixturesByDate(${today}) failed:`, e && e.message ? e.message : e); }
    try { base = base.concat(await fixturesByDate(tomorrow)); } catch (e) { console.warn(`[live2/open] fixturesByDate(${tomorrow}) failed:`, e && e.message ? e.message : e); }

    const baseFiltered = applyRuntimeFilter(base, runtimeMode);

    // Manuel fixtures (open penceresi)
    const manual = await manualFixturesWithinWindow(fromMs, toMs);
    const manualFiltered = applyRuntimeFilter(manual, runtimeMode);

    const merged = mergeWithManualFixtures(baseFiltered, manualFiltered);

    // lock + pencere + (kilitli olmayan)
    const windowed = [];
    for (const it of merged) {
      const withLock = withLockFlag(it, nowMs);
      if (!within(withLock, fromMs, toMs)) continue;
      if (!withLock.lock) windowed.push(withLock);
    }

    // Admin uyarısı: manuel olup provider’da olmayanlar
    for (const mf of manualFiltered) {
      const key = sameFixtureKey(mf);
      const providerHas = baseFiltered.some((p) => sameFixtureKey(p) === key);
      if (!providerHas) {
        await appendAdminAlert(
          "provider_missing_open",
          "open",
          `Maç open penceresinde provider'dan gelmedi; manuel listeden alındı. (fixtureId=${mf.fixtureId}, ${mf.home} - ${mf.away})`,
          {
            fixtureId: mf.fixtureId,
            home: mf.home,
            away: mf.away,
            kickoffISO: kickoffComparableISO(mf),
            profile: runtimeMode.profile,
          }
        );
      }
    }

    // CAP + sıralama
    const per = new Map();
    const capped = [];
    for (const it of windowed.sort((a, b) => (parseKickoffMs(a) ?? 0) - (parseKickoffMs(b) ?? 0))) {
      const key = it.country || "Other";
      const c = per.get(key) || 0;
      if (c < cap) {
        capped.push(finalizeFixtureForOutput(it));
        per.set(key, c + 1);
      }
    }

    res.json({
      ok: true,
      count: capped.length,
      fixtures: capped,
      window: { backH, fwdH: fwdH_eff },
      lockBeforeMin: LOCK_BEFORE_MIN,
      runtimeMode,
      cap,
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: "OPEN_FAILED",
      detail: String((e && e.message) || e),
    });
  }
});

// GET /api/live2/fav?team=Galatasaray  (fav her zaman takım bazlı)
router.get("/fav", async (req, res) => {
  try {
    const team = String(req.query.team || "").trim();
    if (!team) return res.status(400).json({ ok: false, error: "TEAM_REQUIRED" });

    const providerList = await fixturesByTeamWithPreference(team);
    const manualList = await manualFixturesForTeamWithinWindow(team);

    let fixtures = providerList;
    let usedManual = false;

    if (providerList.length === 0 && manualList.length > 0) {
      fixtures = manualList;
      usedManual = true;

      await appendAdminAlert(
        "provider_missing_fav",
        "fav",
        `Favori takım (${team}) için pencerede provider'dan maç alınamadı; manuel fixtures.json'dan maçlar dönüyor.`,
        { team, manualCount: manualList.length }
      );
    }

    const windowHours = getWindowHoursForTeam(team);

    const out = fixtures
      .slice()
      .sort((a, b) => (parseKickoffMs(a) ?? 0) - (parseKickoffMs(b) ?? 0))
      .map(finalizeFixtureForOutput);

    res.json({
      ok: true,
      team,
      count: out.length,
      fixtures: out,
      windowHours,
      lockBeforeMin: LOCK_BEFORE_MIN,
      manualFallback: usedManual,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: "FAV_FAILED", detail: String((e && e.message) || e) });
  }
});

router.get("/fav-debug", async (req, res) => {
  try {
    const team = String(req.query.team || "").trim();
    if (!team) return res.status(400).json({ ok: false, error: "TEAM_REQUIRED" });
    const pref = await getTeamPref(team);

    let ts = [];
    let af = [];
    let tsError = null;
    let afError = null;

    try {
      ts = await tsdbNextFixturesByTeamName(team, 12);
    } catch (e) {
      tsError = String(e && (e.message || e));
    }
    try {
      af = await afNextFixturesByTeam(team, 12);
    } catch (e) {
      afError = String(e && (e.message || e));
    }

    res.json({
      ok: true,
      team,
      pref: pref || null,
      tsCount: ts.length,
      afCount: af.length,
      fdoCount: 0,
      tsError,
      afError,
      sample: { ts: ts.slice(0, 3), af: af.slice(0, 3) },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: "FAV_DEBUG_FAILED", detail: String(e && (e.message || e)) });
  }
});

// DEBUG: AF key durumu
router.get("/debug-af-key", (req, res) => {
  res.json({
    ok: true,
    ping: "v2025-12-22-1",
    AF_KEY: AF_KEY ? "SET" : "EMPTY",
    AF_BASE,
    AF_HDR,
  });
});

// DEBUG: FDO key durumu
router.get("/debug-fdo-key", (req, res) => {
  res.json({
    ok: true,
    FDO_KEY: FDO_KEY ? "SET" : "EMPTY",
    FDO_BASE,
    FDO_HDR,
  });
});

// ========= DEBUG: MANUAL FIXTURES WINDOW =========
router.get("/debug-manual", async (req, res) => {
  try {
    const runtimeMode = await getRuntimeSafe();

    const qBackDays = intOrNull(req.query.backDays);
    const qFwdDays = intOrNull(req.query.fwdDays);
    const backDays = qBackDays != null ? clamp(qBackDays, 0, 14) : 2;
    const fwdDays  = qFwdDays  != null ? clamp(qFwdDays, 1, 90) : MANUAL_LIST_AHEAD_DAYS;

    const nowMs = Date.now();
    const fromMs = nowMs - backDays * 24 * 3600 * 1000;
    const toMs   = nowMs + fwdDays  * 24 * 3600 * 1000;

    const all = await loadManualFixtures();

    // ham parse durumunu görelim
    const mapped = all.map((f) => {
      const koMs = parseKickoffMs(f);
      return {
        fixtureId: f.fixtureId,
        home: f.home,
        away: f.away,
        kickoffISO: f.kickoffISO || null,
        kickoffDate: f.kickoffDate || null,
        koMs,
        koISO: Number.isFinite(koMs) ? new Date(koMs).toISOString() : null,
      };
    });

    const withinAll = mapped.filter((x) => Number.isFinite(x.koMs) && x.koMs >= fromMs && x.koMs <= toMs);

    const filteredAll = applyRuntimeFilter(all, runtimeMode);
    const filteredMapped = filteredAll.map((f) => {
      const koMs = parseKickoffMs(f);
      return {
        fixtureId: f.fixtureId,
        home: f.home,
        away: f.away,
        kickoffISO: f.kickoffISO || null,
        kickoffDate: f.kickoffDate || null,
        koMs,
        koISO: Number.isFinite(koMs) ? new Date(koMs).toISOString() : null,
      };
    });
    const withinFiltered = filteredMapped.filter((x) => Number.isFinite(x.koMs) && x.koMs >= fromMs && x.koMs <= toMs);

    res.json({
      ok: true,
      file: MANUAL_FIXTURES_FILE,
      serverNowISO: new Date(nowMs).toISOString(),
      window: { backDays, fwdDays, fromMs, toMs, fromISO: new Date(fromMs).toISOString(), toISO: new Date(toMs).toISOString() },
      runtimeMode,
      counts: {
        manualTotal: all.length,
        manualWithinWindow: withinAll.length,
        manualAfterRuntimeFilter: filteredAll.length,
        manualWithinWindowAfterRuntimeFilter: withinFiltered.length,
      },
      sampleWithin: withinFiltered.slice(0, 10),
      sampleAllFirst10: mapped.slice(0, 10),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: "DEBUG_MANUAL_FAILED", detail: String((e && e.message) || e) });
  }
});

module.exports = router;

