"use strict";

/**
 * MONGO BAĞLANTISI — tek istemci, paylaşımlı havuz.
 *
 * Buradaki üç davranış gerçek olaylardan çıktı:
 *
 *  1) NEGATİF ÖNBELLEK. getDb() rotalardan İSTEK BAŞINA çağrılıyor. Eskiden
 *     bağlantı yokken her çağrı yeniden bağlanmayı deniyor ve sunucu seçimi
 *     zaman aşımı kadar (saniyeler) bekliyordu. Yani Mongo kesintisi tüm API'yi
 *     sürünmeye çeviriyordu — dosya moduna düşüp hızlı yanıt vermek yerine.
 *     Artık başarısızlıktan sonra kısa bir süre HIZLICA null dönülür.
 *
 *  2) YENİDEN DENEME. Açılışta tek bir geçici hata (TLS el sıkışması, SRV
 *     çözümlemesi, kümenin daha ısınmamış olması) uygulamayı kalıcı dosya
 *     moduna düşürüyordu; toparlanma ancak mongo-health'in bir sonraki turunda
 *     (10 dk) geliyordu. Yaşandı: `[mongo] INIT FAILED: tlsv1 alert internal
 *     error`. Artık artan bekleyişle birkaç kez denenir.
 *
 *  3) ORTAM DEĞİŞKENİ GEÇ OKUNUR. URI modül yüklenirken okunuyordu; bu modül
 *     dotenv'den önce require edilirse URI sonsuza kadar tanımsız kalırdı.
 *     Artık her denemede okunur.
 *
 * Hata YUTULMAZ: son hata saklanır ve status() ile /api/admin/mongo-health
 * üzerinden görülebilir — sessiz dosya moduna düşüş bu projede bir kez
 * günlerce fark edilmedi.
 */

const { MongoClient, ServerApiVersion } = require("mongodb");

const DB_NAME = () => process.env.MONGODB_DB || "skorlig";

// MONGO_URI yalnızca geriye uyumluluk için (bkz. db.cjs).
const readUri = () => process.env.MONGODB_URI || process.env.MONGO_URI || "";

const RETRIES = Number(process.env.SKORLIG_MONGO_RETRIES || 3);
const RETRY_BASE_MS = Number(process.env.SKORLIG_MONGO_RETRY_MS || 800);
// Başarısızlıktan sonra bu süre boyunca denenmez — istekler beklemek yerine
// dosya moduna düşer. Kısa tutuluyor: bağlantı geri geldiğinde uzun sürmesin.
const COOLDOWN_MS = Number(process.env.SKORLIG_MONGO_COOLDOWN_MS || 30000);

let _client = null;
let _db = null;
let _connecting = null;
let _cooldownUntil = 0;

const state = {
  configured: false,
  connectedAt: null,
  lastError: null,
  lastAttemptAt: null,
  attempts: 0,
  failures: 0,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildClient(uri) {
  return new MongoClient(uri, {
    serverApi: {
      version: ServerApiVersion.v1,
      strict: false,
      deprecationErrors: false,
    },
    maxPoolSize: Number(process.env.SKORLIG_MONGO_POOL || 50),
    minPoolSize: 0,
    waitQueueTimeoutMS: 10000,
    // Render'da soğuk kap + SRV çözümlemesi + TLS el sıkışması 8sn'ye
    // sığmayabiliyor. Zaman aşımı burada "vazgeçme" anı, sabır değil.
    serverSelectionTimeoutMS: Number(process.env.SKORLIG_MONGO_SELECT_MS || 15000),
    connectTimeoutMS: Number(process.env.SKORLIG_MONGO_CONNECT_MS || 15000),
    heartbeatFrequencyMS: 10000,
    retryWrites: true,
    retryReads: true,
  });
}

/** Tek deneme — başarılıysa db, değilse fırlatır. */
async function attemptConnect(uri) {
  const client = buildClient(uri);
  try {
    await client.connect();
    // connect() bazı arıza biçimlerinde (yetki, ağ) sessizce dönebiliyor;
    // gerçek canlılık sınavı ping.
    const db = client.db(DB_NAME());
    await db.command({ ping: 1 });
    return { client, db };
  } catch (e) {
    try { await client.close(); } catch {}
    throw e;
  }
}

async function connectOnce({ force = false } = {}) {
  if (_db) return _db;
  if (_connecting) return _connecting;

  const uri = readUri();
  state.configured = !!uri;

  if (!uri) {
    // Yapılandırma tercihi (yerel geliştirme), arıza değil — gürültü yapma.
    state.lastError = "MONGODB_URI tanimsiz";
    return null;
  }

  // Negatif önbellek: yakın zamanda başarısız olduysak isteği bekletme.
  if (!force && Date.now() < _cooldownUntil) return null;

  _connecting = (async () => {
    try {
      for (let deneme = 0; deneme <= RETRIES; deneme++) {
        state.attempts++;
        state.lastAttemptAt = new Date().toISOString();
        try {
          const { client, db } = await attemptConnect(uri);
          _client = client;
          _db = db;
          _cooldownUntil = 0;
          state.connectedAt = state.lastAttemptAt;
          state.lastError = null;
          console.log(`[mongo] baglandi · db=${DB_NAME()}` +
            (deneme ? ` · ${deneme + 1}. denemede` : ""));
          return _db;
        } catch (err) {
          state.failures++;
          state.lastError = String(err?.message || err).slice(0, 300);
          const sonDeneme = deneme === RETRIES;
          console.error(
            `[mongo] baglanti hatasi (${deneme + 1}/${RETRIES + 1})` +
              `${sonDeneme ? "" : " — yeniden denenecek"}: ${state.lastError}`
          );
          if (sonDeneme) break;
          // Artan bekleyiş: küme ısınıyorsa ya da geçici bir el sıkışma
          // hatasıysa arka arkaya denemenin faydası yok.
          await sleep(RETRY_BASE_MS * Math.pow(2, deneme));
        }
      }

      _cooldownUntil = Date.now() + COOLDOWN_MS;
      console.error(
        `[mongo] BAGLANILAMADI — ${Math.round(COOLDOWN_MS / 1000)}sn dosya modunda ` +
          `devam edilecek, sonra tekrar denenecek`
      );
      return null;
    } finally {
      _connecting = null;
    }
  })();

  return _connecting;
}

/**
 * @param {{force?: boolean}} [opts] force: soğuma penceresini yok say
 *   (mongo-health'in düzenli kontrolü için).
 */
async function getDb(opts) {
  return await connectOnce(opts);
}

/** Yan etkisiz durum — yönetim ucu için. */
function status() {
  return {
    ...state,
    connected: !!_db,
    dbName: DB_NAME(),
    cooldownRemainingMs: Math.max(0, _cooldownUntil - Date.now()),
    retries: RETRIES,
  };
}

async function close() {
  try {
    if (_client) {
      await _client.close();
      console.log("[mongo] baglanti kapatildi");
    }
  } catch (e) {}
  _client = null;
  _db = null;
  // Kapatma bilinçli bir eylem; bir sonraki getDb() hemen denesin.
  _cooldownUntil = 0;
}

/* ⚠️ VERİTABANI ADI DIŞA AÇILDI — TEK KAYNAK OLSUN DİYE. `scripts/`
 * altındaki bir betik çıplak `client.db()` kullanıyordu ve MONGODB_URI'de
 * veritabanı adı OLMADIĞI için sürücünün varsayılanına ("test") düşüyordu:
 * canlı veriye bakıyor sanıp BOŞ bir veritabanını tarıyordu. Sonuç hata
 * vermiyor, yalnızca "0 kayıt" diyordu — yani yanlış ölçüm, temiz sonuç gibi
 * görünüyordu. Adı kendi başına türeten her yeni betik aynı tuzağa düşer. */
module.exports = { getDb, close, status, DB_NAME };
