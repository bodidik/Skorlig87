"use strict";

/**
 * Tek seferlik migration: preds.json → MongoDB predictions koleksiyonu.
 *
 * Kullanım:
 *   MONGODB_URI=mongodb+srv://... node api/scripts/migrate-preds-to-mongo.cjs
 *
 * ⚠️ Değişken adı MONGODB_URI (MONGO_URI DEĞİL): bu script lib/mongo.cjs
 * kullanır, yani uygulamayla AYNI bağlantı. Yanlış ad verilirse bağlantı
 * kurulamaz ve script "MongoDB bağlantısı yok" deyip çıkar.
 *
 * İdempotent: mevcut kayıtlar $set ile güncellenir, tekrar çalıştırılabilir.
 * Migration sonrası doğrulama: node scripts/verify-migration.cjs
 */

const path = require("path");
const fs   = require("fs");
// Uygulamayla AYNI bağlantı: server.cjs app.locals.db bunu kullanır (MONGODB_URI).
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { getDb, close } = require("../lib/mongo.cjs");

const PREDS_FILE = path.join(__dirname, "../data/preds.json");
const BATCH      = 500;

(async () => {
  console.log("[migrate] preds.json okunuyor...");
  const raw  = JSON.parse(fs.readFileSync(PREDS_FILE, "utf8"));
  const list = Array.isArray(raw) ? raw : (Array.isArray(raw.items) ? raw.items : []);
  console.log(`[migrate] ${list.length} tahmin bulundu.`);

  const db  = await getDb();
  if (!db) {
    console.error("[migrate] MongoDB bağlantısı yok (MONGODB_URI kontrol et). İptal.");
    process.exit(1);
  }
  const col = db.collection("predictions");

  // İndeksler
  console.log("[migrate] İndeksler oluşturuluyor...");
  await col.createIndex({ fixtureId: 1, userIdLower: 1 }, { unique: true, background: true });
  await col.createIndex({ userIdLower: 1 },               { background: true });
  await col.createIndex({ fixtureId: 1, isBot: 1 },       { background: true });
  console.log("[migrate] İndeksler hazır.");

  // Batch upsert
  let done = 0;
  for (let i = 0; i < list.length; i += BATCH) {
    const chunk = list.slice(i, i + BATCH);
    const ops   = chunk.map((rec) => {
      const uid     = String(rec.userId || rec.user || "").trim();
      const uidLow  = uid.toLowerCase();
      const doc = {
        fixtureId:   rec.fixtureId,
        userId:      uid,
        userIdLower: uidLow,
        isBot:       !!rec.isBot,
        outcome:     rec.outcome  ?? null,
        home:        rec.home     ?? null,
        away:        rec.away     ?? null,
        firstGoal:   rec.firstGoal  || null,
        firstHalf:   rec.firstHalf  || null,
        redAny:      rec.redAny    ?? null,
        redSide:     rec.redSide   || null,
        redHome:     rec.redHome   ?? null,
        redAway:     rec.redAway   ?? null,
        penaltyAny:  rec.penaltyAny ?? null,
        penaltySide: rec.penaltySide || null,
        at:          rec.at         || new Date().toISOString(),
        tag:         rec.tag        || null,
        source:      rec.isBot ? "bot" : "user",
      };
      return {
        updateOne: {
          filter: { fixtureId: doc.fixtureId, userIdLower: uidLow },
          update: { $set: doc },
          upsert: true,
        },
      };
    });

    await col.bulkWrite(ops, { ordered: false });
    done += chunk.length;
    process.stdout.write(`\r[migrate] ${done}/${list.length}`);
  }

  console.log(`\n[migrate] Tamamlandı. ${done} tahmin MongoDB'ye aktarıldı.`);
  await close();
  process.exit(0);
})().catch((e) => {
  console.error("[migrate] HATA:", e);
  process.exit(1);
});
