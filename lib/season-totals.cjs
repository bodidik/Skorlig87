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
      const ham = await db.collection("season_totals").find(suzgec).toArray();
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

/** userId (küçük harfe duyarsız) → toplam kaydı eşlemesi. */
async function totalsMap(db) {
  const { items } = await loadTotals(db);
  const m = new Map();
  for (const it of items) {
    const uid = String(it?.userId || "").toLowerCase();
    if (uid) m.set(uid, it);
  }
  return m;
}

module.exports = { loadTotals, totalsMap, TOTALS_FILE, belgeleriBirlestir };
