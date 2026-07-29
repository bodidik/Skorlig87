"use strict";

/**
 * Tek seferlik migration: totals.json → MongoDB `season_totals` koleksiyonu.
 *
 * Kullanım:
 *   MONGODB_URI=mongodb+srv://... node api/scripts/migrate-season-totals.cjs
 *   (önizleme için: ... node api/scripts/migrate-season-totals.cjs --dry)
 *
 * NEDEN GEREKLİ (bulundu 2026-07-29): routes/leaderboard.cjs birincil kaynak
 * olarak `season_totals` koleksiyonunu sorguluyordu, ama oraya HİÇBİR YERDEN
 * yazılmıyordu — settle2 sezon toplamlarını yalnızca totals.json'a yazıyordu.
 * Zincir: season_totals boş → leaderboard totals.json'a düşüyor → Render'da
 * disk kalıcı değil → her deploy'da tüm sezon puanları sıfırlanıyordu.
 *
 * settle2 artık `season_totals`'a $inc ile yazıyor. Bu script, o düzeltme
 * yayına çıkmadan ÖNCEKİ birikmiş toplamları taşır; yoksa mevcut sezon
 * bir anda sıfırdan başlamış görünür.
 *
 * ⚠️ İDEMPOTENT DEĞİL ANLAMINDA DİKKAT: $inc değil $set kullanır — yani
 * toplamları TOPLAMAZ, dosyadaki değerle DEĞİŞTİRİR. Tekrar çalıştırmak
 * güvenlidir (aynı sonucu verir), ama settle2 yeni maçlar işledikten SONRA
 * çalıştırmak o maçların puanını geri alır. Bir kez, geçiş anında çalıştır.
 *
 * Doğrulama: GET /api/leaderboard → source "mongo_season_totals" olmalı.
 */

const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { getDb } = require("../lib/mongo.cjs");

const DATA_DIR = process.env.SKORLIG_DATA_DIR || path.join(__dirname, "..", "data");
const TOTALS_FILE = path.join(DATA_DIR, "totals.json");

const DRY = process.argv.includes("--dry");

(async () => {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(TOTALS_FILE, "utf8"));
  } catch (e) {
    console.error(`totals.json okunamadi (${TOTALS_FILE}):`, e.message);
    process.exit(1);
  }

  const items = Array.isArray(raw?.items) ? raw.items : [];
  if (!items.length) {
    console.log("totals.json bos — tasinacak kayit yok.");
    process.exit(0);
  }

  const db = await getDb();
  if (!db) {
    console.error("MongoDB baglantisi yok. MONGODB_URI dogru mu?");
    process.exit(1);
  }

  const col = db.collection("season_totals");
  // leaderboard.cjs ve settle2 bu alanla sorguluyor; benzersiz olmali.
  await col.createIndex({ userIdLower: 1 }, { unique: true });

  const nowISO = new Date().toISOString();
  const ops = [];
  let atlanan = 0;

  for (const it of items) {
    const uid = String(it?.userId || "").trim();
    if (!uid) { atlanan++; continue; }
    ops.push({
      updateOne: {
        filter: { userIdLower: uid.toLowerCase() },
        update: {
          $set: {
            userId: uid,
            totalPoints: Math.round(Number(it.totalPoints || 0)),
            totalPenalty: Math.round(Number(it.totalPenalty || 0)),
            matches: Number(it.matches || 0),
            lastAt: it.lastAt || null,
            updatedAt: nowISO,
          },
          $setOnInsert: { userIdLower: uid.toLowerCase(), createdAt: nowISO },
        },
        upsert: true,
      },
    });
  }

  console.log(`totals.json: ${items.length} kayit, ${ops.length} tasinacak, ${atlanan} atlandi (userId yok)`);

  if (DRY) {
    console.log("--dry: hicbir sey yazilmadi. Ornek ilk 3:");
    for (const o of ops.slice(0, 3)) console.log("  ", JSON.stringify(o.updateOne.update.$set));
    process.exit(0);
  }

  const r = await col.bulkWrite(ops, { ordered: false });
  const toplam = await col.countDocuments();
  console.log(`yazildi: eklenen ${r.upsertedCount}, guncellenen ${r.modifiedCount}`);
  console.log(`season_totals toplam kayit: ${toplam}`);
  console.log("dogrulama: GET /api/leaderboard -> source \"mongo_season_totals\" olmali");
  process.exit(0);
})().catch((e) => {
  console.error("migration hatasi:", e);
  process.exit(1);
});
