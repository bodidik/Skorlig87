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

  await db.collection("predictions").createIndex({ fixtureId: 1, userId: 1, at: -1 });
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
  console.log("indexes: predictions OK");

  // Sezon toplamları: settle2 her settle'da kullanıcı başına upsert eder,
  // leaderboard tüm koleksiyonu okur. userIdLower BENZERSİZ olmalı — aksi
  // halde yarış koşulunda aynı oyuncu için iki kayıt oluşur ve tabloda
  // iki kez görünür (puanı da bölünür).
  await db.collection("season_totals").createIndex({ userIdLower: 1 }, { unique: true });
  console.log("indexes: season_totals OK");

  // Fikstürler: senkron her turda tam listeyi upsert eder (fixtureId benzersiz
  // olmazsa aynı maç iki kez listelenir), rotalar zaman penceresiyle sorgular.
  // bkz. lib/fixtures-store.cjs
  await db.collection("fixtures").createIndex({ fixtureId: 1 }, { unique: true, background: true });
  await db.collection("fixtures").createIndex({ kickoffISO: 1 }, { background: true });
  console.log("indexes: fixtures OK");

  console.log(`veritabani: ${db.databaseName}`);
  process.exit(0);
})().catch((e) => {
  console.error("indeks kurulumu basarisiz:", e?.message || e);
  process.exit(1);
});
