"use strict";
/**
 * PUAN DENETİMİ — salt okunur, hiçbir dosyaya yazmaz.
 *
 * Kullanım:  node scripts/audit-points.cjs
 *
 * Ne kontrol eder:
 *  1) match-results.json snapshot'larında awardedAt sentinel'ı var mı
 *     (settle idempotency koruması aktif mi)
 *  2) totals.json'daki matches sayısı, kullanıcının gerçekten tahmin verdiği
 *     fixture sayısıyla tutuyor mu → tutmuyorsa çift-settle olmuş
 *  3) preds.json'da aynı user+fixture için mükerrer kayıt var mı
 *     (tek settle'da çoklu puanlanmaya yol açar)
 *  4) totals.json'daki kayıtların bot / test / gerçek kullanıcı dağılımı
 *
 * Bot kimliği lib/botIds.cjs'ten okunur — kodun kullandığı kümenin aynısı
 * (aktif kadro + emekli botlar). Böylece denetim, runtime ile aynı şeyi görür.
 */

const fs = require("fs");
const path = require("path");
const { isBot, BOT_ID_SET, BOT_PROFILES } = require("../lib/botIds.cjs");

const DATA_DIR = path.join(__dirname, "..", "data");
const F = {
  matchResults: path.join(DATA_DIR, "match-results.json"),
  totals: path.join(DATA_DIR, "totals.json"),
  preds: path.join(DATA_DIR, "preds.json"),
};

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    console.error(`[!] okunamadi: ${path.basename(file)} — ${e.message}`);
    return fallback;
  }
}

function asList(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.items)) return raw.items;
  if (raw && Array.isArray(raw.users)) return raw.users;
  return [];
}

const line = (c = "=") => console.log(c.repeat(78));

// ── Veri yükleme ────────────────────────────────────────────────────────────
const book = readJson(F.matchResults, { items: [] });
const totals = readJson(F.totals, { items: [] });
const preds = asList(readJson(F.preds, []));

const snaps = asList(book);
const totalRows = asList(totals);

line();
console.log("SKORLIG PUAN DENETİMİ");
line();
console.log(`match-results.json : ${snaps.length} maç snapshot`);
console.log(`totals.json        : ${totalRows.length} kullanıcı (updatedAt: ${totals.updatedAt || "-"})`);
console.log(`preds.json         : ${preds.length} tahmin kaydı`);
console.log(`bot kimliği        : ${BOT_ID_SET.size} (aktif kadro ${BOT_PROFILES.length} + emekli ${BOT_ID_SET.size - BOT_PROFILES.length})`);
console.log();

let problems = 0;

// ── 1) awardedAt sentinel ───────────────────────────────────────────────────
console.log("── 1) Settle idempotency koruması (awardedAt) ──");
const withAwarded = snaps.filter((s) => s && s.awardedAt);
const withoutAwarded = snaps.filter((s) => s && !s.awardedAt);
console.log(`   korumalı (awardedAt var) : ${withAwarded.length}`);
console.log(`   korumasız (awardedAt yok): ${withoutAwarded.length}`);
if (withoutAwarded.length) {
  console.log("   ℹ Bu maçlar fix öncesinden. İlk yeni settle'da sentinel yazılır,");
  console.log("     sonraki çağrılar puan yatırmaz.");
}
console.log();

// ── 2) matches vs gerçek fixture sayısı ────────────────────────────────────
console.log("── 2) Çift-settle kontrolü (totals.matches vs gerçek fixture) ──");

const fixturesByUser = new Map(); // uidLower -> Set(fixtureId)
for (const p of preds) {
  const uid = String(p.userId || p.user || "").trim().toLowerCase();
  const fid = String(p.fixtureId || "").trim();
  if (!uid || !fid) continue;
  if (!fixturesByUser.has(uid)) fixturesByUser.set(uid, new Set());
  fixturesByUser.get(uid).add(fid);
}

const inflated = [];
for (const row of totalRows) {
  const uid = String(row.userId || "").trim().toLowerCase();
  if (!uid) continue;
  const realFixtures = (fixturesByUser.get(uid) || new Set()).size;
  const claimed = Number(row.matches || 0);
  // Tahmini silinmiş eski maçlar olabilir; sadece belirgin şişmeyi işaretle
  if (realFixtures > 0 && claimed > realFixtures) {
    inflated.push({
      userId: row.userId,
      realFixtures,
      claimed,
      ratio: +(claimed / realFixtures).toFixed(1),
      points: Number(row.totalPoints || 0),
    });
  }
}

if (!inflated.length) {
  console.log("   ✅ Şişme yok — her kullanıcının matches değeri tahmin sayısıyla tutuyor.");
} else {
  problems++;
  inflated.sort((a, b) => b.ratio - a.ratio);
  console.log(`   ⚠ ${inflated.length} kullanıcıda matches > gerçek fixture sayısı:`);
  console.log();
  const head =
    "   " + "userId".padEnd(28) + "gerçek".padStart(8) + "totals".padStart(8) + "kat".padStart(7) + "puan".padStart(8);
  console.log(head);
  console.log("   " + "-".repeat(head.length - 3));
  for (const d of inflated.slice(0, 30)) {
    const uid = d.userId.length > 26 ? d.userId.slice(0, 24) + ".." : d.userId;
    console.log(
      "   " +
        uid.padEnd(28) +
        String(d.realFixtures).padStart(8) +
        String(d.claimed).padStart(8) +
        (d.ratio + "x").padStart(7) +
        String(d.points).padStart(8)
    );
  }
  if (inflated.length > 30) console.log(`   … ve ${inflated.length - 30} kullanıcı daha`);
}
console.log();

// ── 3) Mükerrer tahmin ─────────────────────────────────────────────────────
console.log("── 3) Mükerrer tahmin (aynı user + aynı fixture) ──");
const pairCount = new Map();
for (const p of preds) {
  const uid = String(p.userId || p.user || "").trim().toLowerCase();
  const fid = String(p.fixtureId || "").trim();
  if (!uid || !fid) continue;
  const k = `${fid}::${uid}`;
  pairCount.set(k, (pairCount.get(k) || 0) + 1);
}
const dups = [...pairCount.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]);
const extra = dups.reduce((s, [, n]) => s + (n - 1), 0);

console.log(`   tekil user+fixture çifti : ${pairCount.size}`);
console.log(`   mükerrer çift            : ${dups.length}`);
console.log(`   fazladan kayıt           : ${extra}`);
if (dups.length) {
  problems++;
  console.log("   ⚠ settle2 artık en son kaydı geçerli sayıyor, ama dosya kirli:");
  for (const [k, n] of dups.slice(0, 15)) console.log(`     ${n}x  ${k}`);
  if (dups.length > 15) console.log(`     … ve ${dups.length - 15} çift daha`);
} else {
  console.log("   ✅ Mükerrer kayıt yok.");
}
console.log();

// ── 4) Kullanıcı dağılımı ──────────────────────────────────────────────────
console.log("── 4) totals.json kullanıcı dağılımı ──");
const cat = { bot: [], test: [], firebaseUid: [], unknown: [] };
const TEST_IDS = new Set(["demo1", "demo2", "dz", "demo_admin", "admin", "dev"]);

for (const row of totalRows) {
  const raw = String(row.userId || "");
  if (isBot(raw)) cat.bot.push(row);
  else if (TEST_IDS.has(raw.toLowerCase())) cat.test.push(row);
  else if (/^[A-Za-z0-9]{26,32}$/.test(raw)) cat.firebaseUid.push(row);
  else cat.unknown.push(row);
}

console.log(`   bot olarak tanınan   : ${cat.bot.length}`);
console.log(`   test hesabı          : ${cat.test.length}`);
console.log(`   gerçek Firebase UID  : ${cat.firebaseUid.length}`);
console.log(`   sınıflanamayan       : ${cat.unknown.length}`);

if (cat.unknown.length > 0) {
  problems++;
  console.log();
  console.log(`   ⚠ ${cat.unknown.length} hesap ne bot ne test ne geçerli UID → kod bunları "insan" sayar.`);
  console.log("     Etkisi: topluluk çarpanı bozulur, settle'da LC alırlar.");
  console.log("     Çözüm: gerçek kullanıcı değilse data/bot-legacy-ids.json içine ekle.");
  cat.unknown.slice(0, 15).forEach((r) => console.log(`       ${r.userId}`));
  if (cat.unknown.length > 15) console.log(`       … ve ${cat.unknown.length - 15} tane daha`);
} else {
  console.log();
  console.log("   ✅ Sınıflanamayan hesap yok — bot/insan ayrımı temiz.");
}

if (cat.firebaseUid.length) {
  console.log();
  console.log("   Gerçek kullanıcılar:");
  cat.firebaseUid
    .slice()
    .sort((a, b) => Number(b.totalPoints || 0) - Number(a.totalPoints || 0))
    .slice(0, 20)
    .forEach((r) =>
      console.log(
        `     ${String(r.userId).padEnd(30)} puan: ${String(r.totalPoints).padStart(6)}  maç: ${String(r.matches).padStart(4)}`
      )
    );
}
console.log();

// ── Özet ───────────────────────────────────────────────────────────────────
line();
if (problems === 0) {
  console.log("SONUÇ: ✅ Tutarsızlık bulunmadı.");
} else {
  console.log(`SONUÇ: ⚠ ${problems} başlıkta dikkat gerektiren bulgu var (yukarıda).`);
}
console.log("Hiçbir dosya değiştirilmedi.");
line();
