"use strict";

/**
 * ESKİ MONGO SARMALAYICISI — artık lib/mongo.cjs'e devrediyor.
 *
 * NEDEN DEĞİŞTİ: Bu dosya KENDİ MongoClient'ını kuruyordu ve hiçbir koruması
 * yoktu — yeniden deneme yok, negatif önbellek yok, zaman aşımı bile ayarlı
 * değildi (sürücü varsayılanı 30 saniye). Oysa İSTEK YOLUNDA kullanılıyor:
 * `routes/realtime.cjs` (7 rota), `models/preds.cjs`, `routes/db.cjs`.
 *
 * Sonuç: Mongo düştüğünde bu rotalara gelen her istek 30 saniye asılı kalır ve
 * bağlantı havuzu dolardı. lib/mongo.cjs'te tam olarak bu sorun çözülmüştü
 * (yeniden deneme + 30sn soğuma penceresi + 15sn zaman aşımı) ama bu dosya o
 * düzeltmenin dışında kalmıştı — ayrı istemci, ayrı havuz, ayrı davranış.
 *
 * Artık tek bağlantı havuzu var. Dışa açılan yüzey aynı (getDb, pingDb);
 * çağıranların hiçbiri değişmedi.
 */

const mongo = require("./mongo.cjs");

function hata() {
  const durum = mongo.status();
  return new Error(
    "MONGO_UNAVAILABLE" + (durum.lastError ? `: ${durum.lastError}` : "")
  );
}

/**
 * Veritabanı. Bağlantı yoksa HATA FIRLATIR.
 *
 * Bu dosyanın tarihsel sözleşmesi bu ve çağıranlar buna göre yazılmış
 * (lib/mongo.cjs ise null döner). Sessizce null dönmek burada tehlikeli
 * olurdu: `models/preds.cjs` dönen nesne üzerinde doğrudan koleksiyon açıyor,
 * null gelseydi hata çok daha uzakta ve anlaşılmaz bir yerde patlardı.
 */
async function getDb() {
  const db = await mongo.getDb();
  if (!db) throw hata();
  return db;
}

/**
 * Sağlık yoklaması. Soğuma penceresini AŞAR (`force`) — yoklamanın işi tam da
 * o pencerede gerçek durumu ölçmek; soğumaya uyarsa toparlanmayı göremezdi.
 */
async function pingDb() {
  const db = await mongo.getDb({ force: true });
  if (!db) throw hata();
  return await db.admin().ping();
}

module.exports = { getDb, pingDb };
