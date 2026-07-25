"use strict";
/**
 * TEST FIXTURE TEMİZLİĞİ — fixtures.json'da bulunmayan fixture'lara ait
 * tahminleri (ve istenirse bayat live state dosyalarını) siler.
 *
 * Kullanım:
 *   node scripts/purge-test-fixtures.cjs              → rapor (DRY RUN)
 *   node scripts/purge-test-fixtures.cjs --apply      → yedek alıp siler
 *   node scripts/purge-test-fixtures.cjs --apply --with-state
 *       → ayrıca data/live/<id>.json bayat state dosyalarını da siler
 *
 * ÖLÇÜT: fixtures.json'da olmayan fixtureId. Gerekçe — yük testi ve demo
 * amaçlı üretilmiş fixture'lar (TEST- önekliler, 1000 botluk UCL / SL
 * denemeleri, yörüngeden düşmüş sayısal ID'ler) gerçek takvimde yer almaz.
 *
 * GÜVENLİK AĞI: gerçek Firebase UID'li (26-32 karakter alfanümerik) bir
 * kullanıcıya ait kayıt ASLA silinmez — ölçüt onu işaretlese bile atlanır ve
 * raporda gösterilir. Test verisi temizliği gerçek oyuncu geçmişini silmemeli.
 */

const fs = require("fs");
const path = require("path");

const APPLY = process.argv.includes("--apply");
const WITH_STATE = process.argv.includes("--with-state");

const DATA_DIR = path.join(__dirname, "..", "data");
const PREDS_FILE = path.join(DATA_DIR, "preds.json");
const FIXTURES_FILE = path.join(DATA_DIR, "fixtures.json");
const LIVE_DIR = path.join(DATA_DIR, "live");

const line = (c = "=") => console.log(c.repeat(76));
const isRealUid = (u) => /^[A-Za-z0-9]{26,32}$/.test(String(u || ""));

function readJson(f, fb) {
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fb; }
}

line();
console.log(APPLY ? "TEST FIXTURE TEMİZLİĞİ — UYGULAMA MODU" : "TEST FIXTURE TEMİZLİĞİ — DRY RUN (dosya değişmez)");
if (WITH_STATE) console.log("Mod: --with-state (bayat live state dosyaları da silinecek)");
line();

// ── Gerçek fixture kümesi ──────────────────────────────────────────────────
const fxRaw = readJson(FIXTURES_FILE, null);
const fxList = Array.isArray(fxRaw) ? fxRaw : (fxRaw && (fxRaw.fixtures || fxRaw.items)) || [];
const realFixtures = new Set(
  fxList.map((f) => String((f && (f.fixtureId || f.id)) || "").trim()).filter(Boolean)
);

if (!realFixtures.size) {
  console.error("[!] fixtures.json boş veya okunamadı — güvenlik gereği çıkılıyor.");
  console.error("    (Boş kümeyle her tahmin 'test' sayılır ve her şey silinir.)");
  process.exit(1);
}
console.log(`fixtures.json : ${realFixtures.size} gerçek fixture`);

// ── Tahminler ──────────────────────────────────────────────────────────────
const predsRaw = readJson(PREDS_FILE, null);
if (!predsRaw) { console.error("[!] preds.json okunamadı."); process.exit(1); }
const isWrapped = !Array.isArray(predsRaw);
const list = Array.isArray(predsRaw) ? predsRaw : predsRaw.items;
if (!Array.isArray(list)) { console.error("[!] preds.json beklenen formatta değil."); process.exit(1); }

console.log(`preds.json    : ${list.length} kayıt`);
console.log();

// ── Sınıflandır ────────────────────────────────────────────────────────────
const dropIdx = new Set();
const perFixture = new Map(); // fid -> { drop, keepReal, users:Set }
const protectedRows = [];

for (let i = 0; i < list.length; i++) {
  const rec = list[i];
  const fid = String((rec && rec.fixtureId) || "").trim();
  const uid = String((rec && (rec.userId || rec.user)) || "").trim();
  if (!perFixture.has(fid)) perFixture.set(fid, { drop: 0, keepReal: 0, users: new Set() });
  const g = perFixture.get(fid);
  g.users.add(uid);

  if (realFixtures.has(fid)) continue; // gerçek fixture → dokunma

  if (isRealUid(uid)) {
    // GÜVENLİK AĞI: gerçek kullanıcı kaydı silinmez
    g.keepReal++;
    protectedRows.push({ fid, uid });
    continue;
  }
  dropIdx.add(i);
  g.drop++;
}

// ── Rapor ──────────────────────────────────────────────────────────────────
const toPurge = [...perFixture.entries()].filter(([fid]) => fid && !realFixtures.has(fid));
const toKeep = [...perFixture.entries()].filter(([fid]) => realFixtures.has(fid));

console.log("── SİLİNECEK (fixtures.json'da yok) ──");
if (!toPurge.length) {
  console.log("   ✅ Temizlenecek test fixture yok.");
} else {
  console.log("   fixtureId".padEnd(30) + "sil".padStart(6) + "korunan".padStart(9) + "  kullanıcılar");
  for (const [fid, g] of toPurge.sort((a, b) => b[1].drop - a[1].drop)) {
    const users = [...g.users].slice(0, 3).join(",") + (g.users.size > 3 ? `,+${g.users.size - 3}` : "");
    console.log("   " + fid.padEnd(30) + String(g.drop).padStart(6) + String(g.keepReal).padStart(9) + "  " + users);
  }
}
console.log();

console.log("── KORUNACAK (gerçek fixture) ──");
for (const [fid, g] of toKeep) {
  const users = [...g.users].join(",");
  console.log("   " + fid.padEnd(30) + String(g.users.size).padStart(4) + " kayıt  " + users);
}
console.log();

if (protectedRows.length) {
  console.log("── ⚠ GÜVENLİK AĞI DEVREDE ──");
  console.log(`   ${protectedRows.length} kayıt gerçek Firebase UID'e ait, ölçüt işaretledi ama SİLİNMEYECEK:`);
  for (const r of protectedRows.slice(0, 10)) console.log(`     ${r.fid}  ←  ${r.uid}`);
  console.log();
}

// ── Bayat live state dosyaları ─────────────────────────────────────────────
let staleStates = [];
try {
  staleStates = fs
    .readdirSync(LIVE_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .filter((id) => !realFixtures.has(id) && perFixture.has(id));
} catch {}

if (staleStates.length) {
  console.log("── BAYAT LIVE STATE ──");
  console.log(`   ${staleStates.length} dosya test fixture'a ait: ${staleStates.join(", ")}`);
  console.log(`   ${WITH_STATE ? "--with-state verildi → silinecek" : "silmek için --with-state ekle"}`);
  console.log();
}

console.log("── ÖZET ──");
console.log(`   silinecek kayıt : ${dropIdx.size}`);
console.log(`   kalacak kayıt   : ${list.length} → ${list.length - dropIdx.size}`);
console.log(`   korunan (gerçek UID) : ${protectedRows.length}`);
console.log();

if (!dropIdx.size && !(WITH_STATE && staleStates.length)) {
  line();
  console.log("Yapılacak bir şey yok.");
  line();
  process.exit(0);
}

if (!APPLY) {
  line();
  console.log("DRY RUN — hiçbir şey yazılmadı.");
  console.log("Uygulamak için : node scripts/purge-test-fixtures.cjs --apply");
  console.log("State ile      : node scripts/purge-test-fixtures.cjs --apply --with-state");
  line();
  process.exit(0);
}

// ── Uygula ─────────────────────────────────────────────────────────────────
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backup = path.join(DATA_DIR, `preds.backup-${stamp}.json`);
fs.copyFileSync(PREDS_FILE, backup);
console.log(`Yedek : ${path.basename(backup)}`);

const cleaned = list.filter((_, i) => !dropIdx.has(i));
const out = isWrapped ? { ...predsRaw, items: cleaned } : cleaned;
const tmp = PREDS_FILE + ".tmp";
fs.writeFileSync(tmp, JSON.stringify(out, null, 2), "utf8");
fs.renameSync(tmp, PREDS_FILE);
console.log(`Yazıldı: preds.json (${cleaned.length} kayıt)`);

let statesRemoved = 0;
if (WITH_STATE && staleStates.length) {
  const stateBackupDir = path.join(DATA_DIR, `live-backup-${stamp}`);
  fs.mkdirSync(stateBackupDir, { recursive: true });
  for (const id of staleStates) {
    const src = path.join(LIVE_DIR, `${id}.json`);
    try {
      fs.copyFileSync(src, path.join(stateBackupDir, `${id}.json`));
      fs.unlinkSync(src);
      statesRemoved++;
    } catch (e) {
      console.error(`  [!] ${id}.json silinemedi: ${e.message}`);
    }
  }
  console.log(`Yedek : ${path.basename(stateBackupDir)}/ (${statesRemoved} state dosyası)`);
  console.log(`Silindi: ${statesRemoved} bayat live state`);
}
console.log();

// ── Doğrula ────────────────────────────────────────────────────────────────
const vRaw = readJson(PREDS_FILE, null);
const vList = Array.isArray(vRaw) ? vRaw : (vRaw && vRaw.items) || [];
const leftover = vList.filter((r) => {
  const fid = String((r && r.fixtureId) || "").trim();
  const uid = String((r && (r.userId || r.user)) || "").trim();
  return fid && !realFixtures.has(fid) && !isRealUid(uid);
});
const realUidRows = vList.filter((r) => isRealUid((r && (r.userId || r.user)) || ""));

line();
if (!leftover.length && vList.length === cleaned.length) {
  console.log(`✅ DOĞRULANDI — ${dropIdx.size} kayıt silindi, kalan ${vList.length}`);
  console.log(`   test fixture kaydı: 0 · gerçek kullanıcı kaydı korundu: ${realUidRows.length}`);
  if (WITH_STATE) console.log(`   bayat live state silindi: ${statesRemoved}`);
} else {
  console.log("⚠ DOĞRULAMA SORUNU:");
  console.log(`   kalan test kaydı: ${leftover.length} · beklenen ${cleaned.length}, bulunan ${vList.length}`);
  console.log(`   Yedek: ${backup}`);
}
line();
