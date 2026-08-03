"use strict";

/**
 * Mongo indekslerini kurar. İdempotent — istediğin kadar çalıştırabilirsin.
 *
 * Kullanım:
 *   node api/scripts/ensure-indexes.cjs
 *
 * ⚠️ .env BURADA YÜKLENİR. Eskiden yüklenmiyordu: MONGODB_URI tanımsız kalıyor,
 * kök db.cjs de geliştirmede localhost'a düşüyordu → `ECONNREFUSED 127.0.0.1:27017`.
 * Atlas kullanan bir kurulumda script ya patlıyor ya da (yerelde bir mongod
 * varsa) indeksleri YANLIŞ veritabanına kuruyordu.
 *
 * Bağlantı için lib/mongo.cjs kullanılır — uygulamayla ve diğer migration
 * script'leriyle AYNI yol. Bu dosyanın kök db.cjs'i kullanması, aynı projede
 * üçüncü bir bağlantı davranışı demekti.
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { getDb } = require("../lib/mongo.cjs");

(async () => {
  const db = await getDb();
  if (!db) {
    console.error("MongoDB baglantisi yok. api/.env icinde MONGODB_URI tanimli mi?");
    process.exit(1);
  }

  /* ⚠️ KALDIRILDI: `{ fixtureId: 1, userId: 1, at: -1 }` — ATIL İNDEKS.
   *
   * ÖLÇÜLDÜ (üretim, $indexStats):
   *     fixtureId_1_userId_1_at_-1 → 117 saatte 0 ERİŞİM, 2440 KB
   *     (aynı koleksiyonda fixtureId_1_userIdLower_1 → 325.756 erişim)
   * `predictions` en büyük koleksiyon ve indeks alanının %36'sını bu tutuyordu.
   *
   * NEDEN HİÇ KULLANILAMAZ: anahtarın ikinci alanı KARIŞIK HARFLİ `userId`.
   * Kimlikler Firebase UID'si; tam eşleşme kaçırdığı için tüm kod
   * `userIdLower` ile sorguluyor — bu, bu depoda ölçülmüş bir kusurun
   * düzeltmesiydi. Yani indeks yalnızca kullanılmıyor değil, KULLANILAMAZ.
   * `tests/tahmin-sorgu-plani.mongo.test.cjs` nöbetçisi karışık harfli
   * sorguyu ayrıca yasaklıyor.
   *
   * ⚠️ ZATEN VAR OLAN İNDEKS BU BETİKLE DÜŞMEZ. Üretimde düşürmek ayrı bir
   * işlem (bkz. commit notu); burada yapılan, betiğin onu YENİDEN KURMAMASI.
   */
  // Varlık sorguları userIdLower ile yapılıyor (kimlikler karışık harfli):
  // pred.cjs hasPrediction ve weekly-picks getUserPred. Üstteki indeks bunu
  // karşılamaz — fixtureId önekiyle daralıp geri kalanı tarar. Bu ikisi
  // "ikinci kez ücret alma" korumasının kendisi, yani sıcak yol.
  // ⚠️ SEÇENEKLER MEVCUT İNDEKSLE AYNI OLMALI. createIndex yalnızca tanım
  // birebir aynıysa sessizce geçer; `unique` farklıysa Mongo aynı ada sahip
  // farklı indeks diye REDDEDER ve script patlar. Bu indeks migration
  // tarafında `unique+background` olarak kurulmuştu.
  // unique doğru: maç+oyuncu başına tek tahmin (upsert eskisini ezer).
  await db
    .collection("predictions")
    .createIndex({ fixtureId: 1, userIdLower: 1 }, { unique: true, background: true });

  /* ⚠️ TEK BAŞINA userIdLower — "maçlarım" sorgusu buna muhtaç.
   *
   * Yukarıdaki iki indeksin İKİSİ DE `fixtureId` ile başlıyor. Bileşik indeks
   * yalnızca ÖN EKİYLE kullanılabilir, dolayısıyla `{ userIdLower: X }` (fikstür
   * listesi olmadan) hiçbirine düşmüyordu → TAM KOLEKSİYON TARAMASI.
   *
   * Ölçüldü (47.000 tahmin / 1700 kullanıcı, bellek-içi Mongo):
   *     indekssiz : COLLSCAN · 47.000 belge incelendi · 28 döndü · 30,0 ms
   *     indeksli  : IXSCAN   ·     28 belge incelendi · 28 döndü ·  2,3 ms
   * 1679 kat daha az belge. Atlas'ta ağ gecikmesiyle fark daha da büyük.
   *
   * Etkilenen sıcak yollar:
   *   - pred.cjs getPredFlagsFromMongo(filtresiz) → GET /api/pred/my
   *     ("My bets" ekranı; uygulamada her açılışta çağrılıyor)
   *   - settle2.cjs profil tahmin sayacı (countDocuments)
   */
  await db.collection("predictions").createIndex({ userIdLower: 1 }, { background: true });
  console.log("indexes: predictions OK");

  // Sezon toplamları: settle2 her settle'da kullanıcı başına upsert eder,
  // leaderboard tüm koleksiyonu okur. userIdLower BENZERSİZ olmalı — aksi
  // halde yarış koşulunda aynı oyuncu için iki kayıt oluşur ve tabloda
  // iki kez görünür (puanı da bölünür).
  // ⚠️ BİLEŞİK: sıralama sezona bölündü (bkz. lib/season.cjs). Yalnızca
  // `userIdLower` benzersiz olsaydı aynı oyuncunun İKİNCİ sezonu yazılamazdı.
  // Eski tekil indeksi düşürmek için: node scripts/migrate-season-field.cjs
  await db.collection("season_totals").createIndex({ season: 1, userIdLower: 1 }, { unique: true, background: true });
  console.log("indexes: season_totals OK");

  // Fikstürler: senkron her turda tam listeyi upsert eder (fixtureId benzersiz
  // olmazsa aynı maç iki kez listelenir), rotalar zaman penceresiyle sorgular.
  // bkz. lib/fixtures-store.cjs
  await db.collection("fixtures").createIndex({ fixtureId: 1 }, { unique: true, background: true });
  await db.collection("fixtures").createIndex({ kickoffISO: 1 }, { background: true });
  console.log("indexes: fixtures OK");

  // Sosyal + oyun depoları. Hepsi lib/social-store.cjs ve lib/streak-store.cjs
  // üzerinden yazılıyor; oradaki ensureIndexes de aynılarını kurar — bu script
  // yalnızca "hepsi baştan hazır olsun" içindir.
  await db.collection("groups").createIndex({ code: 1 }, { unique: true, background: true });
  await db.collection("mini_tournaments").createIndex({ id: 1 }, { unique: true, background: true });
  await db.collection("friend_links").createIndex({ pair: 1 }, { unique: true, background: true });
  await db.collection("friend_requests").createIndex({ pair: 1 }, { unique: true, background: true });
  await db.collection("friend_blocks").createIndex({ pair: 1 }, { unique: true, background: true });
  // ⚠️ Bu ikisi PARA korumasının dayanağı: benzersizlik olmazsa kopya belge
  // oluşur ve claimTournamentSettle/claimDuelSettle birden fazla çağrıya
  // "kazandın" der (çift ödeme).
  await db.collection("tournaments").createIndex({ id: 1 }, { unique: true, background: true });
  await db.collection("duels").createIndex({ id: 1 }, { unique: true, background: true });
  await db.collection("streaks").createIndex({ userIdLower: 1 }, { unique: true, background: true });
  // ⚠️ Bu ikisi de "bir kez ver" garantisinin dayanağı:
  //   tr_league_weeks → hafta ödülü tekrar dağıtılmasın
  //   invite_codes_1987 → kod kotası aşılmasın (1987 üyeliği LC değeri taşıyor)
  await db.collection("tr_league_weeks").createIndex({ weekKey: 1 }, { unique: true, background: true });
  await db.collection("invite_codes_1987").createIndex({ codeNorm: 1 }, { unique: true, background: true });
  console.log("indexes: social + duels + streaks + tr-league + invite OK");

  // ⚠️ GÜVENLİK: yasak listesi her isteği süzüyor. Kopya kayıt, "kaldırıldı
  // sanılan ama duran" yasak demek.
  await db.collection("admin_users").createIndex({ userId: 1 }, { unique: true, background: true });
  await db.collection("banned_users").createIndex({ userId: 1 }, { unique: true, background: true });
  console.log("indexes: moderation OK");

  // Maç havuzu (bkz. lib/pool-store.cjs). Bir oyuncu bir maçta TEK bahis
  // tutar; benzersizlik olmazsa aynı kişi için iki kayıt oluşur ve ödeme
  // iki kez yapılır.
  await db.collection("pool_bets").createIndex({ fixtureId: 1, userIdLower: 1 }, { unique: true, background: true });
  await db.collection("pool_bets").createIndex({ fixtureId: 1 }, { background: true });
  await db.collection("pools").createIndex({ fixtureId: 1 }, { unique: true, background: true });
  console.log("indexes: pool OK");

  /* ⚠️ CÜZDAN — PARA. `lc_wallet_users` hiç indekslenmemişti.
   *
   * creditLc `{userIdLower}` üzerinde `upsert:true` yapıyor. Benzersiz indeks
   * yokken iki eşzamanlı upsert eşleşme bulamazsa İKİSİ DE ekler. Ölçüldü
   * (40 eşzamanlı ödül): 2 belge, bakiyeler [195, 5]. Toplam doğru ama
   * bölünmüş — `findOne` birini döndürdüğü için kullanıcı 5 LC görüyor.
   *
   * ÖNCE KOPYA VAR MI BAK: varsa createIndex zaten patlar, ama hata mesajı
   * ("E11000") neyin yanlış olduğunu söylemez. Kopyaları birleştirmek elle
   * karar gerektirir (hangi bakiye doğru?), o yüzden burada YAPMIYORUZ —
   * yalnızca açıkça rapor ediyoruz.
   */
  const kopyalar = await db.collection("lc_wallet_users").aggregate([
    { $group: { _id: "$userIdLower", n: { $sum: 1 }, bakiyeler: { $push: "$balance" } } },
    { $match: { n: { $gt: 1 } } },
  ]).toArray();
  if (kopyalar.length) {
    console.error(`\n⛔ ${kopyalar.length} kullanicida KOPYA CUZDAN var — benzersiz indeks kurulamaz:`);
    for (const k of kopyalar) console.error(`   ${k._id}: ${k.n} belge, bakiyeler [${k.bakiyeler.join(", ")}]`);
    console.error(`   Once bunlari elle birlestir (dogru bakiye = toplam), sonra bu betigi tekrar calistir.\n`);
    process.exit(1);
  }
  await db.collection("lc_wallet_users").createIndex({ userIdLower: 1 }, { unique: true, background: true });
  await db.collection("lc_wallet_ledger").createIndex({ userIdLower: 1, createdAt: -1 }, { background: true });
  // Bildirim jetonlari + tercihleri (bkz. lib/push-store.cjs). Dosyada
  // tutulurken her deploy siliniyordu: jeton kaybi bildirimi olu birakiyor,
  // TERCIH kaybi ise kapatilan bildirimi yeniden aciyordu.
  await db.collection("push_tokens").createIndex({ userIdLower: 1 }, { unique: true, background: true });
  /* Haftalik kupon (bkz. lib/kupon-store.cjs).
   * ⚠️ Ikisi de PARA korumasi: ayni hafta+tur+ulke icin tek kupon, ve bir
   * oyuncu bir kupona bir kez katilir. Benzersizlik olmazsa oyuncu iki kez
   * odeyip iki kez odul alabilir. */
  await db.collection("kuponlar").createIndex({ id: 1 }, { unique: true, background: true });
  await db.collection("kuponlar").createIndex({ haftaKey: 1, tur: 1, ulke: 1 }, { unique: true, background: true });
  await db.collection("kupon_katilim").createIndex({ kuponId: 1, userIdLower: 1 }, { unique: true, background: true });
  await db.collection("kupon_katilim").createIndex({ userIdLower: 1 }, { background: true });
  console.log("indexes: kupon OK");

  console.log("indexes: push OK");

  console.log("indexes: wallet OK");

  console.log(`veritabani: ${db.databaseName}`);
  process.exit(0);
})().catch((e) => {
  console.error("indeks kurulumu basarisiz:", e?.message || e);
  process.exit(1);
});
