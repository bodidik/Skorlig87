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
    await col.createIndex({ computedAt: -1 }, { background: true });
    // Kullanıcının maç geçmişi sorgusu için (rows dizisi üzerinde multikey).
    await col.createIndex({ "rows.userIdLower": 1 }, { background: true });
  } catch (e) {
    console.error("[match-results] indeks kurulamadi:", e.message || e);
  }
  })();
  return _indexPromise;
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

    /* ⚠️ ÖDÜL MÜHRÜ SİLİNEMEZ.
     *
     * Yazma `$set: { ...next }` — çağıranın verdiği nesne belgeyi olduğu gibi
     * eziyor. `awardedAt` ise settle2'nin çift-ödeme koruması: bir kez
     * yazıldıktan sonra `claimAward` bir daha mühür vermiyor ve fixture tekrar
     * ödenmiyor.
     *
     * Bugün tek çağıran (`routes/settle2.cjs`) mührü elle taşıyor
     * (`awardedAt: existing?.awardedAt || ...`). Ama bu, korumanın ÇAĞIRANIN
     * HATIRLAMASINA bağlı olması demek: ikinci bir çağıran ya da o satırın
     * düşmesi mührü sessizce siler ve maç YENİDEN ÖDENİR.
     *
     * Bu oturumun tekrar eden dersi, korumanın unutulamayacağı yere konması.
     * Depo artık mührü kendisi savunuyor: bir kez atılmışsa geri alınamaz.
     */
    if (existing?.awardedAt && !next.awardedAt) {
      console.warn(
        `[match-results] ${fid}: yazma odul muhrunu silmeye calisti — muhur korundu ` +
        `(${existing.awardedAt})`
      );
      next.awardedAt = existing.awardedAt;
    }

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

/**
 * ÖDÜL MÜHRÜNÜ ATOMİK OLARAK ALIR. Yalnızca kazanan çağrı true döner.
 *
 * ⚠️ BU BİR PARA KORUMASI — ve settle2'deki eski kullanım kırıktı.
 * Akış şöyleydi:
 *     1) getSnapshot(fid) oku → awardedAt var mı?
 *     2) yoksa ~90 satır boyunca LC dağıt, sezon toplamlarını işle
 *     3) EN SONDA awardedAt'i yaz
 * Kontrol ile mühür arasındaki pencere tüm ödül dağıtımı kadar genişti.
 * livescore-sync 30 saniyede bir, af-sync ayrıca ve manuel çağrılar da aynı
 * fixture'ı settle2'ye gönderiyor (kodun kendi yorumu bunu söylüyor). İki
 * çağrı pencereye girerse İKİSİ de kontrolü geçip ödülü İKİ KEZ dağıtır.
 *
 * Burada koşul yazmanın içinde: `awardedAt` yoksa yazılır, varsa hiçbir şey
 * yapılmaz. `upsert` şart, çünkü snapshot henüz yaratılmamış olabilir —
 * mühür ödül dağıtımından ÖNCE alınır.
 *
 * TASARIM TERCİHİ: mühür önce alınır. Settle ortasında bir hata olursa maç
 * "ödüllendirildi" işaretli kalır ama ödüller eksik olabilir — bu, admin'in
 * görüp düzeltebileceği bir durum. Alternatifi (mührü sona bırakmak) sessiz
 * ÇİFT ÖDÜL demek; ekonomiye para basar ve kimse fark etmez.
 *
 * @returns {Promise<boolean>} mührü BU çağrı aldıysa true (ödülü sen dağıt)
 */
async function claimAward(fixtureId, awardedAt, db) {
  const fid = normFid(fixtureId);
  if (!fid) return false;
  const damga = awardedAt || new Date().toISOString();

  if (db) {
    try {
      await ensureIndexes(db);
      const col = db.collection(COLL);

      // ⚠️ İKİ ADIM, TEK ADIMDA OLMAZ. `upsert: true` ile KOŞULLU filtre
      // birlikte kullanılınca filtre eşleşmediğinde Mongo YENİ BELGE EKLER —
      // yani mühür zaten alınmışken ikinci bir kayıt oluşur ve her çağrı
      // "kazandım" sanır. Test bunu yakaladı (20 çağrının 20'si true döndü).
      //
      // 1) Belge VARLIĞINI garantile (koşulsuz upsert, mühüre dokunmadan).
      await col.updateOne(
        { fixtureId: fid },
        { $setOnInsert: { fixtureId: fid, awardedAt: null, rows: [] } },
        { upsert: true }
      );

      // 2) Mührü KOŞULLU al (upsert YOK — eşleşmezse hiçbir şey olmaz).
      const r = await col.updateOne(
        { fixtureId: fid, $or: [{ awardedAt: null }, { awardedAt: { $exists: false } }] },
        { $set: { awardedAt: damga } }
      );
      if (!(r.modifiedCount > 0)) return false;
      if (FILE_MIRROR) {
        try {
          await withFileLock(FILE, async () => {
            const book = await readBook();
            const i = book.items.findIndex((x) => normFid(x?.fixtureId) === fid);
            if (i >= 0) book.items[i].awardedAt = book.items[i].awardedAt || damga;
            else book.items.push({ fixtureId: fid, awardedAt: damga, rows: [] });
            book.updatedAt = new Date().toISOString();
            await writeJsonAtomic(FILE, book);
          });
        } catch (e) {
          console.error("[match-results] muhur aynasi yazilamadi:", e?.message || e);
        }
      }
      return true;
    } catch (e) {
      // Mühür alınamadıysa ÖDÜL DAĞITMA — çift ödül riskini almaktansa
      // dağıtımı atlayıp bir sonraki turda tekrar denemek güvenli.
      console.error("[match-results] muhur alinamadi:", e?.message || e);
      return false;
    }
  }

  // Dosya modu: kilit altında oku-kontrol-yaz (tek süreç).
  try {
    return await withFileLock(FILE, async () => {
      const book = await readBook();
      const i = book.items.findIndex((x) => normFid(x?.fixtureId) === fid);
      if (i >= 0 && book.items[i].awardedAt) return false;
      if (i >= 0) book.items[i].awardedAt = damga;
      else book.items.push({ fixtureId: fid, awardedAt: damga, rows: [] });
      book.updatedAt = new Date().toISOString();
      await writeJsonAtomic(FILE, book);
      return true;
    });
  } catch (e) {
    console.error("[match-results] dosya muhru alinamadi:", e?.message || e);
    return false;
  }
}

module.exports = {
  getSnapshot,
  listSnapshots,
  settledFixtureIds,
  upsertSnapshot,
  claimAward,
  FILE,
  COLL,
  FILE_MIRROR,
};
