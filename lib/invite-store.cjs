"use strict";

/**
 * 1987 DAVET KODLARI — kullanım sayaçları.
 *
 * NEDEN VAR (iki ayrı kusur):
 *
 * 1) KALICILIK. `data/gs1987-codes.json` Render'da her deploy'da siliniyordu.
 *    Bu dosya kodların KAÇ KEZ KULLANILDIĞINI tutuyor; kaybolunca sayaçlar
 *    sıfırlanıyor ve kota dolmuş kodlar yeniden kullanılabilir hâle geliyordu.
 *    1987 üyeliği bedava değil: açılış bakiyesi 60 LC (normalde 30), haftalık
 *    seçimler ücretsiz ve premium tabanı geçerli. Yani sınırsız kod = sınırsız
 *    hesap açıp LC basmak.
 *
 * 2) YARIŞ. Eski akış: dosyayı oku → kodu bul → `used >= maxUses` kontrol et →
 *    `used + 1` yaz. Kontrol ile yazma ayrı; son kontenjan için iki eşzamanlı
 *    istek İKİSİ de kontrolü geçip kotayı aşıyordu. Kod dosyasında kilit yoktu.
 *
 * `redeem` koşulu sorgunun içinde tutuyor (`used < maxUses`) ve `$inc` ile
 * artırıyor — kontrol ve yazma tek atomik işlem.
 */

const path = require("path");
const fsp = require("fs").promises;

const COLL = "invite_codes_1987";
const DATA_DIR = process.env.SKORLIG_DATA_DIR || path.join(__dirname, "..", "data");
const FILE = path.join(DATA_DIR, "gs1987-codes.json");

/** ⚠️ MONGODB_URI yoksa YOK SAYILIR (dosya tek kaynaktır). */
const FILE_MIRROR = String(process.env.SKORLIG_INVITE_FILE_MIRROR ?? "1") !== "0";
const mirrorOn = () => FILE_MIRROR || !process.env.MONGODB_URI;

let _indexPromise = null;
function ensureIndexes(db) {
  if (!db) return Promise.resolve();
  if (_indexPromise) return _indexPromise;
  _indexPromise = (async () => {
    try {
      await db.collection(COLL).createIndex({ codeNorm: 1 }, { unique: true, background: true });
    } catch (e) {
      console.error("[invite-store] indeks kurulamadi:", e?.message || e);
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

const norm = (c) => String(c || "").trim().toUpperCase();

let _tmpSayac = 0;

async function readFile_() {
  try {
    const raw = JSON.parse(await fsp.readFile(FILE, "utf8"));
    return { codes: Array.isArray(raw?.codes) ? raw.codes : [], updatedAt: raw?.updatedAt ?? null };
  } catch {
    return { codes: [], updatedAt: null };
  }
}

async function writeFile_(data) {
  const tmp = `${FILE}.tmp-${process.pid}-${Date.now()}-${++_tmpSayac}`;
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  await fsp.rename(tmp, FILE);
}

const strip = (d) => {
  if (!d) return null;
  const { _id, codeNorm: _codeNorm, ...rest } = d;
  return rest;
};

/**
 * Mongo boşsa dosyadan bir kez taşır. Tohumlamadan sonra Mongo yetkilidir.
 * ⚠️ Log'a düşer: yerel `.env` üretime bakıyorsa geliştirme kodları üretime
 * yazılır (bu, gruplarda bir kez yaşandı).
 */
async function tohumla(conn, codes) {
  if (!conn || !codes.length) return;
  try {
    console.warn(
      `[invite-store] TOHUMLAMA: koleksiyon bos, dosyadan ${codes.length} kod yaziliyor. ` +
      `Yerel calistiriyorsan .env'in URETIM veritabanina bakmadigindan emin ol.`
    );
    await conn.collection(COLL).bulkWrite(
      codes.map((c) => ({
        updateOne: {
          filter: { codeNorm: norm(c.code) },
          update: { $set: { ...c, codeNorm: norm(c.code) } },
          upsert: true,
        },
      })),
      { ordered: false }
    );
  } catch (e) {
    console.error("[invite-store] tohumlama basarisiz:", e?.message || e);
  }
}

/** Tüm kodlar (yönetim ekranı için). */
async function listCodes(db) {
  const conn = await getDbSafe(db);
  if (conn) {
    try {
      await ensureIndexes(conn);
      const docs = await conn.collection(COLL).find({}).toArray();
      if (docs.length) return docs.map(strip);
    } catch (e) {
      console.error("[invite-store] mongo okunamadi, dosyaya dusuluyor:", e?.message || e);
    }
  }
  const { codes } = await readFile_();
  await tohumla(conn, codes);
  return codes;
}

/**
 * Kodu ATOMİK olarak kullanır: kota dolmamışsa sayacı artırır.
 *
 * `maxUses = 0` sınırsız demek — filtre o durumda kota koşulu aramaz.
 *
 * @returns {Promise<{ok:boolean, reason?:string, code?:object}>}
 *          reason="INVALID_CODE"   → kod yok
 *          reason="CODE_EXHAUSTED" → kota dolu
 */
async function redeem(code, db) {
  const cn = norm(code);
  if (!cn) return { ok: false, reason: "INVALID_CODE" };

  const conn = await getDbSafe(db);
  if (conn) {
    try {
      await ensureIndexes(conn);
      const col = conn.collection(COLL);

      // Koleksiyon boşsa dosyadan taşı (ilk çalıştırma).
      if ((await col.countDocuments({}, { limit: 1 })) === 0) {
        const { codes } = await readFile_();
        await tohumla(conn, codes);
      }

      // Kota koşulu FİLTRENİN İÇİNDE: `$expr` ile used < maxUses karşılaştırması
      // (maxUses 0 ise sınırsız). Kontrol ve artırma tek işlem.
      const r = await col.findOneAndUpdate(
        {
          codeNorm: cn,
          $or: [
            { maxUses: { $in: [0, null] } },
            { maxUses: { $exists: false } },
            { $expr: { $lt: [{ $ifNull: ["$used", 0] }, "$maxUses"] } },
          ],
        },
        { $inc: { used: 1 }, $set: { lastUsedAt: new Date().toISOString() } },
        { returnDocument: "after" }
      );
      const doc = r ? ("value" in r ? r.value : r) : null;

      if (!doc) {
        const varMi = await col.findOne({ codeNorm: cn }, { projection: { _id: 1 } });
        return { ok: false, reason: varMi ? "CODE_EXHAUSTED" : "INVALID_CODE" };
      }

      if (mirrorOn()) await aynayiTazele(conn);
      return { ok: true, code: strip(doc) };
    } catch (e) {
      console.error("[invite-store] kod kullanilamadi:", e?.message || e);
      // Emin değilsek üyelik VERME — sahte 1987 üyeliği LC basmak demek.
      return { ok: false, reason: "INVALID_CODE" };
    }
  }

  // Dosya modu (tek süreç)
  const data = await readFile_();
  const i = data.codes.findIndex((c) => norm(c.code) === cn);
  if (i === -1) return { ok: false, reason: "INVALID_CODE" };
  const item = data.codes[i];
  const maxUses = Number(item.maxUses || 0) || 0;
  const used = Number(item.used || 0) || 0;
  if (maxUses > 0 && used >= maxUses) return { ok: false, reason: "CODE_EXHAUSTED" };
  item.used = used + 1;
  item.lastUsedAt = new Date().toISOString();
  data.codes[i] = item;
  data.updatedAt = new Date().toISOString();
  await writeFile_(data);
  return { ok: true, code: item };
}

async function aynayiTazele(conn) {
  try {
    const docs = await conn.collection(COLL).find({}).toArray();
    await writeFile_({ codes: docs.map(strip), updatedAt: new Date().toISOString() });
  } catch (e) {
    console.error("[invite-store] ayna tazelenemedi:", e?.message || e);
  }
}

module.exports = { listCodes, redeem, COLL, FILE };
