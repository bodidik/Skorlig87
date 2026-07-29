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
 * ⚠️ EŞZAMANLILIK — DÜRÜST NOT: bu taşıma KALICILIK kazandırır, yarış koşulunu
 * ÇÖZMEZ. Üç rota da bugün "tümünü oku → birini değiştir → tümünü yaz" yapıyor
 * ve hiçbirinde dosya kilidi yok (ölçüldü: groups/friends/mini → 0 withFileLock).
 * Yani iki kullanıcı aynı anda gruba katılırsa biri kaybolabilir — bu davranış
 * taşımadan ÖNCE de böyleydi, taşımayla değişmiyor. Gerçek çözüm rotaların
 * belge-bazlı güncellemeye geçmesi ($addToSet / $pull); ayrı bir iş.
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

async function readFile_(name, fb) {
  try {
    return JSON.parse(await fsp.readFile(path.join(DATA_DIR, name), "utf8"));
  } catch {
    return fb;
  }
}

async function writeFile_(name, data) {
  const file = path.join(DATA_DIR, name);
  const tmp = file + ".tmp";
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
  } catch (e) {
    console.error("[social-store] indeks kurulamadi:", e?.message || e);
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
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
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
  return Array.isArray(raw?.items) ? raw.items : [];
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
  return {
    links: Array.isArray(m.links) ? m.links : [],
    requests: Array.isArray(m.requests) ? m.requests : [],
    blocks: Array.isArray(m.blocks) ? m.blocks : [],
  };
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

module.exports = {
  loadGroups, saveGroups,
  loadMini, saveMini,
  loadFriends, saveFriends,
  COLL_GROUPS, COLL_MINI, COLL_LINKS, COLL_REQUESTS, COLL_BLOCKS,
  _pairKey: pairKey,
  _mirrorOn: mirrorOn,
};
