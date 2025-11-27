"use strict";

const express = require("express");
const router  = express.Router();
const fs      = require("fs");
const fsp     = fs.promises;
const path    = require("path");

const AF_BASE = process.env.AF_BASE || "https://v3.football.api-sports.io";
const AF_KEY  = process.env.AF_KEY  || "";
const AF_HDR  = process.env.AF_HEADER_KEY || "x-apisports-key";

const FDO_BASE = process.env.FDO_BASE || "https://api.football-data.org/v4";
const FDO_KEY  = process.env.FDO_TOKEN || process.env.FDO_KEY || "";
const FDO_HDR  = process.env.FDO_HEADER_KEY || "X-Auth-Token";

const TZ      = "Europe/Istanbul";

const DATA_DIR   = path.join(__dirname, "..", "data");
const PROV_FILE  = path.join(DATA_DIR, "providers.json");   // providers.cjs ile aynı model
const FAV_FILE   = path.join(DATA_DIR, "users.json");       // { users:[{id, mainTeam}] }

const COUNTRY_CAP        = 4;
const LOCK_BEFORE_MIN    = 5;
const OPEN_WINDOW_HOURS  = 36;    // ileri
const BACK_WINDOW_HOURS  = 48;    // geri (–48h)

// --- Ülke / lig filtreleri ---
const ALLOWED = {
  // Türkiye / Turkey birlikte
  "Türkiye": [
    /super\s*lig/i,
    /süper\s*lig/i,
  ],
  "Turkey": [
    /super\s*lig/i,
    /süper\s*lig/i,
  ],

  "England":   [/premier\s*league/i],
  "Spain":     [/la\s*liga/i, /^laliga/i],
  "Germany":   [/bundesliga$/i],
  "Italy":     [/serie\s*a$/i],
  "France":    [/ligue\s*1$/i],
  "Netherlands": [/eredivisie/i],
  "Belgium":   [/pro\s*league/i, /jupiler/i],
  "Greece":    [/super\s*league/i],
  "Portugal":  [/primeira/i, /liga\s*n?sagres/i],
  "Brazil":    [/serie\s*a$/i, /brasileirao/i],
  "Argentina": [/liga\s*professional/i, /primera\s*division/i],
  "Japan":     [/j1\s*league/i],
  "Russia":    [/premier\s*liga/i],
  "Ukraine":   [/premier\s*liga/i],
  "USA":       [/mls/i],
  "Saudi Arabia": [/pro\s*league/i],

  // UEFA & uluslararası kupalar (country genelde Europe / World / International geliyor)
  "World": [
    /champions\s*league/i,
    /europa\s*league/i,
    /conference\s*league/i,
    /uefa/i,
  ],
  "Europe": [
    /champions\s*league/i,
    /europa\s*league/i,
    /conference\s*league/i,
    /uefa/i,
  ],
  "International": [
    /champions\s*league/i,
    /europa\s*league/i,
    /conference\s*league/i,
    /nations\s*league/i,
    /world\s*cup/i,
    /euro\s*20\d{2}/i,
  ],
};

// 🌍 Global kupalar: ülke filtresinden bağımsız olarak geçecek lig isimleri
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

// --- JSON helpers ---
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
  return { ...item, lock: locked, lockAtISO: new Date(lockAt).toISOString() };
}

// --- Sağlayıcı yönetimi (providers.json) ---
function emptyProv() {
  return {
    providers: {
      AF: { ok: 0, fail: 0, lastMs: 0, lastAt: null },
      TSDB: { ok: 0, fail: 0, lastMs: 0, lastAt: null },
    },
    quotas: {
      AF: { daily: 100, used: 0 },
      TSDB: { daily: 1000, used: 0 },
    },
    // takım bazlı ana sağlayıcı tercihleri
    teamPref: {}, // { "galatasaray": "AF" | "TSDB" }
    updatedAt: null,
  };
}
async function loadProv() {
  return await readJson(PROV_FILE, emptyProv());
}
async function saveProv(m) {
  await writeJson(PROV_FILE, m);
}

function teamKey(name) {
  return String(name || "").trim().toLowerCase();
}

async function getTeamPref(team) {
  const m = await loadProv();
  const k = teamKey(team);
  return m.teamPref && m.teamPref[k] ? m.teamPref[k] : null;
}
async function setTeamPref(team, provider) {
  const m = await loadProv();
  const k = teamKey(team);
  m.teamPref ||= {};
  m.teamPref[k] = provider; // "AF" veya "TSDB"
  m.updatedAt = new Date().toISOString();
  await saveProv(m);
}

async function bumpProv(name, ok = true, ms = 0) {
  const m = await loadProv();
  m.providers[name] ||= { ok: 0, fail: 0, lastMs: 0, lastAt: null };
  if (ok) m.providers[name].ok++;
  else m.providers[name].fail++;
  m.providers[name].lastMs = ms;
  m.providers[name].lastAt = new Date().toISOString();
  m.quotas[name] ||= { daily: 100, used: 0 };
  m.quotas[name].used = Math.max(0, (m.quotas[name].used || 0) + 1);
  m.updatedAt = new Date().toISOString();
  await saveProv(m);
}
function quota90(m, name) {
  const q = m.quotas?.[name];
  if (!q) return false;
  return (q.used || 0) >= 0.9 * (q.daily || 100);
}

// --- Fetch helper ---
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

// --- Normalizers ---
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
      e.dateEvent && e.strTime
        ? `${e.dateEvent}T${e.strTime}:00Z`
        : e.dateEvent || null,
    league: e.strLeague || null,
    country: e.strCountry || null,
    home: e.strHomeTeam,
    away: e.strAwayTeam,
    status: "NS",
    source: "TSDB",
  };
}

// --- Tarih bazlı providers (schedule/open için) ---

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
        // Global kupalar (UCL/EL/ECL) ülke filtresine bakmadan geçsin
        if (isGlobalLeagueName(it.league)) return true;
        // Diğerleri klasik ülke + lig filtresine tabi
        return (
          it.country &&
          allowedCountry(it.country) &&
          isTopLeague(it.country, it.league)
        );
      });
    await bumpProv("AF", true, Date.now() - t0);
    return out;
  } catch (e) {
    await bumpProv("AF", false, Date.now() - t0);
    return [];
  }
}

// TheSportsDB (free) — tarih bazlı
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
    const out = arr
      .map(normalizeTS)
      .filter((it) => {
        if (isGlobalLeagueName(it.league)) return true;
        return (
          it.country &&
          allowedCountry(it.country) &&
          isTopLeague(it.country, it.league)
        );
      });
    await bumpProv("TSDB", true, Date.now() - t0);
    return out;
  } catch (e) {
    await bumpProv("TSDB", false, Date.now() - t0);
    return [];
  }
}

// --- Tarih bazlı kompozit (TSDB → AF) ---
async function fixturesByDate(isoDate) {
  const res = [];
  const ts = await tsdbByDate(isoDate);
  res.push(...ts);
  const af = await afByDate(isoDate);
  res.push(...af);
  return dedupe(res);
}

function dedupe(arr) {
  const seen = new Set();
  const out = [];
  for (const it of arr) {
    const k = `${it.country || ""}|${it.league || ""}|${it.home || ""}|${
      it.away || ""
    }|${it.kickoffISO || ""}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(it);
    }
  }
  return out;
}

// --- Takım bazlı providers (FAV için) ---

// TSDB team → eventsnext
async function tsdbFindTeamIdByName(name) {
  const r = await safeFetch(
    `https://www.thesportsdb.com/api/v1/json/3/searchteams.php?t=${encodeURIComponent(
      name
    )}`,
    {},
    12000
  );
  const j = await r.json();
  const team = j?.teams?.[0] || null;
  return {
    idTeam: team?.idTeam || null,
    teamName: team?.strTeam || name,
  };
}
async function tsdbNextFixturesByTeamName(teamName, limit = 10) {
  const { idTeam } = await tsdbFindTeamIdByName(teamName);
  if (!idTeam) return [];
  const r = await safeFetch(
    `https://www.thesportsdb.com/api/v1/json/3/eventsnext.php?id=${encodeURIComponent(
      idTeam
    )}`,
    {},
    12000
  );
  const j = await r.json();
  const arr = Array.isArray(j?.events) ? j.events : [];
  return arr
    .slice(0, limit)
    .map(normalizeTS)
    .filter((it) => {
      if (isGlobalLeagueName(it.league)) return true;
      return it.country
        ? allowedCountry(it.country) && isTopLeague(it.country, it.league)
        : true;
    });
}

// AF team → fixtures next
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
    (t.team?.name || "")
      .toLowerCase()
      .includes(String(name).toLowerCase())
  );
  return hit?.team?.id || null;
}

async function afNextFixturesByTeam(teamName, next = 10) {
  const m = await loadProv();
  if (!AF_KEY || quota90(m, "AF")) return [];
  const id = await afFindTeamIdByName(teamName);
  if (!id) return [];
  const t0 = Date.now();
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
    const arr = Array.isArray(j?.response) ? j.response : [];

    // TAKIM BAZLI: lig/ülke filtresini kaldır → veri gelsin, biz 72 saat penceresinde filtreliyoruz
    const out = arr.map(normalizeAF);

    await bumpProv("AF", true, Date.now() - t0);
    return out;
  } catch (e) {
    await bumpProv("AF", false, Date.now() - t0);
    return [];
  }
}

// team bazlı, provider tercihli kompozit (fav için)
async function fixturesByTeamWithPreference(team) {
  const name = String(team || "").trim();
  if (!name) return [];

  const pref = await getTeamPref(name); // "AF" | "TSDB" | null
  const windowHours = 72;

  async function filterByWindow(list) {
    const nowMs = Date.now();
    const toMs = nowMs + windowHours * 3600 * 1000;
    return list
      .filter((it) => within(it.kickoffISO, nowMs, toMs))
      .sort((a, b) => new Date(a.kickoffISO) - new Date(b.kickoffISO));
  }

  // İlk defa: TSDB → AF
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
    // ikisi de boş / hata
    return [];
  }

  // Bilinen tercih: önce tercih, sonra fallback
  if (pref === "AF") {
    const af = await afNextFixturesByTeam(name, 12);
    if (af.length > 0) return filterByWindow(af);
    const ts = await tsdbNextFixturesByTeamName(name, 12);
    if (ts.length > 0) {
      await setTeamPref(name, "TSDB"); // AF çökmüş olabilir → TSDB'ye kay
      return filterByWindow(ts);
    }
    return [];
  }

  // pref === "TSDB"
  const ts = await tsdbNextFixturesByTeamName(name, 12);
  if (ts.length > 0) return filterByWindow(ts);
  const af = await afNextFixturesByTeam(name, 12);
  if (af.length > 0) {
    await setTeamPref(name, "AF"); // TSDB yetersizse AF’ye kay
    return filterByWindow(af);
  }
  return [];
}

// --- ROUTES ---

// GET /api/live2/schedule  (bugün + yarın + dün)
router.get("/schedule", async (req, res) => {
  try {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const y = now.getFullYear(),
      m = pad(now.getMonth() + 1),
      d = pad(now.getDate());
    const today = `${y}-${m}-${d}`;
    const t1 = new Date(now.getTime() + 24 * 3600 * 1000);
    const tomorrow = `${t1.getFullYear()}-${pad(
      t1.getMonth() + 1
    )}-${pad(t1.getDate())}`;
    const t_1 = new Date(now.getTime() - 24 * 3600 * 1000);
    const yesterday = `${t_1.getFullYear()}-${pad(
      t_1.getMonth() + 1
    )}-${pad(t_1.getDate())}`;

    let list = [];
    try {
      list = list.concat(await fixturesByDate(yesterday));
    } catch {}
    try {
      list = list.concat(await fixturesByDate(today));
    } catch {}
    try {
      list = list.concat(await fixturesByDate(tomorrow));
    } catch {}

    const per = new Map();
    const capped = [];
    for (const it of list.sort(
      (a, b) => new Date(a.kickoffISO) - new Date(b.kickoffISO)
    )) {
      const key = it.country || "Other";
      const c = per.get(key) || 0;
      if (c < COUNTRY_CAP) {
        capped.push(it);
        per.set(key, c + 1);
      }
    }
    res.json({ ok: true, count: capped.length, fixtures: capped });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: "SCHEDULE_FAILED",
      detail: String((e && e.message) || e),
    });
  }
});

// GET /api/live2/open  (–48h .. +36h) + kilit
router.get("/open", async (req, res) => {
  try {
    const nowMs = Date.now();
    const fromMs = nowMs - BACK_WINDOW_HOURS * 3600 * 1000;
    const toMs = nowMs + OPEN_WINDOW_HOURS * 3600 * 1000;

    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const today = `${now.getFullYear()}-${pad(
      now.getMonth() + 1
    )}-${pad(now.getDate())}`;
    const t1 = new Date(nowMs + 24 * 3600 * 1000);
    const tomorrow = `${t1.getFullYear()}-${pad(
      t1.getMonth() + 1
    )}-${pad(t1.getDate())}`;
    const t_1 = new Date(nowMs - 24 * 3600 * 1000);
    const yesterday = `${t_1.getFullYear()}-${pad(
      t_1.getMonth() + 1
    )}-${pad(t_1.getDate())}`;

    let base = [];
    try {
      base = base.concat(await fixturesByDate(yesterday));
    } catch {}
    try {
      base = base.concat(await fixturesByDate(today));
    } catch {}
    try {
      base = base.concat(await fixturesByDate(tomorrow));
    } catch {}

    const windowed = base
      .filter((it) => within(it.kickoffISO, fromMs, toMs))
      .map((it) => withLockFlag(it, nowMs))
      .filter((it) => !it.lock);

    const per = new Map();
    const capped = [];
    for (const it of windowed.sort(
      (a, b) => new Date(a.kickoffISO) - new Date(b.kickoffISO)
    )) {
      const key = it.country || "Other";
      const c = per.get(key) || 0;
      if (c < COUNTRY_CAP) {
        capped.push(it);
        per.set(key, c + 1);
      }
    }
    res.json({
      ok: true,
      count: capped.length,
      fixtures: capped,
      window: { backH: BACK_WINDOW_HOURS, fwdH: OPEN_WINDOW_HOURS },
      lockBeforeMin: LOCK_BEFORE_MIN,
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: "OPEN_FAILED",
      detail: String((e && e.message) || e),
    });
  }
});

// GET /api/live2/fav?team=Galatasaray  (72h ileri, takım bazlı tercihli)
router.get("/fav", async (req, res) => {
  try {
    const team = String(req.query.team || "").trim();
    if (!team)
      return res
        .status(400)
        .json({ ok: false, error: "TEAM_REQUIRED" });

    const list = await fixturesByTeamWithPreference(team);

    res.json({
      ok: true,
      team,
      count: list.length,
      fixtures: list,
      windowHours: 72,
      lockBeforeMin: LOCK_BEFORE_MIN,
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: "FAV_FAILED",
      detail: String((e && e.message) || e),
    });
  }
});

/**
 * DEBUG: Belirli bir takım için TSDB ve AF sonuçlarını ham haliyle gör
 * GET /api/live2/fav-debug?team=Galatasaray
 */
router.get("/fav-debug", async (req, res) => {
  try {
    const team = String(req.query.team || "").trim();
    if (!team) {
      return res
        .status(400)
        .json({ ok: false, error: "TEAM_REQUIRED" });
    }

    const pref = await getTeamPref(team);

    // Her iki sağlayıcıyı da ayrı ayrı dene (hata alsak bile crash etme)
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

    // FDO henüz gerçek entegre değil → sadece sayacı 0 bırakıyoruz
    const fdoCount = 0;

    res.json({
      ok: true,
      team,
      pref: pref || null,
      tsCount: ts.length,
      afCount: af.length,
      fdoCount,
      tsError,
      afError,
      sample: {
        ts: ts.slice(0, 3),
        af: af.slice(0, 3),
      },
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: "FAV_DEBUG_FAILED",
      detail: String(e && (e.message || e)),
    });
  }
});

/// DEBUG: AF key durumu
router.get("/debug-af-key", (req, res) => {
  res.json({
    ok: true,
    AF_KEY: AF_KEY ? "SET" : "EMPTY",
    AF_BASE,
    AF_HDR,
  });
});

// DEBUG: FDO key durumu
router.get("/debug-fdo-key", (req, res) => {
  res.json({
    ok: true,
    FDO_KEY: typeof FDO_KEY !== "undefined" && FDO_KEY ? "SET" : "EMPTY",
    FDO_BASE: typeof FDO_BASE !== "undefined" ? FDO_BASE : null,
    FDO_HDR: typeof FDO_HDR !== "undefined" ? FDO_HDR : null,
  });
});


module.exports = router;
