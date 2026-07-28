"use strict";

/**
 * ELLE EKLENEN FİKSTÜRLER — kalıcı depo.
 *
 * NEDEN VAR: `data/fixtures.json` Render'da kalıcı disk olmadığı için her
 * deploy'da siliniyor. FDO maçları bunu umursamaz — açılışta API'den yeniden
 * çekilirler. Ama ADMIN'İN ELLE GİRDİĞİ maçlar hiçbir yerden geri gelmez:
 * yazılır, görünür, ilk deploy'da yok olur. Sessiz kayıp; kimse hata görmez,
 * maç listeden düşer.
 *
 * Sezon başlamadığı için FDO Türkiye'yi kapsamıyor ve Türk kullanıcıya maç
 * göstermenin tek yolu şu an elle giriş — yani bu kayıp doğrudan "ekranda hiç
 * maç yok" demek.
 *
 * Burası yalnızca MANUEL kayıtları tutar. Sağlayıcıdan gelenler (FDO, MK)
 * kendi senkronlarının işi; onları Mongo'ya kopyalamak gereksiz yazma olurdu.
 *
 * Mongo yoksa sessizce devre dışı kalır — dosya zaten tek kaynaktır.
 */

const COLL = "manual_fixtures";

let _indexed = false;
async function ensureIndexes(db) {
  if (_indexed || !db) return;
  _indexed = true;
  try {
    const col = db.collection(COLL);
    await col.createIndex({ fixtureId: 1 }, { unique: true, background: true });
    // Geçmiş kayıtları ayıklamak için.
    await col.createIndex({ kickoffISO: 1 }, { background: true });
  } catch (e) {
    console.error("[manual-fixtures] indeks kurulamadi:", e.message || e);
  }
}

function strip(doc) {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return rest;
}

/** Elle eklenen bir fikstürü kalıcı yaz (idempotent). */
async function save(fixture, db) {
  if (!db || !fixture?.fixtureId) return false;
  await ensureIndexes(db);
  try {
    await db.collection(COLL).updateOne(
      { fixtureId: String(fixture.fixtureId) },
      { $set: { ...fixture, fixtureId: String(fixture.fixtureId) } },
      { upsert: true }
    );
    return true;
  } catch (e) {
    console.error("[manual-fixtures] yazilamadi:", e.message || e);
    return false;
  }
}

/** Elle eklenen fikstürü kalıcı olarak sil. */
async function remove(fixtureId, db) {
  if (!db || !fixtureId) return false;
  await ensureIndexes(db);
  try {
    const r = await db.collection(COLL).deleteOne({ fixtureId: String(fixtureId) });
    return r.deletedCount > 0;
  } catch (e) {
    console.error("[manual-fixtures] silinemedi:", e.message || e);
    return false;
  }
}

/**
 * Kalıcı depodaki tüm elle eklenen fikstürler.
 * `sinceDays`: bu kadar gün öncesinden eskiler atlanır (geçmiş maçlar
 * listeyi şişirmesin). null = hepsi.
 */
async function list(db, sinceDays = 30) {
  if (!db) return [];
  await ensureIndexes(db);
  try {
    const q = {};
    if (sinceDays != null) {
      const esik = new Date(Date.now() - sinceDays * 86400000).toISOString();
      q.kickoffISO = { $gte: esik };
    }
    return (await db.collection(COLL).find(q).toArray()).map(strip);
  } catch (e) {
    console.error("[manual-fixtures] okunamadi:", e.message || e);
    return [];
  }
}

module.exports = { save, remove, list, COLL };
