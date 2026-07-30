"use strict";
/**
 * İNDEKS DENETİMİ — SALT OKUMA.
 *
 * Ne yazar ne siler ne tohumlar; yalnızca hangi koleksiyonda hangi indeksin
 * kurulu olduğunu listeler. `ensure-indexes.cjs` çalıştıktan sonra "gerçekten
 * oluştu mu" sorusunu yanıtlamak için.
 *
 * NEDEN AYRI BİR BETİK: ensure-indexes yazma yapıyor; yalnızca doğrulamak
 * isterken onu çalıştırmak gereksiz risk. Ayrıca sunucuyu açmak da olmaz —
 * depolar "Mongo boşsa dosyadan tohumla" kuralıyla çalışıyor ve yerel .env
 * üretime bakıyorsa geliştirme verisini üretime yazar (bir kez yaşandı).
 *
 * Kullanım:  node scripts/check-indexes.cjs
 */

require("dotenv").config();
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

// Sıcak yolların BEKLEDİĞİ indeksler. Yeni bir sorgu deseni eklediğinde
// buraya da ekle — betik eksikse "EKSIK" diye bağırır.
const BEKLENEN = {
  predictions: [
    ["fixtureId", "userIdLower"],  // çift tahmin koruması (unique)
    ["userIdLower"],               // "My bets" — bkz. ensure-indexes.cjs notu
  ],
  season_totals: [["season", "userIdLower"]],
  fixtures: [["fixtureId"]],
  groups: [["code"]],
  mini_tournaments: [["id"]],
  friend_links: [["pair"]],
  tournaments: [["id"]],
  duels: [["id"]],
  streaks: [["userIdLower"]],
  invite_codes_1987: [["codeNorm"]],
  pool_bets: [["fixtureId", "userIdLower"]],
  // PARA: benzersizlik olmadan eşzamanlı upsert kopya cüzdan üretiyor.
  lc_wallet_users: [["userIdLower"]],
  lc_wallet_ledger: [["userIdLower", "createdAt"]],
};

(async () => {
  const { getDb } = require("../lib/mongo.cjs");
  const db = await getDb();
  if (!db) {
    console.error("MongoDB baglantisi yok (MONGODB_URI tanimli mi?).");
    process.exit(1);
  }
  console.log(`veritabani: ${db.databaseName}\n`);

  let eksik = 0;
  for (const [koleksiyon, bekleyenler] of Object.entries(BEKLENEN)) {
    let kurulu = [];
    try {
      kurulu = (await db.collection(koleksiyon).indexes()).map((i) => Object.keys(i.key));
    } catch (e) {
      console.log(`${koleksiyon.padEnd(20)} OKUNAMADI: ${e.message}`);
      eksik++;
      continue;
    }
    const anahtar = (a) => a.join("+");
    const kuruluSet = new Set(kurulu.map(anahtar));
    const yok = bekleyenler.filter((b) => !kuruluSet.has(anahtar(b)));
    const durum = yok.length ? `EKSIK -> ${yok.map(anahtar).join(", ")}` : "tamam";
    if (yok.length) eksik++;
    console.log(
      `${koleksiyon.padEnd(20)} ${durum.padEnd(34)} (kurulu: ${kurulu.map(anahtar).join(" | ")})`
    );
  }

  /* ⚠️ LİSTEDE OLMAYANLARI DA GÖSTER.
   *
   * Bu betiğin ilk hâli yalnızca BEKLENEN'deki koleksiyonlara bakıp "hepsi
   * kurulu" diyordu. `lc_wallet_users` listede yoktu — hiç incelenmedi ve
   * betik yine de ✅ bastı. Denetim aracının kendisi, denetlemediği şeyi
   * "sorunsuz" diye raporluyordu. Artık _id dışında indeksi olmayan HER
   * koleksiyon aşağıda görünür; oraya bakıp kasıtlı mı karar verirsin.
   */
  const bilinen = new Set(Object.keys(BEKLENEN));
  const hepsi = await db.listCollections({}, { nameOnly: true }).toArray();
  const cilpak = [];
  for (const c of hepsi) {
    if (bilinen.has(c.name)) continue;
    try {
      const ix = await db.collection(c.name).indexes();
      const belge = await db.collection(c.name).estimatedDocumentCount();
      if (ix.length <= 1) cilpak.push(`${c.name} (${belge} belge)`);
    } catch { /* okunamayan koleksiyonu atla */ }
  }
  if (cilpak.length) {
    console.log(`\nℹ️ Listede olmayan ve _id disinda indeksi bulunmayan koleksiyonlar:`);
    for (const c of cilpak) console.log(`   - ${c}`);
    console.log(`   (kucukse sorun degil; sicak yolda sorgulaniyorsa BEKLENEN'e ekle)`);
  }

  console.log(
    eksik
      ? `\n⚠️ ${eksik} koleksiyonda eksik var — 'node scripts/ensure-indexes.cjs' calistir.`
      : `\n✅ Beklenen indekslerin hepsi kurulu.`
  );
  process.exit(eksik ? 1 : 0);
})().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
