"use strict";

const express = require("express");
const router = express.Router();

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

// Node 18+ global fetch; değilse node-fetch
const fetch = globalThis.fetch || require("node-fetch");

// Runtime mode
const { getRuntimeMode } = require("../lib/runtime-mode.cjs");

// ========= ENV / SABİTLER =========

const AF_BASE = process.env.AF_BASE || "https://v3.football.api-sports.io";
const AF_KEY = process.env.AF_KEY || "";
const AF_HDR = process.env.AF_HEADER_KEY || "x-apisports-key";

const FDO_BASE = process.env.FDO_BASE || "https://api.football-data.org/v4";
const FDO_KEY = process.env.FDO_TOKEN || process.env.FDO_KEY || "";
const FDO_HDR = process.env.FDO_HEADER_KEY || "X-Auth-Token";

const TZ = "Europe/Istanbul";

const DATA_DIR = path.join(__dirname, "..", "data");
const PROV_FILE = path.join(DATA_DIR, "providers.json");
const MANUAL_FIXTURES_FILE = path.join(DATA_DIR, "fixtures.json");
const ADMIN_ALERTS_FILE = path.join(DATA_DIR, "admin-alerts.json");

// Ülke başına maksimum maç
const COUNTRY_CAP_DEFAULT = 4;

// Open penceresi
const LOCK_BEFORE_MIN = 5;
const OPEN_WINDOW_HOURS = 36; // ileri default
const BACK_WINDOW_HOURS = 48; // geri default

// Big-4 test
const DERBY_WINDOW_HOURS = 72;
const DEFAULT_WINDOW_HOURS = 72;

// Open genişleyince provider tarafında kaç güne kadar day-by-day çekelim (safety)
const MAX_PROVIDER_DAYS = 10;

// ========= LİG / ÜLKE FİLTRELERİ =========

const ALLOWED = {
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

// ========= JSON HELPERS =========

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

// ========= TARİH / PENCERE / LOCK =========

function within(dtISO, fromMs, toMs) {
  const t = new Date(dtISO).getTime();
  return Number.isFinite(t) && t >= fromMs && t <= toMs;
}

function withLockFlag(item, nowMs) {
  const ko = new Date(item.kickoffISO).getTime();
  const lockAt = ko - LOCK_BEFORE_MIN * 60 * 1000;
  const locked = Number.isFinite(ko)
    ? nowMs >= lockAt || (item.status && item.status !== "NS")
    : false;

  return {
    ...item,
    lock: locked,
    lockAtISO: Number.isFinite(lockAt) ? new Date(lockAt).toISOString() : null,
  };
}

// ========= RUNTIME MODE =========

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
    t.includes("TRABZON")
  );
}

function isBig4Fixture(it) {
  const h = String(it.home || "").toUpperCase();
  const a = String(it.away || "").toUpperCase();

  const hasGS = h.includes("GALATASARAY") || a.includes("GALATASARAY");
  const hasFB = h.includes("FENERBAH") || a.includes("FENERBAH");
  const hasBJK =
    h.includes("BEŞİKTAŞ") ||
    a.includes("BEŞİKTAŞ") ||
    h.includes("BESIKTAS") ||
    a.includes("BESIKTAS");
  const hasTS = h.includes("TRABZON") || a.includes("TRABZON");

  return hasGS || hasFB || hasBJK || hasTS;
}

function isTRModeFixture(it) {
  if (isGlobalLeagueName(it.league)) return true;
  const c = String(it.country || "");
  if (!c) return false;
  if (c !== "Turkey" && c !== "Türkiye") return false;
  return isTopLeague(c, it.league);
}

function runtimeCountryCap(mode) {
  const p = String(mode?.profile || "").toUpperCase();
  if (p === "DEV_4_TEAMS") return 8;
  if (p === "TR_30_TEAMS") return 8;
  if (p === "GLOBAL_456_TEAMS") return 10;
  return COUNTRY_CAP_DEFAULT;
}

function applyRuntimeFilter(list, mode) {
  const p = String(mode?.profile || "").toUpperCase();
  if (p === "DEV_4_TEAMS") return list.filter(isBig4Fixture);
  if (p === "TR_30_TEAMS") return list.filter(isTRModeFixture);
  return list;
}

// ========= PROVIDER MODEL (providers.json) =========

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
    if (!m.providers[name]) m.providers[name] = { ...defVal };
    else {
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
    if (!m.quotas[name]) m.quotas[name] = { ...defVal };
    else {
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
    if (k && !m.teamPref[k] && typeof prov === "string") m.teamPref[k] = prov.toUpperCase();
  }
  for (const [team, prov] of Object.entries(m.teamPrimary)) {
    const k = String(team || "").toUpperCase().trim();
    if (k && !m.teamPref[k] && typeof prov === "string") m.teamPref[k] = prov.toUpperCase();
  }

  m.settings = m.settings && typeof m.settings === "object" ? m.settings : {};
  m.settings.autoPrimary =
    typeof m.settings.autoPrimary === "boolean" ? m.settings.autoPrimary : true;

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
function quota90(m, name) {
  const key = String(name || "").toUpperCase();
  const q = m.quotas?.[key];
  if (!q) return false;
  return quotaRatio(q) >= 0.9;
}
async function bumpProv(name, ok = true, ms = 0) {
  const m = await loadProv();
  const key = String(name || "").toUpperCase();

  if (!m.providers[key]) m.providers[key] = { ok: 0, fail: 0, lastMs: 0, lastAt: null, weight: 1.0 };
  if (!m.quotas[key]) m.quotas[key] = { daily: 1000, used: 0, warn: 900 };

  const p = m.providers[key];
  const q = m.quotas[key];

  ok ? p.ok++ : p.fail++;
  p.lastMs = ms;
  p.lastAt = new Date().toISOString();
  q.used = Math.max(0, Number(q.used || 0) + 1);

  await saveProv(m);
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

// TSDB bazen HTML/Cloudflare/404 döndürüyor
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
    kickoffISO: e.dateEvent && e.strTime ? `${e.dateEvent}T${e.strTime}:00Z` : e.dateEvent || null,
    league: e.strLeague || null,
    country: e.strCountry || null,
    home: e.strHomeTeam,
    away: e.strAwayTeam,
    status: "NS",
    source: "TSDB",
  };
}

// ========= TARİH BAZLI =========

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
      .filter((it) => (isGlobalLeagueName(it.league) ? true : it.country && allowedCountry(it.country) && isTopLeague(it.country, it.league)));
    await bumpProv("AF", true, Date.now() - t0);
    return out;
  } catch {
    await bumpProv("AF", false, Date.now() - t0);
    return [];
  }
}

async function tsdbByDate(isoDate) {
  const t0 = Date.now();
  try {
    const j = await safeFetchJsonOrNull(
      `https://www.thesportsdb.com/api/v1/json/3/eventsonday.php?d=${encodeURIComponent(isoDate)}&s=Soccer`,
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
      .filter((it) => (isGlobalLeagueName(it.league) ? true : it.country && allowedCountry(it.country) && isTopLeague(it.country, it.league)));
    await bumpProv("TSDB", true, Date.now() - t0);
    return out;
  } catch {
    await bumpProv("TSDB", false, Date.now() - t0);
    return [];
  }
}

async function fixturesByDate(isoDate) {
  const res = [];
  try { res.push(...(await tsdbByDate(isoDate))); } catch (e) { console.warn(`[fixtures] tsdbByDate(${isoDate}) failed:`, e && e.message ? e.message : e); }
  try { res.push(...(await afByDate(isoDate))); } catch (e) { console.warn(`[fixtures] afByDate(${isoDate}) failed:`, e && e.message ? e.message : e); }
  return dedupeFixtures(res);
}

function dedupeFixtures(arr) {
  const seen = new Set();
  const out = [];
  for (const it of arr) {
    const k = `${it.country || ""}|${it.league || ""}|${it.home || ""}|${it.away || ""}|${it.kickoffISO || ""}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(it);
    }
  }
  return out;
}

// ========= TAKIM BAZLI (fav) =========

function getWindowHoursForTeam(teamName) {
  return isBig4TeamName(teamName) ? DERBY_WINDOW_HOURS : DEFAULT_WINDOW_HOURS;
}

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
    .filter((it) => (isGlobalLeagueName(it.league) ? true : it.country ? allowedCountry(it.country) && isTopLeague(it.country, it.league) : true));
}

// AF free plan fallback
function guessSeasonUTC() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
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

  // 1) next ile dene
  try {
    const qs = new URLSearchParams({ team: String(id), next: String(next), timezone: TZ });
    const r = await safeFetch(
      `${AF_BASE}/fixtures?${qs}`,
      { headers: { [AF_HDR]: AF_KEY, Accept: "application/json" } },
      12000
    );
    const j = await r.json();
    const errorsObj = j?.errors || null;
    const hasErrors = errorsObj && typeof errorsObj === "object" && Object.keys(errorsObj).length > 0;
    if (!r.ok || hasErrors) throw new Error(`AF_FIXTURES_ERRORS: ${hasErrors ? JSON.stringify(errorsObj) : JSON.stringify(j)}`);
    const arr = Array.isArray(j?.response) ? j.response : [];
    const out = arr.map(normalizeAF);
    await bumpProv("AF", true, Date.now() - t0);
    return out;
  } catch (e) {
    const msg = String(e && (e.message || e));

    // 2) Free plan: next yok → from/to fallback
    if (msg.includes("Next parameter") || msg.includes("do not have access")) {
      try {
        const season = guessSeasonUTC();
        const from = isoDateUTC(new Date());
        const to = isoDateUTC(addDaysUTC(30));

        const qs2 = new URLSearchParams({ team: String(id), season: String(season), from, to, timezone: TZ });
        const r2 = await safeFetch(
          `${AF_BASE}/fixtures?${qs2}`,
          { headers: { [AF_HDR]: AF_KEY, Accept: "application/json" } },
          12000
        );
        const j2 = await r2.json();
        const errorsObj2 = j2?.errors || null;
        const hasErrors2 = errorsObj2 && typeof errorsObj2 === "object" && Object.keys(errorsObj2).length > 0;
        if (!r2.ok || hasErrors2) throw new Error(`AF_FIXTURES_ERRORS_FALLBACK: ${hasErrors2 ? JSON.stringify(errorsObj2) : JSON.stringify(j2)}`);

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

async function fixturesByTeamWithPreference(team) {
  const name = String(team || "").trim();
  if (!name) return [];

  const pref = await getTeamPref(name);
  const windowHours = getWindowHoursForTeam(name);

  function filterByWindow(list) {
    const nowMs = Date.now();
    const toMs = nowMs + windowHours * 3600 * 1000;
    return list
      .filter((it) => it.kickoffISO && within(it.kickoffISO, nowMs, toMs))
      .sort((a, b) => new Date(a.kickoffISO).getTime() - new Date(b.kickoffISO).getTime());
  }

  if (!pref) {
    const ts = await tsdbNextFixturesByTeamName(name, 12);
    if (ts.length > 0) { await setTeamPref(name, "TSDB"); return filterByWindow(ts); }
    const af = await afNextFixturesByTeam(name, 12);
    if (af.length > 0) { await setTeamPref(name, "AF"); return filterByWindow(af); }
    return [];
  }

  if (pref === "AF") {
    const af = await afNextFixturesByTeam(name, 12);
    if (af.length > 0) return filterByWindow(af);

    const ts = await tsdbNextFixturesByTeamName(name, 12);
    if (ts.length > 0) { await setTeamPref(name, "TSDB"); return filterByWindow(ts); }
    return [];
  }

  const ts = await tsdbNextFixturesByTeamName(name, 12);
  if (ts.length > 0) return filterByWindow(ts);

  const af = await afNextFixturesByTeam(name, 12);
  if (af.length > 0) { await setTeamPref(name, "AF"); return filterByWindow(af); }

  return [];
}

// ========= MANUEL FIXTURES + ADMIN ALERT =========

async function loadManualFixtures() {
  const raw = await readJson(MANUAL_FIXTURES_FILE, { fixtures: [] });
  const list = Array.isArray(raw?.fixtures) ? raw.fixtures : [];
  return list
    .map((f) => ({
      fixtureId: f.fixtureId || f.id || null,
      kickoffISO: f.kickoffISO || f.dateISO || null,
      league: f.league || null,
      home: f.home || null,
      away: f.away || null,
      country: f.country || "Turkey",
      status: f.status || "NS",
      source: "MANUAL",
      seriesId: f.seriesId || null,
    }))
    .filter((f) => f.fixtureId && f.kickoffISO && f.home && f.away);
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

function sameFixtureKey(it) {
  return [
    String(it.fixtureId || ""),
    String(it.home || "").toUpperCase(),
    String(it.away || "").toUpperCase(),
    String(it.kickoffISO || ""),
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

async function manualFixturesWithinWindow(fromMs, toMs) {
  const all = await loadManualFixtures();
  return all.filter((f) => f.kickoffISO && within(f.kickoffISO, fromMs, toMs));
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
    return involveTeam && f.kickoffISO && within(f.kickoffISO, nowMs, toMs);
  });
}

// ========= QUERY HELPERS (open override) =========

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

  const qFwd = intOrNull(req.query.fwdH);
  const qBack = intOrNull(req.query.backH);

  const fwdH =
    qFwd != null
      ? clamp(qFwd, 6, 240)
      : p === "DEV_4_TEAMS"
      ? 96
      : OPEN_WINDOW_HOURS;

  const backH = qBack != null ? clamp(qBack, 6, 240) : BACK_WINDOW_HOURS;

  return { fwdH, backH };
}

// ISO date helpers (local/timezone bağımsız, UTC günü)
function isoDayUTC(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}
function dayStartUTC(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
function listDaysUTC(fromMs, toMs, maxDays) {
  const out = [];
  let cur = dayStartUTC(fromMs);
  const end = dayStartUTC(toMs);
  while (cur <= end && out.length < maxDays) {
    out.push(isoDayUTC(cur));
    cur += 24 * 3600 * 1000;
  }
  return out;
}

// ========= ROUTES =========

// GET /api/live2/schedule  (dün + bugün + yarın)
router.get("/schedule", async (req, res) => {
  try {
    const runtimeMode = await getRuntimeSafe();
    const cap = runtimeCountryCap(runtimeMode);

    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");

    const y = now.getFullYear();
    const m = pad(now.getMonth() + 1);
    const d = pad(now.getDate());
    const today = `${y}-${m}-${d}`;

    const t1 = new Date(now.getTime() + 24 * 3600 * 1000);
    const tomorrow = `${t1.getFullYear()}-${pad(t1.getMonth() + 1)}-${pad(t1.getDate())}`;

    const t_1 = new Date(now.getTime() - 24 * 3600 * 1000);
    const yesterday = `${t_1.getFullYear()}-${pad(t_1.getMonth() + 1)}-${pad(t_1.getDate())}`;

    let list = [];
    try { list = list.concat(await fixturesByDate(yesterday)); } catch (e) { console.warn(`[fixtures/schedule] fixturesByDate(${yesterday}) failed:`, e && e.message ? e.message : e); }
    try { list = list.concat(await fixturesByDate(today)); } catch (e) { console.warn(`[fixtures/schedule] fixturesByDate(${today}) failed:`, e && e.message ? e.message : e); }
    try { list = list.concat(await fixturesByDate(tomorrow)); } catch (e) { console.warn(`[fixtures/schedule] fixturesByDate(${tomorrow}) failed:`, e && e.message ? e.message : e); }

    const filtered = applyRuntimeFilter(list, runtimeMode);

    const fromMs = new Date(yesterday + "T00:00:00Z").getTime();
    const toMs = new Date(tomorrow + "T23:59:59Z").getTime();
    const manual = await manualFixturesWithinWindow(fromMs, toMs);
    const manualFiltered = applyRuntimeFilter(manual, runtimeMode);

    let merged = mergeWithManualFixtures(filtered, manualFiltered);

    for (const mf of manualFiltered) {
      const key = sameFixtureKey(mf);
      const providerHas = filtered.some((p) => sameFixtureKey(p) === key);
      if (!providerHas) {
        await appendAdminAlert(
          "provider_missing_schedule",
          "schedule",
          `Maç schedule penceresinde provider'dan gelmedi; manuel listeden alındı. (fixtureId=${mf.fixtureId}, ${mf.home} - ${mf.away})`,
          { fixtureId: mf.fixtureId, home: mf.home, away: mf.away, kickoffISO: mf.kickoffISO, profile: runtimeMode.profile }
        );
      }
    }

    const per = new Map();
    const capped = [];
    for (const it of merged.sort((a, b) => new Date(a.kickoffISO).getTime() - new Date(b.kickoffISO).getTime())) {
      const key = it.country || "Other";
      const c = per.get(key) || 0;
      if (c < cap) { capped.push(it); per.set(key, c + 1); }
    }

    res.json({ ok: true, count: capped.length, fixtures: capped, runtimeMode, cap });
  } catch (e) {
    res.status(500).json({ ok: false, error: "SCHEDULE_FAILED", detail: String((e && e.message) || e) });
  }
});

// GET /api/live2/open  (–backH .. +fwdH) + lock
router.get("/open", async (req, res) => {
  try {
    const runtimeMode = await getRuntimeSafe();
    const cap = runtimeCountryCap(runtimeMode);

    const { fwdH, backH } = pickOpenWindowHours(runtimeMode, req);

    const nowMs = Date.now();
    const fromMs = nowMs - backH * 3600 * 1000;
    const toMs = nowMs + fwdH * 3600 * 1000;

    // ✅ Kritik düzeltme: pencere genişledikçe gün gün çek
    const days = listDaysUTC(fromMs, toMs, MAX_PROVIDER_DAYS);

    let base = [];
    for (const day of days) {
      try { base = base.concat(await fixturesByDate(day)); } catch (e) { console.warn(`[fixtures/open] fixturesByDate(${day}) failed:`, e && e.message ? e.message : e); }
    }

    const baseFiltered = applyRuntimeFilter(base, runtimeMode);

    const manual = await manualFixturesWithinWindow(fromMs, toMs);
    const manualFiltered = applyRuntimeFilter(manual, runtimeMode);

    let merged = mergeWithManualFixtures(baseFiltered, manualFiltered);

    const windowed = [];
    for (const it of merged) {
      const withLock = withLockFlag(it, nowMs);
      if (!withLock.kickoffISO) continue;
      if (!within(withLock.kickoffISO, fromMs, toMs)) continue;
      if (!withLock.lock) windowed.push(withLock);
    }

    for (const mf of manualFiltered) {
      const key = sameFixtureKey(mf);
      const providerHas = baseFiltered.some((p) => sameFixtureKey(p) === key);
      if (!providerHas) {
        await appendAdminAlert(
          "provider_missing_open",
          "open",
          `Maç open penceresinde provider'dan gelmedi; manuel listeden alındı. (fixtureId=${mf.fixtureId}, ${mf.home} - ${mf.away})`,
          { fixtureId: mf.fixtureId, home: mf.home, away: mf.away, kickoffISO: mf.kickoffISO, profile: runtimeMode.profile }
        );
      }
    }

    const per = new Map();
    const capped = [];
    for (const it of windowed.sort((a, b) => new Date(a.kickoffISO).getTime() - new Date(b.kickoffISO).getTime())) {
      const key = it.country || "Other";
      const c = per.get(key) || 0;
      if (c < cap) { capped.push(it); per.set(key, c + 1); }
    }

    res.json({
      ok: true,
      count: capped.length,
      fixtures: capped,
      window: { backH, fwdH },
      lockBeforeMin: LOCK_BEFORE_MIN,
      runtimeMode,
      cap,
      providerDays: days,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: "OPEN_FAILED", detail: String((e && e.message) || e) });
  }
});

// GET /api/live2/fav?team=Galatasaray
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

    res.json({
      ok: true,
      team,
      count: fixtures.length,
      fixtures,
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

    try { ts = await tsdbNextFixturesByTeamName(team, 12); } catch (e) { tsError = String(e && (e.message || e)); }
    try { af = await afNextFixturesByTeam(team, 12); } catch (e) { afError = String(e && (e.message || e)); }

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

// DEBUG key durumları
router.get("/debug-af-key", (req, res) => res.json({ ok: true, AF_KEY: AF_KEY ? "SET" : "EMPTY", AF_BASE, AF_HDR }));
router.get("/debug-fdo-key", (req, res) => res.json({ ok: true, FDO_KEY: FDO_KEY ? "SET" : "EMPTY", FDO_BASE, FDO_HDR }));

module.exports = router;
