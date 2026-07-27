"use strict";

/**
 * MIGRATION DOĞRULAMA — preds.json vs MongoDB.
 *
 * NEDEN ŞART: `SKORLIG_PREDS_FILE_MIRROR=0` yapıldığı anda preds.json artık
 * YAZILMAZ. Migration eksik/bozuksa bu, fark edilmeyen kalıcı veri kaybına
 * döner — dosya donmuş, Mongo eksik. Bayrağı çevirmeden ÖNCE bu script
 * "GO" demeli.
 *
 * Kullanım:
 *   MONGODB_URI=mongodb+srv://... node scripts/verify-migration.cjs
 *
 * Çıkış kodu: 0 = GO (geçilebilir), 1 = NO-GO (bayrağı çevirme).
 */

const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { getDb, close } = require("../lib/mongo.cjs");

const PREDS_FILE = path.join(__dirname, "../data/preds.json");
const SAMPLE_SIZE = Number(process.env.VERIFY_SAMPLE || 200);

// Karşılaştırılan alanlar. `at` ve `tag` gibi bilgi alanları dışarıda:
// migration bunları taşır ama farkları veri kaybı sayılmaz.
const FIELDS = [
  "outcome", "home", "away", "firstGoal", "firstHalf",
  "redAny", "redSide", "redHome", "redAway",
  "penaltyAny", "penaltySide",
];

const norm = (v) => (v === undefined ? null : v);

(async () => {
  const problems = [];

  console.log("[verify] preds.json okunuyor...");
  const raw = JSON.parse(fs.readFileSync(PREDS_FILE, "utf8"));
  const list = Array.isArray(raw) ? raw : Array.isArray(raw.items) ? raw.items : [];
  console.log(`[verify] dosyada ${list.length} tahmin`);

  const db = await getDb();
  if (!db) {
    console.error("[verify] MongoDB baglantisi YOK (MONGODB_URI kontrol et). NO-GO.");
    process.exit(1);
  }
  const col = db.collection("predictions");

  // 1) Sayı karşılaştırması
  const mongoCount = await col.countDocuments();
  console.log(`[verify] Mongo'da ${mongoCount} kayit`);
  if (mongoCount < list.length) {
    problems.push(`Mongo'da ${list.length - mongoCount} kayit EKSIK`);
  }

  // 2) İndeksler — mirror kapandıktan sonra tüm okumalar Mongo'dan gelir,
  //    indeks yoksa sorgular tam tarama yapar ve yük altında çöker.
  const idx = await col.indexes();
  const idxKeys = idx.map((i) => JSON.stringify(i.key));
  const required = [
    { fixtureId: 1, userIdLower: 1 },
    { userIdLower: 1 },
  ];
  for (const r of required) {
    const want = JSON.stringify(r);
    if (!idxKeys.some((k) => k === want)) {
      problems.push(`Indeks EKSIK: ${want}`);
    }
  }
  console.log(`[verify] indeksler: ${idxKeys.join(" · ")}`);

  // 3) Örneklem: rastgele kayıtları alan alan karşılaştır
  const step = Math.max(1, Math.floor(list.length / SAMPLE_SIZE));
  let checked = 0;
  let missing = 0;
  let mismatched = 0;

  for (let i = 0; i < list.length; i += step) {
    const rec = list[i];
    const uid = String(rec.userId || rec.user || "").trim().toLowerCase();
    if (!uid) continue;

    const doc = await col.findOne({ fixtureId: rec.fixtureId, userIdLower: uid });
    checked++;

    if (!doc) {
      missing++;
      if (missing <= 5) console.log(`  EKSIK: ${rec.fixtureId} / ${uid}`);
      continue;
    }

    const diffs = FIELDS.filter((f) => norm(doc[f]) !== norm(rec[f]));
    if (diffs.length) {
      mismatched++;
      if (mismatched <= 5) {
        console.log(`  FARK : ${rec.fixtureId} / ${uid} -> ${diffs.join(",")}`);
      }
    }
  }

  console.log(`[verify] orneklem: ${checked} kayit · eksik ${missing} · farkli ${mismatched}`);
  if (missing) problems.push(`Orneklemde ${missing}/${checked} kayit Mongo'da yok`);
  if (mismatched) problems.push(`Orneklemde ${mismatched}/${checked} kayit alan farki tasiyor`);

  // 4) Bot/insan dağılımı — kabaca tutmalı
  const mongoBots = await col.countDocuments({ isBot: true });
  const fileBots = list.filter((r) => r.isBot).length;
  console.log(`[verify] bot kayit — dosya ${fileBots} · mongo ${mongoBots}`);

  console.log("");
  if (problems.length) {
    console.log("SONUC: NO-GO — SKORLIG_PREDS_FILE_MIRROR=0 YAPMA");
    problems.forEach((p) => console.log("  ✗ " + p));
    await close();
    process.exit(1);
  }

  console.log("SONUC: GO — migration eksiksiz gorunuyor.");
  console.log("  Sonraki adim: SKORLIG_PREDS_FILE_MIRROR=0 (once bir sure 1'de izle).");
  await close();
  process.exit(0);
})().catch((e) => {
  console.error("[verify] HATA:", e);
  process.exit(1);
});
