"use strict";

/**
 * MAÇ TEPKİLERİ DEPOSU — Mongo birincil, dosya ayna.
 *
 * NEDEN SERBEST METİN YOK: maç odasında sohbet, moderasyonun en çok gerektiği
 * yer (derbi anında, tanıdık grup içinde, hakaretin en ucuz olduğu dakika).
 * `moderation-store` var ama sohbet için hiç sınanmadı. Kapalı bir tepki
 * listesi bu yükü SIFIRLIYOR: sunucu yalnızca bir ANAHTAR saklıyor, metni
 * istemci kendi dilinde basıyor. Kullanıcının yazdığı hiçbir şey saklanmıyor,
 * dolayısıyla moderasyona konu olabilecek hiçbir şey de üretilmiyor.
 *
 * ⚠️ Bu, listenin sunucuda tutulmasına bağlı. Anahtar doğrulaması istemciye
 * bırakılırsa özellik anlamını yitirir: elle atılan bir POST istediği metni
 * `key` olarak yazar ve odada moderasyonsuz serbest metin belirir. Uç, listede
 * OLMAYAN anahtarı reddediyor (bkz. `TEPKILER`), test bunu koruyor.
 *
 * OLAY BAŞINA BELGE — tek belgede sayaç tutmak `loadAll → değiştir → saveAll`
 * demekti; maç anında onlarca kişi aynı anda tepki verir ve o kalıp eşzamanlı
 * yazmaları SESSİZCE siliyor (bkz. tests/snapshot-yazimi-nobetcisi.test.cjs).
 * Her tepki ayrı `insertOne`: hiçbir yazma başka bir yazmaya dokunmuyor.
 */

const path = require("path");
const fsp = require("fs").promises;

const COLL = "match_reactions";
const DATA_DIR = process.env.SKORLIG_DATA_DIR || path.join(__dirname, "..", "data");
const FILE = path.join(DATA_DIR, "match-reactions.json");

/** ⚠️ MONGODB_URI yoksa YOK SAYILIR (dosya tek kaynaktır). */
const FILE_MIRROR = String(process.env.SKORLIG_REACTION_FILE_MIRROR ?? "1") !== "0";
const mirrorOn = () => FILE_MIRROR || !process.env.MONGODB_URI;

/**
 * İZİN VERİLEN TEPKİLER — TEK KAYNAK.
 *
 * Emoji burada, METİN İSTEMCİDE (i18n). Sunucu metni hiç görmüyor; bu yüzden
 * yeni bir dil eklemek bu dosyaya dokunmuyor ve saklanan veri dilden bağımsız.
 *
 * ⚠️ Anahtar SİLERSEN eski kayıtlar okunamaz hâle gelmez ama sayımda görünmez.
 * Yeniden adlandırma yerine ekleme yap.
 */
const TEPKILER = Object.freeze([
  "gol",      // ⚽
  "ates",     // 🔥
  "sok",      // 😱
  "guldum",   // 😂
  "sinir",    // 😤
  "helal",    // 👏
  "hakem",    // 🤨
  "yikildim", // 💔
]);
const TEPKI_KUMESI = new Set(TEPKILER);

/** Aynı kullanıcının arka arkaya basması arasındaki asgari süre. */
const BEKLEME_MS = Number(process.env.SKORLIG_TEPKI_BEKLEME_MS || 3_000);
/** Bir kullanıcının tek maçta verebileceği toplam tepki. */
const KISI_BASI_AZAMI = Number(process.env.SKORLIG_TEPKI_KISI_AZAMI || 40);
/** Akışta dönen en fazla olay sayısı. */
const AKIS_AZAMI = 50;
/** Dosya aynasında maç başına saklanan en fazla olay (ayna sınırsız büyümesin). */
const AYNA_AZAMI = 500;

const lower = (x) => String(x || "").trim().toLowerCase();

let _indexPromise = null;
function ensureIndexes(db) {
  if (!db) return Promise.resolve();
  if (_indexPromise) return _indexPromise;
  _indexPromise = (async () => {
    try {
      const c = db.collection(COLL);
      // Okuma yolu: bir maçın son N olayı + anahtar bazlı sayım.
      await c.createIndex({ fixtureIdLower: 1, scope: 1, at: -1 }, { background: true });
      // Yazma yolu: bekleme süresi ve kişi başı üst sınır denetimi.
      await c.createIndex({ fixtureIdLower: 1, userIdLower: 1, at: -1 }, { background: true });
    } catch (e) {
      console.error("[reactions-store] indeks kurulamadi:", e?.message || e);
      /* Geçici arızada önbelleği düşür — yoksa hata SÜREÇ BOYUNCA kalıcı olur
       * ve maç anındaki her tepki indekssiz koleksiyonu tarar. */
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

/** Dosya aynasındaki bir maçın olayları (yeniden eskiye). */
function aynadanOku(map, fixtureId, scope) {
  const dizi = Array.isArray(map[lower(fixtureId)]) ? map[lower(fixtureId)] : [];
  return dizi.filter((o) => (o.scope || "all") === scope);
}

/**
 * Tepki yazar. Geçerlilik denetimi ÇAĞIRANIN işi değil — burada yapılıyor ki
 * her yeni çağrı yeri aynı korumayı almış olsun.
 *
 * Dönen: { ok, error?, at?, kalan? }
 */
async function addReaction({ fixtureId, userId, key, scope = "all" }, db) {
  const fx = lower(fixtureId);
  const uid = lower(userId);
  if (!fx) return { ok: false, error: "FIXTURE_ID_REQUIRED" };
  if (!uid) return { ok: false, error: "USER_REQUIRED" };
  if (!TEPKI_KUMESI.has(String(key))) return { ok: false, error: "UNKNOWN_REACTION" };

  const simdi = Date.now();
  const olay = {
    fixtureIdLower: fx,
    scope: String(scope || "all"),
    userIdLower: uid,
    userId: String(userId),
    key: String(key),
    at: simdi,
  };

  const conn = await getDbSafe(db);
  let ok = false;

  if (conn) {
    try {
      await ensureIndexes(conn);
      const c = conn.collection(COLL);

      /* ⚠️ KONTROL-SONRA-YAZ YARIŞI BİLEREK KABUL EDİLİYOR. İki istek aynı
       * milisaniyede geçerse bekleme süresi bir kez delinir — bedeli FAZLADAN
       * BİR TEPKİ. Kilit maliyeti bu bedelin çok üstünde. Yazma sonrası
       * bütünlük gerektiren bir şey yok: sayımlar zaten olayların toplamı. */
      const sonuncu = await c
        .find({ fixtureIdLower: fx, userIdLower: uid })
        .sort({ at: -1 })
        .limit(1)
        .toArray();
      if (sonuncu[0] && simdi - Number(sonuncu[0].at || 0) < BEKLEME_MS) {
        return { ok: false, error: "TOO_FAST", retryInMs: BEKLEME_MS - (simdi - Number(sonuncu[0].at)) };
      }

      const adet = await c.countDocuments({ fixtureIdLower: fx, userIdLower: uid });
      if (adet >= KISI_BASI_AZAMI) return { ok: false, error: "REACTION_LIMIT", limit: KISI_BASI_AZAMI };

      await c.insertOne({ ...olay });
      ok = true;
      if (!mirrorOn()) return { ok: true, at: simdi, kalan: KISI_BASI_AZAMI - adet - 1 };
    } catch (e) {
      console.error("[reactions-store] mongo yazilamadi:", e?.message || e);
    }
  }

  // Ayna açık ya da Mongo hiç yazamadı — dosya yolu.
  try {
    const map = await readFile_();
    const dizi = Array.isArray(map[fx]) ? map[fx] : [];

    if (!ok) {
      const benimkiler = dizi.filter((o) => o.userIdLower === uid);
      const son = benimkiler[benimkiler.length - 1];
      if (son && simdi - Number(son.at || 0) < BEKLEME_MS) {
        return { ok: false, error: "TOO_FAST", retryInMs: BEKLEME_MS - (simdi - Number(son.at)) };
      }
      if (benimkiler.length >= KISI_BASI_AZAMI) {
        return { ok: false, error: "REACTION_LIMIT", limit: KISI_BASI_AZAMI };
      }
    }

    dizi.push(olay);
    // En eskiyi at — ayna maç başına sınırsız büyümesin.
    map[fx] = dizi.slice(-AYNA_AZAMI);
    await writeFile_(map);
    ok = true;
  } catch (e) {
    console.error("[reactions-store] dosya yazilamadi:", e?.message || e);
  }

  return ok ? { ok: true, at: simdi } : { ok: false, error: "WRITE_FAILED" };
}

/**
 * Bir maçın tepki özeti.
 * Dönen: { counts: {anahtar: adet}, total, feed: [{key,userId,at}] } — feed
 * yeniden eskiye.
 */
async function readReactions({ fixtureId, scope = "all", limit = 20 }, db) {
  const fx = lower(fixtureId);
  const kapsam = String(scope || "all");
  const n = Math.max(1, Math.min(AKIS_AZAMI, Number(limit) || 20));
  const bos = { counts: {}, total: 0, feed: [] };
  if (!fx) return bos;

  const conn = await getDbSafe(db);

  if (conn) {
    try {
      await ensureIndexes(conn);
      const c = conn.collection(COLL);
      const q = { fixtureIdLower: fx, scope: kapsam };

      const [sayimlar, akis] = await Promise.all([
        c.aggregate([{ $match: q }, { $group: { _id: "$key", n: { $sum: 1 } } }]).toArray(),
        c.find(q).sort({ at: -1 }).limit(n).toArray(),
      ]);

      const counts = {};
      let total = 0;
      for (const s of sayimlar) {
        /* Listeden ÇIKARILMIŞ eski anahtarlar sayıma girmesin — istemci
         * bilmediği anahtarı basamaz, toplam ise şişer. */
        if (!TEPKI_KUMESI.has(String(s._id))) continue;
        counts[s._id] = s.n;
        total += s.n;
      }
      return {
        counts,
        total,
        feed: akis
          .filter((o) => TEPKI_KUMESI.has(String(o.key)))
          .map((o) => ({ key: o.key, userId: o.userId || o.userIdLower, at: o.at })),
      };
    } catch (e) {
      console.error("[reactions-store] mongo okunamadi, dosyaya dusuluyor:", e?.message || e);
    }
  }

  try {
    const olaylar = aynadanOku(await readFile_(), fx, kapsam);
    const counts = {};
    let total = 0;
    for (const o of olaylar) {
      if (!TEPKI_KUMESI.has(String(o.key))) continue;
      counts[o.key] = (counts[o.key] || 0) + 1;
      total++;
    }
    const feed = olaylar
      .filter((o) => TEPKI_KUMESI.has(String(o.key)))
      .slice(-n)
      .reverse()
      .map((o) => ({ key: o.key, userId: o.userId || o.userIdLower, at: o.at }));
    return { counts, total, feed };
  } catch {
    return bos;
  }
}

module.exports = {
  addReaction,
  readReactions,
  TEPKILER,
  TEPKI_KUMESI,
  BEKLEME_MS,
  KISI_BASI_AZAMI,
  AKIS_AZAMI,
  COLL,
  FILE,
};
