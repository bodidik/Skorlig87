"use strict";

/**
 * YÖNETİM VE YASAK LİSTESİ — admin rolleri + banlı kullanıcılar.
 *
 * ⚠️ BU BİR GÜVENLİK DÜZELTMESİ, sadece veri kaybı değil.
 *
 * `middleware/verifyToken.cjs` her isteği `banned-users.json` üzerinden
 * süzüyor ve dosya okunamazsa şöyle davranıyordu:
 *     catch { _bannedCache = new Set(); }
 * Yani dosya yoksa "kimse yasaklı değil". Render'da kalıcı disk olmadığı için
 * o dosya HER DEPLOY'DA siliniyor → tüm yasaklar sessizce kalkıyordu. Ne hata
 * ne log; yasaklı kullanıcı bir dağıtım sonrası geri dönüyordu.
 *
 * Aynı şey admin listesi için de geçerliydi: `admin-users.json` silinince
 * yönetici hakları sıfırlanıyordu.
 *
 * Fail-open bir güvenlik kontrolü, kontrolün kendisinden daha tehlikeli:
 * "çalışıyor" görünüyor ama korumuyor.
 *
 * Yasak listesi TAM OKUNUR (kullanıcı başına sorgu değil) çünkü
 * verifyToken 60 saniyelik bir küme önbelleği tutuyor — istek başına Mongo
 * turu atmak sıcak yolu yavaşlatırdı. Liste küçük kalır (yasaklı sayısı
 * kullanıcı sayısıyla değil, ihlal sayısıyla büyür).
 */

const path = require("path");
const fsp = require("fs").promises;

const COLL_ADMINS = "admin_users";
const COLL_BANNED = "banned_users";

const DATA_DIR = process.env.SKORLIG_DATA_DIR || path.join(__dirname, "..", "data");
const ADMINS_FILE = path.join(DATA_DIR, "admin-users.json");
const BANNED_FILE = path.join(DATA_DIR, "banned-users.json");

/** ⚠️ MONGODB_URI yoksa YOK SAYILIR (dosya tek kaynaktır). */
const FILE_MIRROR = String(process.env.SKORLIG_MODERATION_FILE_MIRROR ?? "1") !== "0";
const mirrorOn = () => FILE_MIRROR || !process.env.MONGODB_URI;

let _indexPromise = null;
function ensureIndexes(db) {
  if (!db) return Promise.resolve();
  if (_indexPromise) return _indexPromise;
  _indexPromise = (async () => {
    try {
      await db.collection(COLL_ADMINS).createIndex({ userId: 1 }, { unique: true, background: true });
      await db.collection(COLL_BANNED).createIndex({ userId: 1 }, { unique: true, background: true });
    } catch (e) {
      console.error("[moderation-store] indeks kurulamadi:", e?.message || e);
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

const norm = (x) => String(x ?? "").trim().toLowerCase();

let _tmpSayac = 0;
async function readFile_(file, fb) {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"));
  } catch {
    return fb;
  }
}
async function writeFile_(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${++_tmpSayac}`;
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  await fsp.rename(tmp, file);
}

async function tohumla(conn, coll, userIds, etiket) {
  if (!conn || !userIds.length) return;
  try {
    console.warn(
      `[moderation-store] TOHUMLAMA: ${etiket} bos, dosyadan ${userIds.length} kayit yaziliyor. ` +
      `Yerel calistiriyorsan .env'in URETIM veritabanina bakmadigindan emin ol.`
    );
    await conn.collection(coll).bulkWrite(
      userIds.map((u) => ({
        updateOne: { filter: { userId: u }, update: { $set: { userId: u } }, upsert: true },
      })),
      { ordered: false }
    );
  } catch (e) {
    console.error(`[moderation-store] ${etiket} tohumlanamadi:`, e?.message || e);
  }
}

/* ───────────────────────────── admin listesi ───────────────────────────── */

async function listAdmins(db) {
  const conn = await getDbSafe(db);
  if (conn) {
    try {
      await ensureIndexes(conn);
      const docs = await conn.collection(COLL_ADMINS).find({}, { projection: { userId: 1, _id: 0 } }).toArray();
      if (docs.length) return docs.map((d) => d.userId);
    } catch (e) {
      console.error("[moderation-store] adminler okunamadi, dosyaya dusuluyor:", e?.message || e);
    }
  }
  const j = await readFile_(ADMINS_FILE, { items: [] });
  const items = (Array.isArray(j?.items) ? j.items : []).map(norm).filter(Boolean);
  await tohumla(conn, COLL_ADMINS, Array.from(new Set(items)), "admin listesi");
  return Array.from(new Set(items));
}

/** İdempotent: aynı kullanıcı iki kez eklenemez (benzersiz indeks). */
async function addAdmin(userId, db) {
  const uid = norm(userId);
  if (!uid) return false;
  const conn = await getDbSafe(db);
  if (conn) {
    try {
      await ensureIndexes(conn);
      await conn.collection(COLL_ADMINS).updateOne(
        { userId: uid },
        { $set: { userId: uid, addedAt: new Date().toISOString() } },
        { upsert: true }
      );
      if (mirrorOn()) await aynayiTazele(conn, "admins");
      return true;
    } catch (e) {
      console.error("[moderation-store] admin eklenemedi:", e?.message || e);
      return false;
    }
  }
  const list = new Set(await listAdmins(null));
  list.add(uid);
  await writeFile_(ADMINS_FILE, { items: [...list], updatedAt: new Date().toISOString() });
  return true;
}

async function removeAdmin(userId, db) {
  const uid = norm(userId);
  if (!uid) return false;
  const conn = await getDbSafe(db);
  if (conn) {
    try {
      await ensureIndexes(conn);
      await conn.collection(COLL_ADMINS).deleteOne({ userId: uid });
      if (mirrorOn()) await aynayiTazele(conn, "admins");
      return true;
    } catch (e) {
      console.error("[moderation-store] admin silinemedi:", e?.message || e);
      return false;
    }
  }
  const list = (await listAdmins(null)).filter((x) => x !== uid);
  await writeFile_(ADMINS_FILE, { items: list, updatedAt: new Date().toISOString() });
  return true;
}

/* ───────────────────────────── yasak listesi ───────────────────────────── */

/** @returns {Promise<Array<{userId, reason?, bannedAt?}>>} */
async function listBanned(db) {
  const conn = await getDbSafe(db);
  if (conn) {
    try {
      await ensureIndexes(conn);
      const docs = await conn.collection(COLL_BANNED).find({}, { projection: { _id: 0 } }).toArray();
      if (docs.length) return docs;
    } catch (e) {
      // ⚠️ Burada dosyaya düşmek DOĞRU: yasak listesi okunamıyorsa
      // "kimse yasaklı değil" demek fail-open olurdu.
      console.error("[moderation-store] yasak listesi okunamadi, dosyaya dusuluyor:", e?.message || e);
    }
  }
  const j = await readFile_(BANNED_FILE, { items: [] });
  const items = (Array.isArray(j?.items) ? j.items : [])
    .map((x) => (typeof x === "string" ? { userId: norm(x) } : { ...x, userId: norm(x?.userId) }))
    .filter((x) => x.userId);
  await tohumla(conn, COLL_BANNED, items.map((x) => x.userId), "yasak listesi");
  return items;
}

async function ban(userId, meta, db) {
  const uid = norm(userId);
  if (!uid) return false;
  const kayit = { userId: uid, bannedAt: new Date().toISOString(), ...(meta || {}) };
  const conn = await getDbSafe(db);
  if (conn) {
    try {
      await ensureIndexes(conn);
      await conn.collection(COLL_BANNED).updateOne({ userId: uid }, { $set: kayit }, { upsert: true });
      if (mirrorOn()) await aynayiTazele(conn, "banned");
      return true;
    } catch (e) {
      console.error("[moderation-store] yasaklanamadi:", e?.message || e);
      return false;
    }
  }
  const items = (await listBanned(null)).filter((x) => x.userId !== uid);
  items.push(kayit);
  await writeFile_(BANNED_FILE, { items, updatedAt: new Date().toISOString() });
  return true;
}

async function unban(userId, db) {
  const uid = norm(userId);
  if (!uid) return false;
  const conn = await getDbSafe(db);
  if (conn) {
    try {
      await ensureIndexes(conn);
      await conn.collection(COLL_BANNED).deleteOne({ userId: uid });
      if (mirrorOn()) await aynayiTazele(conn, "banned");
      return true;
    } catch (e) {
      console.error("[moderation-store] yasak kaldirilamadi:", e?.message || e);
      return false;
    }
  }
  const items = (await listBanned(null)).filter((x) => x.userId !== uid);
  await writeFile_(BANNED_FILE, { items, updatedAt: new Date().toISOString() });
  return true;
}

/** verifyToken'ın 60sn'lik önbelleği bunu kullanır: küçük küme, tek okuma. */
async function bannedSet(db) {
  return new Set((await listBanned(db)).map((x) => x.userId));
}

async function aynayiTazele(conn, hangi) {
  try {
    if (hangi === "admins") {
      const docs = await conn.collection(COLL_ADMINS).find({}, { projection: { userId: 1, _id: 0 } }).toArray();
      await writeFile_(ADMINS_FILE, { items: docs.map((d) => d.userId), updatedAt: new Date().toISOString() });
    } else {
      const docs = await conn.collection(COLL_BANNED).find({}, { projection: { _id: 0 } }).toArray();
      await writeFile_(BANNED_FILE, { items: docs, updatedAt: new Date().toISOString() });
    }
  } catch (e) {
    console.error("[moderation-store] ayna tazelenemedi:", e?.message || e);
  }
}

module.exports = {
  listAdmins, addAdmin, removeAdmin,
  listBanned, ban, unban, bannedSet,
  COLL_ADMINS, COLL_BANNED, ADMINS_FILE, BANNED_FILE,
};
