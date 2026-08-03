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
 * ⚠️ SEZON KAYDIN KENDİ ZAMANINDAN gelir, scriptin çalıştırıldığı andan DEĞİL.
 * Önceki hâli hepsine `Season.seasonKey()` yazıyordu; ölçüldü (2026-08-03):
 * sezonsuz 34 kaydın tamamı 29 Temmuz tarihliydi, yani bugün çalıştırılsa
 * 195.3 puan kalıcı olarak Ağustos a yazılacaktı.
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

  /**
   * ⚠️ KURU KOŞU PLANI GÖSTERMELİ. Önceki hâli yalnızca "kaç kayıt sezonsuz"
   * diyip çıkıyordu — HANGİ sezona yazılacağını hiç söylemiyordu. Tam da bu
   * yüzden "hepsini şimdiki aya damgalama" kusuru kuru koşuda görünmüyordu:
   * çıktı doğru görünüyor, karar yanlış.
   */
  const sezonsuzlar = eksik > 0
    ? await col
        .find({ season: { $exists: false } })
        .project({ _id: 1, lastAt: 1, updatedAt: 1, createdAt: 1, totalPoints: 1, matches: 1 })
        .toArray()
    : [];

  const kova = new Map();   // sezon -> { idler, puan, mac }
  let damgasiz = 0;
  for (const d of sezonsuzlar) {
    const ms = Date.parse(String(d.lastAt || d.updatedAt || d.createdAt || ""));
    let k = sezon;
    if (Number.isFinite(ms)) k = Season.seasonKey(new Date(ms));
    else damgasiz++;
    if (!kova.has(k)) kova.set(k, { idler: [], puan: 0, mac: 0 });
    const b = kova.get(k);
    b.idler.push(d._id);
    b.puan += Number(d.totalPoints || 0);
    b.mac += Number(d.matches || 0);
  }

  if (sezonsuzlar.length) {
    console.log("plan (sezon <- kaydin kendi zamani):");
    for (const [k, b] of kova) {
      console.log(`  ${k}: ${b.idler.length} kayit · ${Math.round(b.puan * 10) / 10} puan · ${b.mac} mac`);
    }
    if (damgasiz) console.log(`  (zaman damgasi olmayan ${damgasiz} kayit -> ${sezon})`);
  }

  if (DRY) {
    console.log("--dry: hicbir sey yazilmadi.");
    process.exit(0);
  }

  // 1) Alanı doldur (indeksten ÖNCE — bkz. dosya başı)
  /**
   * ⚠️ SEZON KAYDIN KENDİ ZAMANINDAN TÜRETİLİR, "ŞİMDİ"DEN DEĞİL.
   *
   * ÖNCEKİ HÂLİ tek `updateMany` ile HEPSİNE `Season.seasonKey()` yazıyordu,
   * yani script hangi ay çalıştırılırsa kayıtlar O AYA damgalanıyordu.
   *
   * ÖLÇÜLDÜ (2026-08-03, üretim): sezonsuz 34 kaydın TAMAMI 2026-07-29
   * tarihli, yani Temmuz'a ait. Script bugün çalıştırılsaydı 195.3 puan ve
   * 45 maç kalıcı olarak AĞUSTOS tablosuna yazılacaktı — hem Temmuz eksik
   * kalır hem Ağustos şişerdi, üstelik geri alınamazdı (özgün tarih artık
   * yalnızca `lastAt`ta).
   *
   * ⚠️ ÜÇÜNCÜ KEZ AYNI SINIF. `routes/settle2.cjs` ve `lib/kupon-settle.cjs`
   * de sezonu "şimdi"den alıyordu ve ikisi de olayın kendi zamanına
   * geçirildi (settle2'de 9 vaka ölçülmüştü). Bakım betiği atlanmış —
   * "kural kopyalanınca ayrışır"ın betik hâli.
   *
   * Zaman damgası hiç yoksa şimdiki sezona düşülür: puanı hiç yazmamaktansa
   * muhtemelen doğru olan sezona yazmak iyidir (settle2 ile aynı gerekçe).
   */
  if (sezonsuzlar.length) {
    let toplamYazilan = 0;
    for (const [k, b] of kova) {
      const r = await col.updateMany({ _id: { $in: b.idler } }, { $set: { season: k } });
      toplamYazilan += r.modifiedCount;
      console.log(`sezon alani dolduruldu: ${r.modifiedCount} kayit -> ${k}`);
    }
    if (damgasiz) {
      console.warn(`⚠️ ${damgasiz} kaydin zaman damgasi yok, simdiki sezona (${sezon}) yazildi`);
    }
    console.log(`toplam: ${toplamYazilan} kayit`);
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
