"use strict";

/**
 * MAÇ SONUCU SNAPSHOT DEPOSU — Mongo varsa Mongo, yoksa dosya.
 *
 * NEDEN: `data/match-results.json` tek bir JSON dosyasıydı ve HER settle'da
 * tamamı yeniden yazılıyordu. Her kayıt maçın TÜM sıralamasını gömdüğü için
 * (ölçüldü: 15 kayıt / 5.3 MB, kayıt başına ~408 KB) maliyet geçmişteki maç
 * sayısıyla doğrusal büyüyor — yani sistem yaşlandıkça her settle yavaşlıyor.
 *
 * ⚠️ KIRPMA ÇÖZÜM DEĞİL: dosyadaki `awardedAt` aynı zamanda çift-ödül
 * mührüdür ve `livescore-sync` "hangi maçlar sonuçlandı" bilgisini buradan
 * alır. Eski kayıtları atmak, o maçların yeniden sonuçlandırılıp ödüllerin
 * İKİNCİ kez dağıtılmasına yol açardı. Bu yüzden çözüm indeksli depo.
 *
 * Mongo modunda `match_results` koleksiyonu kullanılır; fixtureId benzersiz
 * indekslidir, sorgular tam tarama yapmaz.
 *
 * Geçiş bayrağı: SKORLIG_MATCHRESULTS_FILE_MIRROR (varsayılan 1 = dosya da yazılır)
 * Mongo yoksa bayrak YOK SAYILIR — dosya tek kaynaktır, veri kaybı olmaz.
 */

const path = require("path");
const fsp = require("fs").promises;
const { withFileLock, writeJsonAtomic } = require("./fileLock.cjs");

const DATA_DIR = process.env.SKORLIG_DATA_DIR || path.join(__dirname, "..", "data");
const FILE = path.join(DATA_DIR, "match-results.json");
const COLL = "match_results";

const FILE_MIRROR =
  String(process.env.SKORLIG_MATCHRESULTS_FILE_MIRROR ?? "1") !== "0";

function normFid(x) {
  return String(x || "").trim();
}

async function readBook() {
  try {
    const raw = JSON.parse(await fsp.readFile(FILE, "utf8"));
    if (Array.isArray(raw)) return { items: raw, updatedAt: null };
    return { items: Array.isArray(raw.items) ? raw.items : [], updatedAt: raw.updatedAt ?? null };
  } catch {
    return { items: [], updatedAt: null };
  }
}

let _indexed = false;
async function ensureIndexes(db) {
  if (_indexed || !db) return;
  _indexed = true;
  try {
    const col = db.collection(COLL);
    await col.createIndex({ fixtureId: 1 }, { unique: true, background: true });
    await col.createIndex({ computedAt: -1 }, { background: true });
    // Kullanıcının maç geçmişi sorgusu için (rows dizisi üzerinde multikey).
    await col.createIndex({ "rows.userIdLower": 1 }, { background: true });
  } catch (e) {
    console.error("[match-results] indeks kurulamadi:", e.message || e);
  }
}

/* ── Okuma ────────────────────────────────────────────────────────────── */

/** Tek maçın snapshot'ı (yoksa null). */
async function getSnapshot(fixtureId, db) {
  const fid = normFid(fixtureId);
  if (!fid) return null;

  if (db) {
    await ensureIndexes(db);
    return db.collection(COLL).findOne({ fixtureId: fid }, { projection: { _id: 0 } });
  }
  const book = await readBook();
  return book.items.find((x) => normFid(x?.fixtureId) === fid) || null;
}

/**
 * Snapshot listesi.
 * @param {object} o
 * @param {string} [o.sinceISO]      bu tarihten sonra hesaplananlar
 * @param {string[]} [o.fixtureIds]  yalnızca bu maçlar
 * @param {boolean} [o.settledOnly]  yalnızca ödülü dağıtılmış olanlar
 * @param {string} [o.userIdLower]   satırlarında bu kullanıcı geçenler
 */
async function listSnapshots({ db = null, sinceISO, fixtureIds, settledOnly, userIdLower } = {}) {
  if (db) {
    await ensureIndexes(db);
    const q = {};
    if (sinceISO) q.computedAt = { $gte: sinceISO };
    if (Array.isArray(fixtureIds) && fixtureIds.length) q.fixtureId = { $in: fixtureIds.map(normFid) };
    if (settledOnly) q.awardedAt = { $ne: null };
    if (userIdLower) q["rows.userIdLower"] = userIdLower;
    return db.collection(COLL).find(q, { projection: { _id: 0 } }).toArray();
  }

  const book = await readBook();
  let out = book.items;
  if (sinceISO) out = out.filter((s) => String(s?.computedAt || "") >= sinceISO);
  if (Array.isArray(fixtureIds) && fixtureIds.length) {
    const set = new Set(fixtureIds.map(normFid));
    out = out.filter((s) => set.has(normFid(s?.fixtureId)));
  }
  if (settledOnly) out = out.filter((s) => !!s?.awardedAt);
  if (userIdLower) {
    // `userIdLower` yeni kayıtlarda hazır gelir; eski kayıtlarda yoktur, o
    // yüzden userId'den de türetilir (geriye uyumluluk).
    out = out.filter((s) =>
      (Array.isArray(s?.rows) ? s.rows : []).some(
        (r) => (r?.userIdLower || String(r?.userId || "").toLowerCase()) === userIdLower
      )
    );
  }
  return out;
}

/**
 * Sonuçlandırılmış maç kimlikleri (Set).
 * livescore-sync yalnızca bunu ister; tüm snapshot'ları çekmek gereksizdir.
 */
async function settledFixtureIds(db) {
  if (db) {
    await ensureIndexes(db);
    const docs = await db
      .collection(COLL)
      .find({}, { projection: { fixtureId: 1, _id: 0 } })
      .toArray();
    return new Set(docs.map((d) => normFid(d.fixtureId)));
  }
  const book = await readBook();
  return new Set(book.items.map((x) => normFid(x?.fixtureId)));
}

/* ── Yazma ────────────────────────────────────────────────────────────── */

/**
 * Snapshot ekle/güncelle. `mutate(mevcut)` yeni kaydı döndürmelidir —
 * böylece "oku → karar ver → yaz" tek kilit altında olur (idempotency mührü).
 */
async function upsertSnapshot(fixtureId, mutate, db) {
  const fid = normFid(fixtureId);
  if (!fid) return null;

  const needFile = !db || FILE_MIRROR;

  const run = async () => {
    const existing = await getSnapshot(fid, db);
    const raw = await mutate(existing || null);
    if (!raw) return existing || null;

    // Satırlara `userIdLower` eklenir. Mongo'da kullanıcı geçmişi sorgusu
    // (`rows.userIdLower`) dizi içi alan eşleşmesiyle çalışır ve büyük/küçük
    // harf duyarsız arama için ayrı bir alan gerekir; yoksa sorgu SESSİZCE
    // boş döner (test bunu yakaladı: dosya modu 1, Mongo modu 0 kayıt).
    const next = {
      ...raw,
      rows: (Array.isArray(raw.rows) ? raw.rows : []).map((r) => ({
        ...r,
        userIdLower: String(r?.userId || "").toLowerCase(),
      })),
    };

    if (db) {
      await ensureIndexes(db);
      await db.collection(COLL).updateOne(
        { fixtureId: fid },
        { $set: { ...next, fixtureId: fid } },
        { upsert: true }
      );
    }

    if (needFile) {
      const book = await readBook();
      const i = book.items.findIndex((x) => normFid(x?.fixtureId) === fid);
      if (i >= 0) book.items[i] = { ...next, fixtureId: fid };
      else book.items.push({ ...next, fixtureId: fid });
      book.updatedAt = new Date().toISOString();
      await writeJsonAtomic(FILE, book);
    }

    return next;
  };

  // Dosya yazılacaksa kilit şart (tam dosya read-modify-write).
  // Yalnızca Mongo ise kilit gereksiz; upsert tek atomik işlemdir.
  return needFile ? withFileLock(FILE, run) : run();
}

module.exports = {
  getSnapshot,
  listSnapshots,
  settledFixtureIds,
  upsertSnapshot,
  FILE,
  COLL,
  FILE_MIRROR,
};
