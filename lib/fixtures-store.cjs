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
/* ────────────────────────────────────────────────────────────────────────────
 * TÜM LİSTE İÇİN KISA ÖMÜRLÜ SÜREÇ İÇİ ÖNBELLEK
 *
 * ⚠️ NEDEN: `loadAll()` üretimde ÖLÇÜLDÜ — 1875 fikstür için **1706 ms**.
 * Ve 12 ayrı yerden çağrılıyor (mini.cjs tek başına 4 kez, team.cjs,
 * push-scheduler, livescore-sync, bot-filler, live2/schedule...). Maç listesi
 * ucu bu yüzden tek istekte saniyeler harcıyordu; ölçüm zinciri:
 *     loadAll 1.7s + sortByPriority 1.1s + ... = izole ~7s,
 *     arka plan senkronuyla çekişince 40s+ (mobilin 15s zaman aşımının üstü).
 *
 * ⚠️ ÖNBELLEK GÜVENLİ, ÇÜNKÜ `fixtures` KOLEKSİYONUNA TEK YAZAN `saveAll`.
 * Doğrulandı: `lib/bayat-mac.cjs` yalnızca okuyor (findOne + projection),
 * `lib/manual-fixtures.cjs` BAŞKA koleksiyon (`manual_fixtures`). Bu yüzden
 * `saveAll` içinde önbellek düşürülüyor ve tazelik korunuyor.
 *
 * ⚠️ TTL YİNE DE VAR (30 sn) — geçersiz kılma tek başına yeterli değil:
 * ileride biri koleksiyona doğrudan yazarsa ya da başka bir SÜREÇ (Render'da
 * ikinci instance, migration betiği) yazarsa geçersiz kılma o süreçte
 * çalışmaz. TTL o durumda bayatlığın üst sınırıdır.
 *
 * ⚠️ DİZİ KOPYASI DÖNÜYOR. Çağıranların bir kısmı listeyi yerinde sıralıyor/
 * değiştiriyor; aynı diziyi paylaştırsaydım önbellek sessizce bozulurdu.
 * Kopya sığ: öğe NESNELERİ paylaşılıyor (1875 referans kopyalamak
 * mikrosaniye). Öğeyi değiştiren çağıran zaten ardından `saveAll` çağırıyor,
 * o da önbelleği düşürüyor.
 * ──────────────────────────────────────────────────────────────────────── */
const CACHE_MS = Number(process.env.SKORLIG_FIXTURES_CACHE_MS ?? 30000);

let _cacheItems = null;
let _cacheAt = 0;
let _ucusan = null; // uçuşan okuma sözü

/** Önbelleği düşürür. `saveAll` sonrası ve testlerde çağrılır. */
function invalidateCache() {
  _cacheItems = null;
  _cacheAt = 0;
}

async function _loadAllTaze(db) {
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
 * @param {object} [db]
 * @param {{taze?: boolean}} [opt] `taze:true` → önbelleği ATLA.
 *
 * ⚠️ OKU-DEĞİŞTİR-YAZ YOLLARI `taze: true` KULLANMAK ZORUNDA. `saveAll`
 * TAM DEĞİŞTİRME yapıyor (listede olmayan belgeler SİLİNİYOR). Bayat bir
 * liste okunup üzerine yazılırsa, arada eklenen maçlar silinir — sessiz
 * VERİ KAYBI. Süreç içindeki yazmalar önbelleği düşürdüğü için risk yalnızca
 * BAŞKA süreçten (migration betiği, ikinci instance) gelir, ama önbellek
 * penceresi kadar gerçektir.
 *
 * Bu yüzden `services/fixture-sync.cjs` içindeki `readFixtures()` — ki dört
 * oku-değiştir-yaz noktasını besliyor — taze okuyor. Salt-okuyan sıcak
 * yollar (live2, mini, team, push-scheduler) önbelleği kullanmaya devam
 * ediyor; kazanç zaten oradan geliyor.
 */
async function loadAll(db, opt) {
  if (opt?.taze) return _loadAllTaze(db);

  if (CACHE_MS > 0 && _cacheItems && Date.now() - _cacheAt < CACHE_MS) {
    return _cacheItems.slice();
  }

  /* ⚠️ UÇUŞAN İSTEK PAYLAŞILIYOR. Soğuk önbellekte aynı anda gelen N istek
   * yoksa N ayrı Mongo taraması başlatır — tam da yavaşlığın en çok
   * hissedildiği anda (istekler birikmişken) yükü katlardı. */
  if (_ucusan) return (await _ucusan).slice();

  _ucusan = _loadAllTaze(db)
    .then((items) => {
      if (CACHE_MS > 0) { _cacheItems = items; _cacheAt = Date.now(); }
      return items;
    })
    .finally(() => { _ucusan = null; });

  return (await _ucusan).slice();
}

/**
 * Tüm fikstürleri yazar (tam liste — bkz. dosya başı: değiştirme semantiği).
 * @returns {Promise<{mongo:boolean, file:boolean, count:number, deleted:number}>}
 */
/**
 * TEK FİKSTÜR — indeksli arama.
 *
 * ⚠️ NEDEN AYRI FONKSİYON: tek bir maçı bulmak için her yerde `loadAll()`
 * çağrılıp sonuç bellekte süzülüyordu. Üretimde ÖLÇÜLDÜ (2026-07-31):
 * 639 fikstür = 169 KB çekiliyor, aranan belge 271 bayt. 639 KAT israf.
 *
 * Bu sıcak bir yol: düello kurulumu, havuz bahsi ve düello ekranının her
 * açılışı bu aramayı yapıyor. Üstelik maliyet fikstür sayısıyla BÜYÜYOR.
 * `fixtureId` üzerinde benzersiz indeks zaten vardı — kullanılmıyordu.
 *
 * ⚠️ DOSYAYA DÜŞME SEMANTİĞİ `loadAll` İLE AYNI TUTULDU: Mongo'da belge
 * BULUNAMAMASI ile Mongo'nun BOŞ olması farklı şeyler. Yalnızca koleksiyon
 * boşken dosyaya düşülür; doluysa "yok" cevabı gerçek cevaptır. Aksi hâlde
 * her bilinmeyen fixtureId 169 KB'lık dosya okuması tetiklerdi.
 *
 * @param {string} fixtureId
 * @param {*} [db]
 * @returns {Promise<object|null>}
 */
async function getOne(fixtureId, db) {
  const fid = String(fixtureId || "").trim();
  if (!fid) return null;

  const conn = await getDbSafe(db);
  if (conn) {
    try {
      await ensureIndexes(conn);
      const col = conn.collection(COLL);
      const doc = await col.findOne({ fixtureId: fid });
      if (doc) return strip(doc);
      // Koleksiyon doluysa "yok" gerçek cevaptır; boşsa dosyaya düşülür.
      if (await col.estimatedDocumentCount()) return null;
    } catch (e) {
      console.error("[fixtures-store] tekil okuma basarisiz, dosyaya dusuluyor:", e?.message || e);
    }
  }

  const liste = unwrap(await readFile_());
  return (liste || []).find((f) => String(f?.fixtureId || "") === fid) || null;
}

async function saveAll(list, db) {
  const items = (Array.isArray(list) ? list : []).filter((f) => f && f.fixtureId != null);
  const sonuc = { mongo: false, file: false, count: items.length, deleted: 0 };

  /* ⚠️ ÖNBELLEK EN BAŞTA DÜŞÜRÜLÜYOR, sonda değil: yazma sırasında gelen bir
   * `loadAll` eski listeyi önbelleğe geri koyabilirdi. Yazma başarısız olsa
   * bile düşürmek zararsız — yalnızca bir kez daha okunur. */
  invalidateCache();

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

  /* ⚠️ İKİNCİ KEZ DÜŞÜRÜLÜYOR — VE İKİSİ DE GEREKLİ. Yalnızca baştaki
   * düşürme yetmez: yazma SÜRERKEN gelen bir `loadAll` Mongo'dan HENÜZ ESKİ
   * olan listeyi okuyup önbelleğe koyabilir; yazma bitince önbellek bayat
   * kalırdı. Yalnızca sondaki de yetmez: baştan düşürmezsek yazma boyunca
   * eski önbellek servis edilir. */
  invalidateCache();

  return sonuc;
}

module.exports = {
  loadAll,
  getOne,
  saveAll,
  invalidateCache,
  COLL,
  FIXTURES_FILE,
  _unwrap: unwrap,
  _mirrorOn: mirrorOn,
};
