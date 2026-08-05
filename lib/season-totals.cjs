"use strict";

/**
 * SEZON TOPLAMLARI OKUMA — tek yer.
 *
 * NEDEN VAR (bulundu 2026-07-29): sezon toplamları üç ayrı rotadan okunuyordu
 * (leaderboard, groups, friends) ve ÜÇÜ DE doğrudan totals.json'a bakıyordu.
 * Render'da disk kalıcı olmadığı için her deploy tüm sezonu siliyordu; üstelik
 * settle2 aynı veriyi artık Mongo'ya da yazdığı için okuma yolları ayrışmaya
 * başlamıştı — biri Mongo'yu görür, ikisi görmez.
 *
 * Aynı hatanın dördüncü kez tekrarlanmaması için okuma buraya toplandı:
 * yeni bir tablo eklendiğinde `loadTotals(db)` çağrılır, dosya yolu bilinmez.
 *
 * ⚠️ Mongo BOŞ dönerse dosyaya düşülür. Boş koleksiyon ile "Mongo yok" ayrımı
 * Mongo'da hata vermez — bu yüzden geçiş döneminde dosya hâlâ yedek.
 */

const path = require("path");
const fsp = require("fs").promises;

const Season = require("./season.cjs");

const DATA_DIR = process.env.SKORLIG_DATA_DIR || path.join(__dirname, "..", "data");
const TOTALS_FILE = path.join(DATA_DIR, "totals.json");

const COLL = "season_totals";

/**
 * ⚠️ İNDEKS YOKTU — HER SORGU TAM TARAMA YAPIYORDU.
 *
 * `kullaniciToplami` (aşağıda) `{ season, userIdLower }` ile TEK kullanıcı
 * arıyor; koleksiyonda indeks olmadığı için Mongo tüm belgeleri okuyordu.
 *
 * ÖLÇÜLDÜ (bellek-içi Mongo, 20 000 kayıt, hedef en sondaki belge):
 *     indekssiz : 41.55 ms/sorgu · incelenen belge 20000
 *     indeksli  :  1.66 ms/sorgu · incelenen belge     1
 *     kazanç    : 25x
 *
 * Bu yol kullanıcı istatistik/profil ekranlarından çağrılıyor, yani her
 * açılışta ödeniyor ve maliyet kullanıcı sayısıyla doğrusal büyüyor.
 *
 * ⚠️ BENZERSİZ DEĞİL — BİLEREK. `belgeleriBirlestir` aynı kullanıcının
 * "sezonsuz" (migration öncesi) ve sezonlu belgesini BİRLEŞTİRİYOR, yani
 * mevcut veride aynı `userIdLower` için birden çok belge OLMASI beklenen bir
 * durum. Benzersiz indeks kurulum anında patlar ve depoyu indekssiz bırakırdı.
 * Kopya belge riski ayrı bir konu; burada yalnızca okuma maliyeti çözülüyor.
 *
 * ⚠️ BAYRAK DEĞİL SÖZ önbelleklenir — bu deponun her yerinde aynı desen:
 * bayrak `await createIndex` bitmeden kalkarsa eşzamanlı ikinci çağrı indeks
 * HENÜZ YOKKEN sorgu yapar (bkz. lib/pool-store.cjs notu).
 */
let _indexPromise = null;
function ensureIndexes(db) {
  if (!db) return Promise.resolve();
  if (_indexPromise) return _indexPromise;
  _indexPromise = (async () => {
    try {
      await db.collection(COLL).createIndex(
        { userIdLower: 1, season: 1 },
        { background: true }
      );
    } catch (e) {
      console.error("[season-totals] indeks kurulamadi:", e?.message || e);
      /* Geçici arızada önbelleği düşür — yoksa hata SÜREÇ BOYUNCA kalıcı olur. */
      _indexPromise = null;
    }
  })();
  return _indexPromise;
}

/**
 * Sezon toplamlarını döndürür.
 *
 * @param {object|null} db
 * @returns {Promise<{items: Array<{userId,totalPoints,totalPenalty,matches,lastAt}>, updatedAt: string|null, source: string}>}
 */
/**
 * @param {object|null} db
 * @param {string} [season] sezon anahtarı; verilmezse İÇİNDE BULUNULAN sezon.
 *
 * ⚠️ GEÇİŞ TOLERANSI: sezon alanı eklenmeden ÖNCE yazılmış kayıtlarda `season`
 * yok. Onları da içinde bulunulan sezona sayıyoruz, yoksa migration çalışana
 * kadar tablo boş görünürdü. Migration sonrası bu kol kendiliğinden ölü kalır.
 * bkz. scripts/migrate-season-field.cjs
 */
/**
 * AYNI KULLANICININ BİRDEN FAZLA BELGESİNİ BİRLEŞTİRİR.
 *
 * ⚠️ BULUNAN: güncel sezon sorgusu, `season` alanı OLMAYAN eski kayıtları da
 * kapsıyor (geçiş dönemi için, bilinçli). Ama yazma tarafı
 * `filter: { season, userIdLower }` kullanıyor — eski belgede `season` yok, o
 * yüzden eşleşmiyor ve `$setOnInsert` İKİNCİ bir belge yaratıyor.
 *
 * Sonuç: eski kayıtlı bir kullanıcı yeni bir maç oynar oynamaz sıralamada İKİ
 * KEZ görünüyor ve puanı ikiye bölünüyor.
 *
 * ÖLÇÜLDÜ (bellek-içi Mongo): aynı kullanıcı için eski (puan 40, 10 maç) ve
 * yeni (puan 25, 5 maç) belge → sorgu 3 satır döndü, tekil kullanıcı 2.
 * Birleştirmeden sonra 2 satır, puan 65 / 15 maç.
 *
 * ⚠️ VERİ TAŞIMA YAPILMIYOR. Eski belgeleri güncellemek bir migration olurdu;
 * okuma tarafında birleştirmek hem geri dönüşsüz değil hem de taşıma
 * yapılana kadar doğru sonuç veriyor.
 */
function belgeleriBirlestir(docs) {
  const harita = new Map();
  for (const d of docs || []) {
    const k = String(d?.userIdLower || d?.userId || "").toLowerCase();
    if (!k) continue;
    const v = harita.get(k) || {
      userId: d.userId || d.userIdLower || "anon",
      userIdLower: k,
      totalPoints: 0, totalPenalty: 0, matches: 0,
      lastAt: null, updatedAt: null,
    };
    v.totalPoints += Number(d.totalPoints || 0);
    v.totalPenalty += Number(d.totalPenalty || 0);
    v.matches += Number(d.matches || 0);
    const t = d.lastAt || d.updatedAt || null;
    if (t && (!v.lastAt || String(t) > String(v.lastAt))) v.lastAt = t;
    if (t && (!v.updatedAt || String(t) > String(v.updatedAt))) v.updatedAt = t;
    // Görünen ad: sezonlu (yeni) belgeninki tercih edilir.
    if (d.season && d.userId) v.userId = d.userId;
    harita.set(k, v);
  }
  return [...harita.values()];
}

async function loadTotals(db, season) {
  const sezon = season || Season.seasonKey();
  const suzgec = sezon === Season.seasonKey()
    ? { $or: [{ season: sezon }, { season: { $exists: false } }] }
    : { season: sezon };

  if (db) {
    try {
      await ensureIndexes(db);
      const ham = await db.collection(COLL).find(suzgec).toArray();
      // Eski (sezonsuz) + yeni belge ayni kullaniciya aitse birlestir.
      const docs = belgeleriBirlestir(ham);

      // ⚠️ BOŞ SEZON GEÇERLİ BİR DURUMDUR — dosyaya DÜŞÜLMEZ.
      //
      // Yakalandı (2026-07-29, sezon dönümüne 2 gün kala): `?season=2026-08`
      // sorgusu Mongo'da 0 kayıt bulunca dosyaya düşüyor ve dosyadaki TEMMUZ
      // verisini AĞUSTOS diye döndürüyordu. Yani 1 Ağustos'ta sezon hiç
      // sıfırlanmayacak, tablo eski veriyi yeni sezon etiketiyle gösterecekti.
      //
      // Ayrım: Mongo'ya ERİŞİLEMİYOR (catch → dosya yedeği doğru) ile
      // Mongo BOŞ (yeni sezon, henüz kimse oynamadı → boş dönmeli) farklı
      // şeyler. Aynı ayrımı social-store'da da yapmak zorunda kalmıştık.
      if (!docs.length) {
        return { items: [], updatedAt: null, source: "mongo_season_totals" };
      }

      {
        return {
          items: docs.map((d) => ({
            userId: d.userId || d.userIdLower || "anon",
            // ⚠️ OKUMADA YUVARLANIR. Puanlar oran ağırlıklı olduğu için
            // kesirli; `$inc` ile birikince kayan nokta artığı oluşuyor
            // (üretimde görüldü: 10.700000000000001). Dosya yolu toplamı her
            // yazımda yuvarlıyordu — depoda tam duyarlığı KORUYUP ekrana
            // yuvarlanmış vermek daha doğru, birikimli hata da olmuyor.
            totalPoints: Math.round(Number(d.totalPoints || 0)),
            totalPenalty: Math.round(Number(d.totalPenalty || 0)),
            matches: Number(d.matches || 0),
            lastAt: d.lastAt || d.updatedAt || null,
          })),
          updatedAt: docs[0]?.updatedAt || docs[0]?.lastAt || null,
          source: "mongo_season_totals",
        };
      }
    } catch (e) {
      console.error("[season-totals] mongo okunamadi, dosyaya dusuluyor:", e?.message || e);
    }
  }

  try {
    const raw = JSON.parse(await fsp.readFile(TOTALS_FILE, "utf8"));
    return {
      items: Array.isArray(raw?.items) ? raw.items : [],
      updatedAt: raw?.updatedAt || null,
      source: "totals_json",
    };
  } catch {
    return { items: [], updatedAt: null, source: "empty" };
  }
}

/**
 * TEK KULLANICININ SEZON TOPLAMI — indeksli, sezon kapsamlı.
 *
 * ⚠️ NEDEN VAR (2026-08-03): `routes/stats.cjs` kendi sorgusunu yazıyordu ve
 * SEZON SÜZGECİ YOKTU:
 *
 *     seasonCol.findOne({ userIdLower })      // hangi sezon? belirsiz
 *
 * Yani kullanıcının HERHANGİ bir sezon kaydı dönüyordu. Aynı yanıttaki takım
 * bloğu ise güncel sezonu kullanıyor — tek cevapta İKİ FARKLI SEZON karışıyor.
 *
 * ÖLÇÜLDÜ (üretim, gerçek kullanıcı; yalnızca 2026-07 kaydı var, güncel sezon
 * 2026-08):
 *     totalPoints        : 9.9   ← Temmuz'dan
 *     team.myTeamTotal   : 0     ← Ağustos'tan
 * Kullanıcı aynı ekranda "9.9 puanım var" ve "takımımdaki toplamım 0" görüyor.
 *
 * ⚠️ ASIL RİSK BELİRSİZLİK: birden fazla sezonu olan kullanıcıda `findOne`
 * hangi belgeyi döndüreceğini GARANTİ ETMEZ. Sezon biriktikçe "puanım" rastgele
 * bir geçmiş sezonu gösterebilirdi — hata vermeden.
 *
 * Kural burada, çünkü `loadTotals` ile AYNI olmalı: geçiş toleransı (sezonsuz
 * eski kayıtlar), mükerrer belge birleştirme ve okuma yuvarlaması. Üçü de
 * ayrı ayrı yazılıp ayrışmış olsaydı sıralama ile profil farklı sayı gösterirdi.
 *
 * @returns {Promise<null|{userId,totalPoints,totalPenalty,matches,lastAt,season}>}
 */
async function kullaniciToplami(db, userId, season) {
  const uid = String(userId || "").trim().toLowerCase();
  if (!db || !uid) return null;
  const sezon = season || Season.seasonKey();
  const suzgec = sezon === Season.seasonKey()
    ? { $or: [{ season: sezon }, { season: { $exists: false } }] }
    : { season: sezon };

  try {
    await ensureIndexes(db);
    const ham = await db.collection(COLL)
      .find({ ...suzgec, userIdLower: uid })
      .toArray();
    const [tek] = belgeleriBirlestir(ham);
    if (!tek) return null;
    return {
      userId: tek.userId || userId,
      // Yuvarlama `loadTotals` ile aynı: sıralamada 10 görünen puan profilde
      // 9.9 görünmemeli.
      totalPoints: Math.round(Number(tek.totalPoints || 0)),
      totalPenalty: Math.round(Number(tek.totalPenalty || 0)),
      matches: Number(tek.matches || 0),
      lastAt: tek.lastAt || tek.updatedAt || null,
      season: sezon,
    };
  } catch (e) {
    console.error("[season-totals] kullanici toplami okunamadi:", e?.message || e);
    return null;
  }
}

/** userId (küçük harfe duyarsız) → toplam kaydı eşlemesi. */
async function totalsMap(db, season) {
  const { items } = await loadTotals(db, season);
  const m = new Map();
  for (const it of items) {
    const uid = String(it?.userId || "").toLowerCase();
    if (uid) m.set(uid, it);
  }
  return m;
}

module.exports = { loadTotals, totalsMap, TOTALS_FILE, belgeleriBirlestir,
  // Profil/istatistik icin sezon KAPSAMLI tekil okuma — stats.cjs kendi
  // sorgusunu yaziyordu ve sezon suzgeci yoktu (bkz. tanimi).
  kullaniciToplami };
