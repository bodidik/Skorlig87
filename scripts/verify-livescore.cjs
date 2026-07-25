"use strict";
/**
 * CANLI SKOR BORU HATTI DOĞRULAMA — salt okunur.
 *
 *   node scripts/verify-livescore.cjs            → scrape + tüm kontroller
 *   node scripts/verify-livescore.cjs --no-fetch → sadece önbellekten (hızlı)
 *
 * Kontroller:
 *   1) Kaynak şelalesi — hangi site çalışıyor, kaç yedek gerçekten sağlam
 *   2) Takım adı normalizasyonu — farklı takımlar aynı anahtara düşüyor mu
 *      (bu hata sessizce YANLIŞ skoru fixture'a yazdırır → yanlış settle)
 *   3) Fixture eşleştirme — takvimimizdeki maçlar canlı veride bulunuyor mu
 *   4) Otomatik settle zinciri — FT tespiti ve tetikleme koşulları
 */

const fs = require("fs");
const path = require("path");

const NO_FETCH = process.argv.includes("--no-fetch");

const API_DIR = path.join(__dirname, "..");
// server.cjs ile aynı env'i gör — yoksa SKORLIG_* anahtarları yanlış raporlanır
try { require("dotenv").config({ path: path.join(API_DIR, ".env") }); } catch {}

const DATA_DIR = path.join(API_DIR, "data");
const scraper = require(path.join(API_DIR, "services/livescore-scraper.cjs"));
const { normalizeTeam, TEAM_MAP } = require(path.join(API_DIR, "services/livescore-sync.cjs"));

const line = (c = "=") => console.log(c.repeat(78));
const readJson = (f, fb) => {
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fb; }
};

let problems = 0;

(async () => {
  line();
  console.log("CANLI SKOR BORU HATTI DOĞRULAMA");
  line();

  // ── 1) Kaynak şelalesi ───────────────────────────────────────────────────
  if (!NO_FETCH) {
    const t0 = Date.now();
    try {
      await scraper.scrape();
      console.log(`scrape süresi: ${Date.now() - t0}ms`);
    } catch (e) {
      console.error(`[!] scrape hatası: ${e.message}`);
    }
  }

  const cache = scraper.getCache() || {};
  const allLive = [];
  for (const lg of Object.values(cache.leagues || {})) {
    if (lg.matches) allLive.push(...lg.matches);
  }

  console.log(`aktif kaynak : ${cache.source || "(yok)"}`);
  console.log(`çekilen maç  : ${allLive.length}`);
  console.log();

  console.log("── 1) Kaynak şelalesi sağlamlığı ──");
  const stats = scraper.getStats();
  const rows = Array.isArray(stats) ? stats : stats.sources || stats.items || [];
  let working = 0;
  for (const s of rows) {
    const ok = Number(s.success || 0) > 0;
    if (ok) working++;
    console.log(
      `   ${ok ? "✅" : "❌"} ${String(s.name).padEnd(14)}` +
      `deneme ${String(s.attempts).padStart(4)}  başarı ${String(s.success).padStart(4)}` +
      `  oran ${String(s.rate).padStart(4)}%  son: ${s.lastSuccess || "HİÇ"}`
    );
  }
  console.log();
  if (working <= 1) {
    problems++;
    console.log(`   ⚠ TEK NOKTA ARIZASI: sadece ${working} kaynak çalışıyor.`);
    console.log("     Bu kaynak bloklanırsa/HTML değişirse tüm puanlama durur.");
  } else {
    console.log(`   ✅ ${working} kaynak çalışıyor — yedek var.`);
  }
  console.log();

  // ── 2) Takım adı normalizasyonu ──────────────────────────────────────────
  console.log("── 2) Takım adı normalizasyonu (çakışma = yanlış skor riski) ──");
  const teams = new Set();
  for (const m of allLive) { teams.add(m.homeTeam); teams.add(m.awayTeam); }

  const byKey = new Map();
  for (const t of teams) {
    const k = normalizeTeam(t);
    if (!byKey.has(k)) byKey.set(k, new Set());
    byKey.get(k).add(t);
  }

  // Sadece diakritik/noktalama farkı olan çakışmalar MEŞRUDUR:
  // "Atletico" ile "Atlético" aynı takım — birleşmeleri istenen davranış.
  const asciiFold = (s) =>
    String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");

  const allCollisions = [...byKey.entries()].filter(([, set]) => set.size > 1);
  const benign = [];
  const harmful = [];
  for (const entry of allCollisions) {
    const folded = new Set([...entry[1]].map(asciiFold));
    (folded.size === 1 ? benign : harmful).push(entry);
  }

  console.log(`   tekil takım: ${teams.size} · tekil anahtar: ${byKey.size}`);
  if (benign.length) {
    console.log(`   ℹ ${benign.length} meşru birleşme (sadece yazım/diakritik farkı):`);
    for (const [k, set] of benign.slice(0, 5)) {
      console.log(`     "${k}" <- ${[...set].map((x) => `"${x}"`).join(", ")}`);
    }
  }
  if (!harmful.length) {
    console.log("   ✅ Zararlı çakışma yok — farklı takımlar farklı anahtarlarda.");
  } else {
    problems++;
    console.log(`   ⚠ ${harmful.length} anahtarı FARKLI takımlar paylaşıyor:`);
    for (const [k, set] of harmful.slice(0, 15)) {
      console.log(`     "${k}" <- ${[...set].map((x) => `"${x}"`).join(", ")}`);
    }
    if (harmful.length > 15) console.log(`     … +${harmful.length - 15}`);
    console.log("     Bunlar 45dk kickoff toleransı içinde birbirinin skorunu alabilir.");
  }
  console.log();

  // TEAM_MAP kısa alias denetimi (substring hatasının kaynağıydı)
  const shortAliases = [];
  for (const [c, vars] of Object.entries(TEAM_MAP || {})) {
    for (const v of vars) if (String(v).length <= 3) shortAliases.push(`${v} → ${c}`);
  }
  if (shortAliases.length) {
    console.log(`   ℹ TEAM_MAP'te ${shortAliases.length} kısa alias var: ${shortAliases.join(", ")}`);
    console.log("     Tam eşitlik kullanıldığı sürece güvenli (substring eşleşme YOK).");
    console.log();
  }

  // ── 3) Fixture eşleştirme ────────────────────────────────────────────────
  console.log("── 3) Fixture eşleştirme ──");
  const fxRaw = readJson(path.join(DATA_DIR, "fixtures.json"), null);
  const fixtures = Array.isArray(fxRaw) ? fxRaw : (fxRaw && (fxRaw.fixtures || fxRaw.items)) || [];
  const today = new Date().toISOString().slice(0, 10);

  const relevant = fixtures.filter((f) => {
    const d = String(f.kickoffISO || f.kickoffDate || "").slice(0, 10);
    return d >= today;
  });

  console.log(`   fixtures.json: ${fixtures.length} maç · bugün/sonrası: ${relevant.length}`);
  if (!relevant.length) {
    problems++;
    console.log("   ⚠ Bugün veya sonrası için maç YOK — otomatik skor girecek bir şey yok.");
    console.log("     fixtures.json'ı yalnızca admin endpoint'i yazıyor; otomatik");
    console.log("     maç ekleme yok. Takvim elle güncellenmezse sistem boşa çalışır.");
  } else {
    let hit = 0;
    for (const f of relevant) {
      const fh = normalizeTeam(f.home);
      const fa = normalizeTeam(f.away);
      const m = allLive.find((x) => normalizeTeam(x.homeTeam) === fh && normalizeTeam(x.awayTeam) === fa);
      const mark = m ? "✅" : "❌";
      const score = m && m.homeScore != null ? `${m.homeScore}-${m.awayScore}` : "—";
      const st = m ? (m.isFinished ? "FT" : m.isLive ? "CANLI" : "başlamadı") : "";
      console.log(`   ${mark} ${String(f.fixtureId).padEnd(26)} ${(f.home + " - " + f.away).padEnd(36)} ${score.padStart(5)} ${st}`);
      if (m) hit++;
    }
    console.log();
    if (hit < relevant.length) {
      problems++;
      console.log(`   ⚠ ${relevant.length - hit}/${relevant.length} maç canlı veride bulunamadı.`);
      console.log("     Sebep: takım adı TEAM_MAP'te yok veya kaynak o ligi taşımıyor.");
    } else {
      console.log(`   ✅ ${hit}/${relevant.length} maç eşleşti.`);
    }
  }
  console.log();

  // ── 4) Otomatik settle zinciri ───────────────────────────────────────────
  console.log("── 4) Otomatik settle zinciri ──");
  const envOff = (k) => process.env[k] === "0";
  console.log(`   livescore-scraper : ${envOff("SKORLIG_LIVESCORE") ? "KAPALI (SKORLIG_LIVESCORE=0)" : "açık, 2dk aralık"}`);
  console.log(`   livescore-sync    : ${envOff("SKORLIG_SYNC") ? "KAPALI (SKORLIG_SYNC=0)" : "açık, 30sn aralık"}`);
  console.log(`   af-sync           : ${envOff("SKORLIG_AF_SYNC") ? "KAPALI (SKORLIG_AF_SYNC=0)" : "açık"}`);
  if (envOff("SKORLIG_SYNC") || envOff("SKORLIG_LIVESCORE")) {
    problems++;
    console.log("   ⚠ Zincirin bir halkası kapalı — otomatik skor/settle çalışmaz.");
  }

  const book = readJson(path.join(DATA_DIR, "match-results.json"), { items: [] });
  const snaps = Array.isArray(book) ? book : book.items || [];
  const awarded = snaps.filter((s) => s && s.awardedAt).length;
  console.log(`   settle geçmişi    : ${snaps.length} snapshot, ${awarded} tanesi awardedAt korumalı`);
  console.log("   FT tespiti        : scraper isFinished → writeResultsEntry + settle tetiklenir");
  console.log("   çift-settle koruması: match-results awardedAt + _settledThisSession");
  console.log();

  line();
  console.log(problems === 0 ? "SONUÇ: ✅ Boru hattı sağlam." : `SONUÇ: ⚠ ${problems} başlıkta bulgu var (yukarıda).`);
  line();
  process.exit(0);
})();
