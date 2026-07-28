"use strict";

/**
 * KULLANICI PROFİLİ DEPOSU — Mongo varsa Mongo, yoksa dosya.
 *
 * NEDEN (iki ayrı sorun, ikisi de ölçüldü):
 *
 * 1) VERİ KAYBI — BUGÜN OLUYOR. `data/users.json` profil verisinin (ülke,
 *    favori takım, takma ad, ligler, dil) TEK deposuydu ve hiçbir yerde
 *    Mongo'ya yazılmıyordu. Render ücretsiz katmanda kalıcı disk olmadığı
 *    için her deploy'da tüm profiller siliniyordu. `ensureUser` kullanıcıyı
 *    bulamayınca sessizce sıfırdan yaratıyor — hata vermiyor, boş profil
 *    dönüyor. Az kullanıcıda fark edilmez; kaybın kendisi sessizdir.
 *
 * 2) OLAY DÖNGÜSÜ KİLİDİ. Her `/profile` isteği dosyanın TAMAMINI okuyup
 *    doğrusal arıyordu. `JSON.parse` senkron olduğu için bu süre boyunca
 *    sunucu başka HİÇBİR isteği işleyemez. Ölçülen (tek profil isteği):
 *
 *      kullanıcı   dosya      oku+ara    yazma da varsa
 *        1.000     0.2 MB        5 ms          9 ms
 *       50.000     9.3 MB      131 ms        254 ms
 *      200.000    37.4 MB      520 ms       1058 ms
 *      500.000    93.7 MB     1340 ms       2699 ms
 *
 * 3) KAYIP GÜNCELLEME YARIŞI. Setter'lar (set-country, set-nickname…)
 *    oku→değiştir→tümünü-yaz yapıyordu ve dosya kilidi YOKTU. Eşzamanlı iki
 *    çağrıdan biri sessizce kayboluyordu. Mongo modunda `$set` alan bazlı ve
 *    atomik; dosya modunda kilit eklendi.
 *
 * Mongo modunda `users` koleksiyonu, `userId` benzersiz indeksli — sorgular
 * tam tarama yapmaz, maliyet kullanıcı sayısından bağımsızdır.
 *
 * Geçiş bayrağı: SKORLIG_USERS_FILE_MIRROR (varsayılan 1 = dosya da yazılır)
 * Mongo yoksa bayrak YOK SAYILIR — dosya tek kaynaktır, veri kaybı olmaz.
 */

const path = require("path");
const fsp = require("fs").promises;
const { withFileLock, writeJsonAtomic } = require("./fileLock.cjs");

const DATA_DIR = process.env.SKORLIG_DATA_DIR || path.join(__dirname, "..", "data");
const FILE = path.join(DATA_DIR, "users.json");
const COLL = "users";

const FILE_MIRROR = () =>
  String(process.env.SKORLIG_USERS_FILE_MIRROR ?? "1") !== "0";

/** Dosya yazılmalı mı: Mongo yoksa ZORUNLU (tek kaynak), varsa bayrağa bakılır. */
const needFile = (db) => !db || FILE_MIRROR();

const normId = (x) => String(x || "").trim();

/**
 * Kimliğin küçük harfli hali. Firebase UID'leri karışık harfli olduğu için
 * tam eşleşme sorgusu, küçük harfe indirgenmiş bir anahtarla ARAMA YAPILDIĞINDA
 * hiçbir şey bulamaz — hata da vermez, sessizce boş döner. Sıralamada ülke
 * çözümü tam olarak bu yolu kullanıyor.
 */
const lowId = (x) => normId(x).toLowerCase();

// ── Dosya tarafı ────────────────────────────────────────────────────────────

async function readBook() {
  try {
    const raw = JSON.parse(await fsp.readFile(FILE, "utf8"));
    if (Array.isArray(raw)) return { items: raw };
    return { items: Array.isArray(raw.items) ? raw.items : [] };
  } catch {
    return { items: [] };
  }
}

// ── Mongo tarafı ────────────────────────────────────────────────────────────

let _indexed = false;
async function ensureIndexes(db) {
  if (_indexed || !db) return;
  _indexed = true;
  try {
    const col = db.collection(COLL);
    await col.createIndex({ userId: 1 }, { unique: true, background: true });
    // Ülke sıralaması bu alana göre süzüyor.
    await col.createIndex({ country: 1 }, { background: true });
    // Takım kadrosu ekranı bu alandan süzüyor.
    await col.createIndex({ mainTeam: 1 }, { background: true, sparse: true });
    // Takma ad benzersizlik kontrolü. İndeks OLMADAN her set-nickname çağrısı
    // koleksiyonu tam tarardı — 500K'da tek istek saniyeler sürerdi.
    // unique DEĞİL: takma adı olmayan kullanıcı çok (null çakışması olurdu) ve
    // benzersizliği uygulama katmanı zaten kontrol ediyor.
    await col.createIndex({ nicknameNorm: 1 }, { background: true, sparse: true });
    await col.createIndex({ userIdNorm: 1 }, { background: true, sparse: true });
    // 1987 segment listesi bu iki alandan süzüyor.
    await col.createIndex({ is1987: 1 }, { background: true, sparse: true });
    await col.createIndex({ segment: 1 }, { background: true, sparse: true });
    // Sıralamada ülke çözümü küçük harfli kimlikle sorgu yapıyor.
    await col.createIndex({ userIdLower: 1 }, { background: true });
    // Davet kodu ile kullanıcı bulma (arkadaş daveti). İndeks olmadan her
    // kod kullanımı koleksiyonu tam tarardı.
    await col.createIndex({ inviteCode: 1 }, { background: true, sparse: true });
  } catch (e) {
    console.error("[users-store] indeks kurulamadi:", e.message || e);
  }
}

/** Mongo'nun _id'si dışarı sızmasın — çağıranlar düz profil bekliyor. */
function strip(doc) {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return rest;
}

// ── Genel API ───────────────────────────────────────────────────────────────

/**
 * Tek kullanıcı. Mongo modunda indeksli findOne — dosya boyutundan bağımsız.
 * @returns {Promise<object|null>}
 */
async function getUser(userId, db) {
  const uid = normId(userId);
  if (!uid) return null;

  if (db) {
    await ensureIndexes(db);
    return strip(await db.collection(COLL).findOne({ userId: uid }));
  }

  const { items } = await readBook();
  return items.find((x) => normId(x.userId) === uid) || null;
}

/**
 * Kullanıcıyı getirir, yoksa `defaults` ile yaratır.
 *
 * Mongo modunda tek bir atomik `findOneAndUpdate` + `$setOnInsert`: eşzamanlı
 * iki istek çift kayıt oluşturamaz ve dosya hiç okunmaz.
 */
async function ensureUser(userId, defaults, db) {
  const uid = normId(userId);
  if (!uid) throw new Error("USER_REQUIRED");

  const nowISO = new Date().toISOString();
  // userIdLower olmadan sıralamanın ülke sorgusu hata vermeden boş döner.
  const taban = { userId: uid, userIdLower: lowId(uid), createdAt: nowISO, ...defaults };

  let sonuc = null;

  if (db) {
    await ensureIndexes(db);
    const r = await db.collection(COLL).findOneAndUpdate(
      { userId: uid },
      {
        $setOnInsert: taban,
        // Eski kayıtlarda eksik olabilecek alanları tamamla. $setOnInsert ile
        // aynı alana dokunulamaz, bu yüzden eksik-alan tamamlaması ayrı
        // çağrıda yapılır (aşağıda).
      },
      { upsert: true, returnDocument: "after" }
    );
    sonuc = strip(r?.value ?? r);

    // Eksik alan tamamlama: yalnızca gerçekten eksikse yaz (gereksiz yazma yok).
    const eksik = {};
    for (const [k, v] of Object.entries(defaults || {})) {
      if (sonuc && sonuc[k] === undefined) eksik[k] = v;
    }
    if (Object.keys(eksik).length) {
      const r2 = await db.collection(COLL).findOneAndUpdate(
        { userId: uid },
        { $set: eksik },
        { returnDocument: "after" }
      );
      sonuc = strip(r2?.value ?? r2) || { ...sonuc, ...eksik };
    }
  }

  if (needFile(db)) {
    const dosyaSonuc = await withFileLock(FILE, async () => {
      const { items } = await readBook();
      let u = items.find((x) => normId(x.userId) === uid);
      let degisti = false;

      if (!u) {
        u = { ...taban };
        items.push(u);
        degisti = true;
      } else {
        for (const [k, v] of Object.entries(defaults || {})) {
          if (u[k] === undefined) { u[k] = v; degisti = true; }
        }
      }

      if (degisti) await writeJsonAtomic(FILE, { items });
      return u;
    });
    if (!sonuc) sonuc = dosyaSonuc;
  }

  return sonuc;
}

/**
 * Alan bazlı güncelleme. Kullanıcı yoksa `defaults` ile yaratılır.
 *
 * Mongo modunda `$set` yalnızca verilen alanlara dokunur — eşzamanlı iki
 * farklı alanın güncellenmesi birbirini EZMEZ. Dosya modunda kilit altında.
 */
async function updateUser(userId, patch, defaults, db) {
  const uid = normId(userId);
  if (!uid) throw new Error("USER_REQUIRED");

  const nowISO = new Date().toISOString();
  const set = { ...patch, updatedAt: nowISO };
  let sonuc = null;

  if (db) {
    await ensureIndexes(db);

    // ⚠️ Mongo aynı alanın hem $set hem $setOnInsert içinde olmasını REDDEDER
    // ("would create a conflict at ..."), tüm işlem hata verir. Çakışma çok
    // kolay oluşuyor: set-main-team yaması {mainTeam} gönderiyor, varsayılanlar
    // da {mainTeam: null} içeriyordu — uç Mongo modunda tamamen patlıyordu.
    // $set kazanır: çağıranın açıkça verdiği değer, varsayılandan önceliklidir.
    const insertOnly = { userId: uid, userIdLower: lowId(uid), createdAt: nowISO };
    for (const [k, v] of Object.entries(defaults || {})) {
      if (!(k in set)) insertOnly[k] = v;
    }

    const r = await db.collection(COLL).findOneAndUpdate(
      { userId: uid },
      { $set: set, $setOnInsert: insertOnly },
      { upsert: true, returnDocument: "after" }
    );
    sonuc = strip(r?.value ?? r);
  }

  if (needFile(db)) {
    const dosyaSonuc = await withFileLock(FILE, async () => {
      const { items } = await readBook();
      let u = items.find((x) => normId(x.userId) === uid);
      if (!u) {
        u = { userId: uid, userIdLower: lowId(uid), createdAt: nowISO, ...defaults };
        items.push(u);
      }
      Object.assign(u, set);
      await writeJsonAtomic(FILE, { items });
      return u;
    });
    if (!sonuc) sonuc = dosyaSonuc;
  }

  return sonuc;
}

/**
 * Birden çok kullanıcıyı kimliğe göre getirir (grup tabloları için).
 *
 * NEDEN AYRI: Eskiden grup tablosu TÜM kullanıcı dosyasını yükleyip map
 * kuruyordu — 20 kişilik grup için 500.000 kaydın tamamı okunuyordu.
 * Mongo modunda yalnızca istenen kimlikler çekilir.
 *
 * @returns {Promise<Record<string, object>>} userId → profil
 */
async function getUsersByIds(userIds, db) {
  const ids = [...new Set((userIds || []).map(normId).filter(Boolean))];
  const map = {};
  if (!ids.length) return map;

  if (db) {
    await ensureIndexes(db);
    const docs = await db.collection(COLL).find({ userId: { $in: ids } }).toArray();
    for (const d of docs) map[normId(d.userId)] = strip(d);
    return map;
  }

  const { items } = await readBook();
  const istenen = new Set(ids);
  for (const u of items) {
    const id = normId(u.userId);
    if (istenen.has(id) && !map[id]) map[id] = u;
  }
  return map;
}

/**
 * KÜÇÜK HARFLİ kimliklerle toplu getirme (sıralamada ülke çözümü için).
 *
 * Ayrı fonksiyon çünkü `getUsersByIds` TAM eşleşme yapıyor; küçük harfe
 * indirgenmiş anahtarla oraya sormak hata vermeden boş döner ve tüm insanlar
 * ülkesiz görünür.
 *
 * @returns {Promise<Record<string, object>>} userIdLower → profil
 */
async function getUsersByIdsLower(idsLower, db) {
  const ids = [...new Set((idsLower || []).map(lowId).filter(Boolean))];
  const map = {};
  if (!ids.length) return map;

  if (db) {
    await ensureIndexes(db);
    const docs = await db
      .collection(COLL)
      .find({ userIdLower: { $in: ids } })
      .toArray();
    for (const d of docs) map[lowId(d.userId)] = strip(d);
    return map;
  }

  const { items } = await readBook();
  const istenen = new Set(ids);
  for (const u of items) {
    const id = lowId(u.userId);
    if (istenen.has(id) && !map[id]) map[id] = u;
  }
  return map;
}

/**
 * Kullanıcı arama (arkadaş ekleme ekranı).
 *
 * Takma ad VE kimlik üzerinde, baştan eşleşme öncelikli değil — mevcut
 * davranış "içeriyor" idi, korundu. `limit` zorunlu: sınırsız sonuç dönmek
 * 500.000 kullanıcıda tek istekle tüm koleksiyonu belleğe alırdı.
 */
async function searchUsers(query, limit = 20, db) {
  const q = String(query || "").trim();
  if (!q) return [];
  const n = Math.max(1, Math.min(100, Number(limit) || 20));

  if (db) {
    await ensureIndexes(db);
    const kacis = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(kacis, "i");
    const docs = await db
      .collection(COLL)
      // `name` eski şemadan kalan alan; arkadaş arama hâlâ onu da okuyor.
      // Kapsam dışı bırakmak eski hesapları aramada görünmez yapardı.
      .find({ $or: [{ nickname: re }, { name: re }, { userId: re }] })
      .limit(n)
      .toArray();
    return docs.map(strip);
  }

  const { items } = await readBook();
  const ql = q.toLowerCase();
  const out = [];
  for (const u of items) {
    const ad = String(u?.nickname || "").toLowerCase();
    const isim = String(u?.name || "").toLowerCase();
    const id = String(u?.userId || "").toLowerCase();
    if (ad.includes(ql) || isim.includes(ql) || id.includes(ql)) out.push(u);
    if (out.length >= n) break;
  }
  return out;
}

/**
 * Belirli bir takımı tutan kullanıcılar (takım kadrosu ekranı).
 *
 * Karşılaştırma büyük/küçük harf duyarsız — eski dosya kodu da öyleydi.
 * Mongo'da `mainTeam` indeksli; eskiden tüm kullanıcı dosyası okunup JS'te
 * süzülüyordu.
 */
async function listByTeam(team, db) {
  const t = String(team || "").trim();
  if (!t) return [];

  if (db) {
    await ensureIndexes(db);
    // Kaçış: takım adı düzenli ifade karakteri içerebilir.
    const kacis = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const docs = await db
      .collection(COLL)
      .find({ mainTeam: new RegExp(`^${kacis}$`, "i") })
      .toArray();
    return docs.map(strip);
  }

  const { items } = await readBook();
  const tl = t.toLowerCase();
  return items.filter(
    (u) => String(u?.mainTeam || u?.team || "").toLowerCase() === tl
  );
}

/**
 * Davet kodundan kullanıcıyı bulur (arkadaş daveti).
 * Kod büyük harfe normalize edilir — üretim ve arama aynı biçimde olmalı.
 */
async function findByInviteCode(code, db) {
  const kod = String(code || "").trim().toUpperCase();
  if (!kod) return null;

  if (db) {
    await ensureIndexes(db);
    return strip(await db.collection(COLL).findOne({ inviteCode: kod }));
  }

  const { items } = await readBook();
  return items.find((u) => String(u.inviteCode || "").toUpperCase() === kod) || null;
}

/** Davet kodu başkasında var mı (çakışma kontrolü). */
async function isInviteCodeTaken(code, db) {
  return !!(await findByInviteCode(code, db));
}

/**
 * Takma ad başkasında kullanılıyor mu?
 *
 * Kimliklere de bakılır: okunabilir userId'si olan eski hesapların takma adla
 * taklit edilmesini engelliyor (mevcut davranış korundu).
 *
 * Normalizasyon ÇAĞIRANA ait (uygulamaya özgü Türkçe harf katlama) — depo
 * yalnızca hazır normalize değeri sorgular. Mongo modunda iki indeksli sorgu;
 * eskiden tüm kullanıcılar üzerinde `.some()` çalışıyordu.
 *
 * @param {string} nicknameNorm normalize edilmiş aday
 * @param {string} exceptUserId bu kullanıcının kendi kaydı sayılmaz
 */
async function isNicknameTaken(nicknameNorm, exceptUserId, db) {
  const aday = String(nicknameNorm || "").trim();
  if (!aday) return false;
  const haric = normId(exceptUserId);

  if (db) {
    await ensureIndexes(db);
    const doc = await db.collection(COLL).findOne(
      {
        userId: { $ne: haric },
        $or: [{ nicknameNorm: aday }, { userIdNorm: aday }],
      },
      { projection: { userId: 1 } }
    );
    return !!doc;
  }

  const { items } = await readBook();
  return items.some((x) => {
    if (normId(x.userId) === haric) return false;
    return x.nicknameNorm === aday || x.userIdNorm === aday;
  });
}

/**
 * "1987" segmentindeki kullanıcılar.
 *
 * İki alan de kontrol edilir (`is1987` bayrağı ve `segment` metni) çünkü
 * kayıtlar tarihsel olarak iki biçimde yazılmış; birini atlamak üyelerin bir
 * kısmını sessizce listeden düşürürdü.
 *
 * Mongo modunda indeksli sorgu — eskiden tüm kullanıcılar yüklenip JS'te
 * süzülüyordu.
 */
async function listSegment1987(db) {
  if (db) {
    await ensureIndexes(db);
    const docs = await db
      .collection(COLL)
      .find({ $or: [{ is1987: true }, { segment: /^1987$/i }] })
      .toArray();
    return docs.map(strip);
  }

  const { items } = await readBook();
  return items.filter(
    (u) => u && (u.is1987 === true || String(u.segment || "").toLowerCase() === "1987")
  );
}

/**
 * TÜM kullanıcılar. PAHALI — yalnızca aktarım/yönetim için.
 * İstek yolunda kullanmayın; adı bilerek uzun.
 */
async function listAllUsersExpensive(db) {
  if (db) {
    await ensureIndexes(db);
    return (await db.collection(COLL).find({}).toArray()).map(strip);
  }
  return (await readBook()).items;
}

async function countUsers(db) {
  if (db) {
    await ensureIndexes(db);
    return await db.collection(COLL).countDocuments();
  }
  return (await readBook()).items.length;
}

module.exports = {
  getUser,
  ensureUser,
  updateUser,
  getUsersByIds,
  getUsersByIdsLower,
  isNicknameTaken,
  findByInviteCode,
  isInviteCodeTaken,
  listByTeam,
  searchUsers,
  listSegment1987,
  listAllUsersExpensive,
  countUsers,
  FILE,
  COLL,
  _readBook: readBook,
};
