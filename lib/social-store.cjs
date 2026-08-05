"use strict";


const crypto = require("crypto");
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
// Düellolar: oyuncu-oyuncu, bahisli. Aynı dosya-deseni + kendi mührü.
const COLL_DUELS = "duels";

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

// ⚠️ BAYRAK DEĞİL SÖZ (promise) ÖNBELLEKLENİR.
// Eskiden `if (_indexed) return; _indexed = true;` idi ve bayrak
// `await createIndex(...)` TAMAMLANMADAN kalkıyordu. Eşzamanlı ikinci çağrı
// "indeksler hazır" sanıp hemen dönüyor, indeks HENÜZ YOKKEN upsert yapıyordu
// → aynı anahtardan KOPYA BELGE. Benzersizliğe dayanan para korumaları
// (claimAward, claimDuelSettle) o kopyalar yüzünden birden fazla çağrıya
// "kazandın" diyordu — eşzamanlılık testi yakaladı (20 çağrının 2'si geçti).
// Söz önbekleyince ikinci çağrı aynı sözü BEKLER.
let _indexPromise = null;
function ensureIndexes(db) {
  if (!db) return Promise.resolve();
  if (_indexPromise) return _indexPromise;
  _indexPromise = (async () => {
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
    await db.collection(COLL_DUELS).createIndex({ id: 1 }, { unique: true, background: true });
    await db.collection(COLL_DUELS).createIndex({ status: 1 }, { background: true });
    await db.collection(COLL_DUELS).createIndex({ fixtureId: 1 }, { background: true });
  } catch (e) {
    console.error("[social-store] indeks kurulamadi:", e?.message || e);
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
    const { pair: _pair, ...rest } = strip(d);
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
    else if (hangi === "duels") await writeFile_("duels.json", await hamDuels(conn));
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
    // ⚠️ SESSİZ OLMAMALI. Yaşandı (2026-07-29): `.env`'i ÜRETİM Atlas'ına bakan
    // bir yerel sunucu çalıştırıldığında bu tohumlama, geliştirme makinesindeki
    // 13 test grubunu üretime yazdı. Kimse fark etmedi çünkü hiçbir iz yoktu.
    // Tohumlama doğru davranış (üretim kendi dosyasından Mongo'ya geçiyor) ama
    // NE ZAMAN ve NE KADAR çalıştığı loga düşmeli.
    const adet = Array.isArray(dosyaVerisi)
      ? dosyaVerisi.length
      : Object.keys(dosyaVerisi || {}).length || "?";
    console.warn(
      `[social-store] TOHUMLAMA: ${hangi} koleksiyonu bos, dosyadan ${adet} kayit yaziliyor. ` +
      `Yerel calistiriyorsan .env'in URETIM veritabanina bakmadigindan emin ol.`
    );
    if (hangi === "groups") await saveGroups(dosyaVerisi, conn);
    else if (hangi === "mini") await saveMini(dosyaVerisi, conn);
    else if (hangi === "friends") await saveFriends(dosyaVerisi, conn);
    else if (hangi === "tournaments") await saveTournaments(dosyaVerisi, conn);
    else if (hangi === "duels") await saveDuels(dosyaVerisi, conn);
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

/**
 * ⚠️ AYNAYA DÜŞME KARARI KOLEKSİYON BAŞINA VERİLİR.
 *
 * BULUNAN: eski koşul `links.length || requests.length || blocks.length` idi —
 * ÜÇÜ BİRDEN boş değilse Mongo sonucu olduğu gibi dönüyordu. Yani Mongo'da
 * ALAKASIZ tek bir arkadaşlık bağı bulunması, yalnızca `friends.json`'da
 * kalmış bir ENGELİ görünmez yapıyordu.
 *
 * ÖLÇÜLDÜ (dosyada 1 engel, aynı veri):
 *     mongo tamamen boş            → blocks: 1   engel görünüyor
 *     mongo'da 1 ALAKASIZ bağ var  → blocks: 0   engel KAYBOLDU
 *
 * ⚠️ NEDEN CİDDİ: `routes/friends.cjs` engel denetimini tam bu yüzden ekledi —
 * kendi notu "engellenen biri, engelleyenin kodunu kullanarak arkadaş
 * olabiliyordu, engelin tamamını atlayarak" diyor. Engel listesi boş dönünce
 * o denetim sessizce hiçbir şey yapmaz: hata yok, log yok, sadece geçer.
 *
 * ⚠️ AYNI KUSUR BU OTURUMDA `lib/streak-store.cjs`'te de bulundu: "hiçbiri
 * yoksa dosyaya düş" kestirmesi, bağımsız kayıtları tek bir karara bağlıyor.
 */
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
          const { pair: _pair, ...rest } = strip(d);
          return rest;
        };
        const cikti = {
          links: links.map(kes), requests: requests.map(kes), blocks: blocks.map(kes),
        };

        /* Mongo'da BOŞ dönen koleksiyonlar aynadan tamamlanır. Dolu olanlara
         * dokunulmaz: Mongo birincil kaynak, ayna yalnızca boşluğu doldurur. */
        const eksik = ["links", "requests", "blocks"].filter((k) => !cikti[k].length);
        if (eksik.length) {
          const ayna = await readFile_("friends.json", null);
          if (ayna && typeof ayna === "object") {
            for (const k of eksik) {
              if (Array.isArray(ayna[k]) && ayna[k].length) {
                console.warn(
                  `[social-store] ${k}: mongo bos, aynadan ${ayna[k].length} kayit kullaniliyor`
                );
                cikti[k] = ayna[k];
              }
            }
          }
        }
        return cikti;
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

/**
 * Grup kodu üretimi.
 *
 * ⚠️ ESKİDEN `Math.random()` KULLANIYORDU. Kod tabanindaki diğer iki kod
 * üreticisi (arkadaş davet kodu — routes/friends.cjs, mini turnuva kodu —
 * routes/mini.cjs) `crypto.randomInt` kullanıyordu; yalnızca grup kodu
 * ayrışıyordu.
 *
 * Neden önemli: `Math.random()` öngörülebilir. V8'in üreteci ardışık
 * çıktılardan iç durumu geri kazanılabilecek bir PRNG; birkaç grup kurup
 * kendi kodlarını gören biri, AYNI SÜREÇte üretilen başka grupların
 * kodlarını kestirebilir. Grup kodu iki şey veriyor: `/groups/:code/board`
 * (kimliksiz okunuyor — üye listesi ve puanlar) ve `/groups/join`.
 *
 * ⚠️ ALFABE DE DEĞİŞTİ: I/O/0/1 çıkarıldı. Kodlar elle yazılıyor ve
 * paylaşılıyor; karıştırılan karakterler "kod yanlış" şikayeti üretir. Diğer
 * iki üretici zaten bu alfabeyi kullanıyordu. Eski kodlar geçerli kalır —
 * doğrulama yalnızca büyük harfe çeviriyor, karakter kümesi dayatmıyor.
 */
const code6 = () => {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += A[crypto.randomInt(A.length)];
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

/**
 * İKİ KULLANICI ARASINDA ENGEL VAR MI — YÖNSÜZ, TEK KAYNAK.
 *
 * ⚠️ NEDEN BURADA (2026-08-03): engel denetimi her yüzeyde elle yazılıyordu ve
 * bir yüzeyde HİÇ YAZILMAMIŞTI. Ölçüldü (gerçek rotalar, izole veritabanı):
 *
 *     KURBAN, TACIZCI'yi engelliyor          → 200 blocked:true
 *     TACIZCI, KURBAN'a ÖZEL düello açıyor   → 200 OLUŞTU
 *     KURBAN'ın arenası                      → düello görünüyor (creatorName ile)
 *     KURBAN'a push                          → "⚔️ Sana meydan okundu"
 *
 * Yani engellenen kişi, engelleyene bildirim gönderebiliyordu — engellemenin
 * önlemek için var olduğu şeyin ta kendisi.
 *
 * ⚠️ YÖNSÜZ OLMALI: yalnızca "ben onu engelledim" yönüne bakmak, engellenen
 * kişinin bana ulaşmasına izin verirdi. `routes/mini.cjs` bunu doğru yapıyordu
 * (areFriends içinde iki yön de sınanıyor); kural oradan buraya taşındı ki
 * üçüncü bir yüzey eklenince yeniden yazılmasın.
 *
 * ⚠️ FAIL-CLOSED DEĞİL: liste okunamazsa `false` döner (engel yok sayılır).
 * Bilinçli — engel listesi okunamadığında tüm daveti kilitlemek, geçici bir
 * Mongo arızasında oyunun sosyal tarafını komple durdururdu. Karşılığında
 * kaçak riski var; bu yüzden çağıranlar ayrıca kendi kapılarını korur.
 */
async function engelliMi(a, b, db) {
  const x = String(a || "").trim().toLowerCase();
  const y = String(b || "").trim().toLowerCase();
  if (!x || !y || x === y) return false;
  try {
    const m = await loadFriends(db);
    return (m.blocks || []).some((k) => {
      const by = String(k?.by || "").trim().toLowerCase();
      const tg = String(k?.target || "").trim().toLowerCase();
      return (by === x && tg === y) || (by === y && tg === x);
    });
  } catch (e) {
    console.error("[social-store] engel listesi okunamadi:", e?.message || e);
    return false;
  }
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

/**
 * Kullanıcıyı TÜM sosyal kayıtlardan HEDEFLİ olarak siler (hesap silme).
 *
 * ⚠️ ESKİDEN SNAPSHOT YAZILIYORDU — ARAYA GİREN HERKESİN VERİSİ SİLİNİYORDU.
 *
 * `routes/users.cjs` hesap silme akışı şunu yapıyordu: TÜM arkadaşlık verisini
 * oku → kullanıcıya ait satırları filtrele → TÜMÜNÜ geri yaz (`saveFriends`
 * → `replaceAll`). Okuma ile yazma arasında başkalarının kurduğu arkadaşlık,
 * gönderdiği istek, koyduğu engel SESSİZCE siliniyordu.
 *
 * ÖLÇÜLDÜ: silme akışı sürerken `cem-deniz` arkadaşlığı ve `mehmet→zeynep`
 * isteği eklendi; snapshot geri yazılınca İKİSİ DE yok oldu. Hata yok, log yok.
 *
 * ⚠️ HARF DUYARSIZ: `addLink` kimlikleri HAM saklıyor (`{a: String(a)}`),
 * silme ölçütü ise küçük harf karşılaştırması yapıyordu. `$expr`+`$toLower`
 * ile aynı davranış korunuyor — düz eşitlik kullansaydım "Ali" kaydı
 * "ali" hesabı silinince geride kalırdı.
 *
 * ⚠️ İKİ ŞEMA: istekler `{from,to}` ya da `{a,b}`, engeller `{by,target}` ya
 * da `{a,b}` taşıyabiliyor (çağıran kod da `r.from ?? r.a` diye okuyor).
 * Dördünü de kapsıyoruz; birini atlamak kaydı geride bırakırdı.
 */
async function removeUserFromSocial(userId, db) {
  const uidL = String(userId || "").trim().toLowerCase();
  if (!uidL) return { ok: false, reason: "BAD_INPUT" };

  const conn = await getDbSafe(db);
  if (!conn) return { ok: false, reason: "NO_DB" };

  const esitse = (...alanlar) => ({
    $expr: {
      $or: alanlar.map((a) => ({
        $eq: [{ $toLower: { $ifNull: [`$${a}`, ""] } }, uidL],
      })),
    },
  });

  try {
    await ensureIndexes(conn);
    const r1 = await conn.collection(COLL_LINKS).deleteMany(esitse("a", "b"));
    const r2 = await conn.collection(COLL_REQUESTS).deleteMany(esitse("from", "to", "a", "b"));
    const r3 = await conn.collection(COLL_BLOCKS).deleteMany(esitse("by", "target", "a", "b"));
    /**
     * ⚠️ AYNA ADI "friends" — ÜÇ KOLEKSİYONU BİRDEN YAZIYOR.
     *
     * İlk hâlde "links"/"requests"/"blocks" geçirmiştim; `aynayiTazele`
     * yalnızca groups|mini|friends|tournaments|duels tanıyor, yani ÜÇÜ DE
     * sessizce hiçbir şey yapmıyordu. Sonuç ağırdı: Mongo'dan silinen kayıt
     * dosya aynasında kalıyor, koleksiyon boşalınca okuma tarafındaki
     * tohumlama onu Mongo'ya GERİ YAZIYOR ve silinen arkadaşlık DİRİLİYORDU.
     * (Aynı tuzak bu dosyada zaten belgelenmiş — bkz. tohumlama notu.)
     */
    if (mirrorOn()) await aynayiTazele(conn, "friends");
    return {
      ok: true,
      silinen: { links: r1.deletedCount, requests: r2.deletedCount, blocks: r3.deletedCount },
    };
  } catch (e) {
    console.error("[social-store] sosyal kayitlar silinemedi:", e?.message || e);
    return { ok: false, reason: "DELETE_FAILED" };
  }
}

/**
 * Kullanıcıyı gruplardan HEDEFLİ olarak çıkarır: sahibi olduğu gruplar silinir,
 * üyesi olduklarından `$pull` ile çıkarılır.
 *
 * ⚠️ Aynı snapshot kusuru gruplarda da vardı (`routes/users.cjs` grup bloğu):
 * tüm grup haritasını okuyup geri yazınca, arada kurulan grup ve katılan üye
 * siliniyordu.
 */
async function removeUserFromGroups(userId, db) {
  const uid = String(userId || "").trim();
  const uidL = uid.toLowerCase();
  if (!uidL) return { ok: false, reason: "BAD_INPUT" };

  const conn = await getDbSafe(db);
  if (!conn) return { ok: false, reason: "NO_DB" };

  try {
    await ensureIndexes(conn);
    const silinen = await conn.collection(COLL_GROUPS).deleteMany({
      $expr: { $eq: [{ $toLower: { $ifNull: ["$ownerId", ""] } }, uidL] },
    });
    /* Üyelikten çıkarma: `$pull` yalnızca ilgili diziye dokunur, belgenin
     * geri kalanına ve diğer gruplara değmez. Harf farkı olabileceği için
     * hem ham hem küçük harf değeri çekiliyor. */
    const cikarilan = await conn.collection(COLL_GROUPS).updateMany(
      {},
      { $pull: { members: { $in: [uid, uidL] } } }
    );
    if (mirrorOn()) await aynayiTazele(conn, "groups");
    return {
      ok: true,
      silinenGrup: silinen.deletedCount,
      cikarilanUyelik: cikarilan.modifiedCount,
    };
  } catch (e) {
    console.error("[social-store] gruplardan cikarilamadi:", e?.message || e);
    return { ok: false, reason: "DELETE_FAILED" };
  }
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

async function hamDuels(conn) {
  return (await conn.collection(COLL_DUELS).find({}).toArray()).map(strip);
}

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
/**
 * Turnuvaya ATOMİK katılım: koşullar yazmanın İÇİNDE.
 *
 * ⚠️ PARA KORUMASI — ÖLÇÜLMÜŞ KAYIP. Eski akış `services/tournament.cjs
 * join`de şöyleydi: `loadAll()` ile TÜM turnuva listesini oku → ücreti TAHSİL
 * ET → snapshot'a katılımcıyı ekle → `saveAll()` ile TÜM KOLEKSİYONU o
 * snapshot'la DEĞİŞTİR (`replaceAll`).
 *
 * İki katılım aynı anda gelirse ikisi de aynı snapshot'ı okur; sonra yazan,
 * öncekinin katılımını SİLER. Üstelik sessizce: `saveAll` başarılı döndüğü
 * için `join`in iade kolu (`join_save_failed`) hiç çalışmaz ve uç `ok:true`
 * verir — kullanıcı katıldığını sanır.
 *
 * ÖLÇÜLDÜ (bellek-içi Mongo, 4 eşzamanlı katılım, giriş 10 LC):
 *     join çagrisi 4 → 4'u de BASARILI dondu
 *     kayitli katilimci: kurucu + 1
 *     ucreti alinip katilamayan: 3 kisi, 30 LC
 *     havuz 20 (olmasi gereken 50)
 *
 * Koşul (`status:"open"` + kullanıcı listede DEĞİL) filtrenin içinde, ekleme
 * `$push` ile: yalnızca bir çağrı `modifiedCount` alır ve hiçbir katılım
 * ötekini ezmez. `claimTournamentSettle` ile aynı desen.
 *
 * @returns {Promise<{ok:boolean, reason?:string}>} ok:false ise ÜCRET İADE EDİLMELİ
 */
async function joinTournamentAtomik(code, katilimci, entryLC, db) {
  const kod = String(code || "").toUpperCase();
  const uid = String(katilimci?.userId || "");
  if (!kod || !uid) return { ok: false, reason: "BAD_INPUT" };

  const conn = await getDbSafe(db);
  if (!conn) return { ok: false, reason: "NO_DB" };

  try {
    await ensureIndexes(conn);
    const r = await conn.collection(COLL_TOURNAMENTS).updateOne(
      {
        code: kod,
        status: "open",
        /* Zaten katılmışsa eşleşme olmaz — çift katılım ve çift tahsilat
         * aynı koşulla engellenir. */
        "participants.userId": { $ne: uid },
      },
      {
        $push: { participants: katilimci },
        $inc: { pool: Number(entryLC) || 0 },
      }
    );
    if (!r.modifiedCount) return { ok: false, reason: "NOT_JOINABLE" };
    await aynayiTazele(conn, "tournaments");
    return { ok: true };
  } catch (e) {
    console.error("[social-store] turnuvaya katilim yazilamadi:", e?.message || e);
    return { ok: false, reason: "WRITE_FAILED" };
  }
}

/**
 * Yeni turnuvayı TEK BELGE olarak ekler.
 *
 * ⚠️ `saveTournaments` TÜM koleksiyonu verilen listeyle değiştiriyor
 * (`replaceAll`); iki kurucu aynı anda turnuva açtığında sonra yazan
 * ötekinin turnuvasını siliyordu. ÖLÇÜLDÜ: 4 eşzamanlı create → 3 çağrı
 * başarılı döndü, koleksiyonda 0 turnuva, 30 LC alınmış.
 */
async function insertTournamentAtomik(t, db) {
  if (!t || !t.id) return { ok: false, reason: "BAD_INPUT" };
  const conn = await getDbSafe(db);
  if (!conn) return { ok: false, reason: "NO_DB" };
  try {
    await ensureIndexes(conn);
    await conn.collection(COLL_TOURNAMENTS).insertOne({ ...t });
    await aynayiTazele(conn, "tournaments");
    return { ok: true };
  } catch (e) {
    console.error("[social-store] turnuva eklenemedi:", e?.message || e);
    return { ok: false, reason: "WRITE_FAILED" };
  }
}

/**
 * Katılımcının tek bir maç tahminini ATOMİK yazar.
 *
 * ⚠️ `arrayFilters` ŞART: pozisyonel `$` yalnızca ilk eşleşmeyi günceller ve
 * filtre ile güncelleme farklı katılımcıya denk gelebilir. `arrayFilters`
 * hedefi açıkça adlandırır, diğer katılımcıların tahmin haritasına hiç
 * dokunulmaz.
 *
 * ⚠️ NOKTA İÇEREN fixtureId REDDEDİLİR: Mongo alan adlarında nokta yol
 * ayıracıdır; `predictions.a.b` iç içe belge olur ve tahmin yanlış yere
 * yazılır. Sessizce bozuk veri üretmektense hata vermek doğru.
 */
async function setTournamentPredictionAtomik(code, userId, fixtureId, kayit, db) {
  const kod = String(code || "").toUpperCase();
  const uid = String(userId || "");
  const fid = String(fixtureId || "");
  if (!kod || !uid || !fid) return { ok: false, reason: "BAD_INPUT" };
  if (fid.includes(".") || fid.startsWith("$")) {
    return { ok: false, reason: "BAD_FIXTURE_ID" };
  }

  const conn = await getDbSafe(db);
  if (!conn) return { ok: false, reason: "NO_DB" };

  try {
    await ensureIndexes(conn);
    const r = await conn.collection(COLL_TOURNAMENTS).updateOne(
      { code: kod, status: "open" },
      { $set: { [`participants.$[k].predictions.${fid}`]: kayit } },
      { arrayFilters: [{ "k.userId": uid }] }
    );
    if (!r.matchedCount) return { ok: false, reason: "NOT_FOUND" };
    if (!r.modifiedCount) return { ok: false, reason: "NOT_JOINED" };
    await aynayiTazele(conn, "tournaments");
    return { ok: true };
  } catch (e) {
    console.error("[social-store] turnuva tahmini yazilamadi:", e?.message || e);
    return { ok: false, reason: "WRITE_FAILED" };
  }
}

async function claimTournamentSettle(id, nowISO, db, ekAlanlar) {
  const tid = String(id || "");
  if (!tid) return false;
  const damga = nowISO || new Date().toISOString();

  const conn = await getDbSafe(db);
  if (conn) {
    try {
      await ensureIndexes(conn);
      /* ⚠️ `ekAlanlar` MÜHÜRLE AYNI İŞLEMDE YAZILIR (tipik kullanım: `payouts`).
       *
       * Çağıran bunları ayrı bir `saveAll` ile yazıyordu; o çağrı TÜM
       * koleksiyonu kendi eski snapshot'ıyla değiştirdiği için araya giren
       * atomik yazmaları (başka turnuvaya katılım, tahmin) SİLİYORDU.
       * ÖLÇÜLDÜ: A turnuvası sonuçlanırken B'ye yapılan katılım başarılı
       * döndü ama kayıttan silindi — 10 LC alınmış, katılım yok. */
      const r = await conn.collection(COLL_TOURNAMENTS).updateOne(
        { id: tid, status: "open" },
        { $set: { status: "settled", settledAt: damga, ...(ekAlanlar || {}) } }
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


/* ═══════════════════════════════ DÜELLOLAR ═══════════════════════════════
 * Dosya biçimi: düz dizi [ { id, status, stake, pot, ... } ]
 *
 * ⚠️ BU DEPO BİR ÖNCEKİ DÜZELTMEMİN AÇTIĞI DELİĞİ KAPATIYOR.
 * Daha önce `loadDuels` Mongo'dan okumaya çevrilmişti (deploy'da kaybolan
 * düellolar yatırılan LC'yi götürüyordu). Ama `saveDuels` DOSYADA BIRAKILDI.
 * Sonuç: yeni kurulan düello yalnızca dosyaya yazılıyor, okuma ise Mongo'dan
 * yapılıyor — Mongo'da kayıt varken YENİ DÜELLO GÖRÜNMEZ oluyor. Oyuncu
 * bahsini yatırıyor, düello ortadan kayboluyor. Yarım taşıma, taşımamaktan
 * daha kötü: hiç olmayan bir kaynak yerine YANLIŞ bir kaynak okunuyordu.
 */

async function loadDuels(db) {
  const conn = await getDbSafe(db);
  if (conn) {
    try {
      await ensureIndexes(conn);
      const docs = await hamDuels(conn);
      if (docs.length) return docs;
    } catch (e) {
      console.error("[social-store] duellolar okunamadi, dosyaya dusuluyor:", e?.message || e);
    }
  }
  const raw = await readFile_("duels.json", []);
  const list = Array.isArray(raw) ? raw : [];
  await tohumla(conn, "duels", list, list.length === 0);
  return list;
}

/* ── Hedefli düello sorguları ────────────────────────────────────────────────
 *
 * ⚠️ NEDEN VAR: `loadDuels()` her çağrıda `find({})` yapıyor — açık,
 * sonuçlanmış, iptal, geçersiz, HER düello ağdan geçip Node belleğine
 * çözülüyor. 13 çağrı yeri var ve üçü sıcak: düello ekranının her açılışı,
 * her düello kurulumu, arena listesi.
 *
 * Fikstürler budanıyor, düellolar BİRİKİYOR. Bugün 1 düello var, yani ölçülebilir
 * bir etkisi yok; bir sezon sonra her ekran açılışı megabaytlarca veri çeker.
 * `status` ve `fixtureId` üzerinde indeksler zaten vardı, kullanılmıyordu.
 *
 * ⚠️ DOSYA YEDEĞİ SEMANTİĞİ AYNEN KORUNUYOR. `loadDuels` yalnızca "dosyaya
 * düşmek" yapmıyor, aynı zamanda boş Mongo'yu dosyadan TOHUMLUYOR. Hedefli
 * sorgu bunu atlasaydı ilk çalıştırmada veri Mongo'ya hiç geçmezdi. Bu yüzden
 * Mongo boşken hedefli sorgu KULLANILMIYOR; `loadDuels`e düşülüp bellekte
 * süzülüyor — yani eski davranış birebir.
 *
 * ⚠️ KİMLİK KARŞILAŞTIRMASI İNDEKSLİ DEĞİL. Düello belgelerinde
 * `creatorIdLower`/`acceptorIdLower` alanı yok; büyük/küçük harf duyarsız
 * eşleşme `$expr` ile yapılıyor (aynı yöntem `claimDuelCancel`de de var).
 * Bu Mongo tarafında tarama demek — ama belgeler ağdan geçmediği ve Node'a
 * çözülmediği için yine de büyük kazanç. Tam indeksli sürüm için belgelere
 * `*Lower` alanları eklenmeli; ayrı iş.
 */

/** Mongo bu koleksiyon için yetkili mi (dolu mu)? Boşsa dosya yolu geçerli. */
async function duelsMongoYetkili(conn) {
  if (!conn) return false;
  try {
    await ensureIndexes(conn);
    return (await conn.collection(COLL_DUELS).estimatedDocumentCount()) > 0;
  } catch (e) {
    console.error("[social-store] duel sayimi basarisiz, dosya yoluna dusuluyor:", e?.message || e);
    return false;
  }
}

/** Küçük harfe indirgenmiş alan eşitliği (indekssiz; bkz. dosya başı notu). */
const esitKucukHarf = (alan, deger) => ({ $expr: { $eq: [{ $toLower: `$${alan}` }, deger] } });

/**
 * Bir maçın düelloları. `/duels/open` ve `/duels/arena` için.
 * @param {string|null} fixtureId  null ise tüm maçlar (arena)
 * @param {object} [o]
 * @param {string} [o.status]      "open" gibi; verilmezse hepsi
 */
async function duelsBul({ fixtureId = null, status = null }, db) {
  const fid = fixtureId == null ? null : String(fixtureId).trim();
  const conn = await getDbSafe(db);

  if (await duelsMongoYetkili(conn)) {
    const q = {};
    if (fid) q.fixtureId = fid;
    if (status) q.status = status;
    return (await conn.collection(COLL_DUELS).find(q).toArray()).map(strip);
  }

  const hepsi = await loadDuels(db);
  return hepsi.filter(
    (d) => (!fid || String(d.fixtureId) === fid) && (!status || d.status === status)
  );
}

/** Kullanıcının (kurucu ya da kabul eden) düelloları. `/duels/my` için. */
async function duelsKullanici(userId, db, { fixtureId = null } = {}) {
  const uidL = String(userId || "").trim().toLowerCase();
  if (!uidL) return [];
  const fid = fixtureId == null ? null : String(fixtureId).trim();
  const conn = await getDbSafe(db);

  if (await duelsMongoYetkili(conn)) {
    const q = { $or: [esitKucukHarf("creatorId", uidL), esitKucukHarf("acceptorId", uidL)] };
    if (fid) q.fixtureId = fid;
    return (await conn.collection(COLL_DUELS).find(q).toArray()).map(strip);
  }

  const hepsi = await loadDuels(db);
  return hepsi.filter((d) => {
    const benim =
      String(d.creatorId || "").toLowerCase() === uidL ||
      (d.acceptorId && String(d.acceptorId).toLowerCase() === uidL);
    return benim && (!fid || String(d.fixtureId) === fid);
  });
}

/**
 * Kullanıcının AÇIK düello sayısı — düello kurulumundaki sınır denetimi için.
 *
 * ⚠️ `countDocuments` belge TAŞIMAZ, yalnızca sayı döner. Eski hâli tüm
 * düelloları çekip `.filter().length` alıyordu; tek ihtiyaç bir sayıydı.
 */
async function acikDuelloSayisi(creatorId, db) {
  const uidL = String(creatorId || "").trim().toLowerCase();
  if (!uidL) return 0;
  const conn = await getDbSafe(db);

  if (await duelsMongoYetkili(conn)) {
    return conn.collection(COLL_DUELS).countDocuments({
      status: "open",
      ...esitKucukHarf("creatorId", uidL),
    });
  }

  const hepsi = await loadDuels(db);
  return hepsi.filter(
    (d) => String(d.creatorId || "").toLowerCase() === uidL && d.status === "open"
  ).length;
}

async function saveDuels(list, db) {
  const items = (Array.isArray(list) ? list : []).filter((d) => d && d.id);
  const conn = await getDbSafe(db);
  let wrote = { ok: false };
  if (conn) {
    await ensureIndexes(conn);
    wrote = await replaceAll(conn, COLL_DUELS, items, "id", (d) => String(d.id));
  }
  if (mirrorOn() || !wrote.ok) await writeFile_("duels.json", items);
  return wrote;
}

/**
 * Düello ödemesini ATOMİK olarak üstlenir: "settled" DEĞİLSE işaretler.
 *
 * ⚠️ PARA KORUMASI. Eski akış işaretlemeyi DOSYA KİLİDİ altında yapıyordu ama
 * depo artık Mongo — kilit yalnızca tek süreci korur, çok instance'ta hiçbir
 * şey yapmaz. Üstelik ödeme kilidin DIŞINDA, Mongo'ya durum yazımı ise
 * ödemeden SONRA yapılıyordu: iki tarama arasında ikinci geçiş düelloyu hâlâ
 * "accepted" görüp ödülü TEKRAR yatırabilirdi.
 *
 * @returns {Promise<boolean>} ödemeyi BU çağrı yapacaksa true
 */
/**
 * DÜELLOYU ATOMİK KABUL ET.
 *
 * ⚠️ NEDEN VAR: `/duels/accept` şu akışı kullanıyordu — listeyi oku, durum
 * "open" mu diye BAK, bahsi TAHSİL ET, sonra yaz. `withFileLock` yalnızca tek
 * süreci korur ve depo Mongo'ya taşındığı için çok instance'lı ortamda hiçbir
 * şey yapmıyordu. İki eşzamanlı kabul de kontrolü geçiyor, İKİSİNDEN DE bahis
 * tahsil ediliyor, son yazan kazanıyordu: biri parasını verip düelloya
 * girememiş oluyordu.
 *
 * claimDuelSettle ile aynı ilke — koşul (`status: "open"`) yazmanın İÇİNDE.
 *
 * @returns {Promise<boolean>} yalnızca kabulü gerçekten alan çağrı true alır
 */
async function claimDuelAccept(id, alanlar, db) {
  const did = String(id || "");
  if (!did) return false;

  const conn = await getDbSafe(db);
  if (conn) {
    try {
      await ensureIndexes(conn);
      const r = await conn.collection(COLL_DUELS).updateOne(
        { id: did, status: "open" },
        { $set: { ...alanlar, status: "active" } }
      );
      if (!r.modifiedCount) return false;
      await aynayiTazele(conn, "duels");
      return true;
    } catch (e) {
      console.error("[social-store] duello kabulu alinamadi:", e?.message || e);
      return false;
    }
  }

  const list = await loadDuels(conn);
  const d = list.find((x) => String(x.id) === did);
  if (!d || d.status !== "open") return false;
  Object.assign(d, alanlar, { status: "active" });
  await saveDuels(list, conn);
  return true;
}

/**
 * DÜELLOYU ATOMİK İPTAL ET (yalnızca kuran, yalnızca açıkken).
 *
 * ⚠️ NEDEN VAR: `/duels/cancel` durumu okuyup "open" mu diye bakıyor, sonra
 * KİLİDİN DIŞINDA iade veriyordu. Aradaki pencerede ikinci bir istek de
 * kontrolü geçip İADEYİ TEKRAR alabiliyordu — bahis bir kez yatırılmış olsa
 * bile iki kez geri ödenirdi.
 *
 * Kurucu kontrolü de filtreye alındı: başkasının düellosunu iptal etme
 * denemesi ayrı bir okumaya değil, yazmanın kendisine takılır.
 *
 * @returns {Promise<boolean>} yalnızca iptali gerçekten alan çağrı true alır
 */
async function claimDuelCancel(id, creatorIdLower, alanlar, db) {
  const did = String(id || "");
  const uid = String(creatorIdLower || "").toLowerCase();
  if (!did || !uid) return false;

  const conn = await getDbSafe(db);
  if (conn) {
    try {
      await ensureIndexes(conn);
      // creatorId büyük/küçük harf karışık saklanıyor; $expr ile küçültüp
      // karşılaştırıyoruz — ayrı bir okuma yapmadan sahiplik de doğrulansın.
      const r = await conn.collection(COLL_DUELS).updateOne(
        {
          id: did,
          status: "open",
          $expr: { $eq: [{ $toLower: "$creatorId" }, uid] },
        },
        { $set: { ...alanlar, status: "cancelled" } }
      );
      if (!r.modifiedCount) return false;
      await aynayiTazele(conn, "duels");
      return true;
    } catch (e) {
      console.error("[social-store] duello iptali alinamadi:", e?.message || e);
      return false;
    }
  }

  const list = await loadDuels(conn);
  const d = list.find((x) => String(x.id) === did);
  if (!d || d.status !== "open") return false;
  if (String(d.creatorId || "").toLowerCase() !== uid) return false;
  Object.assign(d, alanlar, { status: "cancelled" });
  await saveDuels(list, conn);
  return true;
}

async function claimDuelSettle(id, alanlar, db) {
  const did = String(id || "");
  if (!did) return false;

  const conn = await getDbSafe(db);
  if (conn) {
    try {
      await ensureIndexes(conn);
      const r = await conn.collection(COLL_DUELS).updateOne(
        { id: did, status: { $ne: "settled" } },
        { $set: { ...alanlar, status: "settled" } }
      );
      if (!r.modifiedCount) return false;
      await aynayiTazele(conn, "duels");
      return true;
    } catch (e) {
      console.error("[social-store] duello muhru alinamadi:", e?.message || e);
      return false;
    }
  }

  const list = await loadDuels(conn);
  const d = list.find((x) => String(x.id) === did);
  if (!d || d.status === "settled") return false;
  Object.assign(d, alanlar, { status: "settled" });
  await saveDuels(list, conn);
  return true;
}

module.exports = {
  loadGroups, saveGroups,
  loadMini, saveMini,
  loadFriends, saveFriends,
  // Engel denetimi TEK KAYNAK: yüzeyler kendi kopyasını yazmasın (bir yüzey
  // hiç yazmamış ve engellenen kişi engelleyene düello atabiliyordu).
  engelliMi,
  loadTournaments, saveTournaments, claimTournamentSettle, joinTournamentAtomik,
  insertTournamentAtomik, setTournamentPredictionAtomik,
  _code6: code6,   // test: uretilen kodun bicimi/carpismasi dogrudan olculsun
  loadDuels, saveDuels, claimDuelSettle, claimDuelAccept, claimDuelCancel,
  duelsBul, duelsKullanici, acikDuelloSayisi,
  createGroup, joinGroup, setGroupOpt,
  addLink, removeLink, addRequest, removeRequest, addBlock, removeBlock,
  removeUserFromSocial, removeUserFromGroups,
  createMini, addMiniMember, finishMini,
  COLL_GROUPS, COLL_MINI, COLL_LINKS, COLL_REQUESTS, COLL_BLOCKS, COLL_TOURNAMENTS, COLL_DUELS,
  _pairKey: pairKey,
  _mirrorOn: mirrorOn,
};
