"use strict";

const fs   = require("fs");
const path = require("path");

// Testlerde izole dizine yönlendirilebilir — yoksa cache/istatistik yazımları
// GERÇEK data/ klasörüne düşer (bu tuzağa bu projede birkaç kez düşüldü).
const DATA_DIR   = process.env.SKORLIG_DATA_DIR || path.join(__dirname, "..", "data");

/**
 * Date → "YYYY-MM-DD HH:mm" — İSTANBUL saatiyle, süreç hangi dilimde çalışırsa
 * çalışsın. matchDate tüketicileri (mackolik-fixture-sync.toIso, livescore-sync)
 * bu değeri İstanbul yereli sayıp +03:00 yapıştırıyor.
 *
 * NEDEN ŞART: getHours() süreç dilimini kullanır. Yerelde (TR) doğru çalışıp
 * Render'da (UTC) her maçı 3 saat erken gösteriyordu — akşam maçları
 * "başlamış" sayılıp elendi, goal'un 49 maçından fikstüre SIFIR düştü
 * (NO_MATCHING_COUNTRIES diye loglandı ki o da ayrı bir yanılgıydı).
 */
function toIstanbulMatchDate(d) {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d);
  const g = (t) => p.find((x) => x.type === t)?.value || "";
  const hh = g("hour") === "24" ? "00" : g("hour"); // en-CA tuhaflığı
  return { matchDate: `${g("year")}-${g("month")}-${g("day")} ${hh}:${g("minute")}`, startTime: `${hh}:${g("minute")}` };
}
const CACHE_FILE = path.join(DATA_DIR, "livescore-cache.json");

const CHROME_PATH = process.env.LOCAL_CHROME_PATH
  || "C:/Program Files/Google/Chrome/Application/chrome.exe";

const IS_PROD = process.env.NODE_ENV === "production" || process.platform !== "win32";

const NAV_TIMEOUT  = 15000; // 15s per source
const SEL_TIMEOUT  = 10000;
const BLOCKED_TYPES = new Set(["image", "stylesheet", "font", "media"]);

async function getLaunchOptions() {
  const baseArgs = [
    "--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu",
    "--disable-dev-shm-usage", "--disable-extensions",
    "--disable-background-networking", "--disable-default-apps",
    "--disable-sync", "--no-first-run", "--disable-notifications",
  ];
  if (IS_PROD) {
    const chromium = require("@sparticuz/chromium");
    return { args: [...chromium.args, ...baseArgs], executablePath: await chromium.executablePath(), headless: chromium.headless };
  }
  return { executablePath: CHROME_PATH, headless: "new", args: baseArgs };
}

// ─── League map ───────────────────────────────────────────────────────────────

const LEAGUES = {
  "turkiye-super-lig":     { country: "Türkiye",   name: "Süper Lig",        keywords: ["süper lig", "super lig", "trendyol süper", "turkish super lig"],   countryMatch: ["türkiye", "turkey"] },
  "turkiye-1-lig":         { country: "Türkiye",   name: "1. Lig",           keywords: ["1. lig", "tff 1. lig", "tff first league"],                        countryMatch: ["türkiye", "turkey"] },
  "turkiye-hazirlik":      { country: "Türkiye",   name: "Hazırlık",         keywords: ["hazırlık türk"],                                                   countryMatch: ["dünya", "türkiye", "turkey"] },
  "ingiltere-premier-lig": { country: "İngiltere", name: "Premier Lig",      keywords: ["premier league", "premier lig"],                                   countryMatch: ["ingiltere", "england"] },
  "ispanya-la-liga":       { country: "İspanya",   name: "La Liga",          keywords: ["la liga"],                                                         countryMatch: ["ispanya", "spain"] },
  "sampiyonlar-ligi":      { country: "Avrupa",    name: "Şampiyonlar Ligi", keywords: ["şampiyonlar ligi", "champions league", "uefa champions league"],   countryMatch: ["avrupa", "dünya", "europe", "world"] },
};

// ─── Source stats (başarı oranı takibi) ──────────────────────────────────────

const STATS_FILE   = path.join(DATA_DIR, "livescore-stats.json");
const MIN_ATTEMPTS = 15;   // istatistik için minimum deneme sayısı
const WARN_RATE    = 0.25; // %25 altı başarı → eleme önerisi

function readStats() {
  try { if (fs.existsSync(STATS_FILE)) return JSON.parse(fs.readFileSync(STATS_FILE, "utf8")); } catch (_) {}
  return {};
}

function saveStats(stats) {
  try { fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2), "utf8"); } catch (_) {}
}

function recordAttempt(stats, name, success) {
  if (!stats[name]) stats[name] = { attempts: 0, success: 0, lastSuccess: null, lastAttempt: null };
  const s = stats[name];
  s.attempts++;
  s.lastAttempt = new Date().toISOString();
  if (success) { s.success++; s.lastSuccess = s.lastAttempt; }
}

/**
 * Düşük başarılı kaynakları uyarır.
 *
 * ⚠️ "ELEME ÖNERİLİR" DEMİYORUZ — şu tuzağa iki kez düşüldü: şelale sırayla
 * çalışır ve ÖNCEKİ kaynak başarılı olunca sonrakiler HİÇ denenmez. Bir kaynağın
 * düşük oranı çoğu zaman "bozuk" değil, "yalnızca kötü koşullarda sıra ona
 * geliyor" demektir. Üstelik sıra ortama göre değişiyor: yerelde mackolik
 * kazanıyor, Render'da mackolik zaman aşımına uğrayıp goal kazanıyor.
 *
 * Bu uyarıya bakıp kaynak elemek, YANLIŞ kaynağı silmeye yol açar. O yüzden
 * artık şelaledeki sıra da yazılıyor ve karar yoklamaya (--probe) havale
 * ediliyor — yoklama kaynağı şelaleden BAĞIMSIZ dener, tek güvenilir ölçüm o.
 */
function checkAndWarnStats(stats) {
  const sira = new Map(orderedSources().map((s, i) => [s.name, i + 1]));
  const poor = [];
  for (const [name, s] of Object.entries(stats)) {
    if (s.attempts >= MIN_ATTEMPTS && s.success / s.attempts < WARN_RATE) {
      poor.push({
        name,
        rate: Math.round((s.success / s.attempts) * 100),
        attempts: s.attempts,
        pos: sira.get(name) ?? "?",
      });
    }
  }
  if (poor.length) {
    console.warn(
      "[livescore] ⚠️  Düşük başarı oranlı kaynaklar " +
        "(şelalede sırası geç olan kaynak zaten nadiren denenir — " +
        "eleme kararı için --probe kullanın):"
    );
    poor.forEach((p) =>
      console.warn(`   → ${p.name}: %${p.rate} başarı (${p.attempts} deneme · şelalede ${p.pos}. sırada)`)
    );
  }
  return poor;
}

// ─── Cache helpers ────────────────────────────────────────────────────────────

let _cache    = { ts: null, leagues: {}, trackedMatchCount: 0, totalMatchCount: 0 };
let _interval = null;
let _scraping = false;

function readCache() {
  try { if (fs.existsSync(CACHE_FILE)) _cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")); } catch (_) {}
  return _cache;
}

function writeCache(data) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch (e) { console.error("[livescore] cache write failed:", e.message); }
}

function matchLeague(compTitle, compCountry) {
  if (!compTitle) return null;
  const t = compTitle.toLowerCase();
  const c = (compCountry || "").toLowerCase();
  for (const [id, league] of Object.entries(LEAGUES)) {
    if (!league.keywords.some(kw => t.includes(kw))) continue;
    if (league.countryMatch.some(cm => c.includes(cm.toLowerCase()))) return { id, ...league };
  }
  return null;
}

function slugify(str) {
  return (str || "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64) || "other";
}

// ─── Shared browser helper ────────────────────────────────────────────────────

async function scrapeWithBrowser(url, parseFn, selectorHint) {
  const puppeteer  = require("puppeteer-core");
  const launchOpts = await getLaunchOptions();
  const browser    = await puppeteer.launch(launchOpts);
  try {
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36");
    await page.setViewport({ width: 1280, height: 800 });
    await page.setRequestInterception(true);
    page.on("request", req => {
      if (BLOCKED_TYPES.has(req.resourceType())) req.abort();
      else req.continue();
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
    if (selectorHint) await page.waitForSelector(selectorHint, { timeout: SEL_TIMEOUT }).catch(() => {});
    await new Promise(r => setTimeout(r, 1200));
    return await page.evaluate(parseFn);
  } finally {
    try { await browser.close(); } catch (_) {}
  }
}

// ─── Source 1: Maçkolik ───────────────────────────────────────────────────────

function fromMackolik() {
  return scrapeWithBrowser(
    "https://www.mackolik.com/canli-sonuclar",
    () => {
      const rows = document.querySelectorAll(".match-row");
      const results = [];
      rows.forEach(row => {
        const sport = row.querySelector(".match-row__match-content")?.getAttribute("data-sport");
        if (sport && sport !== "S") return;
        const compTitle   = row.querySelector(".match-row__competition abbr")?.getAttribute("title") || "";
        const compCountry = row.querySelector(".match-row__competition img")?.getAttribute("alt") || "";
        const homeTeam    = row.querySelector(".match-row__team-name--home .match-row__team-name-text")?.textContent?.trim() || "";
        const awayTeam    = row.querySelector(".match-row__team-name--away .match-row__team-name-text")?.textContent?.trim() || "";
        if (!homeTeam || !awayTeam) return;
        const homeScore = row.querySelector(".match-row__score-home")?.textContent?.trim() || null;
        const awayScore = row.querySelector(".match-row__score-away")?.textContent?.trim() || null;
        const status    = row.querySelector(".match-row__status")?.textContent?.trim() || "";
        const startTime = row.querySelector(".match-row__start-time")?.textContent?.trim() || "";
        const htScore   = row.querySelector(".match-row__half-time-score")?.textContent?.trim() || null;
        const matchDate = row.getAttribute("data-match-date") || "";
        const hcSrc = row.querySelector(".match-row__team-crest--home")?.getAttribute("data-src") || row.querySelector(".match-row__team-crest--home")?.getAttribute("src") || "";
        const acSrc = row.querySelector(".match-row__team-crest--away")?.getAttribute("data-src") || row.querySelector(".match-row__team-crest--away")?.getAttribute("src") || "";
        const homeRed = parseInt(row.querySelector(".match-row__team-name--home")?.getAttribute("data-red-cards") || "0", 10);
        const awayRed = parseInt(row.querySelector(".match-row__team-name--away")?.getAttribute("data-red-cards") || "0", 10);
        results.push({
          homeTeam, awayTeam, homeScore, awayScore,
          status: status || startTime || "—", startTime, htScore, matchDate,
          homeCrest: hcSrc ? (hcSrc.startsWith("http") ? hcSrc : "https:" + hcSrc) : null,
          awayCrest: acSrc ? (acSrc.startsWith("http") ? acSrc : "https:" + acSrc) : null,
          homeRed, awayRed,
          isLive: row.classList.contains("match-row--live"),
          isHT:   row.classList.contains("match-row--halfTime"),
          isFinished: status === "MS",
          compTitle, compCountry,
        });
      });
      return results;
    },
    ".match-row"
  );
}

// ─── Source 2: Bilyoner ───────────────────────────────────────────────────────

function fromBilyoner() {
  return scrapeWithBrowser(
    "https://www.bilyoner.com/canli-mac-sonuclari",
    () => {
      // Angular app — tries several selector patterns
      const rows = document.querySelectorAll(
        ".event-row, .live-event-item, [class*='liveEvent'], [class*='EventRow'], [class*='event-item']"
      );
      const results = [];
      rows.forEach(row => {
        const teams     = row.querySelectorAll("[class*='team-name'], [class*='teamName'], [class*='TeamName']");
        if (teams.length < 2) return;
        const homeTeam  = teams[0]?.textContent?.trim() || "";
        const awayTeam  = teams[1]?.textContent?.trim() || "";
        if (!homeTeam || !awayTeam) return;
        const scoreEls  = row.querySelectorAll("[class*='score'], [class*='Score']");
        const homeScore = scoreEls[0]?.textContent?.trim() || null;
        const awayScore = scoreEls[1]?.textContent?.trim() || null;
        const statusEl  = row.querySelector("[class*='status'], [class*='Status'], [class*='minute'], [class*='time']");
        const status    = statusEl?.textContent?.trim() || "—";
        const leagueEl  = row.closest("[class*='league'], [class*='competition'], [class*='League']")
                            ?.querySelector("[class*='title'], [class*='name']");
        results.push({
          homeTeam, awayTeam, homeScore, awayScore,
          status, startTime: "", htScore: null, matchDate: "",
          homeCrest: null, awayCrest: null, homeRed: 0, awayRed: 0,
          isLive: true, isHT: status === "HT", isFinished: false,
          compTitle: leagueEl?.textContent?.trim() || "",
          compCountry: "Turkey",
        });
      });
      return results;
    },
    null
  );
}

// ─── Source 3: Nesine ─────────────────────────────────────────────────────────

/**
 * Nesine lig başlığı → Türkçe ülke adı.
 *
 * NEDEN GEREKLİ: Nesine'de ülke için ayrı bir alan yok; başlığın BAŞINA gömülü
 * geliyor ("Brezilya Serie B", "Arjantin Primera Nacional"). Ülke boş kalırsa
 * cache'e `country: ""` yazılır ve fikstür senkronu (TR_TO_COUNTRY[""]) tüm
 * maçları SESSİZCE eler — hata değil, sadece sıfır maç.
 *
 * Çıktı Türkçe: mackolik-fixture-sync'in beklediği biçim bu. Aynı şekli
 * üretince nesine, Maçkolik'in yerine hiçbir değişiklik olmadan geçebiliyor.
 * Buradaki anahtarlar TR_TO_COUNTRY anahtarlarıyla birebir olmalı.
 */
const NESINE_COUNTRY_PREFIXES = [
  "Türkiye", "İngiltere", "İspanya", "Almanya", "İtalya", "Fransa", "Hollanda",
  "Portekiz", "Brezilya", "Arjantin", "Meksika", "Japonya", "ABD",
  "Suudi Arabistan", "Yunanistan", "Rusya", "Ukrayna", "Polonya", "Avusturya",
  "İsviçre", "Belçika", "Çekya", "Sırbistan", "Hırvatistan", "Slovakya",
  "Bulgaristan", "Romanya", "Macaristan",
];

function nesineCountryFromTitle(title) {
  const t = String(title || "").trim();
  if (!t) return "";

  // UEFA turnuvaları ülkeye değil kıtaya ait ("Uefa Şampiyonlar Ligi Elemeleri")
  if (/^uefa\b/i.test(t)) return "Avrupa";

  const tl = t.toLocaleLowerCase("tr-TR");
  for (const c of NESINE_COUNTRY_PREFIXES) {
    // Yalnızca BAŞTA ara: "Kolombiya Kupası" ülke, ama bir takım adının içinde
    // geçen ülke kelimesi (varsa) ligi yanlış ülkeye yazardı.
    if (tl.startsWith(c.toLocaleLowerCase("tr-TR"))) return c;
  }
  return ""; // kapsam dışı ülke → fikstür senkronunda atlanır
}

/** Europe/Istanbul'a göre bugünün YYYY-MM-DD'si. */
function istanbulToday(nowMs = Date.now()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(nowMs));
}

/**
 * Nesine satırlarını Maçkolik'in ürettiği şekle tamamlar.
 *
 * İki eksik doldurulur:
 *   compCountry — lig başlığından (yukarı bak)
 *   matchDate   — nesine yalnızca SAAT veriyor ("20:00"), tarih yok. Canlı skor
 *                 sayfası günün programı olduğu için tarih = İstanbul'da bugün.
 *
 * GECE YARISI KAYMASI: 00:30'luk bir maç, akşam saatlerinde hâlâ "bugünün"
 * sayfasında listelenebilir. Ham hesap onu geçmişte gösterir ve fikstür
 * senkronu (geçmiş maçları atar) sessizce düşürür. Hesaplanan saat belirgin
 * şekilde geçmişteyse ertesi güne alıyoruz — yanılırsak maç zaten atılacaktı,
 * yani bu değişiklik yalnızca kaybedilecek maçları kurtarabilir.
 */
const NESINE_ROLLOVER_MS = 6 * 3600 * 1000;

function enrichNesine(rows, nowMs = Date.now()) {
  const today = istanbulToday(nowMs);

  return (Array.isArray(rows) ? rows : []).map((m) => {
    const compCountry = nesineCountryFromTitle(m.compTitle);

    // Saat yalnızca başlamamış maçlarda var; canlı/bitmiş olanın tarihine
    // fikstür tarafında zaten ihtiyaç yok.
    let matchDate = m.matchDate || "";
    const hhmm = String(m.startTime || "").trim();
    if (!matchDate && /^\d{1,2}:\d{2}$/.test(hhmm)) {
      const padded = hhmm.padStart(5, "0");
      let day = today;
      const ko = Date.parse(`${today}T${padded}:00+03:00`);
      if (Number.isFinite(ko) && ko < nowMs - NESINE_ROLLOVER_MS) {
        day = istanbulToday(nowMs + 24 * 3600 * 1000);
      }
      matchDate = `${day} ${padded}`;
    }

    return { ...m, compCountry, matchDate };
  });
}

/**
 * Nesine — canlı skor sayfası.
 *
 * ÖNCEKİ SÜRÜM ÖLÜ ADRESİ KAZIYORDU: iddaa.nesine.com/canli artık 404
 * ("Aradığınız sayfa bulunamadı"). Sayfa yüklendiği için hata fırlatmıyor,
 * sessizce 0 maç dönüyordu. Doğru adres www.nesine.com/iddaa/canli-skor/futbol.
 *
 * Not: nesine'nin bülten API'si (bulten.nesine.com/api/bulten/getlivebultenv3)
 * JSON döner ama SKOR İÇERMEZ — bahis programı + oranlardır. Canlı skor için
 * bu sayfa ayrıştırılmak zorunda.
 *
 * Ayrıca yalnızca canlı değil, günün tamamı gelir (biten + başlamamış dahil).
 */
async function fromNesine() {
  const rows = await scrapeWithBrowser(
    "https://www.nesine.com/iddaa/canli-skor/futbol",
    () => {
      const results = [];
      const txt = (el) => (el?.textContent || "").replace(/\s+/g, " ").trim();

      document.querySelectorAll("[data-test-id='ClassicMatchLine']").forEach((row) => {
        const homeTeam = txt(row.querySelector(".home-team"));
        const awayTeam = txt(row.querySelector(".away-team"));
        if (!homeTeam || !awayTeam) return;

        // Skor kutusu yalnızca başlamış maçlarda dolu.
        const hs = txt(row.querySelector(".home-score"));
        const as = txt(row.querySelector(".away-score"));

        // Durum rozeti: "88'" | "MS" | "20:00" (başlamamışta kickoff saati)
        const status = txt(row.querySelector("[data-test-id='Status'], .status")) || "—";

        // Satır sınıfı durumun asıl kaynağı — metinden daha kararlı.
        // "live liveData" | "not-started unliveData" |
        // "match-not-play unliveData" | "extra-time unliveData finished"
        const cls = String(row.className || "");
        // \b sınırı "unliveData" ile eşleşmez (n-l arasında sözcük sınırı yok),
        // bu yüzden ayrıca dışlamaya gerek kalmaz.
        const isLive = /\bliveData\b/.test(cls);
        const isFinished = /match-not-play|finished/.test(cls);
        const notStarted = /not-started/.test(cls);

        // Lig adı: maç listesi <ul class="classic-score">, lig başlığı onun
        // hemen ÖNCEKİ kardeşi. Başlığın kendi sınıfı derleme üretimi
        // (f23faf59...) olduğundan sınıfa değil yapıya bakılır.
        const ul = row.closest("ul.classic-score") || row.closest("ul");
        const league = txt(ul?.previousElementSibling);

        results.push({
          homeTeam,
          awayTeam,
          homeScore: notStarted ? null : hs || null,
          awayScore: notStarted ? null : as || null,
          status: isFinished ? "MS" : status,
          startTime: notStarted ? status : "",
          htScore: null,
          matchDate: "",
          homeCrest: null,
          awayCrest: null,
          homeRed: 0,
          awayRed: 0,
          isLive,
          isHT: status === "HT" || status === "DA",
          isFinished,
          compTitle: league || "",
          // Ülke lig adının içinde gömülü geliyor ("Brezilya Serie B"); sayfada
          // ayrı bir alan yok. Tarayıcı içinde çözemeyiz (bu fonksiyon sayfa
          // bağlamında çalışır, dış kapsama erişemez) — enrichNesine() dolduruyor.
          compCountry: "",
        });
      });

      return results;
    },
    "[data-test-id='ClassicMatchLine']"
  );

  return enrichNesine(rows);
}

// ─── Source 4: BBC Sport ──────────────────────────────────────────────────────

function fromBBC() {
  return scrapeWithBrowser(
    "https://www.bbc.com/sport/football/scores-fixtures",
    () => {
      const fixtures = document.querySelectorAll(".sp-c-fixture");
      const results  = [];
      fixtures.forEach(f => {
        const teams    = f.querySelectorAll(".sp-c-fixture__team-name-trunc, .sp-c-fixture__team-name");
        if (teams.length < 2) return;
        const homeTeam = teams[0]?.textContent?.trim() || "";
        const awayTeam = teams[1]?.textContent?.trim() || "";
        if (!homeTeam || !awayTeam) return;
        const scores   = f.querySelectorAll(".sp-c-fixture__number--score");
        const homeScore = scores[0]?.textContent?.trim() || null;
        const awayScore = scores[1]?.textContent?.trim() || null;
        const timeEl   = f.querySelector(".sp-c-fixture__number--time, .sp-c-fixture__status");
        const status   = timeEl?.textContent?.trim() || "—";
        const isLive   = f.classList.contains("sp-c-fixture--live") || /\d+'/.test(status);
        const sectionH = f.closest("[class*='fixture-group'], section")?.querySelector("h2, h3");
        results.push({
          homeTeam, awayTeam, homeScore, awayScore,
          status, startTime: "", htScore: null, matchDate: "",
          homeCrest: null, awayCrest: null, homeRed: 0, awayRed: 0,
          isLive, isHT: status === "HT", isFinished: status === "FT",
          compTitle: sectionH?.textContent?.trim() || "",
          compCountry: "England",
        });
      });
      return results;
    },
    ".sp-c-fixture"
  );
}

// ─── Source 5: Sky Sports ─────────────────────────────────────────────────────

function fromSkySports() {
  return scrapeWithBrowser(
    "https://www.skysports.com/football-scores-fixtures",
    () => {
      const rows    = document.querySelectorAll(".matches__item");
      const results = [];
      rows.forEach(row => {
        const homeTeam = row.querySelector(".matches__participant--side-one .matches__participant-name, [class*='home'] [class*='name']")?.textContent?.trim() || "";
        const awayTeam = row.querySelector(".matches__participant--side-two .matches__participant-name, [class*='away'] [class*='name']")?.textContent?.trim() || "";
        if (!homeTeam || !awayTeam) return;
        const homeScore = row.querySelector(".matches__teamscores-side--home, [class*='score-home']")?.textContent?.trim() || null;
        const awayScore = row.querySelector(".matches__teamscores-side--away, [class*='score-away']")?.textContent?.trim() || null;
        const status    = row.querySelector(".matches__status, .matches__date")?.textContent?.trim() || "—";
        results.push({
          homeTeam, awayTeam, homeScore, awayScore,
          status, startTime: "", htScore: null, matchDate: "",
          homeCrest: null, awayCrest: null, homeRed: 0, awayRed: 0,
          isLive: /\d+'/.test(status) || status === "HT",
          isHT: status === "HT", isFinished: status === "FT",
          compTitle: "", compCountry: "",
        });
      });
      return results;
    },
    null
  );
}

// ─── Source 6: Goal.com ───────────────────────────────────────────────────────

/**
 * Goal.com — Next.js gömülü JSON'undan okur (CSS seçici DEĞİL).
 *
 * Neden: eski sürüm `[class*='MatchRow']` gibi seçiciler kullanıyordu ve
 * hiç çalışmadı (0/13 deneme). Site derlenmiş/hash'li sınıf adları üretiyor,
 * bunlar her deploy'da değişir — seçiciyle scrape sürdürülemez.
 * `__NEXT_DATA__` ise sayfanın kendi veri sözleşmesi; çok daha kararlı.
 *
 * Yol: props.pageProps.content.liveScores[] → { competition, matches[] }
 * Maç: { teamA, teamB, score:{teamA,teamB}, status, period:{type,minute},
 *        redCards:{teamA,teamB}, startDate }
 * status: RESULT (bitti) · LIVE · FIXTURE (başlamadı) · POSTPONED · CANCELLED
 * Ölçüm (2026-07-25): 66 lig, 291 maç, 53 canlı.
 */
function fromGoal() {
  return scrapeWithBrowser(
    "https://www.goal.com/en/live-scores",
    () => {
      const el = document.getElementById("__NEXT_DATA__");
      if (!el) return [];
      let data;
      try { data = JSON.parse(el.textContent || "{}"); } catch { return []; }

      const groups = data?.props?.pageProps?.content?.liveScores;
      if (!Array.isArray(groups)) return [];

      const two = (n) => String(n).padStart(2, "0");
      const results = [];

      for (const g of groups) {
        const compTitle = g?.competition?.name || "";
        const compCountry = g?.competition?.area?.name || "";
        for (const m of g?.matches || []) {
          const homeTeam = m?.teamA?.name || m?.teamA?.full || m?.teamA?.short || "";
          const awayTeam = m?.teamB?.name || m?.teamB?.full || m?.teamB?.short || "";
          if (!homeTeam || !awayTeam) continue;

          const st = String(m?.status || "").toUpperCase();
          const isFinished = st === "RESULT";
          const isLive = st === "LIVE";
          const periodType = String(m?.period?.type || "").toUpperCase();
          const minute = m?.period?.minute;
          const isHT = isLive && periodType === "HALF_TIME";

          // Skor yalnızca başlamış maçlarda anlamlı
          const hasScore = m?.score && m.score.teamA != null && m.score.teamB != null;
          const homeScore = hasScore && !(st === "FIXTURE") ? String(m.score.teamA) : null;
          const awayScore = hasScore && !(st === "FIXTURE") ? String(m.score.teamB) : null;

          // matchDate — livescore-sync kickoff toleransı için "YYYY-MM-DD HH:mm"
          // bekler ve tüketiciler bu değeri İSTANBUL saati sayar (toIso +03:00
          // yapıştırır). Bu yüzden tarayıcının saat dilimi NE OLURSA OLSUN
          // Europe/Istanbul'a çevirerek üretilmeli. Eski kod d.getHours() ile
          // tarayıcı yerelini kullanıyordu: yerelde (TR) doğru çalışıp
          // Render'da (UTC) her maçı 3 saat erken gösteriyordu — akşam maçları
          // "başlamış" sayılıp elendi ve fikstüre TEK maç dönüşmedi.
          let matchDate = "";
          let startTime = "";
          if (m?.startDate) {
            const d = new Date(m.startDate);
            if (!isNaN(d)) {
              try {
                const p = new Intl.DateTimeFormat("en-CA", {
                  timeZone: "Europe/Istanbul",
                  year: "numeric", month: "2-digit", day: "2-digit",
                  hour: "2-digit", minute: "2-digit", hour12: false,
                }).formatToParts(d);
                const g = (t) => p.find((x) => x.type === t)?.value || "";
                // en-CA + hour12:false bazen "24:xx" üretir — 00'a çevir.
                const hh = g("hour") === "24" ? "00" : g("hour");
                startTime = `${hh}:${g("minute")}`;
                matchDate = `${g("year")}-${g("month")}-${g("day")} ${startTime}`;
              } catch {
                // Intl yoksa (olmamalı) eski davranışa düş — yanlış dilim,
                // hiç veri olmamasından iyidir.
                startTime = `${two(d.getHours())}:${two(d.getMinutes())}`;
                matchDate = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${startTime}`;
              }
            }
          }

          const statusText = isFinished
            ? "MS"
            : isHT
              ? "HT"
              : isLive && Number.isFinite(minute)
                ? `${minute}'`
                : startTime || st;

          results.push({
            homeTeam, awayTeam, homeScore, awayScore,
            status: statusText, startTime, htScore: null, matchDate,
            homeCrest: m?.teamA?.image?.url || null,
            awayCrest: m?.teamB?.image?.url || null,
            homeRed: Number(m?.redCards?.teamA || 0),
            awayRed: Number(m?.redCards?.teamB || 0),
            isLive, isHT, isFinished,
            compTitle, compCountry,
          });
        }
      }
      return results;
    },
    // Seçici beklemesi yok: veri HTML'in içinde gömülü, render beklemeye gerek yok
    null
  );
}

// ─── Source: ESPN (HTTP, tarayıcı YOK) ────────────────────────────────────────

/**
 * ESPN genel futbol skorboard'u — açık JSON ucu, anahtar/kayıt gerekmez.
 *
 * Neden değerli: Puppeteer'a hiç ihtiyaç duymaz. Diğer tüm kaynaklar tarayıcı
 * başlatıyor (2-15 sn + bellek); Chrome bulunamadığı veya çöktüğü senaryoda
 * hepsi birden düşer. Bu kaynak o ortak arıza noktasının dışında kalır.
 * Ölçüm (2026-07-25): 376ms, 100 maç.
 *
 * Yapı: events[].competitions[0].competitors[] → { homeAway, team, score }
 * status.type.name: STATUS_SCHEDULED · STATUS_IN_PROGRESS · STATUS_HALFTIME
 *                   STATUS_FULL_TIME · STATUS_FINAL_PEN · STATUS_POSTPONED
 *
 * Sınır: "all" ucu ~100 maçla sınırlı ve lig ADI dönmüyor (uid içinde sadece
 * sayısal lig kimliği var: s:600~l:19834~e:...). Skorlar doğru olduğu için
 * settle açısından sorun değil; lig adı yalnızca gruplama/görsel amaçlı.
 */
function fromESPN() {
  const URL_ALL = "https://site.api.espn.com/apis/site/v2/sports/soccer/all/scoreboard";

  return (async () => {
    const res = await fetch(URL_ALL, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`espn HTTP ${res.status}`);
    const data = await res.json();
    const events = Array.isArray(data?.events) ? data.events : [];

    const two = (n) => String(n).padStart(2, "0");
    const out = [];

    for (const ev of events) {
      const comp = ev?.competitions?.[0];
      if (!comp) continue;
      const home = (comp.competitors || []).find((c) => c.homeAway === "home");
      const away = (comp.competitors || []).find((c) => c.homeAway === "away");
      const homeTeam = home?.team?.displayName || home?.team?.name || "";
      const awayTeam = away?.team?.displayName || away?.team?.name || "";
      if (!homeTeam || !awayTeam) continue;

      const t = ev?.status?.type || {};
      const name = String(t.name || "").toUpperCase();
      const state = String(t.state || "").toLowerCase(); // pre | in | post
      const isFinished = state === "post" && t.completed !== false;
      const isLive = state === "in";
      const isHT = name === "STATUS_HALFTIME";
      const started = state !== "pre";

      const homeScore = started && home?.score != null ? String(home.score) : null;
      const awayScore = started && away?.score != null ? String(away.score) : null;

      let matchDate = "";
      let startTime = "";
      if (ev?.date) {
        const d = new Date(ev.date);
        if (!isNaN(d)) {
          // İstanbul saatiyle — getHours() Render'da UTC verir, maç 3 saat
          // erken görünürdü (bkz. toIstanbulMatchDate).
          ({ matchDate, startTime } = toIstanbulMatchDate(d));
        }
      }

      const clock = ev?.status?.displayClock || "";
      const status = isFinished ? "MS" : isHT ? "HT" : isLive ? clock || "CANLI" : startTime || "—";

      // uid: "s:600~l:19834~e:401886521" — lig adı yok, kimliği etiket olarak kullan
      const leagueId = String(ev?.uid || "").match(/~l:(\d+)/)?.[1] || "";

      out.push({
        homeTeam, awayTeam, homeScore, awayScore,
        status, startTime, htScore: null, matchDate,
        homeCrest: home?.team?.logo || null,
        awayCrest: away?.team?.logo || null,
        homeRed: 0, awayRed: 0,
        isLive, isHT, isFinished,
        compTitle: leagueId ? `ESPN ${leagueId}` : "",
        compCountry: "",
      });
    }
    return out;
  })();
}

// ─── Source 7: API-Football (HTTP, no browser) ────────────────────────────────

function fromApiFootball() {
  const key = process.env.AF_KEY;
  if (!key) return Promise.reject(new Error("AF_KEY not set"));

  return new Promise((resolve, reject) => {
    const https = require("https");
    const req = https.get(
      { hostname: "v3.football.api-sports.io", path: "/fixtures?live=all", headers: { "x-apisports-key": key } },
      (res) => {
        let raw = "";
        res.on("data", c => raw += c);
        res.on("end", () => {
          try {
            const json = JSON.parse(raw);
            if (json.errors && Object.keys(json.errors).length)
              return reject(new Error("api-football: " + JSON.stringify(json.errors)));
            const matches = (json.response || []).map(f => {
              const elapsed = f.fixture.status.elapsed;
              const short   = f.fixture.status.short;
              return {
                homeTeam:  f.teams.home.name,
                awayTeam:  f.teams.away.name,
                homeScore: f.goals.home !== null ? String(f.goals.home) : null,
                awayScore: f.goals.away !== null ? String(f.goals.away) : null,
                status:    elapsed ? `${elapsed}'` : short,
                startTime: (f.fixture.date || "").substring(11, 16),
                matchDate: (f.fixture.date || "").substring(0, 10),
                htScore:   f.score.halftime.home !== null ? `${f.score.halftime.home}-${f.score.halftime.away}` : null,
                homeCrest: f.teams.home.logo || null,
                awayCrest: f.teams.away.logo || null,
                homeRed: 0, awayRed: 0,
                isLive:    ["1H","HT","2H","ET","BT","P","SUSP","INT","LIVE"].includes(short),
                isHT:      short === "HT",
                isFinished: short === "FT",
                compTitle:   f.league.name,
                compCountry: f.league.country,
              };
            });
            resolve(matches);
          } catch (e) { reject(e); }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("api-football timeout")); });
  });
}

// ─── Source 8: TNT Sports ─────────────────────────────────────────────────────

function fromTNTSports() {
  return scrapeWithBrowser(
    "https://www.tntsports.co.uk/football/score-center.shtml",
    () => {
      // TNT/Discovery — score-center page, usually server-rendered
      const rows = document.querySelectorAll(
        ".match, .fixture, .event, [class*='scoreItem'], [class*='score-item'], [class*='match-row']"
      );
      const results = [];
      rows.forEach(row => {
        const homeTeam = row.querySelector("[class*='home'] [class*='team'], [class*='homeTeam'], [class*='home-team']")?.textContent?.trim()
          || row.querySelector("[class*='team']:first-child")?.textContent?.trim() || "";
        const awayTeam = row.querySelector("[class*='away'] [class*='team'], [class*='awayTeam'], [class*='away-team']")?.textContent?.trim()
          || row.querySelector("[class*='team']:last-child")?.textContent?.trim() || "";
        if (!homeTeam || !awayTeam || homeTeam === awayTeam) return;
        const homeScore = row.querySelector("[class*='homeScore'], [class*='home-score'], [class*='score']:first-of-type")?.textContent?.trim() || null;
        const awayScore = row.querySelector("[class*='awayScore'], [class*='away-score'], [class*='score']:last-of-type")?.textContent?.trim() || null;
        const status    = row.querySelector("[class*='status'], [class*='minute'], [class*='time'], [class*='clock']")?.textContent?.trim() || "—";
        const compEl    = row.closest("[class*='competition'], [class*='league'], [class*='tournament']")?.querySelector("[class*='name'], [class*='title'], h2, h3");
        results.push({
          homeTeam, awayTeam, homeScore, awayScore,
          status, startTime: "", htScore: null, matchDate: "",
          homeCrest: null, awayCrest: null, homeRed: 0, awayRed: 0,
          isLive: /\d+'/.test(status) || status === "HT",
          isHT: status === "HT", isFinished: ["FT","AET","PEN"].includes(status),
          compTitle:   compEl?.textContent?.trim() || "",
          compCountry: "",
        });
      });
      return results;
    },
    null
  );
}

// ─── Source 9: WSL Football ───────────────────────────────────────────────────
// Not: WSL = Women's Super League (İngiltere kadın futbolu).
// Türk ligleri için veri üretmez; genel kapsamı genişletmek için eklendi.

function fromWSLFootball() {
  return scrapeWithBrowser(
    "https://www.wslfootball.com/fixtures/index",
    () => {
      const rows = document.querySelectorAll(
        ".fixture-row, .match-row, .fixture, [class*='fixture'], [class*='match']"
      );
      const results = [];
      rows.forEach(row => {
        const teamEls  = row.querySelectorAll("[class*='team-name'], [class*='teamName'], [class*='club-name'], td.team");
        if (teamEls.length < 2) return;
        const homeTeam = teamEls[0]?.textContent?.trim() || "";
        const awayTeam = teamEls[1]?.textContent?.trim() || "";
        if (!homeTeam || !awayTeam) return;
        const scoreEls  = row.querySelectorAll("[class*='score'], td.score");
        const rawScore  = scoreEls[0]?.textContent?.trim() || "";
        const parts     = rawScore.split(/[-–]/);
        const homeScore = parts[0]?.trim() || null;
        const awayScore = parts[1]?.trim() || null;
        const status    = row.querySelector("[class*='status'], [class*='time'], td.time")?.textContent?.trim() || "—";
        results.push({
          homeTeam, awayTeam, homeScore, awayScore,
          status, startTime: "", htScore: null, matchDate: "",
          homeCrest: null, awayCrest: null, homeRed: 0, awayRed: 0,
          isLive: /\d+'/.test(status) || status === "HT",
          isHT: status === "HT", isFinished: status === "FT",
          compTitle: "Women's Super League", compCountry: "England",
        });
      });
      return results;
    },
    null
  );
}

// ─── Source 10: SoccersAPI livescore widget ───────────────────────────────────

/**
 * SoccersAPI — canlı skor widget'ı.
 *
 * ÖNCEKİ SÜRÜM YANLIŞ SAYFAYI KAZIYORDU: livescore.soccersapi.com/livescore-widget
 * widget'ın KURULUM sayfası ("Get Widget", "Fonts", "Colors" ayarları) — maç
 * verisi içermez. Bu yüzden hatasız ama hep 0 maç dönüyordu. Asıl veri
 * ls.soccersapi.com'daki widget önizlemesinde.
 *
 * Yeni ayrıştırıcı joker (`[class*='...']`) seçici kullanmaz; işaretlemedeki
 * data-* öznitelikleri okunur — bunlar sınıf adlarından çok daha kararlıdır
 * ve ülke/lig/durum bilgisini hazır verir.
 */
function fromSoccersAPI() {
  return scrapeWithBrowser(
    "https://ls.soccersapi.com/?w=w_preview",
    () => {
      const results = [];

      document.querySelectorAll(".match[data-match]").forEach((row) => {
        // Takım adı: kap içindeki metin (logo <img> metin üretmez).
        // İçerideki .events kutusu kart/gol ikonları taşır, metni ayıklanır.
        const teamName = (el) => {
          if (!el) return "";
          const clone = el.cloneNode(true);
          clone.querySelectorAll(".events").forEach((e) => e.remove());
          return (clone.textContent || "").replace(/\s+/g, " ").trim();
        };

        const homeEl = row.querySelector(".mteams .home");
        const awayEl = row.querySelector(".mteams .away");
        const homeTeam = teamName(homeEl);
        const awayTeam = teamName(awayEl);
        if (!homeTeam || !awayTeam) return;

        const hs = row.querySelector("[data-home-score]");
        const as = row.querySelector("[data-away-score]");
        const homeScore = hs ? hs.getAttribute("data-home-score") : null;
        const awayScore = as ? as.getAttribute("data-away-score") : null;

        // Durum rozeti: "NS" | "FT" | "HT" | "45'" ...
        const statusEl = row.querySelector(".status_info span");
        const status = (statusEl?.textContent || "").trim() || "—";

        // data-status-id kaynağın kendi kodu: 0=başlamadı, 1=oynanıyor, 3=bitti.
        // Metin yerine buna bakmak dil/biçim değişimlerine dayanıklı.
        const sid = String(row.getAttribute("data-status-id") || "");
        const isLive = sid === "1" || /^\d+['’]/.test(status) || status === "HT";
        const isFinished = sid === "3" || status === "FT";

        // data-datetime UTC'dir (11:00 → sayfada 14:00 TRT görünüyor).
        // İSTANBUL saatine çevrilir — "sunucu yerel saati" DEĞİL: tarayıcı
        // Render'da UTC dilimindedir ve getHours() maçı 3 saat erken
        // gösterirdi (goal'da yaşandı, tüm akşam maçları elendi).
        // Bu fonksiyon sayfa bağlamında çalıştığı için dış kapsamdaki
        // yardımcıya erişemez — Intl burada tekrarlanmak zorunda.
        const dtRaw = row.getAttribute("data-datetime") || "";
        let startTime = "";
        let matchDate = "";
        if (dtRaw) {
          const d = new Date(dtRaw.replace(" ", "T") + "Z");
          if (!isNaN(d.getTime())) {
            const p = new Intl.DateTimeFormat("en-CA", {
              timeZone: "Europe/Istanbul",
              year: "numeric", month: "2-digit", day: "2-digit",
              hour: "2-digit", minute: "2-digit", hour12: false,
            }).formatToParts(d);
            const g = (t) => p.find((x) => x.type === t)?.value || "";
            const hh = g("hour") === "24" ? "00" : g("hour");
            startTime = `${hh}:${g("minute")}`;
            matchDate = `${g("year")}-${g("month")}-${g("day")} ${startTime}`;
          }
        }

        // Canlı maçta .tm .time kickoff DEĞİL, oynanan dakikayı taşır.
        // Bu yüzden startTime her zaman data-datetime'dan türetilir; dakika
        // status alanına yazılır (goal/espn'deki "45'" / "CANLI" biçimi).
        const minuteRaw = row.querySelector(".tm .time")?.getAttribute("data-time") || "";
        const statusText = isFinished
          ? "MS"
          : status === "HT"
          ? "HT"
          : isLive
          ? (/^\d+$/.test(minuteRaw) ? `${minuteRaw}'` : status || "CANLI")
          : startTime || status;

        results.push({
          homeTeam,
          awayTeam,
          homeScore,
          awayScore,
          status: statusText,
          startTime,
          htScore: null,
          matchDate,
          homeCrest: homeEl?.querySelector("img")?.getAttribute("src") || null,
          awayCrest: awayEl?.querySelector("img")?.getAttribute("src") || null,
          homeRed: 0,
          awayRed: 0,
          isLive,
          isHT: status === "HT",
          isFinished,
          compTitle: row.getAttribute("data-league-name") || "",
          compCountry: row.getAttribute("data-country-name") || "",
        });
      });

      return results;
    },
    ".match[data-match]"
  );
}

// ─── Waterfall ────────────────────────────────────────────────────────────────

/**
 * Şelale sırası: ÇALIŞTIĞI DOĞRULANAN kaynaklar önce.
 *
 * Sıra önemli — şelale ilk başarılı kaynakta durur. Bir dönem goal.com 6.
 * sıradaydı ve önünde 4 bozuk kaynak vardı; mackolik düştüğünde her denemede
 * ~20 saniye boşa gidiyordu (ölçülen tam tur: 104 sn, hepsi başarısız).
 *
 * Durum (ölçüm: 2026-07-25, scripts/verify-livescore.cjs --probe):
 *   ✅ mackolik   666 maç / 3.0sn — birincil
 *   ✅ goal       291 maç / 2.7sn — __NEXT_DATA__ gömülü JSON, seçici yok
 *   ❌ bilyoner   URL'ler ölü (400/404) — site yeniden yapılandırılmış
 *   ❌ nesine     /canli 404; canlı bülten API'si skor taşımıyor (sadece oran)
 *   ❌ bbc        .sp-c-fixture kayboldu; site hash'li sınıf (ssrcss-*) üretiyor,
 *                 her deploy'da değişir. __INITIAL_DATA__ global'i var ama sayfa
 *                 çok ağır, domcontentloaded'da henüz dolmuyor.
 *   ❌ skysports  .matches__item eşleşmiyor
 *   ❌ tntsports  sayfa 30sn'de yüklenmiyor (reklam/consent yığını)
 *   ❌ wslfootball sadece kadınlar süper ligi — kapsam zaten dar
 *   ❌ soccersapi widget; /data uçları var ama canlı skor içermiyor
 *
 * Bozuk olanlar listede bırakıldı: ikisi de düşerse yine de denensin, ve
 * biri düzelirse --probe ile fark edilsin. Ama sona alındılar.
 */
const SOURCES = [
  // — doğrulanmış —
  { name: "mackolik",     fn: fromMackolik },   // en geniş kapsam
  { name: "goal",         fn: fromGoal },       // gömülü JSON
  { name: "espn",         fn: fromESPN },       // HTTP-only: Chrome gerekmez
  // — şu an veri döndürmüyor (yukarıdaki teşhislere bak) —
  { name: "bbc",          fn: fromBBC },
  { name: "skysports",    fn: fromSkySports },
  // bilyoner: API alan adı (sportsbookv2.bilyoner.com) artık DNS'te çözülmüyor —
  // "fetch failed", HTTP hatası bile alınmıyor. Kaynak ortadan kalkmış; şelalede
  // tutmak her turda boşuna bekleme demek. Yeni uç bulunursa geri açılabilir.
  // { name: "bilyoner",     fn: fromBilyoner },
  { name: "nesine",       fn: fromNesine },
  { name: "tntsports",    fn: fromTNTSports },
  { name: "wslfootball",  fn: fromWSLFootball },
  { name: "soccersapi",   fn: fromSoccersAPI },
  // api-football: hesap askıya alındı (dashboard.api-football.com "suspended").
  // Kırık fallback gereksiz deneme + log gürültüsü yaratıyordu; hesap düzelince
  // aşağıdaki satırı geri aç.
  // { name: "api-football", fn: fromApiFootball },
];

/**
 * Production'da denenmeyecek kaynaklar.
 *
 * mackolik yerelde en iyi kaynak (666 maç) ama Render'da sayfası
 * `domcontentloaded`'a 15 saniyede ulaşamıyor — yoklamada ölçüldü:
 * "Navigation timeout of 15000 ms exceeded". Şelalenin BAŞINDA olduğu için
 * her tur, ücretsiz katmanın kısa ömürlü kabı içinde, bir Chromium başlatma +
 * 15 saniyeyi kesin kayba harcıyordu. Servis çoğu turda SIGTERM ile
 * uyutulduğundan sıra ikinci kaynağa hiç gelmiyor, cache hiç yazılmıyordu.
 *
 * Yerelde dokunulmuyor: orada çalışıyor ve kapsamı en geniş olan o.
 */
const PROD_SKIP = new Set(["mackolik"]);

/** Ortama göre kaynak sırası. */
function orderedSources() {
  if (!IS_PROD) return SOURCES;
  const skipped = SOURCES.filter((s) => PROD_SKIP.has(s.name));
  // Tamamen çıkarmıyoruz: sona alınıyor ki site düzelirse yine yakalansın,
  // ama hızlı kaynaklar bir sonuç üretemezse diye.
  return SOURCES.filter((s) => !PROD_SKIP.has(s.name)).concat(skipped);
}

// ─── Main scrape ──────────────────────────────────────────────────────────────

async function scrape() {
  if (_scraping) { console.log("[livescore] skip, already scraping"); return _cache; }
  _scraping = true;

  console.log("[livescore] waterfall başlıyor...");
  const startMs = Date.now();
  const stats   = readStats();

  let rawMatches = null;
  let usedSource = null;

  for (const { name, fn } of orderedSources()) {
    try {
      console.log(`[livescore] ${name} deneniyor...`);
      const result = await fn();
      const ok = result && result.length > 0;
      recordAttempt(stats, name, ok);
      // HER denemeden sonra yaz. Eskiden yalnızca döngü bitince yazılıyordu ve
      // süreç ortada ölürse (Render ücretsiz katmanda SIGTERM ile uyutuluyor)
      // hiçbir iz kalmıyordu: tüm kaynaklar `attempts: 0` görünüyor, yani
      // "hiç denenmedi" ile "denendi ama yazamadan öldük" ayırt edilemiyordu.
      saveStats(stats);
      if (ok) {
        rawMatches = result;
        usedSource = name;
        console.log(`[livescore] ${name}: ${result.length} maç bulundu`);
        break;
      }
      console.log(`[livescore] ${name}: 0 maç — sonraki kaynak`);
    } catch (e) {
      recordAttempt(stats, name, false);
      saveStats(stats);
      console.warn(`[livescore] ${name} hata: ${e.message}`);
    }
  }

  checkAndWarnStats(stats); // düşük performanslı kaynakları logla

  if (!rawMatches) {
    console.error("[livescore] tüm kaynaklar başarısız, stale cache dönülüyor");
    _scraping = false;
    return _cache;
  }

  try {
    const leagueMap = {};
    for (const m of rawMatches) {
      const known  = matchLeague(m.compTitle, m.compCountry);
      const lid    = known?.id      ?? slugify((m.compTitle || "") + "-" + (m.compCountry || ""));
      const lname  = known?.name    ?? m.compTitle   ?? "Diğer";
      const lcountry = known?.country ?? m.compCountry ?? "";
      const match  = { ...m, league: lname, leagueId: lid, country: lcountry };
      delete match.compTitle;
      delete match.compCountry;
      if (!leagueMap[lid])
        leagueMap[lid] = { id: lid, name: lname, country: lcountry, known: !!known, matches: [] };
      leagueMap[lid].matches.push(match);
    }

    const result = {
      ts:                new Date().toISOString(),
      source:            usedSource,
      scrapeDurationMs:  Date.now() - startMs,
      leagues:           leagueMap,
      trackedMatchCount: Object.values(leagueMap).reduce((s, l) => s + l.matches.length, 0),
      totalMatchCount:   rawMatches.length,
    };

    _cache = result;
    writeCache(result);
    console.log(`[livescore] tamamlandı (${usedSource}) ${result.scrapeDurationMs}ms — ${result.trackedMatchCount}/${result.totalMatchCount} takip edilen`);
    return result;
  } catch (e) {
    console.error("[livescore] işlem hatası:", e.message);
    return _cache;
  } finally {
    _scraping = false;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

function getCache() {
  if (!_cache.ts) readCache();
  return _cache;
}

/**
 * Kaynak başarı istatistikleri.
 *
 * `suggestion` alanı "ELE" DEMİYOR — bkz. checkAndWarnStats: şelalede sırası
 * geç olan kaynak yalnızca öncekiler düştüğünde denenir, yani düşük oranı
 * bozukluk değil nadir-deneme göstergesi olabilir. Alan artık "İNCELE" diyor
 * ve şelaledeki sırayı da veriyor; karar --probe ölçümüyle verilmeli.
 */
function getStats() {
  const stats = readStats();
  const sira = new Map(orderedSources().map((s, i) => [s.name, i + 1]));
  const report = Object.entries(stats).map(([name, s]) => ({
    name,
    attempts: s.attempts,
    success:  s.success,
    rate:     s.attempts ? Math.round(s.success / s.attempts * 100) : null,
    lastSuccess: s.lastSuccess,
    waterfallPos: sira.get(name) ?? null,
    suggestion:
      s.attempts >= MIN_ATTEMPTS && s.success / s.attempts < WARN_RATE
        ? "INCELE"
        : "TUT",
  }));
  report.sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1));
  return report;
}

function start(intervalMs = 5 * 60 * 1000) {
  if (_interval) return;
  console.log(`[livescore] scraper başlatıldı, aralık=${intervalMs / 1000}s`);
  scrape();
  _interval = setInterval(scrape, intervalMs);
}

function stop() {
  if (_interval) { clearInterval(_interval); _interval = null; }
}

/**
 * Tek bir kaynağı izole test eder — şelaleyi çalıştırmadan.
 * Kaynak bozulduğunda hangi adımda kırıldığını görmek için gerekli
 * (kaynaklar sessizce 0 maç dönüp şelalede fark edilmeden eleniyordu).
 */
async function scrapeOne(name) {
  const s = SOURCES.find((x) => x.name === name);
  if (!s) {
    const list = SOURCES.map((x) => x.name).join(", ");
    throw new Error(`Bilinmeyen kaynak: ${name}. Mevcut: ${list}`);
  }
  const t0 = Date.now();
  const matches = await s.fn();
  return { name, ms: Date.now() - t0, count: Array.isArray(matches) ? matches.length : 0, matches };
}

module.exports = {
  scrape, getCache, getStats, start, stop, LEAGUES,
  scrapeOne, SOURCE_NAMES: SOURCES.map((s) => s.name),
  // Nesine zenginleştirmesi ağ olmadan sınanabilsin: ülke ayrıştırma ve gece
  // yarısı kayması, sessizce yanlış çalıştığında sıfır maçla sonuçlanan
  // türden hatalar — testle tutulmaları gerekiyor.
  enrichNesine, nesineCountryFromTitle, istanbulToday,
  // Saat dilimi dönüşümü testle tutulmalı: bozulması "yanlış saat" değil,
  // "akşam maçlarının tamamen kaybolması" olarak görünüyor.
  toIstanbulMatchDate,
};
