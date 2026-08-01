"use strict";

/**
 * SERİ (STREAK) DEPOSU — Mongo birincil, dosya ayna.
 *
 * NEDEN VAR: `data/streaks.json` Render'da her deploy'da siliniyordu ve seriler
 * PARA dağıtıyor (eşik bonusları: 10 doğruda 5 LC, 20'de 15, 40'ta 25).
 * Bonusun tek kez verilmesini sağlayan alan `lastTier`; dosya kaybolunca -1'e
 * dönüyor, oyuncu aynı eşikleri yeniden geçiyor ve bonusu TEKRAR alıyor.
 * Yani kayıp yalnızca ilerleme kaybı değil, sessiz LC enflasyonu.
 *
 * KULLANICI BAŞINA BELGE — iki sebeple:
 *   1) Eski kod tüm haritayı okuyup tümünü geri yazıyordu (kilitsiz). İki maç
 *      aynı anda sonuçlanırsa (livescore-sync toplu settle) biri diğerinin
 *      seri güncellemesini siliyordu. Belge başına upsert'te FARKLI
 *      kullanıcılar birbirine hiç değmiyor.
 *   2) 500k kullanıcıda tüm haritayı her settle'da okumak/yazmak sürdürülemez;
 *      artık yalnızca o partideki kullanıcılar okunuyor.
 *
 * ⚠️ SİLME YOK: `saveMany` yalnızca upsert eder, listede olmayanı SİLMEZ.
 * Diğer depoların "tam değiştirme" semantiğinin tersi — burada kısmi liste
 * normaldir (yalnızca değişen kullanıcılar yazılır) ve silmek tüm seri
 * geçmişini yok ederdi.
 */

const path = require("path");
const fsp = require("fs").promises;

const COLL = "streaks";
const DATA_DIR = process.env.SKORLIG_DATA_DIR || path.join(__dirname, "..", "data");
const FILE = path.join(DATA_DIR, "streaks.json");

/** ⚠️ MONGODB_URI yoksa YOK SAYILIR (dosya tek kaynaktır). */
const FILE_MIRROR = String(process.env.SKORLIG_STREAK_FILE_MIRROR ?? "1") !== "0";
const mirrorOn = () => FILE_MIRROR || !process.env.MONGODB_URI;

// bkz. diğer depolar: bayrak değil SÖZ önbeklenir, yoksa indeks hazır
// olmadan upsert yapılır ve kopya belge oluşur.
let _indexPromise = null;
function ensureIndexes(db) {
  if (!db) return Promise.resolve();
  if (_indexPromise) return _indexPromise;
  _indexPromise = (async () => {
    try {
      await db.collection(COLL).createIndex({ userIdLower: 1 }, { unique: true, background: true });
    } catch (e) {
      console.error("[streak-store] indeks kurulamadi:", e?.message || e);
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
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

async function writeFile_(map) {
  const tmp = `${FILE}.tmp-${process.pid}-${Date.now()}-${++_tmpSayac}`;
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.writeFile(tmp, JSON.stringify(map, null, 2) + "\n", "utf8");
  await fsp.rename(tmp, FILE);
}

function strip(d) {
  if (!d) return null;
  const { _id, userIdLower: _uidLower, ...rest } = d;
  return rest;
}

/**
 * Belirtilen kullanıcıların serilerini döndürür (kimlik → seri).
 * `userIds` verilmezse TÜMÜ okunur — yalnızca yönetim/rapor için; sıcak yolda
 * kullanma, kullanıcı sayısıyla büyür.
 */
/**
 * ⚠️ EKSİK KULLANICILAR AYNADAN TAMAMLANIR — "hiç yoksa dosyaya düş" YETMİYOR.
 *
 * BULUNAN: eski kod `docs.length` doluysa Mongo sonucunu OLDUĞU GİBİ
 * döndürüyordu. Dosyaya düşme yalnızca istenen kullanıcıların HİÇBİRİ Mongo'da
 * yokken çalışıyordu. Yani serisi yalnızca dosyada olan bir kullanıcı, aynı
 * partide Mongo'da kaydı bulunan başka biri varsa SESSİZCE DÜŞÜYORDU.
 *
 * ÖLÇÜLDÜ (aynı kullanıcı, aynı veri):
 *     loadMany(["eski"])          → lastTier: 2   (bulundu)
 *     loadMany(["eski","yeni"])   → KAYIP         (dönmedi)
 * Kaybolunca `getUserStreak` sıfırdan kayıt açıyor, `lastTier` -1 oluyor ve
 * 42 birikimli seri "Durdurulamıyor" eşiğini YENİDEN geçip 25 LC bonusu
 * TEKRAR ödüyor — dosya başlığının uyardığı LC enflasyonunun ta kendisi,
 * yalnızca başka bir yoldan.
 *
 * ⚠️ SETTLE HER ZAMAN TOPLU SORAR (maça bahis giren tüm oyuncular), yani
 * "tek başına sorulma" hâli üretimde nadir — kusur normal yolda çalışıyordu.
 *
 * ⚠️ AYNA KAPALIYKEN DOSYA OKUNMAZ. `SKORLIG_STREAK_FILE_MIRROR=0` ise dosyaya
 * artık yazılmıyor demektir; oradan tamamlamak KAPANMIŞ eski serileri
 * diriltirdi. O durumda Mongo'da yokluk "seri yok" anlamına gelir.
 */
async function loadMany(userIds, db) {
  const conn = await getDbSafe(db);
  const idler = Array.isArray(userIds) ? userIds.map(lower).filter(Boolean) : null;

  let out = null;
  if (conn) {
    try {
      await ensureIndexes(conn);
      const q = idler ? { userIdLower: { $in: idler } } : {};
      const docs = await conn.collection(COLL).find(q).toArray();
      out = {};
      for (const d of docs) out[d.userIdLower] = strip(d);
    } catch (e) {
      console.error("[streak-store] mongo okunamadi, dosyaya dusuluyor:", e?.message || e);
      out = null;
    }
  }

  // Mongo hiç okunamadıysa dosya TEK kaynak.
  if (out === null) {
    const map = await readFile_();
    if (!idler) return map;
    const eksiksiz = {};
    for (const uid of idler) if (map[uid]) eksiksiz[uid] = map[uid];
    return eksiksiz;
  }

  /* Mongo okundu: yalnızca ORADA OLMAYAN, AÇIKÇA İSTENEN kullanıcılar aynadan
   * tamamlanır.
   *
   * ⚠️ "TÜMÜNÜ OKU" (idler === null) TAMAMLANMAZ. O yol yalnızca yönetim/rapor
   * için ve orada doldurulacak bir boşluk yok: çağıran zaten "Mongo ne
   * biliyorsa" istiyor. Aynayı oraya karıştırmak, Mongo'dan silinmiş kayıtları
   * raporda diriltirdi (mevcut money-races testi tam bunu koruyor). Mongo hiç
   * cevap vermezse eski davranış korunuyor: dosya tek kaynak. */
  if (!idler || !mirrorOn()) {
    if (!idler && !Object.keys(out).length) return await readFile_();
    return out;
  }
  const eksik = idler.filter((uid) => !out[uid]);
  if (!eksik.length) return out;

  const map = await readFile_();
  for (const uid of eksik) if (map[uid]) out[uid] = map[uid];
  return out;
}

/**
 * Verilen kullanıcıların serilerini yazar (upsert). Listede olmayan
 * kullanıcılara DOKUNMAZ — bkz. dosya başı.
 */
async function saveMany(map, db) {
  const girdiler = Object.entries(map || {}).filter(([uid]) => lower(uid));
  if (!girdiler.length) return { ok: false };

  const conn = await getDbSafe(db);
  let ok = false;

  if (conn) {
    try {
      await ensureIndexes(conn);
      await conn.collection(COLL).bulkWrite(
        girdiler.map(([uid, s]) => ({
          updateOne: {
            filter: { userIdLower: lower(uid) },
            update: { $set: { ...s, userIdLower: lower(uid) } },
            upsert: true,
          },
        })),
        { ordered: false }
      );
      ok = true;
    } catch (e) {
      // Sessiz kalmıyoruz: yazılamayan seri, bonusun tekrar verilmesi demek.
      console.error("[streak-store] mongo yazilamadi:", e?.message || e);
    }
  }

  if (mirrorOn() || !ok) {
    try {
      // Dosya tam harita tutuyor: yalnızca değişenleri birleştir.
      const mevcut = await readFile_();
      for (const [uid, s] of girdiler) mevcut[lower(uid)] = s;
      await writeFile_(mevcut);
    } catch (e) {
      console.error("[streak-store] dosya yazilamadi:", e?.message || e);
    }
  }

  return { ok };
}

module.exports = { loadMany, saveMany, COLL, FILE };
