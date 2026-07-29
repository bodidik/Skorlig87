"use strict";
const { getDb } = require("../db.cjs");

(async ()=>{
  const db = await getDb();
  await db.collection("predictions").createIndex({ fixtureId:1, userId:1, at:-1 });
  // Varlık sorguları userIdLower ile yapılıyor (kimlikler karışık harfli):
  // pred.cjs hasPrediction ve weekly-picks getUserPred. Üstteki indeks bunu
  // karşılamaz — fixtureId önekiyle daralıp geri kalanı tarar. Bu ikisi
  // "ikinci kez ücret alma" korumasının kendisi, yani sıcak yol.
  await db.collection("predictions").createIndex({ fixtureId:1, userIdLower:1 });
  console.log("indexes: predictions OK");

  // Sezon toplamlari: settle2 her settle'da kullanici basina upsert eder,
  // leaderboard tum koleksiyonu okur. userIdLower BENZERSIZ olmali — aksi
  // halde yaris kosulunda ayni oyuncu icin iki kayit olusur ve tabloda
  // iki kez gorunur (puani da bolunur).
  await db.collection("season_totals").createIndex({ userIdLower:1 }, { unique:true });
  console.log("indexes: season_totals OK");
  process.exit(0);
})();