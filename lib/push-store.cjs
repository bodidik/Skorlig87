"use strict";

/**
 * BİLDİRİM JETONLARI VE TERCİHLERİ — Mongo birincil, dosya ayna.
 *
 * ⚠️ NEDEN VAR: `data/push-tokens.json` Render'da her deploy'da siliniyordu.
 * Bu, gruplar/arkadaşlar/düellolar/seriler/moderasyon için düzeltilen sınıfın
 * aynısı — push atlanmıştı.
 *
 * İKİ AYRI KAYIP, ikincisi daha kötü:
 *
 *   1) JETONLAR. İstemci her açılışta yeniden kaydoluyor (_layout.tsx), yani
 *      uygulamayı AÇAN kullanıcı jetonunu geri kazanıyor. Ama bildirimin
 *      amacı tam da AÇMAYANI geri getirmek; onlar bir daha hiç bildirim
 *      almıyordu. Yani özellik en çok ihtiyaç duyulan kişide çalışmıyordu.
 *
 *   2) TERCİHLER. Bildirimi KAPATAN kullanıcının tercihi de siliniyor ve
 *      varsayılana dönüyordu: kapattığı bildirimi yeniden almaya başlıyordu.
 *      İstenmeyen bildirim, kaçırılan bildirimden daha çok uygulama sildirir.
 *
 * KULLANICI BAŞINA BELGE: jeton listesi ve tercihler birlikte tutulur; farklı
 * kullanıcılar birbirine hiç değmez (tüm haritayı okuyup geri yazma yok).
 */

const path = require("path");
const fsp = require("fs").promises;

const COLL = "push_tokens";
const DATA_DIR = process.env.SKORLIG_DATA_DIR || path.join(__dirname, "..", "data");
const FILE = path.join(DATA_DIR, "push-tokens.json");

/** ⚠️ MONGODB_URI yoksa YOK SAYILIR (dosya tek kaynaktır). */
const FILE_MIRROR = String(process.env.SKORLIG_PUSH_FILE_MIRROR ?? "1") !== "0";
const mirrorOn = () => FILE_MIRROR || !process.env.MONGODB_URI;

// bkz. diğer depolar: BAYRAK DEĞİL SÖZ önbeklenir. Bayrak `await createIndex`
// bitmeden kalkarsa eşzamanlı ikinci çağrı indeks HENÜZ YOKKEN upsert yapar ve
// aynı kullanıcıya kopya belge oluşur.
let _indexPromise = null;
function ensureIndexes(db) {
  if (!db) return Promise.resolve();
  if (_indexPromise) return _indexPromise;
  _indexPromise = (async () => {
    try {
      await db.collection(COLL).createIndex({ userIdLower: 1 }, { unique: true, background: true });
    } catch (e) {
      console.error("[push-store] indeks kurulamadi:", e?.message || e);
      /* ⚠️ GECICI ARIZADA ONBELLEGI DUSUR — yoksa hata KALICI olur.
      * Soz bir kez cozulunce ensureIndexes bir daha hic denemez; tek bir
      * gecici Mongo hatasi indeksleri SUREC BOYUNCA kurulmamis birakir.
      * OLCULDU (gercek pool-store, ilk createIndex cagrisi patlatildi):
      *   indeks: hicbiri  ->  ayni kullanici ayni maca IKI bahis yazabildi
      * Yani kaybolan yalnizca hiz degil, BENZERSIZLIK GARANTISI. */
      _indexPromise = null;
    }
  })();
  return _indexPromise;
}

async function getDbSafe(db) {
  if (db) return db;
  try {
    const { getDb } = require("./mongo.cjs");
    return await getDb();
  } catch {
    return null;
  }
}

const lower = (x) => String(x || "").trim().toLowerCase();

let _tmpSayac = 0;

async function readFile_() {
  try {
    const raw = JSON.parse(await fsp.readFile(FILE, "utf8"));
    return raw && typeof raw === "object" && raw.items ? raw : { items: {} };
  } catch {
    return { items: {} };
  }
}

async function writeFile_(store) {
  const tmp = `${FILE}.tmp-${process.pid}-${Date.now()}-${++_tmpSayac}`;
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.writeFile(tmp, JSON.stringify(store, null, 2) + "\n", "utf8");
  await fsp.rename(tmp, FILE);
}

function strip(d) {
  if (!d) return null;
  const { _id, userIdLower, ...rest } = d;
  return rest;
}

/**
 * ⚠️ ANAHTARLAR KÜÇÜK HARFE NORMALİZE EDİLİR — ESKİDEN ORİJİNAL DÜZENDEYDİ.
 *
 * `getUser` harf duyarsız arıyor (`Object.keys().find(k => lower(k) === uid)`),
 * yani bu riskin farkında olan biri orayı özenle yazmış. Ama toplu okuma
 * anahtarları `d.userId` ile, yani ORİJİNAL harf düzeniyle kuruyordu ve tek
 * tüketicisi `services/push.cjs sendToUsers` onları DOĞRUDAN indeksliyordu
 * (`store.items[uid]`). Harf düzeni birebir tutmazsa kayıt bulunamıyor,
 * `continue` ediliyor ve BİLDİRİM SESSİZCE GİTMİYOR — hata yok, log yok.
 *
 * ÖLÇÜLDÜ: "TestAli" olarak kayıtlı kullanıcıya
 *     sendToUsers(["TestAli"]) → 1 mesaj
 *     sendToUsers(["testali"]) → 0 mesaj
 *     sendToUsers(["TESTALI"]) → 0 mesaj
 * `getUser("testali")` ise aynı kaydı BULUYOR — aynı depoda iki okuma yolu
 * ters davranıyordu.
 *
 * Somut tetikleyici: `push-scheduler.cjs:345` sonuç bildirimini leaderboard
 * snapshot satırındaki `row.userId` ile gönderiyor. O alanın harf düzeni
 * güvenilmez — `routes/stats.cjs` aynı alanı okurken `$toLower` ile
 * karşılaştırıyor, yani kod tabanı bunu zaten kabul etmiş durumda.
 *
 * ⚠️ AYNI KULLANICI İKİ DÜZENDE KAYITLIYSA TOKEN'LAR BİRLEŞTİRİLİR. Üzerine
 * yazmak, kullanıcının bir cihazını sessizce bildirim dışı bırakırdı.
 */
function anahtarlariNormalizeEt(items) {
  const out = {};
  for (const [k, v] of Object.entries(items || {})) {
    const lk = lower(k);
    if (!lk) continue;
    if (out[lk]) {
      const tokens = [...new Set([...(out[lk].tokens || []), ...(v.tokens || [])])];
      out[lk] = { ...out[lk], ...v, tokens };
    } else {
      out[lk] = v;
    }
  }
  return out;
}

/** Tüm kayıtlar (gönderim taraması için) — `{ items: { <küçük-harf-uid>: {...} } }`. */
async function loadStore(db) {
  const conn = await getDbSafe(db);
  if (conn) {
    try {
      await ensureIndexes(conn);
      const docs = await conn.collection(COLL).find({}).toArray();
      if (docs.length) {
        const items = {};
        for (const d of docs) items[d.userIdLower || d.userId] = strip(d);
        return { items: anahtarlariNormalizeEt(items) };
      }
      // Koleksiyon boş → dosyadan bir kez taşı (ilk çalıştırma).
      const dosya = await readFile_();
      const girdiler = Object.entries(dosya.items || {});
      if (girdiler.length) {
        console.warn(
          `[push-store] TOHUMLAMA: koleksiyon bos, dosyadan ${girdiler.length} kayit yaziliyor.`
        );
        await conn.collection(COLL).bulkWrite(
          girdiler.map(([uid, rec]) => ({
            updateOne: {
              filter: { userIdLower: lower(uid) },
              update: { $set: { ...rec, userId: uid, userIdLower: lower(uid) } },
              upsert: true,
            },
          })),
          { ordered: false }
        );
      }
      return { items: anahtarlariNormalizeEt(dosya.items) };
    } catch (e) {
      console.error("[push-store] mongo okunamadi, dosyaya dusuluyor:", e?.message || e);
    }
  }
  const dosya = await readFile_();
  return { items: anahtarlariNormalizeEt(dosya.items) };
}

/** Tek kullanıcının kaydı (yoksa null). */
async function getUser(userId, db) {
  const uid = lower(userId);
  if (!uid) return null;
  const conn = await getDbSafe(db);
  if (conn) {
    try {
      await ensureIndexes(conn);
      const d = await conn.collection(COLL).findOne({ userIdLower: uid });
      if (d) return strip(d);
    } catch (e) {
      console.error("[push-store] kullanici okunamadi:", e?.message || e);
    }
  }
  const store = await readFile_();
  const anahtar = Object.keys(store.items || {}).find((k) => lower(k) === uid);
  return anahtar ? store.items[anahtar] : null;
}

/**
 * Tek kullanıcının kaydını yazar (upsert). Diğer kullanıcılara DOKUNMAZ.
 * `rec` tam kayıttır: `{ userId, tokens, prefs, updatedAt }`.
 */
async function saveUser(userId, rec, db) {
  const uid = lower(userId);
  if (!uid) return { ok: false };

  const conn = await getDbSafe(db);
  let ok = false;
  if (conn) {
    try {
      await ensureIndexes(conn);
      await conn.collection(COLL).updateOne(
        { userIdLower: uid },
        { $set: { ...rec, userId: rec.userId || userId, userIdLower: uid } },
        { upsert: true }
      );
      ok = true;
    } catch (e) {
      // Sessiz kalmıyoruz: yazılamayan tercih, kapatılan bildirimin geri
      // açılması demek.
      console.error("[push-store] mongo yazilamadi:", e?.message || e);
    }
  }

  if (mirrorOn() || !ok) {
    try {
      const store = await readFile_();
      if (!store.items) store.items = {};
      store.items[rec.userId || userId] = rec;
      await writeFile_(store);
    } catch (e) {
      console.error("[push-store] dosya yazilamadi:", e?.message || e);
    }
  }
  return { ok };
}

/** Jetonu belirli kullanıcı HARİCİNDE tüm kayıtlardan söker. */
async function revokeTokenFrom(token, exceptUid, db) {
  const conn = await getDbSafe(db);
  if (!conn) return 0;
  try {
    await ensureIndexes(conn);
    const r = await conn.collection(COLL).updateMany(
      { userIdLower: { $ne: lower(exceptUid) }, tokens: token },
      { $pull: { tokens: token } }
    );
    return r.modifiedCount || 0;
  } catch (e) {
    console.error("[push-store] jeton sokulemedi:", e?.message || e);
    return 0;
  }
}

/** Geçersiz jetonları topluca siler. */
async function pullBadTokens(badTokens, db) {
  const bad = badTokens.filter(Boolean);
  if (!bad.length) return 0;
  const conn = await getDbSafe(db);
  if (!conn) return 0;
  try {
    await ensureIndexes(conn);
    const r = await conn.collection(COLL).updateMany(
      { tokens: { $in: bad } },
      { $pullAll: { tokens: bad } }
    );
    return r.modifiedCount || 0;
  } catch (e) {
    console.error("[push-store] jeton temizlenemedi:", e?.message || e);
    return 0;
  }
}

/** Kullanıcının kaydını siler (hesap silme akışı). */
async function removeUser(userId, db) {
  const uid = lower(userId);
  if (!uid) return { ok: false };
  const conn = await getDbSafe(db);
  if (conn) {
    try {
      await ensureIndexes(conn);
      await conn.collection(COLL).deleteOne({ userIdLower: uid });
    } catch (e) {
      console.error("[push-store] kullanici silinemedi:", e?.message || e);
    }
  }
  if (mirrorOn()) {
    try {
      const store = await readFile_();
      for (const k of Object.keys(store.items || {})) {
        if (lower(k) === uid) delete store.items[k];
      }
      await writeFile_(store);
    } catch { /* ayna hatası akışı durdurmaz */ }
  }
  return { ok: true };
}

/**
 * TÜM HARİTAYI yazar (services/push.cjs mevcut deseni: oku → değiştir → yaz).
 *
 * ⚠️ Kayıt-başına `saveUser` tercih edilir; bu fonksiyon yalnızca mevcut
 * mantığı DEĞİŞTİRMEDEN Mongo'ya taşımak için var. Aynı jetonu başka hesaptan
 * sökme adımı tüm haritayı görmeyi gerektiriyor, o yüzden bölünmedi.
 *
 * Listede olmayan kullanıcılar SİLİNİR — çağıran zaten tam haritayı yazıyor.
 */
async function saveStore(store, db) {
  const items = (store && store.items) || {};
  const girdiler = Object.entries(items).filter(([uid]) => lower(uid));

  const conn = await getDbSafe(db);
  let ok = false;
  if (conn) {
    try {
      await ensureIndexes(conn);
      const col = conn.collection(COLL);
      if (girdiler.length) {
        await col.bulkWrite(
          girdiler.map(([uid, rec]) => ({
            updateOne: {
              filter: { userIdLower: lower(uid) },
              update: { $set: { ...rec, userId: uid, userIdLower: lower(uid) } },
              upsert: true,
            },
          })),
          { ordered: false }
        );
      }
      const anahtarlar = girdiler.map(([uid]) => lower(uid));
      await col.deleteMany({ userIdLower: { $nin: anahtarlar } });
      ok = true;
    } catch (e) {
      console.error("[push-store] harita yazilamadi:", e?.message || e);
    }
  }

  if (mirrorOn() || !ok) {
    try {
      await writeFile_({ items });
    } catch (e) {
      console.error("[push-store] dosya yazilamadi:", e?.message || e);
    }
  }
  return { ok };
}

module.exports = { loadStore, saveStore, getUser, saveUser, removeUser,
  revokeTokenFrom, pullBadTokens, COLL, FILE };
