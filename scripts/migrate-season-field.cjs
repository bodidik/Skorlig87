"use strict";

/**
 * Tek seferlik migration: `season_totals` kayıtlarına sezon alanı ekler ve
 * benzersiz indeksi `{userIdLower}` → `{season, userIdLower}` olarak değiştirir.
 *
 * Kullanım:
 *   node api/scripts/migrate-season-field.cjs --dry
 *   node api/scripts/migrate-season-field.cjs
 *
 * NEDEN: sıralama artık sezona bölünüyor (bkz. lib/season.cjs). Sezon alanı
 * olmayan eski kayıtlar okuma tarafında güncel sezona sayılıyor — ama bu
 * yalnızca GEÇİŞ toleransı. Sezon değiştiğinde o kayıtlar YENİ sezona da
 * sayılmaya devam eder ve tablo hiç sıfırlanmaz. Bu script onları içinde
 * bulunulan sezona sabitler.
 *
 * ⚠️ İNDEKS DEĞİŞİMİ: eski `{userIdLower}` benzersiz indeksi kalırsa aynı
 * oyuncunun İKİNCİ sezonu yazılamaz (duplicate key). Bu yüzden eski indeks
 * düşürülüp bileşik olan kurulur. Sıra önemli: önce alanı doldur, sonra
 * indeksi değiştir — tersi olursa dolgusuz kayıtlar çakışır.
 *
 * İdempotent: sezon alanı olan kayıtlara dokunmaz, tekrar çalıştırılabilir.
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { getDb } = require("../lib/mongo.cjs");
const Season = require("../lib/season.cjs");

const DRY = process.argv.includes("--dry");
const COLL = "season_totals";

(async () => {
  const db = await getDb();
  if (!db) {
    console.error("MongoDB baglantisi yok. api/.env icinde MONGODB_URI tanimli mi?");
    process.exit(1);
  }

  const col = db.collection(COLL);
  const sezon = Season.seasonKey();

  const toplam = await col.countDocuments();
  const eksik = await col.countDocuments({ season: { $exists: false } });
  const idx = await col.indexes();
  const eskiIdx = idx.find((i) => JSON.stringify(i.key) === '{"userIdLower":1}');
  const yeniIdx = idx.find((i) => JSON.stringify(i.key) === '{"season":1,"userIdLower":1}');

  console.log(`koleksiyon    : ${COLL}`);
  console.log(`hedef sezon   : ${sezon} (${Season.label(sezon)}, ${Season.LENGTH})`);
  console.log(`toplam kayit  : ${toplam}`);
  console.log(`sezonsuz kayit: ${eksik}`);
  console.log(`eski indeks   : ${eskiIdx ? eskiIdx.name + (eskiIdx.unique ? " (unique)" : "") : "yok"}`);
  console.log(`yeni indeks   : ${yeniIdx ? yeniIdx.name : "yok"}`);

  if (DRY) {
    console.log("--dry: hicbir sey yazilmadi.");
    process.exit(0);
  }

  // 1) Alanı doldur (indeksten ÖNCE — bkz. dosya başı)
  if (eksik > 0) {
    const r = await col.updateMany({ season: { $exists: false } }, { $set: { season: sezon } });
    console.log(`sezon alani dolduruldu: ${r.modifiedCount} kayit -> ${sezon}`);
  } else {
    console.log("sezon alani zaten dolu, atlandi.");
  }

  // 2) Bileşik indeksi kur
  await col.createIndex({ season: 1, userIdLower: 1 }, { unique: true, background: true });
  console.log("bilesik indeks kuruldu: {season, userIdLower} UNIQUE");

  // 3) Eski tekil indeksi düşür (ikinci sezonu engelliyor)
  if (eskiIdx) {
    await col.dropIndex(eskiIdx.name);
    console.log(`eski indeks dusuruldu: ${eskiIdx.name}`);
  }

  console.log('dogrulama: GET /api/leaderboard -> scope.season "' + sezon + '" olmali');
  process.exit(0);
})().catch((e) => {
  console.error("migration hatasi:", e);
  process.exit(1);
});
