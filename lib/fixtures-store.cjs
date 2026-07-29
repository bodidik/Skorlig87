"use strict";

/**
 * FİKSTÜR DEPOSU — tek yer (Mongo birincil, dosya ayna).
 *
 * NEDEN VAR: `data/fixtures.json` Render'da her deploy'da siliniyor (kalıcı
 * disk yok). Maçlar dış senkronla yeniden dolana kadar uygulama boş görünüyor
 * — ve o senkron, kontrol etmediğimiz kaynaklara bağlı. Ölçüldü (2026-07-29):
 * yeniden başlatmadan sonra şelalede yalnızca `goal` çalışıyordu ve üretim
 * önbelleği 16 lig / 70 maçtı; yerelde aynı anda 62 lig / 201 maç vardı.
 * Yani "yeniden dolar" garantisi kaynağın o anki hâline bağlı.
 *
 * ⚠️ ÖNCEKİ KARARIN TERSİ. lib/manual-fixtures.cjs'te "sağlayıcıdan gelenleri
 * Mongo'ya kopyalamak gereksiz yazma olurdu" yazıyor. O gerekçe, sağlayıcı
 * fikstürlerinin her zaman geri geleceğini varsayıyordu. Varsayım tutmadı:
 * geri gelme HIZI ve KAPSAMI kaynağa bağlı, yani kullanıcı için "maç yok"
 * penceresi öngörülemez. Yazma maliyeti (~500 kayıt, senkron başına bir
 * bulkWrite) bu riskin yanında önemsiz.
 *
 * DEĞİŞTİRME SEMANTİĞİ: `saveAll(list)` listeyi TAM kabul eder — listede
 * olmayan kayıtlar silinir. Çağıranların hepsi tam liste veriyor
 * (fixture-sync, mackolik-fixture-sync, manual-fixtures-restore, admin
 * ekleme/silme uçları hepsi merge sonrası tam listeyi yazıyor).
 * ⚠️ BOŞ LİSTE HİÇBİR ŞEY SİLMEZ: geçici bir ağ/kota hatasından sonra gelen
 * boş senkron, gelecekteki tüm maçları silen "başarılı" bir yazma gibi
 * görünürdü. fixture-sync aynı savunmayı kendi içinde de yapıyor.
 */

const path = require("path");
const fsp = require("fs").promises;

const COLL = "fixtures";

const DATA_DIR = process.env.SKORLIG_DATA_DIR || path.join(__dirname, "..", "data");
const FIXTURES_FILE = path.join(DATA_DIR, "fixtures.json");

/**
 * Dosya aynası. ⚠️ MONGODB_URI yoksa YOK SAYILIR (dosya tek kaynaktır,
 * kapatmak veri kaybı olurdu) — diğer ayna bayraklarıyla aynı kural.
 */
const FILE_MIRROR = String(process.env.SKORLIG_FIXTURES_FILE_MIRROR ?? "1") !== "0";

function mirrorOn() {
  return FILE_MIRROR || !process.env.MONGODB_URI;
}

// ⚠️ BAYRAK DEĞİL SÖZ (promise) ÖNBELLEKLENİR.
// Eskiden `if (_indexed) return; _indexed = true;` idi ve bayrak
// `await createIndex(...)` TAMAMLANMADAN kalkıyordu. Eşzamanlı ikinci çağrı
// "indeksler hazır" sanıp hemen dönüyor, indeks HENÜZ YOKKEN upsert yapıyordu
// → aynı anahtardan KOPYA BELGE. Benzersizliğe dayanan para korumaları
// (claimAward, claimDuelSettle) o kopyalar yüzünden birden fazla çağrıya
// "kazandın" diyordu — eşzamanlılık testi yakaladı (20 çağrının 2'si geçti).
// Söz önbekleyince ikinci çağrı aynı sözü BEKLER.
let _indexPromise = null;
function ensureIndexes(db) {
  if (!db) return Promise.resolve();
  if (_indexPromise) return _indexPromise;
  _indexPromise = (async () => {
  try {
    const col = db.collection(COLL);
    await col.createIndex({ fixtureId: 1 }, { unique: true, background: true });
    // Zaman penceresi sorguları (schedule/open) ve geçmiş ayıklama.
    await col.createIndex({ kickoffISO: 1 }, { background: true });
  } catch (e) {
    console.error("[fixtures-store] indeks kurulamadi:", e?.message || e);
  }
  })();
  return _indexPromise;
}

/** Servisler istek kapsamında değil; bağlantıyı uygulamayla aynı yerden alır. */
async function getDbSafe(db) {
  if (db) return db;
  try {
    const { getDb } = require("./mongo.cjs");
    return await getDb();
  } catch {
    return null;
  }
}

const strip = (d) => {
  if (!d) return null;
  const { _id, ...rest } = d;
  return rest;
};

/* ───────────────────────────── dosya tarafı ───────────────────────────── */

let _tmpSayac = 0;

async function readFile_() {
  try {
    return JSON.parse(await fsp.readFile(FIXTURES_FILE, "utf8"));
  } catch {
    return null;
  }
}

function unwrap(raw) {
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.fixtures)) return raw.fixtures;
  if (Array.isArray(raw?.items)) return raw.items;
  return [];
}

/** Dosyanın sarmalını (düz dizi / {fixtures:[]}) koruyarak yazar. */
async function writeFile_(list) {
  const raw = await readFile_();
  const out = Array.isArray(raw)
    ? list
    : { ...(raw && typeof raw === "object" ? raw : {}), fixtures: list };

  // ⚠️ GEÇİCİ AD BENZERSİZ OLMALI. Sabit `${file}.tmp` iken eşzamanlı iki
  // yazım aynı geçici dosyada yarışıyor: biri rename ediyor, diğeri
  // ENOENT alıyor. Atomik yazmanın kendisi yarış üretiyordu — eşzamanlılık
  // testi yakaladı. (lib/fileLock.cjs bunu baştan doğru yapıyordu.)
  const tmp = `${FIXTURES_FILE}.tmp-${process.pid}-${Date.now()}-${++_tmpSayac}`;
  await fsp.writeFile(tmp, JSON.stringify(out, null, 2) + "\n", "utf8");
  await fsp.rename(tmp, FIXTURES_FILE);
}

/* ───────────────────────────── genel arayüz ───────────────────────────── */

/**
 * Tüm fikstürleri döndürür. Mongo öncelikli; boş/erişilemezse dosyaya düşer.
 *
 * ⚠️ Mongo BOŞ dönerse dosyaya düşülür. Boş koleksiyon ile "Mongo yok" Mongo
 * tarafında aynı görünüyor — geçiş döneminde dosya hâlâ gerçek yedek.
 */
async function loadAll(db) {
  const conn = await getDbSafe(db);
  if (conn) {
    try {
      await ensureIndexes(conn);
      const docs = await conn.collection(COLL).find({}).toArray();
      if (docs.length) return docs.map(strip);
    } catch (e) {
      console.error("[fixtures-store] mongo okunamadi, dosyaya dusuluyor:", e?.message || e);
    }
  }
  return unwrap(await readFile_());
}

/**
 * Tüm fikstürleri yazar (tam liste — bkz. dosya başı: değiştirme semantiği).
 * @returns {Promise<{mongo:boolean, file:boolean, count:number, deleted:number}>}
 */
async function saveAll(list, db) {
  const items = (Array.isArray(list) ? list : []).filter((f) => f && f.fixtureId != null);
  const sonuc = { mongo: false, file: false, count: items.length, deleted: 0 };

  const conn = await getDbSafe(db);
  if (conn && items.length) {
    try {
      await ensureIndexes(conn);
      const col = conn.collection(COLL);
      const ids = items.map((f) => String(f.fixtureId));

      await col.bulkWrite(
        items.map((f) => ({
          updateOne: {
            filter: { fixtureId: String(f.fixtureId) },
            update: { $set: { ...f, fixtureId: String(f.fixtureId) } },
            upsert: true,
          },
        })),
        { ordered: false }
      );

      // Listede olmayanlar silinir — dosya yazımı da tam değiştirme yapıyordu.
      const r = await col.deleteMany({ fixtureId: { $nin: ids } });
      sonuc.deleted = r?.deletedCount || 0;
      sonuc.mongo = true;
    } catch (e) {
      // Sessiz kalmıyoruz: yazılamayan fikstür, yeniden başlatmada kaybolur.
      console.error("[fixtures-store] mongo yazilamadi:", e?.message || e);
    }
  }

  if (mirrorOn() || !sonuc.mongo) {
    try {
      await writeFile_(items);
      sonuc.file = true;
    } catch (e) {
      console.error("[fixtures-store] dosya yazilamadi:", e?.message || e);
    }
  }

  return sonuc;
}

module.exports = {
  loadAll,
  saveAll,
  COLL,
  FIXTURES_FILE,
  _unwrap: unwrap,
  _mirrorOn: mirrorOn,
};
