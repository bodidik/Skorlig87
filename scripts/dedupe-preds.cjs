"use strict";
/**
 * preds.json TEMİZLİĞİ — iki geçiş:
 *
 *   GEÇİŞ 1: geçersiz fixtureId'li kayıtlar silinir.
 *     Bir betiğin yorum satırı fixtureId argümanı olarak geçmiş ve dosyaya
 *     1000 kayıt yazılmış ("# SkorLig: tek maç için bot üret ..."). Hiçbir
 *     maçla eşleşmez; puanlamayı etkilemez ama sayıları kirletir.
 *
 *   GEÇİŞ 2: aynı user + aynı fixture için tek kayıt bırakılır.
 *     Eski bot üretimi mükerrer kayıt bırakmış. scoreFixture her tahmin için
 *     satır ürettiğinden tek settle'da bile o kullanıcı N kere puanlanıyordu.
 *     (settle2 artık runtime'da da tekilleştiriyor — bu script dosyayı kalıcı
 *     olarak temizler.)
 *
 *     Hangi kayıt tutulur: `at`/`createdAt` en yeni olan. Zaman damgaları
 *     eşitse dosyada SONRA gelen — pred/submit yeni kaydı dizinin sonuna
 *     eklediği için doğru varsayım (settle2 ile aynı kural).
 *
 * Kullanım:
 *   node scripts/dedupe-preds.cjs           → sadece rapor (DRY RUN, yazmaz)
 *   node scripts/dedupe-preds.cjs --apply   → yedek alıp temizler
 */

const fs = require("fs");
const path = require("path");

const APPLY = process.argv.includes("--apply");

const DATA_DIR = path.join(__dirname, "..", "data");
const PREDS_FILE = path.join(DATA_DIR, "preds.json");

function ts(rec) {
  return new Date((rec && (rec.at || rec.createdAt)) || 0).getTime() || 0;
}

/**
 * Geçerli fixtureId: boş olmayan, boşluk/'#' içermeyen, aşırı uzun olmayan slug.
 * Gerçek örnekler: "1394548", "GS-2026-01-05-TS", "UCL-GS-USG-20251125"
 * Bilinen bozuk : bir betiğin yorum satırı (boşluk + '#' içeriyor, 40+ karakter)
 */
function invalidReason(rec) {
  const raw = rec == null ? null : rec.fixtureId;
  if (raw == null || String(raw).trim() === "") return "fixtureId boş";
  const f = String(raw);
  if (/\s/.test(f)) return "fixtureId boşluk içeriyor";
  if (f.includes("#")) return "fixtureId '#' içeriyor";
  if (f.length > 40) return `fixtureId aşırı uzun (${f.length} karakter)`;
  const uid = String((rec.userId || rec.user) || "").trim();
  if (!uid) return "userId boş";
  return null;
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

const dropIdx = new Set();

// ── GEÇİŞ 1: geçersiz kayıtlar ─────────────────────────────────────────────
console.log("── GEÇİŞ 1: geçersiz fixtureId / userId ──");
const invalidByReason = new Map(); // sebep -> { count, samples:Set(fixtureId) }
for (let i = 0; i < list.length; i++) {
  const reason = invalidReason(list[i]);
  if (!reason) continue;
  dropIdx.add(i);
  if (!invalidByReason.has(reason)) invalidByReason.set(reason, { count: 0, samples: new Set() });
  const g = invalidByReason.get(reason);
  g.count++;
  if (g.samples.size < 3) g.samples.add(String(list[i] && list[i].fixtureId).slice(0, 60));
}

if (!invalidByReason.size) {
  console.log("   ✅ Geçersiz kayıt yok.");
} else {
  for (const [reason, g] of invalidByReason) {
    console.log(`   ✗ ${String(g.count).padStart(5)} kayıt — ${reason}`);
    for (const s of g.samples) console.log(`        örnek: ${JSON.stringify(s)}`);
  }
}
console.log();

// ── GEÇİŞ 2: mükerrer kayıtlar (geçersizler hariç) ─────────────────────────
console.log("── GEÇİŞ 2: mükerrer user + fixture ──");
const groups = new Map(); // key -> [{idx, rec}]
for (let i = 0; i < list.length; i++) {
  if (dropIdx.has(i)) continue; // geçersizler zaten silinecek
  const rec = list[i];
  const fid = String((rec && rec.fixtureId) || "").trim();
  const uid = String((rec && (rec.userId || rec.user)) || "").trim().toLowerCase();
  const k = `${fid}::${uid}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push({ idx: i, rec });
}

const dupGroups = [...groups.entries()].filter(([, arr]) => arr.length > 1);

if (!dupGroups.length && !invalidByReason.size) {
  console.log("   ✅ Mükerrer kayıt yok.");
  console.log();
  line();
  console.log("✅ Dosya temiz — yapılacak bir şey yok.");
  line();
  process.exit(0);
}

// ── Mükerrerlerde hangisi tutulacak? ───────────────────────────────────────
const keepIdx = new Set();

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

const fmt = (r) => {
  const h = r.home != null ? r.home : "-";
  const a = r.away != null ? r.away : "-";
  return `at=${r.at || r.createdAt || "YOK"}  oc=${r.outcome || "-"}  skor=${h}-${a}`;
};

if (dupGroups.length) {
  console.log(`   ${dupGroups.length} mükerrer grup:`);
  for (const [key, arr] of dupGroups) {
    console.log(`   ${key}  (${arr.length} kayıt)`);
    for (const { idx, rec } of arr) {
      const mark = dropIdx.has(idx) ? "  ✗ sil " : "  ✓ TUT ";
      console.log(`    ${mark} idx=${String(idx).padStart(4)}  ${fmt(rec)}`);
    }
  }
} else {
  console.log("   ✅ Mükerrer kayıt yok.");
}
console.log();

// ── Özet ───────────────────────────────────────────────────────────────────
const invalidCount = [...invalidByReason.values()].reduce((s, g) => s + g.count, 0);
const dupCount = dropIdx.size - invalidCount;
console.log("── ÖZET ──");
console.log(`   geçersiz kayıt   : ${invalidCount}`);
console.log(`   mükerrer kayıt   : ${dupCount}`);
console.log(`   toplam silinecek : ${dropIdx.size}`);
console.log(`   kalacak kayıt    : ${list.length} → ${list.length - dropIdx.size}`);
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
const stillInvalid = verifyList.filter((r) => invalidReason(r) !== null).length;

line();
if (stillDup === 0 && stillInvalid === 0 && verifyList.length === cleaned.length) {
  console.log(`✅ DOĞRULANDI — ${dropIdx.size} kayıt silindi (${invalidCount} geçersiz + ${dupCount} mükerrer)`);
  console.log(`   kalan geçersiz: 0 · kalan mükerrer: 0 · toplam kayıt: ${verifyList.length}`);
} else {
  console.log("⚠ DOĞRULAMA SORUNU:");
  console.log(`   kalan geçersiz: ${stillInvalid} · kalan mükerrer grup: ${stillDup}`);
  console.log(`   beklenen kayıt: ${cleaned.length} · bulunan: ${verifyList.length}`);
  console.log(`   Yedek: ${backup}`);
}
line();
