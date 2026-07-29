"use strict";

/**
 * UYGULAMA AYARLARI — tek belge (özellik bayrakları + puanlama parametreleri).
 *
 * NEDEN VAR: `data/settings.json` Render'da her deploy'da siliniyordu ve
 * admin'in ayarladığı değerler (mod, açık ekranlar, `startBalance`, `K_outcome`,
 * `epsilon`, ceza yüzdesi) sessizce KOD İÇİ VARSAYILANLARA dönüyordu.
 * Hata üretmiyor: rota `readJson(..., null)` alıp varsayılanı kullanıyor, yani
 * "ayarlar hiç değiştirilmemiş" gibi davranıyordu.
 *
 * Puanlama parametreleri oyunun matematiğini belirliyor — sessizce değişmesi,
 * ekonomiyi kimsenin fark etmediği bir yerden kaydırır.
 *
 * Tek belge yeterli: ayar sayısı kullanıcıyla büyümüyor, eşzamanlı yazan tek
 * aktör admin. `_id` sabit tutuluyor ki ikinci belge oluşamasın.
 */

const path = require("path");
const fsp = require("fs").promises;

const COLL = "app_settings";
const DOC_ID = "singleton";

const DATA_DIR = process.env.SKORLIG_DATA_DIR || path.join(__dirname, "..", "data");
const FILE = path.join(DATA_DIR, "settings.json");

/** ⚠️ MONGODB_URI yoksa YOK SAYILIR (dosya tek kaynaktır). */
const FILE_MIRROR = String(process.env.SKORLIG_SETTINGS_FILE_MIRROR ?? "1") !== "0";
const mirrorOn = () => FILE_MIRROR || !process.env.MONGODB_URI;

async function getDbSafe(db) {
  if (db) return db;
  try {
    const { getDb } = require("./mongo.cjs");
    return await getDb();
  } catch {
    return null;
  }
}

let _tmpSayac = 0;
async function readFile_() {
  try {
    return JSON.parse(await fsp.readFile(FILE, "utf8"));
  } catch {
    return null;
  }
}
async function writeFile_(data) {
  const tmp = `${FILE}.tmp-${process.pid}-${Date.now()}-${++_tmpSayac}`;
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  await fsp.rename(tmp, FILE);
}

/** Ayarlar (hiç kaydedilmemişse null — çağıran varsayılanı uygular). */
async function load(db) {
  const conn = await getDbSafe(db);
  if (conn) {
    try {
      const doc = await conn.collection(COLL).findOne({ _id: DOC_ID });
      if (doc) {
        const { _id, ...rest } = doc;
        return rest;
      }
    } catch (e) {
      console.error("[settings-store] mongo okunamadi, dosyaya dusuluyor:", e?.message || e);
    }
  }

  const dosya = await readFile_();
  if (dosya && conn) {
    // Tohumlama: üretim kendi dosyasından Mongo'ya geçer.
    try {
      console.warn(
        "[settings-store] TOHUMLAMA: ayar belgesi bos, dosyadan yaziliyor. " +
        "Yerel calistiriyorsan .env'in URETIM veritabanina bakmadigindan emin ol."
      );
      await conn.collection(COLL).updateOne(
        { _id: DOC_ID },
        { $set: { ...dosya } },
        { upsert: true }
      );
    } catch (e) {
      console.error("[settings-store] tohumlama basarisiz:", e?.message || e);
    }
  }
  return dosya;
}

async function save(data, db) {
  const conn = await getDbSafe(db);
  let ok = false;
  if (conn) {
    try {
      await conn.collection(COLL).updateOne(
        { _id: DOC_ID },
        { $set: { ...data, updatedAt: new Date().toISOString() } },
        { upsert: true }
      );
      ok = true;
    } catch (e) {
      console.error("[settings-store] mongo yazilamadi:", e?.message || e);
    }
  }
  if (mirrorOn() || !ok) {
    try { await writeFile_(data); } catch (e) {
      console.error("[settings-store] dosya yazilamadi:", e?.message || e);
    }
  }
  return { ok };
}

module.exports = { load, save, COLL, DOC_ID, FILE };
