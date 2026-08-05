"use strict";

/**
 * KİRLİ CÜZDAN BAKİYELERİNİ TOPLU TEMİZLER.
 *
 * `lib/wallet-credit.cjs` artık her yazımda bakiyeyi yuvarlıyor (iş hattı
 * güncellemesi + `$round`), yani YENİ artık oluşmuyor ve mevcut kirli bakiye
 * kullanıcının bir sonraki işleminde kendiliğinden düzeliyor. Bu betik o
 * "sonraki işlem"i beklemek istemeyenler için — özellikle uzun süredir işlem
 * yapmamış hesaplar için.
 *
 * ⚠️ NE YAPMAZ: PARA MİKTARINI DEĞİŞTİRMEZ. Yalnızca `37.999999999999986`
 * gibi bir değeri `38`e sabitler; sapma her zaman 1 kuruşun çok altında.
 * Anlamlı bir fark görürseniz bu betik değil, onu üreten yol sorunludur.
 *
 * KULLANIM:
 *   node scripts/cuzdan-yuvarla.cjs            # KURU KOŞU — hiçbir şey yazmaz
 *   node scripts/cuzdan-yuvarla.cjs --uygula   # gerçekten yazar
 *
 * ⚠️ VARSAYILAN KURU KOŞU. Para belgelerine dokunan bir betiğin ilk
 * çalıştırmada yazması, bu depoda tekrar eden bir ders (bkz.
 * scripts/ikiz-birlestir.cjs aynı deseni kullanıyor).
 */

const { MongoClient } = require("mongodb");
const {
  COLL_USERS, tutarNormalle,
} = require("../lib/wallet-credit.cjs");

const UYGULA = process.argv.includes("--uygula");
const ALANLAR = ["balance", "totalEarned", "totalSpent"];

async function main() {
  const uri = process.env.MONGODB_URI || process.env.SKORLIG_MONGODB_URI;
  if (!uri) {
    console.error("MONGODB_URI yok — baglanti adresi olmadan calisamaz.");
    process.exit(1);
  }

  const client = new MongoClient(uri);
  await client.connect();
  try {
    const db = client.db();
    const users = db.collection(COLL_USERS);

    let taranan = 0, kirli = 0, yazilan = 0;
    let enBuyukSapma = 0, ornek = null;

    const imlec = users.find({}, {
      projection: { userId: 1, userIdLower: 1, balance: 1, totalEarned: 1, totalSpent: 1 },
    });

    for await (const d of imlec) {
      taranan++;
      const duzeltme = {};
      let belgeKirli = false;

      for (const alan of ALANLAR) {
        const ham = Number(d[alan]);
        if (!Number.isFinite(ham)) continue;
        const temiz = tutarNormalle(ham);
        if (temiz !== ham) {
          belgeKirli = true;
          duzeltme[alan] = temiz;
          const sapma = Math.abs(temiz - ham);
          if (sapma > enBuyukSapma) {
            enBuyukSapma = sapma;
            ornek = `${d.userIdLower} · ${alan}: ${ham} → ${temiz}`;
          }
        }
      }

      if (!belgeKirli) continue;
      kirli++;

      if (UYGULA) {
        await users.updateOne({ _id: d._id }, { $set: duzeltme });
        yazilan++;
      }
    }

    console.log(`taranan cuzdan : ${taranan}`);
    console.log(`kirli belge    : ${kirli}`);
    console.log(`en buyuk sapma : ${enBuyukSapma}`);
    if (ornek) console.log(`ornek          : ${ornek}`);
    console.log(UYGULA ? `yazilan        : ${yazilan}` : "KURU KOSU — hicbir sey yazilmadi (--uygula ile calistirin)");

    /* ⚠️ Sapma bir kuruşu geçiyorsa bu artık "kayan nokta artığı" değildir;
     * bir ödeme yolu yanlış tutar yazıyor demektir ve yuvarlamak onu GİZLER. */
    if (enBuyukSapma > 0.01) {
      console.error(`⛔ SAPMA COK BUYUK (${enBuyukSapma}) — bu kayan nokta artigi degil, ` +
        `bir odeme yolu yanlis tutar yaziyor olabilir. Yuvarlamadan ONCE arastirin.`);
      process.exitCode = 2;
    }
  } finally {
    await client.close();
  }
}

main().catch((e) => {
  console.error("[cuzdan-yuvarla] hata:", e?.message || e);
  process.exit(1);
});
