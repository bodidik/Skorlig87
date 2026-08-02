"use strict";

const express = require("express");
const Season = require("../lib/season.cjs");
const { tsdbKickoffISO } = require("../lib/tsdb-time.cjs");
const router = express.Router();

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { guvenliYol } = require("../lib/guvenli-dosya.cjs");

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

// ⚠️ SKORLIG_DATA_DIR OKUNUYOR. Sabit yol testleri GERÇEK data/ dizinine
// yazdırıyordu: bir entegrasyon testi 7 kaydı canlı preds.json'a düşürdü.
// Ayrıca settle2 bu değişkeni okuyup pred okumayınca aynı zincirdeki iki
// modül maç durum dosyasını FARKLI dizinlerde arıyordu.
const DATA_DIR = process.env.SKORLIG_DATA_DIR || path.join(__dirname, "..", "data");
const PROV_FILE = path.join(DATA_DIR, "providers.json"); // provider.js ile aynı dosya
// FAV_FILE kaldırıldı: tanımlıydı ama HİÇ kullanılmıyordu (ölü kod). Üstelik
// yorumundaki şema (`{users:[{id, mainTeam}]}`) dosyanın gerçek şemasıyla da
// uyuşmuyordu — okuyan biri çıksa yanlış alan adı kullanırdı. Profil verisi
// artık lib/users-store.cjs üzerinden gider.
const MANUAL_FIXTURES_FILE = path.join(DATA_DIR, "fixtures.json");
const FixturesStore = require("../lib/fixtures-store.cjs");
// admin-alerts.json artık lib/admin-alerts.cjs üzerinden yazılır (kırpma +
// tekrar bastırma + dosya kilidi). Yol tanımı orada.
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
  Austria: [/bundesliga/i, /admiral\s*bundesliga/i],
  Switzerland: [/super\s*league/i, /credit\s*suisse/i],
  Poland: [/ekstraklasa/i],
  Mexico: [/liga\s*mx/i, /liga\s*bbva/i],
  Croatia: [/hnl/i, /hrvatska\s*nogometna/i, /superkup/i],
  Serbia: [/superliga/i, /serbian\s*super/i],
  "Czech Republic": [/czech\s*(first|liga)/i, /fortuna\s*liga/i, /1\.\s*liga/i],
  Romania: [/liga\s*i/i, /superliga/i, /liga\s*1/i],
  Hungary: [/nb\s*i/i, /nemzeti\s*bajnoks/i, /otp\s*bank/i],
  Slovakia: [/fortuna\s*liga/i, /slovak\s*(super|liga)/i],
  Bulgaria: [/efbet\s*liga/i, /first\s*professional/i, /parva\s*liga/i],

  // Avrupa / Dünya kupaları
  World: [
    /champions\s*league/i, /europa\s*league/i, /conference\s*league/i, /uefa/i,
    /world\s*cup/i, /euro\s*20\d{2}/i, /european\s*championship/i,
    /copa\s*america/i, /nations\s*league/i, /africa\s*cup/i,
    // CONMEBOL kulüp turnuvaları — sağlayıcılar bunları country:"World" ya da
    // "International" ile gönderiyor.
    /libertadores/i, /sudamericana/i, /recopa/i,
  ],
  Europe: [/champions\s*league/i, /europa\s*league/i, /conference\s*league/i, /uefa/i, /euro\s*20\d{2}/i, /european\s*championship/i],
  International: [
    /champions\s*league/i,
    /europa\s*league/i,
    /conference\s*league/i,
    /nations\s*league/i,
    /world\s*cup/i,
    /euro\s*20\d{2}/i,
  ],
};

// Küresel kupalar + gençlik/kadın elemesi: tek kaynak lib/global-leagues.cjs.
// Aynı liste routes/fixtures.cjs içinde de vardı ve ayrışmıştı.
const {
  GLOBAL_LEAGUES, EXCLUDED_LEAGUES, isGlobalLeagueName, isExcludedLeague,
} = require("../lib/global-leagues.cjs");

// Ülke = sıralama ölçütü, eleme ölçütü DEĞİL. Kabul kuralı neredeyse her maça
// "evet" der; yalnızca kadın/gençlik/yedek ligler ve eksik veri elenir.
const {
  isAcceptableFixture, sortByPriority, sameCountry, priorityGroupOf,
} = require("../lib/fixture-priority.cjs");

// Ülke adı / bayrak / seçilebilir liste: tek kaynak.
const {
  normalizeCountry, isKnownCountry, flagOf, selectableCountries,
} = require("../lib/countries.cjs");

/**
 * "Maçlar" ekranında en az bu kadar maç gösterilmeye çalışılır.
 * Ülke tavanı yüzünden liste bunun altına düşerse kalanlardan tamamlanır —
 * boş/az dolu ekran uygulamayı kullanılamaz yapıyordu.
 */
const MIN_FIXTURES = Number(process.env.SKORLIG_MIN_FIXTURES || 20);


function isTopLeague(country, league) {
  const pats = ALLOWED[country];
  if (!pats) return false;
  const n = String(league || "");
  if (isExcludedLeague(n)) return false;
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

/**
 * ⚠️ ATOMİK: geçici dosyaya yaz + rename. Doğrudan hedefe yazmak, aynı dosyayı
 * (özellikle providers.json kota sayacını) okuyan başka bir modüle YARIM JSON
 * gösteriyordu — ölçüldü: 662 okumanın 81'i JSON.parse ile patladı ve her
 * okuyucu hatayı yutup varsayılana düşüyor, yani kota SIFIR görünüyor.
 */
const { writeJsonAtomic } = require("../lib/fileLock.cjs");
async function writeJson(file, data) {
  return writeJsonAtomic(file, data);
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

// ---- Kullanıcı bazlı yerelleştirme ----
// Herkes kendi ülkesinin üst ligini + global yarışları (DK, Şampiyonlar Ligi...) görür.
// Türkiye'deki kullanıcı Galatasaray'ı, İtalya'daki Napoli'yi görür.
const COUNTRY_ALIASES = {
  "Türkiye": ["Türkiye", "Turkey"],
  "Turkey": ["Türkiye", "Turkey"],
};

// Ülke bayrağı, seçilebilir liste ve ISO eşlemesi TEK KAYNAKTAN gelir:
// lib/countries.cjs. Burada üç ayrı tablo vardı (COUNTRY_FLAGS,
// SELECTABLE_COUNTRIES, ISO2_TO_COUNTRY) ve hepsi ALLOWED'a bağlıydı — yani
// "kullanıcı hangi ülkeyi seçebilir" ile "hangi ligler üst lig" aynı tabloya
// bağlanmıştı. Ülke elemesi kaldırıldıktan sonra bu bağ anlamsız kaldı.
const COUNTRY_FLAGS = new Proxy({}, { get: (_t, k) => flagOf(String(k)) });
const SELECTABLE_COUNTRIES = selectableCountries();

// Aksan/büyük-küçük/bozuk-bayt farklarına dayanıklı kanonik ülke adı.
// "GR", "greece", "TÜRKİYE", "T?rkiye" hepsini doğru ALLOWED anahtarına çevirir.
/**
 * Kanonik ülke adı — TEK KAYNAK: lib/countries.cjs.
 *
 * Eski hâli yalnızca ALLOWED anahtarlarıyla eşleşiyordu (30 ülke) ve Türkçe
 * adları hiç tanımıyordu. Kaynaklar Türkçe gönderdiğinde ("İzlanda", "Ekvador")
 * `null` dönüyor, ülke eşleşmesi kuruluyordu. Ayrıca "USA" ile
 * "United States" ayrı sayılıyordu — ölçüldü, aynı ülke iki listeye bölünmüştü.
 *
 * Tanınmayan ad için `null` döner: kullanıcı ülkesi olarak kabul edilmez ama
 * MAÇ ELENMEZ (eleme lib/fixture-priority.cjs'te kaldırıldı).
 */
function canonicalCountry(input) {
  const s = String(input || "").trim();
  if (!s) return null;
  return isKnownCountry(s) ? normalizeCountry(s) : null;
}

// extraLeagues: virgülle ayrılmış ülke kodu/adı listesi ("GB,FR" veya "England,France")

function runtimeCountryCap(mode) {
  const p = String(mode?.profile || "").toUpperCase();
  if (p === "DEV_4_TEAMS") return 50;
  if (p === "TR_30_TEAMS") return 8;
  if (p.startsWith("GLOBAL_")) return 10;
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

  // Günlük kota sıfırlama: gün değiştiyse tüm used sayaçlarını sıfırla.
  // (Sayaç hiç sıfırlanmayınca AF kalıcı olarak "kota dolu" sanılıp atlanıyordu.)
  // ⚠️ BURASI BILEREK UTC: dis saglayicilarin gunluk kotasi UTC gece
  // yarisinda doner. Yerel gune cevirmek sayaci saglayiciyla desenkron
  // yapardi. (Kullaniciya gorunen gun hesaplari icin Season.dayKey.)
  const today = new Date().toISOString().slice(0, 10);
  if (m.quotaDay !== today) {
    m.quotaDay = today;
    for (const k of Object.keys(m.quotas || {})) {
      if (m.quotas[k]) m.quotas[k].used = 0;
    }
  }

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
    leagueId: x?.league?.id ?? null,   // TR ligi filtresi id ile (203 = Süper Lig)
    round: x?.league?.round || null,   // "Regular Season - 3" -> hafta etiketi
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
    // bkz. lib/tsdb-time.cjs — strTime saniyeli gelince eski satır
    // "22:00:00:00Z" gibi geçersiz ISO üretiyordu.
    kickoffISO: tsdbKickoffISO(e.dateEvent, e.strTime),
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
      // Ülke artık ELEME ölçütü değil, SIRALAMA ölçütü (lib/fixture-priority).
      // Eskiden ALLOWED dışı her ülkenin maçı burada düşüyordu; Süper Lig
      // sezon arasındayken Türk kullanıcının ekranı 14 gün boyunca boş kaldı.
      .filter(isAcceptableFixture);
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
      `https://www.thesportsdb.com/api/v1/json/3/eventsday.php?d=${encodeURIComponent(
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
      // Ülke elemesi kaldırıldı — bkz. lib/fixture-priority.cjs
      .filter(isAcceptableFixture);

    await bumpProv("TSDB", true, Date.now() - t0);
    return out;
  } catch (e) {
    await bumpProv("TSDB", false, Date.now() - t0);
    return [];
  }
}

// ==== Tarih bazlı disk cache (AF günlük 100 istek kotasını korumak için) ====
// TTL: bugünün listesi 30 dk (skor durumu değişebilir), diğer günler 6 saat.
const FX_CACHE_DIR = path.join(DATA_DIR, "cache");
const FX_CACHE_TTL_TODAY_MS = 30 * 60 * 1000;
const FX_CACHE_TTL_OTHER_MS = 6 * 60 * 60 * 1000;

async function readFxCache(isoDate) {
  const f = guvenliYol(FX_CACHE_DIR, `fx-${isoDate}`, ".json");
  const c = await readJson(f, null);
  if (!c || !Array.isArray(c.items) || !Number.isFinite(c.at)) return null;
  // ⚠️ YEREL GUN: "bugun" UTC ile hesaplaninca yerel 00:00–03:00 arasinda
  // bugunun fikstur onbellegi "eski gun" sayilip UZUN TTL aliyordu, yani
  // gunun ilk saatlerinde bayat veri gosteriliyordu.
  const today = Season.dayKey();
  const ttl = isoDate === today ? FX_CACHE_TTL_TODAY_MS : FX_CACHE_TTL_OTHER_MS;
  if (Date.now() - c.at > ttl) return null;
  return c.items;
}

/** TTL'i geçmiş de olsa diskteki son kopya — bayat servis için. */
async function readFxCacheBayat(isoDate) {
  const f = guvenliYol(FX_CACHE_DIR, `fx-${isoDate}`, ".json");
  const c = await readJson(f, null);
  if (!c || !Array.isArray(c.items)) return null;
  return c.items;
}

async function writeFxCache(isoDate, items) {
  const f = guvenliYol(FX_CACHE_DIR, `fx-${isoDate}`, ".json");
  try {
    await writeJson(f, { at: Date.now(), date: isoDate, items });
  } catch (e) {
    console.warn(`[live2] fx cache yazılamadı (${isoDate}):`, e && e.message ? e.message : e);
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * BAYAT SERVİS ET, ARKADA TAZELE.
 *
 * ⚠️ NEDEN: TTL dolduğu anda gelen İSTEK, ölü sağlayıcıların zaman aşımını
 * KULLANICI BEKLERKEN ödüyordu. Ölçüldü: `tsdbByDate` ve `afByDate` 12'şer
 * saniye zaman aşımlı, üç gün için çağrılıyor → tek istekte 6 çağrı, en
 * kötü halde ~72 sn. Bugünün TTL'i 30 dakika olduğu için yarım saatte bir
 * bir kullanıcı bu faturayı ödüyordu. TSDB kapalı, AF askıda (bkz.
 * lib/providers.cjs sağlık sayaçları) — yani fatura neredeyse HER SEFERİNDE
 * en kötü hâle yakın.
 *
 * ⚠️ BAYAT VERİ, BOŞ EKRANDAN İYİDİR — ama sınırsız değil: `EN_FAZLA_BAYAT`
 * üstündeki kopya kullanılmıyor, o noktada beklemek doğrusu. Fikstür listesi
 * (kim kiminle, saat kaçta) saatler içinde değişmiyor; CANLI SKOR bu yoldan
 * gelmiyor (o `data/live/*.json` durum dosyalarından okunuyor,
 * `effectiveStatusForFixture`), yani bayat kopya yanlış skor göstermez.
 *
 * ⚠️ AYNI GÜN İÇİN TEK TAZELEME UÇUŞTA. Yoksa TTL dolar dolmaz gelen her
 * istek ayrı bir tazeleme başlatır ve kotayı yakardı.
 * ──────────────────────────────────────────────────────────────────────── */
const EN_FAZLA_BAYAT_MS = Number(process.env.SKORLIG_FX_MAX_STALE_H || 12) * 3600 * 1000;
const _fxTazeleme = new Map(); // isoDate → Promise

async function _fxTaze(isoDate) {
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
  const out = dedupeFixtures(res);

  /* ⚠️ BOŞ SONUÇ, DOLU ÖNBELLEĞİ EZMEZ.
   *
   * ÖLÇÜLDÜ (2026-08-02): arka plan tazelemesi çalıştı ve bugünün listesi
   * için `0 kayıt` döndü — TSDB kapalı, AF askıda. Önceki kopyada 3 maç
   * vardı ve üzerine yazılınca listeden düştüler. Yani ölü sağlayıcılar
   * elimizdeki veriyi zamanla SİLİYOR.
   *
   * Aynı kural depoda zaten var: `services/fixture-sync.cjs` içinde
   * "Hiç maç gelmediyse YAZMA: geçici bir ağ/kota hatası, gelecekteki tüm
   * FDO maçlarını silerdi." Burada da aynısı uygulanıyor.
   *
   * ⚠️ ZAMAN DAMGASI YİNE DE TAZELENİYOR: aksi hâlde her istek yeniden
   * tazeleme başlatır ve ölü sağlayıcı beklemesine geri döneriz. Yani
   * "kontrol ettik, yeni bir şey yok" deniyor — veri silinmiyor.
   *
   * ⚠️ GERÇEKTEN BOŞ BİR GÜN (maç yok) ile ÖLÜ SAĞLAYICI ayırt edilemiyor;
   * ikisinde de eldeki kopya korunuyor. Bilinçli seçim: maç listesini
   * boşaltmanın bedeli (uygulama kullanılamaz), birkaç bayat kaydı
   * göstermenin bedelinden büyük. `EN_FAZLA_BAYAT_MS` üst sınırı duruyor. */
  if (!out.length) {
    const eski = await readFxCacheBayat(isoDate);
    if (eski && eski.length) {
      console.warn(`[live2] ${isoDate}: saglayicilar bos dondu, ${eski.length} kayitlik onbellek KORUNDU`);
      await writeFxCache(isoDate, eski);
      return eski;
    }
  }

  // Boş sonucu da kısa süreliğine cache'le ki arka arkaya gelen istekler kota yakmasın
  await writeFxCache(isoDate, out);
  return out;
}

/** Aynı gün için tek uçuşan tazeleme; sonucu paylaşır. */
function _fxTazelemeBaslat(isoDate) {
  let p = _fxTazeleme.get(isoDate);
  if (!p) {
    p = _fxTaze(isoDate).finally(() => _fxTazeleme.delete(isoDate));
    _fxTazeleme.set(isoDate, p);
  }
  return p;
}

// TSDB → AF kompozit
async function fixturesByDate(isoDate) {
  const cached = await readFxCache(isoDate);
  if (cached) return cached;

  /* TTL dolmuş: elde kullanılabilir bir kopya varsa ONU dön, tazelemeyi
   * arkada başlat. Kullanıcı beklemez. */
  const bayat = await readFxCacheBayat(isoDate);
  if (bayat) {
    const f = guvenliYol(FX_CACHE_DIR, `fx-${isoDate}`, ".json");
    const c = await readJson(f, null);
    const yas = Number.isFinite(c?.at) ? Date.now() - c.at : Infinity;
    if (yas <= EN_FAZLA_BAYAT_MS) {
      _fxTazelemeBaslat(isoDate).catch((e) =>
        console.warn(`[live2] arka plan tazeleme (${isoDate}):`, e?.message || e)
      );
      return bayat;
    }
  }

  // Hiç kopya yok ya da çok bayat — beklemek zorundayız.
  return _fxTazelemeBaslat(isoDate);
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
    // Ülke elemesi kaldırıldı — bkz. lib/fixture-priority.cjs
    .filter(isAcceptableFixture);
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
  return guvenliYol(LIVE_DIR, String(fid), ".json");
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
  // Fikstürler Mongo birincil — bkz. lib/fixtures-store.cjs
  const list = await FixturesStore.loadAll();

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
      if (isExcludedLeague(f.league)) return false;
      if (f.kickoffISO) return true;
      return !!(f.kickoffDate && /^\d{4}-\d{2}-\d{2}$/.test(String(f.kickoffDate)));
    });
}

/**
 * Yönetim alarmı yaz. Gerçek iş lib/admin-alerts.cjs'te — burası yalnızca
 * eski çağrı imzasını koruyan ince bir sarmalayıcı.
 *
 * ESKİ GÖMÜLÜ SÜRÜMÜN İKİ SORUNU VARDI (ölçüldü):
 *   • Sınırsız büyüme: `items.push()` + yaz, kırpma/TTL yok. 4 günde 1412
 *     kayıt / 733 KB birikmişti ve HER alarm tüm dosyayı okuyup yazıyordu.
 *   • Tekrar: 1412 kaydın yalnızca 243'ü tekil mesajdı (ortalama ~6 kat, en
 *     fazlası 21 kat). Gürültü gerçek sorunu görünmez yapıyordu.
 *
 * Ortak modül bunları çözer: aynı alarm soğuma penceresi içinde tekrar
 * yazılmaz, kayıt sayısı ve yaşı sınırlanır, yazma dosya kilidiyle atomiktir.
 */
const { appendAlert } = require("../lib/admin-alerts.cjs");

async function appendAdminAlert(kind, scope, message, meta) {
  return appendAlert(kind, scope, message, meta);
}

/* ────────────────────────────────────────────────────────────────────────────
 * SAĞLAYICIDA EKSİK MAÇ UYARISI — /schedule ve /open için TEK gövde.
 *
 * ⚠️ BU DÖNGÜ UYARI SİSTEMİNİ TAMAMEN YOK ETMİŞTİ. ÖLÇÜLDÜ (üretim,
 * 2026-08-02): `data/admin-alerts.json` 500 kaydın 499'u bu türden ve tamamı
 * **3 DAKİKALIK** pencereye sığıyordu. Tavan 500, TTL 14 gün — ama dosya
 * dakikalar içinde tümüyle devriliyor, yani `mongo_down` dahil GERÇEK her
 * uyarı görülmeden siliniyor. Performanstan önce bir TEŞHİS KÖRLÜĞÜ.
 *
 * ⚠️ SEBEP: UYARININ İDDİASI BAŞTAN YANLIŞTI. Sağlayıcı listesi yalnızca
 * DÜN/BUGÜN/YARIN çekiliyor (`fixturesByDate` üç gün); manuel pencere ise
 * -1..+60 gün. O üç günün dışındaki manuel maçın "provider'da olmaması"
 * ANOMALİ DEĞİL, TASARIM. Ölçüldü: istek başına ~102 maç bu duruma girip
 * uyarı yazıyordu. Artık yalnızca sağlayıcının GERÇEKTEN kapsadığı günler
 * değerlendiriliyor — orada eksiklik gerçek sinyaldir.
 *
 * ⚠️ TEK ÖZET UYARI, N TANE DEĞİL; ve yanıt BEKLETİLMİYOR (her uyarı 268KB
 * dosyada kilit alıyordu).
 *
 * ⚠️ ORTAK GÖVDE, ÇÜNKÜ İKİ KOPYA VARDI. `/schedule` ve `/open` aynı döngüyü
 * ayrı ayrı taşıyordu; birini düzeltip ötekini unutmak bu depodaki en sık
 * kusur şekli. Tek yer.
 * ──────────────────────────────────────────────────────────────────────── */
function saglayiciEksikleriniBildir({ manuel, saglayici, kapsananGunler, kind, scope, etiket, profile }) {
  /* O(n×m) → O(n+m): eskiden her manuel maç için TÜM sağlayıcı listesi
   * taranıp `sameFixtureKey` yeniden hesaplanıyordu (≈1300×1250 = 1.6M dize
   * birleştirme, istek başına). */
  const anahtarlar = new Set(saglayici.map(sameFixtureKey));

  const eksikler = manuel.filter((mf) => {
    if (anahtarlar.has(sameFixtureKey(mf))) return false;
    const koMs = parseKickoffMs(mf);
    if (!Number.isFinite(koMs)) return false;   // saati belirsiz — yargılanamaz
    return kapsananGunler.has(ymdInTZ(koMs, TZ));
  });

  if (!eksikler.length) return 0;

  const ornek = eksikler.slice(0, 5).map((m) => `${m.fixtureId} (${m.home} - ${m.away})`).join(", ");
  // Bilinçli olarak beklenmiyor; hata yalnızca loglanır.
  appendAdminAlert(
    kind,
    scope,
    `Sağlayıcının kapsadığı 3 günde ${eksikler.length} maç ${etiket} penceresinde provider'dan gelmedi; manuel listeden alındı. Örnek: ${ornek}`,
    {
      adet: eksikler.length,
      ornekIdler: eksikler.slice(0, 20).map((m) => m.fixtureId),
      gunler: [...kapsananGunler],
      profile,
    }
  ).catch((e) => console.warn(`[live2/${scope}] uyari yazilamadi:`, e?.message || e));

  return eksikler.length;
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

// GET /api/live2/countries : mobil ülke seçici için desteklenen ülkeler
router.get("/countries", (req, res) => {
  res.json({
    ok: true,
    countries: SELECTABLE_COUNTRIES.map((c) => ({
      country: c,
      flag: COUNTRY_FLAGS[c] || "",
    })),
  });
});

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
    let merged = mergeWithManualFixtures(filtered, manualFiltered);

    // Kullanıcının yereli: ?country= verildiyse o ülkenin ligi + global yarışlar
    // ÜLKE ARTIK SÜZMÜYOR — yalnızca sıralıyor.
    //
    // Eskiden `localizeForCountry` kullanıcının ülkesi dışındaki her maçı
    // eliyordu. Süper Lig sezon arasındayken bu, ekranın 14 gün boyunca boş
    // kalması demekti: aynı anda UCL ön elemeleri, Konferans Ligi elemeleri ve
    // Brezilya Série A oynanıyordu. Kaygı "maç kalabalığında oyun kurulamaz"
    // idi; yaşanan tam tersi oldu.
    //
    // Kullanıcının ülkesi hâlâ önemli ama SIRA belirliyor: kendi ülkesi üstte,
    // sonra küresel turnuvalar, sonra büyük ligler, sonra kalan her şey.
    const userCountry = String(req.query.country || "").trim();
    // Bilgi amaçlı: kullanıcının ülkesinde hiç maç yok mu? (arayüz şerit gösterir)
    const countryFallback =
      !!userCountry && !merged.some((it) => sameCountry(it.country, userCountry));
    merged = sortByPriority(merged, userCountry);

    // Takım önceliklendirmesi: ?team= verildiyse kullanıcının takımı en üste
    const userTeam = String(req.query.team || "").trim().toLowerCase();

    /* ────────────────────────────────────────────────────────────────────
     * Admin uyarısı: manuel olup provider'da olmayanlar.
     *
     * ⚠️ BU DÖNGÜ UYARI SİSTEMİNİ TAMAMEN YOK ETMİŞTİ. ÖLÇÜLDÜ (üretim,
     * 2026-08-02): `data/admin-alerts.json` 500 kaydın 499'u bu tek türden
     * ve tamamı **3 DAKİKALIK** bir pencereye sığıyordu. Tavan 500, TTL 14
     * gün — ama dosya dakikalar içinde tamamen devriliyor, yani `mongo_down`
     * dahil GERÇEK her uyarı görülmeden siliniyor. Teşhis körlüğü.
     *
     * ⚠️ SEBEP: UYARININ İDDİASI BAŞTAN YANLIŞTI. Sağlayıcı listesi yalnızca
     * DÜN/BUGÜN/YARIN çekiliyor (`fixturesByDate` üç gün), manuel pencere ise
     * varsayılan -1..+60 GÜN. Yani o üç günün dışındaki her manuel maçın
     * "provider'da olmaması" ANOMALİ DEĞİL, TASARIM. Ölçüldü: istek başına
     * ~102 maç bu duruma giriyor ve her biri uyarı yazıyordu.
     * Uyarı artık yalnızca sağlayıcının GERÇEKTEN kapsadığı üç gün için
     * üretiliyor; orada eksiklik gerçek bir sinyaldir.
     *
     * ⚠️ TEK ÖZET UYARI, N TANE DEĞİL. Aynı sistemik durumu maç maç yazmak
     * dosyayı dolduruyordu; sayı + birkaç örnek yeterli.
     *
     * ⚠️ YANIT BEKLETİLMİYOR (await YOK). Her uyarı 268KB'lık dosyada kilit
     * alıyordu; bu, yanıt yolunda olmaması gereken bir iş.
     * ──────────────────────────────────────────────────────────────────── */
    saglayiciEksikleriniBildir({
      manuel: manualFiltered,
      saglayici: filtered,
      kapsananGunler: new Set([yesterday, today, tomorrow]),
      kind: "provider_missing_schedule",
      scope: "schedule",
      etiket: "schedule",
      profile: runtimeMode.profile,
    });

    // CAP + sıralama: kullanıcının takımı → diğerleri (kickoff sırası)
    function teamScore(it) {
      if (!userTeam) return 0;
      const h = String(it.home || "").toLowerCase();
      const a = String(it.away || "").toLowerCase();
      if (h === userTeam || a === userTeam) return 2;
      if (h.includes(userTeam) || a.includes(userTeam)) return 1;
      return 0;
    }

    // Takım tercihi önceliği bozmadan uygulanır: aynı öncelik grubu içinde
    // kullanıcının takımı üste çıkar (sortByPriority zaten grupladı).
    const sirali = merged.slice().sort((a, b) => {
      const ts = teamScore(b) - teamScore(a);
      return ts !== 0 ? ts : 0; // kararlı sıralama: grup/zaman sırası korunur
    });

    // Ülke başına tavan ÇEŞİTLİLİK içindir (tek lig listeyi kaplamasın),
    // kısıtlama için değil. Tavan yüzünden liste MIN_FIXTURES'ın altına
    // düşerse kalanlardan tamamlanır — "uygulamaya giren zaman geçirebilsin".
    const per = new Map();
    const secilen = [];
    const artanlar = [];
    for (const it of sirali) {
      const key = it.country || "Other";
      const c = per.get(key) || 0;
      if (c < cap) {
        secilen.push(it);
        per.set(key, c + 1);
      } else {
        artanlar.push(it);
      }
    }
    // Taban: tavan yüzünden elenenlerden sırayla tamamla.
    for (const it of artanlar) {
      if (secilen.length >= MIN_FIXTURES) break;
      secilen.push(it);
    }

    const capped = [];
    for (const it of secilen) {
      const effStatus = await effectiveStatusForFixture(it);
      capped.push({
        ...finalizeFixtureForOutput({ ...it, status: effStatus }),
        // Grup başlığı için — arayüz sıra değiştiğinde başlık basar.
        // Sunucu üretiyor: istemcide yeniden hesaplamak iki ayrı tanım demek.
        priorityGroup: priorityGroupOf(it, userCountry),
      });
    }

    res.json({
      ok: true,
      count: capped.length,
      fixtures: capped,
      runtimeMode,
      cap,
      windowDays: { backDays, fwdDays, fromISO, toISO },
      // Kullanıcının ülkesinde maç bulunamadığı için dünya listesi döndü.
      // Arayüz bunu belirtmeli, yoksa Brezilya maçı görmek hata gibi görünür.
      countryFallback,
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

    let merged = mergeWithManualFixtures(baseFiltered, manualFiltered);

    // Kullanıcının yereli: ?country= verildiyse o ülkenin ligi + global yarışlar
    // ÜLKE ARTIK SÜZMÜYOR — yalnızca sıralıyor.
    //
    // Eskiden `localizeForCountry` kullanıcının ülkesi dışındaki her maçı
    // eliyordu. Süper Lig sezon arasındayken bu, ekranın 14 gün boyunca boş
    // kalması demekti: aynı anda UCL ön elemeleri, Konferans Ligi elemeleri ve
    // Brezilya Série A oynanıyordu. Kaygı "maç kalabalığında oyun kurulamaz"
    // idi; yaşanan tam tersi oldu.
    //
    // Kullanıcının ülkesi hâlâ önemli ama SIRA belirliyor: kendi ülkesi üstte,
    // sonra küresel turnuvalar, sonra büyük ligler, sonra kalan her şey.
    const userCountry = String(req.query.country || "").trim();
    // Bilgi amaçlı: kullanıcının ülkesinde hiç maç yok mu? (arayüz şerit gösterir)
    const countryFallback =
      !!userCountry && !merged.some((it) => sameCountry(it.country, userCountry));
    merged = sortByPriority(merged, userCountry);

    // lock + pencere + (kilitli olmayan)
    const windowed = [];
    for (const it of merged) {
      const withLock = withLockFlag(it, nowMs);
      if (!within(withLock, fromMs, toMs)) continue;
      if (!withLock.lock) windowed.push(withLock);
    }

    // Admin uyarısı — ortak gövde. bkz. saglayiciEksikleriniBildir
    saglayiciEksikleriniBildir({
      manuel: manualFiltered,
      saglayici: baseFiltered,
      kapsananGunler: new Set([yesterday, today, tomorrow]),
      kind: "provider_missing_open",
      scope: "open",
      etiket: "open",
      profile: runtimeMode.profile,
    });

    // Ülke tavanı ÇEŞİTLİLİK içindir; taban altına düşerse tamamlanır.
    // (Aynı gerekçe /schedule'da: boş ekran uygulamayı kullanılamaz yapıyordu.)
    const per = new Map();
    const secilen = [];
    const artanlar = [];
    for (const it of windowed) {
      const key = it.country || "Other";
      const c = per.get(key) || 0;
      if (c < cap) {
        secilen.push(it);
        per.set(key, c + 1);
      } else {
        artanlar.push(it);
      }
    }
    for (const it of artanlar) {
      if (secilen.length >= MIN_FIXTURES) break;
      secilen.push(it);
    }
    const capped = secilen.map((it) => ({
      ...finalizeFixtureForOutput(it),
      priorityGroup: priorityGroupOf(it, userCountry),
    }));

    res.json({
      ok: true,
      count: capped.length,
      fixtures: capped,
      window: { backH, fwdH: fwdH_eff },
      lockBeforeMin: LOCK_BEFORE_MIN,
      runtimeMode,
      cap,
      countryFallback,
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

// af-sync servisi aynı filtre + cache + kota yolundan fixture listesi alabilsin
module.exports.fixturesByDate = fixturesByDate;
// users.cjs set-country kanonik ad saklayabilsin
module.exports.canonicalCountry = canonicalCountry;

