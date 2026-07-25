"use strict";
/**
 * preds.json TEKİLLEŞTİRME — aynı user + aynı fixture için tek kayıt bırakır.
 *
 * Kullanım:
 *   node scripts/dedupe-preds.cjs           → sadece rapor (DRY RUN, yazmaz)
 *   node scripts/dedupe-preds.cjs --apply   → yedek alıp temizler
 *
 * Neden gerekli: eski bot üretimi aynı user+fixture için birden fazla kayıt
 * bırakmış. scoreFixture her tahmin için satır ürettiğinden, tek settle'da
 * bile o kullanıcı N kere puanlanıyordu. (settle2 artık runtime'da da
 * tekilleştiriyor — bu script dosyayı kalıcı olarak temizler.)
 *
 * Hangi kayıt tutulur: `at`/`createdAt` en yeni olan. Zaman damgaları eşitse
 * dosyada SONRA gelen tutulur — pred/submit yeni kaydı dizinin sonuna eklediği
 * için "sonra gelen = daha yeni" doğru varsayımdır (settle2 ile aynı kural).
 */

const fs = require("fs");
const path = require("path");

const APPLY = process.argv.includes("--apply");

const DATA_DIR = path.join(__dirname, "..", "data");
const PREDS_FILE = path.join(DATA_DIR, "preds.json");

function ts(rec) {
  return new Date((rec && (rec.at || rec.createdAt)) || 0).getTime() || 0;
}

const line = (c = "=") => console.log(c.repeat(74));

line();
console.log(APPLY ? "PREDS TEKİLLEŞTİRME — UYGULAMA MODU" : "PREDS TEKİLLEŞTİRME — DRY RUN (dosya değişmez)");
line();

let raw;
try {
  raw = JSON.parse(fs.readFileSync(PREDS_FILE, "utf8"));
} catch (e) {
  console.error(`[!] preds.json okunamadi: ${e.message}`);
  process.exit(1);
}

const isWrapped = !Array.isArray(raw);
const list = Array.isArray(raw) ? raw : Array.isArray(raw.items) ? raw.items : null;

if (!list) {
  console.error("[!] preds.json beklenen formatta degil (dizi veya {items:[]} olmali)");
  process.exit(1);
}

console.log(`Toplam kayıt : ${list.length}`);
console.log(`Format       : ${isWrapped ? "{ items: [...] }" : "düz dizi"}`);
console.log();

// ── Grupla ─────────────────────────────────────────────────────────────────
const groups = new Map(); // key -> [{idx, rec}]
for (let i = 0; i < list.length; i++) {
  const rec = list[i];
  const fid = String((rec && rec.fixtureId) || "").trim();
  const uid = String((rec && (rec.userId || rec.user)) || "").trim().toLowerCase();
  if (!fid || !uid) continue;
  const k = `${fid}::${uid}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push({ idx: i, rec });
}

const dupGroups = [...groups.entries()].filter(([, arr]) => arr.length > 1);

if (!dupGroups.length) {
  console.log("✅ Mükerrer kayıt yok — temizlik gerekmiyor.");
  line();
  process.exit(0);
}

// ── Hangisi tutulacak? ─────────────────────────────────────────────────────
const keepIdx = new Set();
const dropIdx = new Set();

for (const [key, arr] of groups) {
  if (arr.length === 1) {
    keepIdx.add(arr[0].idx);
    continue;
  }
  // en yeni; eşitlikte dosyada sonra gelen (idx büyük)
  let winner = arr[0];
  for (const cand of arr.slice(1)) {
    const tc = ts(cand.rec);
    const tw = ts(winner.rec);
    if (tc > tw || (tc === tw && cand.idx > winner.idx)) winner = cand;
  }
  keepIdx.add(winner.idx);
  for (const x of arr) if (x.idx !== winner.idx) dropIdx.add(x.idx);
}

// ── Rapor ──────────────────────────────────────────────────────────────────
console.log(`Mükerrer grup   : ${dupGroups.length}`);
console.log(`Silinecek kayıt : ${dropIdx.size}`);
console.log(`Kalacak kayıt   : ${list.length - dropIdx.size}`);
console.log();

const fmt = (r) => {
  const h = r.home != null ? r.home : "-";
  const a = r.away != null ? r.away : "-";
  return `at=${r.at || r.createdAt || "YOK"}  oc=${r.outcome || "-"}  skor=${h}-${a}`;
};

console.log("Grup detayları:");
for (const [key, arr] of dupGroups) {
  console.log(`  ${key}  (${arr.length} kayıt)`);
  for (const { idx, rec } of arr) {
    const mark = dropIdx.has(idx) ? "  ✗ sil " : "  ✓ TUT ";
    console.log(`   ${mark} idx=${String(idx).padStart(4)}  ${fmt(rec)}`);
  }
}
console.log();

if (!APPLY) {
  line();
  console.log("DRY RUN — hiçbir şey yazılmadı.");
  console.log("Uygulamak için: node scripts/dedupe-preds.cjs --apply");
  line();
  process.exit(0);
}

// ── Uygula ─────────────────────────────────────────────────────────────────
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backup = path.join(DATA_DIR, `preds.backup-${stamp}.json`);

fs.copyFileSync(PREDS_FILE, backup);
console.log(`Yedek alındı : ${path.basename(backup)}`);

const cleaned = list.filter((_, i) => !dropIdx.has(i));
const out = isWrapped ? { ...raw, items: cleaned } : cleaned;

// Atomik yazma: geçici dosyaya yaz, sonra taşı
const tmp = PREDS_FILE + ".tmp";
fs.writeFileSync(tmp, JSON.stringify(out, null, 2), "utf8");
fs.renameSync(tmp, PREDS_FILE);
console.log(`Yazıldı      : preds.json (${cleaned.length} kayıt)`);
console.log();

// ── Doğrula ────────────────────────────────────────────────────────────────
const verifyRaw = JSON.parse(fs.readFileSync(PREDS_FILE, "utf8"));
const verifyList = Array.isArray(verifyRaw) ? verifyRaw : verifyRaw.items || [];
const seen = new Map();
for (const r of verifyList) {
  const fid = String((r && r.fixtureId) || "").trim();
  const uid = String((r && (r.userId || r.user)) || "").trim().toLowerCase();
  if (!fid || !uid) continue;
  const k = `${fid}::${uid}`;
  seen.set(k, (seen.get(k) || 0) + 1);
}
const stillDup = [...seen.values()].filter((n) => n > 1).length;

line();
if (stillDup === 0 && verifyList.length === cleaned.length) {
  console.log(`✅ DOĞRULANDI — ${dropIdx.size} mükerrer kayıt silindi, kalan mükerrer: 0`);
} else {
  console.log(`⚠ DOĞRULAMA SORUNU — kalan mükerrer grup: ${stillDup}, kayıt: ${verifyList.length}`);
  console.log(`  Yedek: ${backup}`);
}
line();
