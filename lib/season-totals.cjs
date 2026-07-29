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

const DATA_DIR = process.env.SKORLIG_DATA_DIR || path.join(__dirname, "..", "data");
const TOTALS_FILE = path.join(DATA_DIR, "totals.json");

/**
 * Sezon toplamlarını döndürür.
 *
 * @param {object|null} db
 * @returns {Promise<{items: Array<{userId,totalPoints,totalPenalty,matches,lastAt}>, updatedAt: string|null, source: string}>}
 */
async function loadTotals(db) {
  if (db) {
    try {
      const docs = await db.collection("season_totals").find({}).toArray();
      if (docs && docs.length) {
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

module.exports = { loadTotals, totalsMap, TOTALS_FILE };
