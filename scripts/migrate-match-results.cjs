"use strict";

/**
 * Maç sonucu snapshot'larını dosyadan MongoDB'ye taşır.
 *
 * NEDEN: `settle2` yeni settle'ları hem dosyaya hem (Mongo varsa) koleksiyona
 * yazar, ama GEÇMİŞ snapshot'lar kendiliğinden taşınmaz.
 * `SKORLIG_MATCHRESULTS_FILE_MIRROR=0` yapıldığı anda dosya okunmaz olur;
 * geçmiş taşınmamışsa kullanıcıların maç geçmişi ve haftalık sıralamalar
 * SESSİZCE eksik görünür (hata vermez, sadece veri yoktur).
 *
 * Kullanım:
 *   MONGODB_URI=mongodb+srv://... node scripts/migrate-match-results.cjs
 *   MONGODB_URI=mongodb+srv://... node scripts/migrate-match-results.cjs --verify
 *
 * ⚠️ Değişken adı MONGODB_URI (MONGO_URI DEĞİL) — uygulamayla aynı bağlantı.
 *
 * İdempotent: fixtureId üzerinden upsert, tekrar çalıştırılabilir.
 * Çıkış kodu: 0 = GO, 1 = NO-GO (bayrağı çevirme).
 */

const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { getDb, close } = require("../lib/mongo.cjs");

const FILE = path.join(__dirname, "..", "data", "match-results.json");
const COLL = "match_results";
const BATCH = 100;
const SAMPLE = Number(process.env.VERIFY_SAMPLE || 50);
const VERIFY_ONLY = process.argv.includes("--verify");

function readBook() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (Array.isArray(raw)) return raw;
    return Array.isArray(raw.items) ? raw.items : [];
  } catch {
    return [];
  }
}

/**
 * Satırlara `userIdLower` ekler.
 *
 * ⚠️ ŞART: kullanıcının maç geçmişi sorgusu Mongo'da `rows.userIdLower`
 * üzerinden çalışır. Bu alan olmadan sorgu HATA VERMEZ, sadece BOŞ döner —
 * yani kullanıcı geçmişini kaybetmiş gibi görür. (Aynı hata lib/match-results
 * geliştirilirken de yaşandı, testte yakalandı.)
 */
function normalize(snap) {
  return {
    ...snap,
    fixtureId: String(snap.fixtureId || "").trim(),
    rows: (Array.isArray(snap.rows) ? snap.rows : []).map((r) => ({
      ...r,
      userIdLower: String(r?.userId || "").toLowerCase(),
    })),
  };
}

async function ensureIndexes(col) {
  await col.createIndex({ fixtureId: 1 }, { unique: true, background: true });
  await col.createIndex({ computedAt: -1 }, { background: true });
  await col.createIndex({ "rows.userIdLower": 1 }, { background: true });
}

async function migrate(col, items) {
  let done = 0;
  for (let i = 0; i < items.length; i += BATCH) {
    const chunk = items.slice(i, i + BATCH).filter((s) => s && s.fixtureId);
    if (!chunk.length) continue;
    await col.bulkWrite(
      chunk.map((s) => {
        const doc = normalize(s);
        return {
          updateOne: {
            filter: { fixtureId: doc.fixtureId },
            update: { $set: doc },
            upsert: true,
          },
        };
      }),
      { ordered: false }
    );
    done += chunk.length;
    process.stdout.write(`\r[migrate] ${done}/${items.length}`);
  }
  if (done) process.stdout.write("\n");
  return done;
}

async function verify(col, items) {
  const problems = [];

  const mongoCount = await col.countDocuments();
  console.log(`[verify] dosya ${items.length} · mongo ${mongoCount}`);
  if (mongoCount < items.length) {
    problems.push(`Mongo'da ${items.length - mongoCount} snapshot EKSIK`);
  }

  // İndeksler — mirror kapandıktan sonra tüm okumalar Mongo'dan gelir.
  const idx = (await col.indexes()).map((i) => JSON.stringify(i.key));
  for (const want of [
    { fixtureId: 1 },
    { "rows.userIdLower": 1 },
  ]) {
    if (!idx.includes(JSON.stringify(want))) {
      problems.push(`Indeks EKSIK: ${JSON.stringify(want)}`);
    }
  }
  console.log(`[verify] indeksler: ${idx.join(" · ")}`);

  // Örneklem: snapshot var mı, satır sayısı tutuyor mu, sentinel korunmuş mu
  const step = Math.max(1, Math.floor(items.length / SAMPLE));
  let checked = 0, missing = 0, rowDiff = 0, sentinelDiff = 0;

  for (let i = 0; i < items.length; i += step) {
    const s = items[i];
    const fid = String(s?.fixtureId || "").trim();
    if (!fid) continue;
    checked++;

    const doc = await col.findOne({ fixtureId: fid });
    if (!doc) {
      missing++;
      if (missing <= 5) console.log(`  EKSIK: ${fid}`);
      continue;
    }
    const fileRows = Array.isArray(s.rows) ? s.rows.length : 0;
    const mongoRows = Array.isArray(doc.rows) ? doc.rows.length : 0;
    if (fileRows !== mongoRows) {
      rowDiff++;
      if (rowDiff <= 5) console.log(`  SATIR FARKI: ${fid} — dosya ${fileRows}, mongo ${mongoRows}`);
    }
    // awardedAt çift-ödül mührü: kaybolursa maç yeniden ödüllendirilir.
    if ((s.awardedAt || null) !== (doc.awardedAt || null)) {
      sentinelDiff++;
      if (sentinelDiff <= 5) console.log(`  SENTINEL FARKI: ${fid}`);
    }
  }
  console.log(`[verify] orneklem ${checked} · eksik ${missing} · satir farki ${rowDiff} · sentinel farki ${sentinelDiff}`);
  if (missing) problems.push(`Orneklemde ${missing}/${checked} snapshot yok`);
  if (rowDiff) problems.push(`Orneklemde ${rowDiff}/${checked} snapshot'ta satir sayisi farkli`);
  if (sentinelDiff) problems.push(`Orneklemde ${sentinelDiff}/${checked} awardedAt muhru farkli — CIFT ODUL RISKI`);

  // Asıl sorgu yolunu dene: bir kullanıcının geçmişi Mongo'dan dönüyor mu?
  // Veri doğru ama bu sorgu boş dönüyorsa kullanıcı geçmişini kaybetmiş görür.
  const withRows = items.find((s) => Array.isArray(s.rows) && s.rows.length && s.rows[0]?.userId);
  if (withRows) {
    const uid = String(withRows.rows[0].userId).toLowerCase();
    const hits = await col.countDocuments({ "rows.userIdLower": uid });
    console.log(`[verify] kullanici gecmisi sorgusu (${uid}): ${hits} snapshot`);
    if (!hits) {
      problems.push(`Kullanici gecmisi sorgusu BOS dondu (rows.userIdLower eksik olabilir)`);
    }
  }

  return problems;
}

(async () => {
  const items = readBook();
  console.log(`[migrate] match-results.json: ${items.length} snapshot`);

  const db = await getDb();
  if (!db) {
    console.error("[migrate] MongoDB baglantisi YOK (MONGODB_URI kontrol et). NO-GO.");
    process.exit(1);
  }
  const col = db.collection(COLL);

  if (!VERIFY_ONLY) {
    console.log("[migrate] indeksler hazirlaniyor...");
    await ensureIndexes(col);
    const n = await migrate(col, items);
    console.log(`[migrate] ${n} snapshot aktarildi.`);
  }

  const problems = await verify(col, items);

  console.log("");
  if (problems.length) {
    console.log("SONUC: NO-GO — SKORLIG_MATCHRESULTS_FILE_MIRROR=0 YAPMA");
    problems.forEach((p) => console.log("  ✗ " + p));
    await close();
    process.exit(1);
  }
  console.log("SONUC: GO — snapshot'lar eksiksiz gorunuyor.");
  console.log("  Sonraki adim: SKORLIG_MATCHRESULTS_FILE_MIRROR=0 (once bir sure 1'de izle).");
  await close();
  process.exit(0);
})().catch((e) => {
  console.error("[migrate] HATA:", e);
  process.exit(1);
});
