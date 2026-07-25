"use strict";
/**
 * SEZON SIFIRLAMA — totals.json (ve türevi leaderboard.json) sıfırlanır.
 *
 * Kullanım:
 *   node scripts/reset-totals.cjs              → rapor (DRY RUN, yazmaz)
 *   node scripts/reset-totals.cjs --apply      → yedek alıp sıfırlar
 *   node scripts/reset-totals.cjs --apply --keep-humans
 *       → botları siler, gerçek kullanıcıları korur
 *
 * DOKUNMADIĞI dosyalar (bilerek):
 *   lc-wallet.json  — LC ekonomisi ayrı; puan sıfırlaması cüzdanı silmez
 *   match-results.json — maç geçmişi/denetim izi korunur
 *   preds.json      — tahmin geçmişi korunur
 *
 * NOT: 1000 aktif bot HER maça tahmin verir, insan ise birkaç maça. Kümülatif
 * puanda botlar kaçınılmaz olarak öne geçer — sıfırlama sorunu erteler, çözmez.
 * Kalıcı çözüm için ya botlar totals'a hiç yazılmamalı ya da tablo ortalama
 * puana göre sıralanmalı.
 */

const fs = require("fs");
const path = require("path");
const { isBot } = require("../lib/botIds.cjs");

const APPLY = process.argv.includes("--apply");
const KEEP_HUMANS = process.argv.includes("--keep-humans");

const DATA_DIR = path.join(__dirname, "..", "data");
const TOTALS_FILE = path.join(DATA_DIR, "totals.json");
const LEADERBOARD_FILE = path.join(DATA_DIR, "leaderboard.json");

const TEST_IDS = new Set(["demo1", "demo2", "dz", "demo_admin", "admin", "dev"]);
const line = (c = "=") => console.log(c.repeat(74));

function readJson(f, fb) {
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fb; }
}

line();
console.log(APPLY ? "SEZON SIFIRLAMA — UYGULAMA MODU" : "SEZON SIFIRLAMA — DRY RUN (dosya değişmez)");
if (KEEP_HUMANS) console.log("Mod: --keep-humans (gerçek kullanıcılar korunacak)");
line();

const totals = readJson(TOTALS_FILE, { items: [], updatedAt: null });
const rows = Array.isArray(totals.items) ? totals.items : [];

// ── Sınıflandır ────────────────────────────────────────────────────────────
const cat = { bot: [], test: [], human: [] };
for (const r of rows) {
  const uid = String(r.userId || "");
  if (isBot(uid)) cat.bot.push(r);
  else if (TEST_IDS.has(uid.toLowerCase())) cat.test.push(r);
  else cat.human.push(r);
}

const sumPts = (a) => a.reduce((s, r) => s + Number(r.totalPoints || 0), 0);

console.log(`Mevcut totals.json : ${rows.length} kayıt`);
console.log(`  bot              : ${String(cat.bot.length).padStart(5)}  (toplam ${sumPts(cat.bot)} puan)`);
console.log(`  test hesabı      : ${String(cat.test.length).padStart(5)}  (toplam ${sumPts(cat.test)} puan)`);
console.log(`  gerçek kullanıcı : ${String(cat.human.length).padStart(5)}  (toplam ${sumPts(cat.human)} puan)`);
console.log();

const kept = KEEP_HUMANS ? cat.human : [];
console.log(`Sonuç: ${rows.length} kayıt → ${kept.length} kayıt (${rows.length - kept.length} silinecek)`);

if (KEEP_HUMANS && cat.human.length) {
  console.log();
  console.log("Korunacak kullanıcılar:");
  for (const r of cat.human.slice(0, 20)) {
    console.log(`  ${String(r.userId).padEnd(30)} puan: ${String(r.totalPoints).padStart(6)}  maç: ${r.matches}`);
  }
  if (cat.human.length > 20) console.log(`  … ve ${cat.human.length - 20} tane daha`);
}
console.log();

if (!APPLY) {
  line();
  console.log("DRY RUN — hiçbir şey yazılmadı.");
  console.log("Uygulamak için : node scripts/reset-totals.cjs --apply");
  console.log("İnsanları tut  : node scripts/reset-totals.cjs --apply --keep-humans");
  line();
  process.exit(0);
}

// ── Uygula ─────────────────────────────────────────────────────────────────
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const nowISO = new Date().toISOString();

function writeAtomic(file, obj) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

// totals.json
const totalsBackup = path.join(DATA_DIR, `totals.backup-${stamp}.json`);
fs.copyFileSync(TOTALS_FILE, totalsBackup);
console.log(`Yedek : ${path.basename(totalsBackup)}`);
writeAtomic(TOTALS_FILE, { items: kept, updatedAt: nowISO, resetAt: nowISO });
console.log(`Yazıldı: totals.json (${kept.length} kayıt)`);

// leaderboard.json (totals'ın türevi — tutarlı kalsın)
if (fs.existsSync(LEADERBOARD_FILE)) {
  const lb = readJson(LEADERBOARD_FILE, { items: [] });
  const lbRows = Array.isArray(lb.items) ? lb.items : [];
  if (lbRows.length) {
    const lbBackup = path.join(DATA_DIR, `leaderboard.backup-${stamp}.json`);
    fs.copyFileSync(LEADERBOARD_FILE, lbBackup);
    console.log(`Yedek : ${path.basename(lbBackup)}`);
  }
  writeAtomic(LEADERBOARD_FILE, { items: [], updatedAt: nowISO });
  console.log(`Yazıldı: leaderboard.json (0 kayıt)`);
}
console.log();

// ── Doğrula ────────────────────────────────────────────────────────────────
const v = readJson(TOTALS_FILE, null);
const vRows = v && Array.isArray(v.items) ? v.items : null;
line();
if (vRows && vRows.length === kept.length) {
  console.log(`✅ DOĞRULANDI — totals.json ${vRows.length} kayıt, resetAt=${v.resetAt}`);
  console.log("   Botlar yeni maçlar settle oldukça tekrar puan biriktirecek.");
  console.log("   Dokunulmadı: lc-wallet.json, preds.json, match-results.json");
} else {
  console.log(`⚠ DOĞRULAMA SORUNU — beklenen ${kept.length}, bulunan ${vRows ? vRows.length : "okunamadı"}`);
  console.log(`  Yedek: ${totalsBackup}`);
}
line();
