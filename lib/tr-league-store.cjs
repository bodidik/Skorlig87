"use strict";

/**
 * TR-LİG HAFTA DURUMU — sonuçlanmış haftalar + ödül kayıtları.
 *
 * NEDEN VAR: `data/tr-league.json` Render'da her deploy'da siliniyordu ve bu
 * dosya HANGİ HAFTANIN ÖDÜLLENDİĞİNİ tutuyor. Kaybolunca hafta "hiç
 * ödüllendirilmemiş" görünüyor ve ilk 3'e haftalık LC TEKRAR dağıtılıyordu.
 *
 * ⚠️ EŞZAMANLILIK: eski koruma `_finalizingWeek` adlı bir SÜREÇ-İÇİ Set idi.
 * Tek instance'ta işe yarar, çok instance'ta hiçbir şey yapmaz. Üstelik sıra
 * şöyleydi: kontrol et → ÖDÜLÜ DAĞIT → kaydı yaz. İki instance aynı anda
 * haftayı kapatırsa ikisi de kontrolü geçip ödülü dağıtıyordu.
 *
 * `claimWeek` koşulu yazmanın içinde tutuyor: hafta kaydı YOKSA oluşturur ve
 * true döner; VARSA hiçbir şey yapmaz. Ödül yalnızca true dalında dağıtılır.
 *
 * TASARIM TERCİHİ (settle2'deki mühürle aynı): kayıt ödülden ÖNCE alınır.
 * Ortada hata olursa hafta "ödüllendirildi" görünür ama ödüller eksik
 * kalabilir — admin'in görebileceği bir durum. Alternatifi sessiz ÇİFT ÖDÜL.
 */

const path = require("path");
const fsp = require("fs").promises;

const COLL = "tr_league_weeks";
const DATA_DIR = process.env.SKORLIG_DATA_DIR || path.join(__dirname, "..", "data");
const FILE = path.join(DATA_DIR, "tr-league.json");

/** ⚠️ MONGODB_URI yoksa YOK SAYILIR (dosya tek kaynaktır). */
const FILE_MIRROR = String(process.env.SKORLIG_TRLEAGUE_FILE_MIRROR ?? "1") !== "0";
const mirrorOn = () => FILE_MIRROR || !process.env.MONGODB_URI;

// bkz. diğer depolar: bayrak değil SÖZ önbeklenir (indeks hazır olmadan
// upsert yapılırsa kopya belge oluşur ve "bir kez" garantisi kırılır).
let _indexPromise = null;
function ensureIndexes(db) {
  if (!db) return Promise.resolve();
  if (_indexPromise) return _indexPromise;
  _indexPromise = (async () => {
    try {
      await db.collection(COLL).createIndex({ weekKey: 1 }, { unique: true, background: true });
      return true;
    } catch (e) {
      console.error("[tr-league-store] indeks kurulamadi:", e?.message || e);
      _indexPromise = null;
      return false;
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

let _tmpSayac = 0;

async function readFile_() {
  try {
    const raw = JSON.parse(await fsp.readFile(FILE, "utf8"));
    return raw && typeof raw === "object" ? raw : { settledWeeks: {} };
  } catch {
    return { settledWeeks: {} };
  }
}

async function writeFile_(state) {
  const tmp = `${FILE}.tmp-${process.pid}-${Date.now()}-${++_tmpSayac}`;
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.writeFile(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  await fsp.rename(tmp, FILE);
}

const strip = (d) => {
  if (!d) return null;
  const { _id, ...rest } = d;
  return rest;
};

/** Tüm sonuçlanmış haftalar: { weekKey: kayıt }. Dosya biçimiyle aynı. */
async function loadWeeks(db) {
  const conn = await getDbSafe(db);
  if (conn) {
    try {
      await ensureIndexes(conn);
      const docs = await conn.collection(COLL).find({}).toArray();
      if (docs.length) {
        const out = {};
        for (const d of docs) out[d.weekKey] = strip(d);
        return out;
      }
    } catch (e) {
      console.error("[tr-league-store] mongo okunamadi, dosyaya dusuluyor:", e?.message || e);
    }
  }
  const state = await readFile_();
  return state.settledWeeks && typeof state.settledWeeks === "object" ? state.settledWeeks : {};
}

/** Tek haftanın kaydı (yoksa null). */
async function getWeek(weekKey, db) {
  const wk = String(weekKey || "");
  if (!wk) return null;
  const conn = await getDbSafe(db);
  if (conn) {
    try {
      await ensureIndexes(conn);
      const d = await conn.collection(COLL).findOne({ weekKey: wk });
      if (d) return strip(d);
    } catch (e) {
      console.error("[tr-league-store] hafta okunamadi:", e?.message || e);
    }
  }
  return (await loadWeeks(conn))[wk] || null;
}

/**
 * Haftayı ATOMİK olarak üstlenir: kayıt yoksa yazar ve true döner.
 *
 * @returns {Promise<boolean>} ödülü BU çağrı dağıtacaksa true
 */
async function claimWeek(weekKey, record, db) {
  const wk = String(weekKey || "");
  if (!wk) return false;

  const conn = await getDbSafe(db);
  if (conn) {
    try {
      /* ⚠️ BENZERSİZ İNDEKS YOKSA MÜHÜR DE YOK — fail-open idi.
       * Bu mühür haftalık LC ödülünü tek çağrıya kilitliyor; indeks
       * kurulamazsa `insertOne` her çağrıda başarılı olur ve ödül tekrar
       * dağıtılır. Aynı kusur bu oturumda push-sent, davet-odul ve
       * kupon-store depolarında bulunup kapatıldı. */
      if (!(await ensureIndexes(conn))) {
        console.error("[tr-league-store] benzersiz indeks yok — hafta muhurlenmiyor (fail-closed)");
        return false;
      }
      // insertOne + benzersiz indeks: ikinci çağrı duplicate key alır.
      // updateOne+upsert yerine bu tercih edildi çünkü upsert, koşullu filtre
      // eşleşmediğinde YENİ BELGE ekliyor (bkz. match-results claimAward'da
      // yakalanan hata) — insertOne'da böyle bir belirsizlik yok.
      await conn.collection(COLL).insertOne({ ...record, weekKey: wk });
      if (mirrorOn()) await aynayiTazele(conn);
      return true;
    } catch (e) {
      if (e?.code === 11000) return false; // zaten ödüllendirilmiş
      console.error("[tr-league-store] hafta muhru alinamadi:", e?.message || e);
      return false; // emin değilsek ÖDÜL DAĞITMA
    }
  }

  const state = await readFile_();
  state.settledWeeks = state.settledWeeks || {};
  if (state.settledWeeks[wk]) return false;
  state.settledWeeks[wk] = { ...record, weekKey: wk };
  await writeFile_(state);
  return true;
}

async function aynayiTazele(conn) {
  try {
    const docs = await conn.collection(COLL).find({}).toArray();
    const settledWeeks = {};
    for (const d of docs) settledWeeks[d.weekKey] = strip(d);
    await writeFile_({ settledWeeks, updatedAt: new Date().toISOString() });
  } catch (e) {
    console.error("[tr-league-store] ayna tazelenemedi:", e?.message || e);
  }
}

module.exports = { loadWeeks, getWeek, claimWeek, COLL, FILE };
