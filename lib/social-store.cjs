"use strict";

/**
 * SOSYAL DEPOLAR — gruplar, arkadaşlıklar, mini turnuvalar.
 *
 * NEDEN VAR: üçü de yalnızca `data/*.json` dosyalarındaydı ve Render'da kalıcı
 * disk yok — her deploy hepsini siliyordu. Fikstür ya da canlı skor gibi
 * yeniden üretilebilir veri değil bunlar: kullanıcının kurduğu grup, eklediği
 * arkadaş, açtığı turnuva hiçbir kaynaktan geri gelmez. Sessiz kayıp; kimse
 * hata görmez, liste boşalır.
 *
 * Desen lib/fixtures-store.cjs ile aynı: Mongo birincil, dosya ayna,
 * `saveX` TAM LİSTE alır (listede olmayan silinir), boş liste hiçbir şey
 * silmez.
 *
 * EŞZAMANLILIK: rotaların 17 mutasyon noktası da artık aşağıdaki BELGE-BAZLI
 * işlemleri kullanıyor — koşul ve yazma tek Mongo çağrısında, okunan bir
 * değere dayanmadan. Önceki "tümünü oku → birini değiştir → tümünü yaz"
 * deseni iki eşzamanlı isteğin birini kaybediyordu (üç rotada da dosya kilidi
 * yoktu). loadX/saveX yalnızca okuma yollarında ve toplu düzeltmelerde
 * (hesap silme) kaldı.
 *
 * Kayıt başına belge tutuluyor (tek dev belge değil): 16MB sınırına takılmasın
 * ve ileride belge-bazlı güncellemeye geçmek şema değişikliği gerektirmesin.
 */

const path = require("path");
const fsp = require("fs").promises;

const DATA_DIR = process.env.SKORLIG_DATA_DIR || path.join(__dirname, "..", "data");

const COLL_GROUPS = "groups";
const COLL_MINI = "mini_tournaments";
const COLL_LINKS = "friend_links";
const COLL_REQUESTS = "friend_requests";
const COLL_BLOCKS = "friend_blocks";
// Giriş ücretli/havuzlu turnuvalar — mini_tournaments'tan ayrı (gerçek para).
const COLL_TOURNAMENTS = "tournaments";

/** ⚠️ MONGODB_URI yoksa ayna bayrağı YOK SAYILIR (dosya tek kaynaktır). */
const FILE_MIRROR = String(process.env.SKORLIG_SOCIAL_FILE_MIRROR ?? "1") !== "0";
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

const strip = (d) => {
  if (!d) return null;
  const { _id, ...rest } = d;
  return rest;
};

const norm = (x) => String(x || "").trim().toLowerCase();

/* ─────────────────────────── dosya yardımcıları ─────────────────────────── */

let _tmpSayac = 0;

async function readFile_(name, fb) {
  try {
    return JSON.parse(await fsp.readFile(path.join(DATA_DIR, name), "utf8"));
  } catch {
    return fb;
  }
}

async function writeFile_(name, data) {
  const file = path.join(DATA_DIR, name);
// ⚠️ GEÇİCİ AD BENZERSİZ OLMALI. Sabit `${file}.tmp` iken eşzamanlı iki
// yazım aynı geçici dosyada yarışıyor: biri rename ediyor, diğeri
// ENOENT alıyor. Atomik yazmanın kendisi yarış üretiyordu — eşzamanlılık
// testi yakaladı. (lib/fileLock.cjs bunu baştan doğru yapıyordu.)
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${++_tmpSayac}`;
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  await fsp.rename(tmp, file);
}

/**
 * Tam değiştirme: listedekiler upsert, listede olmayanlar silinir.
 * `keyOf` belgenin benzersiz anahtarını üretir; `keyField` o anahtarın alan adı.
 *
 * ⚠️ BOŞ LİSTE GERÇEKTEN SİLER — lib/fixtures-store.cjs'in TERSİ. Ayrım kasıtlı:
 *
 *   Fikstürlerde boş liste bir BAŞARISIZLIK belirtisidir (dış kaynak cevap
 *   vermedi), o yüzden orada silme engellenir.
 *
 *   Sosyal veride boş liste GEÇERLİ BİR DURUMDUR: son arkadaşlık isteği kabul
 *   edilince `requests` boşalır, son arkadaş silinince `links` boşalır. Burada
 *   silmeyi engellemek, kullanıcının "arkadaşı çıkar" eylemini sessizce
 *   çalışmaz kılardı — dosya sürümünde böyle bir engel yoktu, yani gerileme
 *   olurdu. (Bu koruma önce buraya da kopyalanmıştı; test yakaladı.)
 *
 * KALAN RİSK, açıkça: `loadX` Mongo'ya erişemezse dosyaya düşer; dosya da yoksa
 * boş döner. Hemen ardından gelen bir `saveX` o boşluğu kalıcı hâle getirebilir.
 * Dosya aynasının varsayılan AÇIK olmasının bir sebebi de bu. Gerçek çözüm
 * rotaların belge-bazlı güncellemeye geçmesi ($addToSet / $pull) — ayrı iş.
 */
async function replaceAll(db, coll, items, keyField, keyOf) {
  if (!db) return { ok: false, deleted: 0 };
  try {
    const col = db.collection(coll);
    const keys = items.map(keyOf);
    if (items.length) {
      await col.bulkWrite(
        items.map((it, i) => ({
          updateOne: {
            filter: { [keyField]: keys[i] },
            update: { $set: { ...it, [keyField]: keys[i] } },
            upsert: true,
          },
        })),
        { ordered: false }
      );
    }
    const r = await col.deleteMany({ [keyField]: { $nin: keys } });
    return { ok: true, deleted: r?.deletedCount || 0 };
  } catch (e) {
    // Sessiz kalmıyoruz: yazılamayan kayıt, yeniden başlatmada kaybolur.
    console.error(`[social-store] ${coll} yazilamadi:`, e?.message || e);
    return { ok: false, deleted: 0 };
  }
}

let _indexed = false;
async function ensureIndexes(db) {
  if (_indexed || !db) return;
  _indexed = true;
  try {
    await db.collection(COLL_GROUPS).createIndex({ code: 1 }, { unique: true, background: true });
    await db.collection(COLL_GROUPS).createIndex({ ownerId: 1 }, { background: true });
    await db.collection(COLL_MINI).createIndex({ id: 1 }, { unique: true, background: true });
    await db.collection(COLL_MINI).createIndex({ code: 1 }, { background: true });
    await db.collection(COLL_LINKS).createIndex({ pair: 1 }, { unique: true, background: true });
    // Arkadaş listesi iki uçtan da sorgulanıyor.
    await db.collection(COLL_LINKS).createIndex({ a: 1 }, { background: true });
    await db.collection(COLL_LINKS).createIndex({ b: 1 }, { background: true });
    await db.collection(COLL_REQUESTS).createIndex({ pair: 1 }, { unique: true, background: true });
    await db.collection(COLL_BLOCKS).createIndex({ pair: 1 }, { unique: true, background: true });
    await db.collection(COLL_TOURNAMENTS).createIndex({ id: 1 }, { unique: true, background: true });
    await db.collection(COLL_TOURNAMENTS).createIndex({ code: 1 }, { background: true });
    // Ödeme taraması "open" olanları arıyor.
    await db.collection(COLL_TOURNAMENTS).createIndex({ status: 1 }, { background: true });
  } catch (e) {
    console.error("[social-store] indeks kurulamadi:", e?.message || e);
  }
}


/* ── HAM MONGO OKUMALARI (geri düşüş YOK) ─────────────────────────────────
 * loadX'in dosya yedeği + tohumlama davranışı var. Ayna tazelerken onu
 * kullanmak ölümcül: silme sonrası Mongo boşalıyor, loadX eski dosyaya
 * düşüp SİLİNEN KAYDI geri tohumluyordu — test yakaladı. Ayna yalnızca
 * Mongo'nun gerçek hâlini yazmalı.
 */
async function hamGroups(conn) {
  const docs = await conn.collection(COLL_GROUPS).find({}).toArray();
  const out = {};
  for (const d of docs) {
    const { code, ...rest } = strip(d);
    out[code] = rest;
  }
  return out;
}
async function hamMini(conn) {
  return (await conn.collection(COLL_MINI).find({}).toArray()).map(strip);
}
async function hamFriends(conn) {
  const kes = (d) => {
    const { pair, ...rest } = strip(d);
    return rest;
  };
  const [links, requests, blocks] = await Promise.all([
    conn.collection(COLL_LINKS).find({}).toArray(),
    conn.collection(COLL_REQUESTS).find({}).toArray(),
    conn.collection(COLL_BLOCKS).find({}).toArray(),
  ]);
  return { links: links.map(kes), requests: requests.map(kes), blocks: blocks.map(kes) };
}

/** Ayna tazeleme — hata yutulur, asıl yazma zaten Mongo'ya yapıldı. */
async function aynayiTazele(conn, hangi) {
  if (!mirrorOn()) return;
  try {
    if (hangi === "groups") await writeFile_("groups.json", await hamGroups(conn));
    else if (hangi === "mini") await saveMiniFileOnly(await hamMini(conn));
    else if (hangi === "friends") await writeFile_("friends.json", await hamFriends(conn));
    else if (hangi === "tournaments") await writeFile_("tournaments.json", { tournaments: await hamTournaments(conn) });
  } catch (e) {
    console.error("[social-store] ayna tazelenemedi:", e?.message || e);
  }
}

/**
 * Mongo BOŞ ama dosyada veri varsa, dosyayı Mongo'ya bir kez taşır.
 *
 * ⚠️ NEDEN GEREKLİ: "Mongo boşsa dosyaya düş" kuralı, veri MEŞRU ŞEKİLDE
 * boşaldığında yanlış çalışıyor — son arkadaşlık isteği silinince Mongo
 * boşalıyor, okuma dosyaya düşüp silinmiş kaydı DİRİLTİYORDU. Test yakaladı.
 *
 * Tohumlamadan sonra Mongo dolu olur; "boş" artık gerçekten boş demektir ve
 * dosyaya bir daha düşülmez. Silme dosya aynasına da yansıdığı için tekrar
 * tohumlanacak eski veri de kalmaz.
 */
async function tohumla(conn, hangi, dosyaVerisi, bos) {
  if (!conn || bos) return false;
  try {
    if (hangi === "groups") await saveGroups(dosyaVerisi, conn);
    else if (hangi === "mini") await saveMini(dosyaVerisi, conn);
    else if (hangi === "friends") await saveFriends(dosyaVerisi, conn);
    else if (hangi === "tournaments") await saveTournaments(dosyaVerisi, conn);
    return true;
  } catch (e) {
    console.error("[social-store] tohumlama basarisiz:", e?.message || e);
    return false;
  }
}

/* ───────────────────────────────── gruplar ──────────────────────────────── */
// Dosya biçimi: { CODE: { name, ownerId, members:[], opts:{}, ... } }

async function loadGroups(db) {
  const conn = await getDbSafe(db);
  if (conn) {
    try {
      await ensureIndexes(conn);
      const docs = await conn.collection(COLL_GROUPS).find({}).toArray();
      if (docs.length) {
        const out = {};
        for (const d of docs) {
          const { code, ...rest } = strip(d);
          out[code] = rest;
        }
        return out;
      }
    } catch (e) {
      console.error("[social-store] gruplar okunamadi, dosyaya dusuluyor:", e?.message || e);
    }
  }
  const raw = await readFile_("groups.json", {});
  const map = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  await tohumla(conn, "groups", map, Object.keys(map).length === 0);
  return map;
}

async function saveGroups(map, db) {
  const store = map && typeof map === "object" ? map : {};
  const items = Object.entries(store).map(([code, g]) => ({ ...g, code: String(code) }));

  const conn = await getDbSafe(db);
  let wrote = { ok: false };
  if (conn) {
    await ensureIndexes(conn);
    wrote = await replaceAll(conn, COLL_GROUPS, items, "code", (g) => String(g.code));
  }
  if (mirrorOn() || !wrote.ok) await writeFile_("groups.json", store);
  return wrote;
}

/* ────────────────────────────── mini turnuvalar ─────────────────────────── */
// Dosya biçimi: { items: [ { id, code, ... } ], updatedAt }

async function loadMini(db) {
  const conn = await getDbSafe(db);
  if (conn) {
    try {
      await ensureIndexes(conn);
      const docs = await conn.collection(COLL_MINI).find({}).toArray();
      if (docs.length) return docs.map(strip);
    } catch (e) {
      console.error("[social-store] mini turnuvalar okunamadi, dosyaya dusuluyor:", e?.message || e);
    }
  }
  const raw = await readFile_("mini-tournaments.json", { items: [] });
  const list = Array.isArray(raw?.items) ? raw.items : [];
  await tohumla(conn, "mini", list, list.length === 0);
  return list;
}

async function saveMini(items, db) {
  const list = (Array.isArray(items) ? items : []).filter((t) => t && t.id);

  const conn = await getDbSafe(db);
  let wrote = { ok: false };
  if (conn) {
    await ensureIndexes(conn);
    wrote = await replaceAll(conn, COLL_MINI, list, "id", (t) => String(t.id));
  }
  if (mirrorOn() || !wrote.ok) {
    await writeFile_("mini-tournaments.json", { items: list, updatedAt: new Date().toISOString() });
  }
  return wrote;
}

/* ─────────────────────────────── arkadaşlıklar ──────────────────────────── */
// Dosya biçimi: { links:[{a,b,createdAt}], requests:[...], blocks:[{by,target,...}] }

/** Yönsüz çift anahtarı — (a,b) ile (b,a) aynı bağlantıdır. */
const pairKey = (x, y) => [norm(x), norm(y)].sort().join("::");
/** Yönlü anahtar — istek ve engel yön taşır. */
const dirKey = (from, to) => `${norm(from)}->${norm(to)}`;

function reqKey(r) {
  return dirKey(r?.from ?? r?.a ?? r?.by, r?.to ?? r?.b ?? r?.target);
}
function blockKey(b) {
  return dirKey(b?.by ?? b?.a, b?.target ?? b?.b);
}

async function loadFriends(db) {
  const conn = await getDbSafe(db);
  if (conn) {
    try {
      await ensureIndexes(conn);
      const [links, requests, blocks] = await Promise.all([
        conn.collection(COLL_LINKS).find({}).toArray(),
        conn.collection(COLL_REQUESTS).find({}).toArray(),
        conn.collection(COLL_BLOCKS).find({}).toArray(),
      ]);
      if (links.length || requests.length || blocks.length) {
        const kes = (d) => {
          const { pair, ...rest } = strip(d);
          return rest;
        };
        return { links: links.map(kes), requests: requests.map(kes), blocks: blocks.map(kes) };
      }
    } catch (e) {
      console.error("[social-store] arkadasliklar okunamadi, dosyaya dusuluyor:", e?.message || e);
    }
  }
  const raw = await readFile_("friends.json", null);
  const m = raw && typeof raw === "object" ? raw : {};
  const out = {
    links: Array.isArray(m.links) ? m.links : [],
    requests: Array.isArray(m.requests) ? m.requests : [],
    blocks: Array.isArray(m.blocks) ? m.blocks : [],
  };
  const bos = !out.links.length && !out.requests.length && !out.blocks.length;
  await tohumla(conn, "friends", out, bos);
  return out;
}

async function saveFriends(m, db) {
  const out = {
    links: Array.isArray(m?.links) ? m.links : [],
    requests: Array.isArray(m?.requests) ? m.requests : [],
    blocks: Array.isArray(m?.blocks) ? m.blocks : [],
  };

  const conn = await getDbSafe(db);
  let ok = false;
  if (conn) {
    await ensureIndexes(conn);
    const r1 = await replaceAll(conn, COLL_LINKS, out.links, "pair", (l) => pairKey(l.a, l.b));
    const r2 = await replaceAll(conn, COLL_REQUESTS, out.requests, "pair", reqKey);
    const r3 = await replaceAll(conn, COLL_BLOCKS, out.blocks, "pair", blockKey);
    ok = r1.ok || r2.ok || r3.ok;
  }
  if (mirrorOn() || !ok) await writeFile_("friends.json", out);
  return { ok };
}

/* ══════════════════════ BELGE-BAZLI ATOMİK İŞLEMLER ══════════════════════
 *
 * Yukarıdaki loadX/saveX çifti "tümünü oku → birini değiştir → tümünü yaz"
 * yapıyor. Bu desen iki eşzamanlı isteği kaybeder: ikisi de aynı anlık
 * görüntüyü okur, ikincinin yazımı birincininkini siler. Dosya sürümünde de
 * böyleydi (üç rotada da kilit yoktu) — taşıma bunu çözmemişti.
 *
 * Aşağıdaki işlemler koşulu ve yazmayı TEK Mongo çağrısında yapar; okunan bir
 * değere dayanmaz, yani yarış kalmaz. Mongo yoksa eski oku-değiştir-yaz yoluna
 * düşülür: tek süreçli dosya modunda kabul edilebilir, çünkü asıl risk çok
 * instance'lı üretimde.
 *
 * loadX/saveX korundu — okuma yolları ve toplu düzeltmeler (hesap silme) hâlâ
 * onları kullanıyor.
 */

const code6 = () => {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
};

/**
 * Grup kurar ve kodunu döndürür.
 *
 * Eski kod `do { code = code6(); } while (store[code])` ile çakışma arıyordu —
 * kendisi de yarışlıydı: iki eşzamanlı kurulum aynı kodu boş görüp ikisi de
 * alabilirdi. Burada benzersiz indeks karar veriyor: çakışırsa insertOne
 * duplicate key atar, yeni kod denenir.
 */
async function createGroup({ name, ownerId }, db) {
  const g = {
    name: String(name),
    ownerId: String(ownerId),
    members: [String(ownerId)],
    opts: {},
    createdAt: new Date().toISOString(),
  };

  const conn = await getDbSafe(db);
  if (conn) {
    await ensureIndexes(conn);
    for (let deneme = 0; deneme < 8; deneme++) {
      const code = code6();
      try {
        await conn.collection(COLL_GROUPS).insertOne({ ...g, code });
      } catch (e) {
        if (e?.code === 11000) continue; // kod tutuldu, yenisini dene
        console.error("[social-store] grup kurulamadi:", e?.message || e);
        break;
      }
      // ⚠️ AYNA YAZIMI try DIŞINDA. İçerideyken dosya hatası (Windows'ta
      // eşzamanlı rename EPERM veriyor) ekleme başarısız sanılıyor, aşağıdaki
      // dosya yoluna düşülüp AYNI grup ikinci kez kuruluyordu — 20 istek 22
      // grup üretti. Ayna en iyi çaba; asıl yazma zaten başarılı.
      await aynayiTazele(conn, "groups");
      return { code, group: g };
    }
  }

  const store = await loadGroups(conn);
  let code;
  do { code = code6(); } while (store[code]);
  store[code] = g;
  await saveGroups(store, conn);
  return { code, group: g };
}

/**
 * Gruba üye ekler. `$addToSet` hem atomiktir hem de mükerrer üyeliği
 * kendiliğinden engeller — `includes` kontrolü gerekmez.
 * @returns {Promise<object|null>} güncel grup, grup yoksa null
 */
async function joinGroup(code, uid, db) {
  const kod = String(code || "").toUpperCase();
  const kisi = String(uid || "").trim();
  if (!kod || !kisi) return null;

  const conn = await getDbSafe(db);
  if (conn) {
    try {
      await ensureIndexes(conn);
      const r = await conn.collection(COLL_GROUPS).findOneAndUpdate(
        { code: kod },
        { $addToSet: { members: kisi } },
        { returnDocument: "after" }
      );
      const doc = r && ("value" in r ? r.value : r);
      if (!doc) return null;
      await aynayiTazele(conn, "groups");
      const { code: _c, ...rest } = strip(doc);
      return rest;
    } catch (e) {
      console.error("[social-store] gruba katilinamadi:", e?.message || e);
    }
  }

  const store = await loadGroups(conn);
  const g = store[kod];
  if (!g) return null;
  if (!Array.isArray(g.members)) g.members = [];
  if (!g.members.includes(kisi)) g.members.push(kisi);
  await saveGroups(store, conn);
  return g;
}

/** Üyenin grup seçeneğini yazar (nokta yolu: yalnızca o alan güncellenir). */
async function setGroupOpt(code, uid, includeInTotal, db) {
  const kod = String(code || "").toUpperCase();
  const kisi = String(uid || "");
  const conn = await getDbSafe(db);

  if (conn) {
    try {
      await ensureIndexes(conn);
      const r = await conn.collection(COLL_GROUPS).updateOne(
        { code: kod },
        { $set: { [`opts.${kisi}`]: { includeInTotal: !!includeInTotal } } }
      );
      if (!r.matchedCount) return false;
      await aynayiTazele(conn, "groups");
      return true;
    } catch (e) {
      console.error("[social-store] grup secenegi yazilamadi:", e?.message || e);
    }
  }

  const store = await loadGroups(conn);
  const g = store[kod];
  if (!g) return false;
  g.opts = g.opts || {};
  g.opts[kisi] = { includeInTotal: !!includeInTotal };
  await saveGroups(store, conn);
  return true;
}

/* ───────────────────────────── arkadaşlık işlemleri ─────────────────────── */

async function friendOp(db, coll, filter, doc, sil) {
  const conn = await getDbSafe(db);
  if (conn) {
    try {
      await ensureIndexes(conn);
      const col = conn.collection(coll);
      if (sil) await col.deleteMany(filter);
      else await col.updateOne(filter, { $set: { ...doc, ...filter } }, { upsert: true });
      await aynayiTazele(conn, "friends");
      return true;
    } catch (e) {
      console.error(`[social-store] ${coll} islemi basarisiz:`, e?.message || e);
    }
  }
  return false;
}

/** Arkadaşlık kurar (yönsüz, idempotent). */
async function addLink(a, b, db) {
  const doc = { a: String(a), b: String(b), createdAt: new Date().toISOString() };
  if (await friendOp(db, COLL_LINKS, { pair: pairKey(a, b) }, doc, false)) return true;
  const m = await loadFriends(db);
  if (!m.links.some((l) => pairKey(l.a, l.b) === pairKey(a, b))) m.links.push(doc);
  await saveFriends(m, db);
  return true;
}

/** Arkadaşlığı kaldırır. */
async function removeLink(a, b, db) {
  if (await friendOp(db, COLL_LINKS, { pair: pairKey(a, b) }, null, true)) return true;
  const m = await loadFriends(db);
  m.links = m.links.filter((l) => pairKey(l.a, l.b) !== pairKey(a, b));
  await saveFriends(m, db);
  return true;
}

/** İstek gönderir (yönlü, idempotent). */
async function addRequest(from, to, db) {
  const doc = { from: String(from), to: String(to), createdAt: new Date().toISOString() };
  if (await friendOp(db, COLL_REQUESTS, { pair: dirKey(from, to) }, doc, false)) return true;
  const m = await loadFriends(db);
  if (!m.requests.some((r) => reqKey(r) === dirKey(from, to))) m.requests.push(doc);
  await saveFriends(m, db);
  return true;
}

/**
 * İstekleri siler. `ciftYonlu` ile (a→b) ve (b→a) birlikte temizlenir —
 * arkadaşlık kurulunca ya da engellenince ikisi de kalkmalı.
 */
async function removeRequest(from, to, db, ciftYonlu = false) {
  const anahtarlar = ciftYonlu ? [dirKey(from, to), dirKey(to, from)] : [dirKey(from, to)];
  if (await friendOp(db, COLL_REQUESTS, { pair: { $in: anahtarlar } }, null, true)) return true;
  const m = await loadFriends(db);
  m.requests = m.requests.filter((r) => !anahtarlar.includes(reqKey(r)));
  await saveFriends(m, db);
  return true;
}

/** Engel ekler (yönlü, idempotent). */
async function addBlock(by, target, db) {
  const doc = { by: String(by), target: String(target), createdAt: new Date().toISOString() };
  if (await friendOp(db, COLL_BLOCKS, { pair: dirKey(by, target) }, doc, false)) return true;
  const m = await loadFriends(db);
  if (!m.blocks.some((x) => blockKey(x) === dirKey(by, target))) m.blocks.push(doc);
  await saveFriends(m, db);
  return true;
}

/** Engeli kaldırır. */
async function removeBlock(by, target, db) {
  if (await friendOp(db, COLL_BLOCKS, { pair: dirKey(by, target) }, null, true)) return true;
  const m = await loadFriends(db);
  m.blocks = m.blocks.filter((x) => blockKey(x) !== dirKey(by, target));
  await saveFriends(m, db);
  return true;
}

/* ─────────────────────────── mini turnuva işlemleri ─────────────────────── */

/** Yeni turnuva ekler. */
async function createMini(t, db) {
  const conn = await getDbSafe(db);
  if (conn && t?.id) {
    try {
      await ensureIndexes(conn);
      await conn.collection(COLL_MINI).insertOne({ ...t });
      await aynayiTazele(conn, "mini");
      return true;
    } catch (e) {
      console.error("[social-store] turnuva olusturulamadi:", e?.message || e);
    }
  }
  const items = await loadMini(conn);
  items.push(t);
  await saveMini(items, conn);
  return true;
}

/**
 * Turnuvaya üye ekler; kapasiteyi AYNI sorguda kontrol eder.
 *
 * ⚠️ Eski kod `if (t.members.length >= MAX) reddet; t.members.push(...)` idi —
 * kontrol ile yazma arasında boşluk var, iki eşzamanlı katılım tavanı aşabilir.
 * `$expr` ile boyut koşulu filtreye taşındı; `$addToSet` de mükerrer üyeliği
 * engelliyor.
 *
 * @returns {Promise<"ok"|"NOT_FOUND"|"FULL"|"ALREADY">}
 */
async function addMiniMember(id, uid, maxMembers, db) {
  const kisi = String(uid || "").trim();
  if (!id || !kisi) return "NOT_FOUND";

  const conn = await getDbSafe(db);
  if (conn) {
    try {
      await ensureIndexes(conn);
      const col = conn.collection(COLL_MINI);
      const r = await col.updateOne(
        {
          id: String(id),
          members: { $ne: kisi },
          $expr: { $lt: [{ $size: { $ifNull: ["$members", []] } }, maxMembers] },
        },
        { $addToSet: { members: kisi } }
      );
      if (r.matchedCount) {
        await aynayiTazele(conn, "mini");
        return "ok";
      }
      // Eşleşmedi: üç sebepten biri. Hangisi olduğunu ayırt et.
      const t = await col.findOne({ id: String(id) }, { projection: { members: 1 } });
      if (!t) return "NOT_FOUND";
      if ((t.members || []).includes(kisi)) return "ALREADY";
      return "FULL";
    } catch (e) {
      console.error("[social-store] turnuvaya uye eklenemedi:", e?.message || e);
    }
  }

  const items = await loadMini(conn);
  const t = items.find((x) => String(x.id) === String(id));
  if (!t) return "NOT_FOUND";
  t.members = Array.isArray(t.members) ? t.members : [];
  if (t.members.includes(kisi)) return "ALREADY";
  if (t.members.length >= maxMembers) return "FULL";
  t.members.push(kisi);
  await saveMini(items, conn);
  return "ok";
}

/**
 * Turnuvayı bitirir. `finishedAt` yoksa yazar; VARSA hiçbir şey yapmaz.
 *
 * ⚠️ BU BİR PARA KORUMASI. Eski kod `if (cur.finishedAt) return` ile kontrol
 * edip SONRA ödül dağıtıyordu; iki eşzamanlı çağrı ikisi de kontrolü geçip
 * ödülü İKİ KEZ verebilirdi. Koşul artık sorgunun içinde — kazanan tek çağrı
 * true alır, ödül yalnızca o dalda dağıtılır.
 *
 * @returns {Promise<boolean>} bu çağrı bitirdiyse true (ödülü sen dağıt)
 */
async function finishMini(id, alanlar, db) {
  const conn = await getDbSafe(db);
  if (conn) {
    try {
      await ensureIndexes(conn);
      const r = await conn.collection(COLL_MINI).updateOne(
        { id: String(id), $or: [{ finishedAt: null }, { finishedAt: { $exists: false } }] },
        { $set: { ...alanlar } }
      );
      if (r.modifiedCount) await aynayiTazele(conn, "mini");
      return r.modifiedCount > 0;
    } catch (e) {
      console.error("[social-store] turnuva bitirilemedi:", e?.message || e);
    }
  }

  const items = await loadMini(conn);
  const t = items.find((x) => String(x.id) === String(id));
  if (!t || t.finishedAt) return false;
  Object.assign(t, alanlar);
  await saveMini(items, conn);
  return true;
}

/** Yalnızca dosya aynasını tazeler (Mongo zaten yazıldı). */
async function saveMiniFileOnly(items) {
  await writeFile_("mini-tournaments.json", {
    items,
    updatedAt: new Date().toISOString(),
  });
}

/* ══════════════════════════════ TURNUVALAR ══════════════════════════════
 * Dosya biçimi: { tournaments: [ { id, code, status, pool, participants, ... } ] }
 *
 * `mini_tournaments`'tan AYRI: bunlar giriş ücretli (entryLC), havuzlu ve
 * ödeme tablosu olan turnuvalar — yani gerçek para. services/tournament.cjs
 * ve settle2 birlikte kullanıyor.
 */

async function hamTournaments(conn) {
  return (await conn.collection(COLL_TOURNAMENTS).find({}).toArray()).map(strip);
}

async function loadTournaments(db) {
  const conn = await getDbSafe(db);
  if (conn) {
    try {
      await ensureIndexes(conn);
      const docs = await hamTournaments(conn);
      if (docs.length) return docs;
    } catch (e) {
      console.error("[social-store] turnuvalar okunamadi, dosyaya dusuluyor:", e?.message || e);
    }
  }
  const raw = await readFile_("tournaments.json", { tournaments: [] });
  const list = Array.isArray(raw?.tournaments) ? raw.tournaments : [];
  await tohumla(conn, "tournaments", list, list.length === 0);
  return list;
}

async function saveTournaments(list, db) {
  const items = (Array.isArray(list) ? list : []).filter((t) => t && t.id);
  const conn = await getDbSafe(db);
  let wrote = { ok: false };
  if (conn) {
    await ensureIndexes(conn);
    wrote = await replaceAll(conn, COLL_TOURNAMENTS, items, "id", (t) => String(t.id));
  }
  if (mirrorOn() || !wrote.ok) await writeFile_("tournaments.json", { tournaments: items });
  return wrote;
}

/**
 * Turnuva ödemesini ATOMİK olarak üstlenir: `status` "open" ise "settled"
 * yapar. Yalnızca kazanan çağrı true döner.
 *
 * ⚠️ PARA KORUMASI. settle2'deki eski akış: dosyadan oku → `status==="open"`
 * olanları süz → ödemeleri YAP → en sonda (≈60 satır aşağıda) hepsini kaydet.
 * Kontrol ile kayıt arasındaki pencerede ikinci bir settle çağrısı aynı
 * turnuvayı hâlâ "open" görür ve ödemeyi TEKRAR yapar. settle2 aynı fixture
 * için livescore-sync, af-sync ve manuel çağrılardan tetiklenebiliyor.
 *
 * @returns {Promise<boolean>} ödemeyi BU çağrı yapacaksa true
 */
async function claimTournamentSettle(id, nowISO, db) {
  const tid = String(id || "");
  if (!tid) return false;
  const damga = nowISO || new Date().toISOString();

  const conn = await getDbSafe(db);
  if (conn) {
    try {
      await ensureIndexes(conn);
      const r = await conn.collection(COLL_TOURNAMENTS).updateOne(
        { id: tid, status: "open" },
        { $set: { status: "settled", settledAt: damga } }
      );
      if (!r.modifiedCount) return false;
      await aynayiTazele(conn, "tournaments");
      return true;
    } catch (e) {
      // Mühür alınamadıysa ÖDEME YAPMA — çift ödemektense atlamak güvenli.
      console.error("[social-store] turnuva muhru alinamadi:", e?.message || e);
      return false;
    }
  }

  const list = await loadTournaments(conn);
  const t = list.find((x) => String(x.id) === tid);
  if (!t || t.status !== "open") return false;
  t.status = "settled";
  t.settledAt = damga;
  await saveTournaments(list, conn);
  return true;
}

module.exports = {
  loadGroups, saveGroups,
  loadMini, saveMini,
  loadFriends, saveFriends,
  loadTournaments, saveTournaments, claimTournamentSettle,
  createGroup, joinGroup, setGroupOpt,
  addLink, removeLink, addRequest, removeRequest, addBlock, removeBlock,
  createMini, addMiniMember, finishMini,
  COLL_GROUPS, COLL_MINI, COLL_LINKS, COLL_REQUESTS, COLL_BLOCKS, COLL_TOURNAMENTS,
  _pairKey: pairKey,
  _mirrorOn: mirrorOn,
};
