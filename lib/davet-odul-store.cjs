"use strict";

/**
 * DAVET ÖDÜLÜ MÜHRÜ — bir kullanıcı davet ödülünü YALNIZCA BİR KEZ alır.
 *
 * ⚠️ NEDEN GEREKLİ: `/use-invite` ödülü vermeden önce "zaten arkadaş mısınız"
 * diye bakıyordu, ama bu kontrol ATOMİK DEĞİL. İki eşzamanlı istek ikisi de
 * "arkadaş değiller" görür, ikisi de `addLink` çağırır (idempotent, sorun yok)
 * ve ikisi de ödül öder: 30 LC yerine 60 LC basılır.
 *
 * `addLink` bunu çözemez çünkü HER ZAMAN `true` döner — yeni bağ mı kurdu,
 * yoksa zaten var mıydı, ayırt etmiyor.
 *
 * ⚠️ MÜHÜR YAZMANIN İÇİNDE: benzersiz indeks + `insertOne`. Çakışma (11000)
 * "bu kullanıcı ödülünü zaten aldı" demektir. Önce-oku-sonra-yaz deseni
 * yarışı kapatmazdı — bu oturumda aynı ders altı ayrı yerde çıktı.
 *
 * ⚠️ ANAHTAR DAVET EDİLEN KİŞİ: her hesap ömrü boyunca bir kez davet ödülü
 * alır. Anahtar çift (davet eden + edilen) olsaydı, aynı kişi farklı kodlarla
 * tekrar tekrar ödül alabilirdi.
 *
 * ⚠️ KİMLİK DEĞİL ÖZETİ SAKLANIYOR. İki gereksinim çakışıyordu:
 *   • Kayıt SİLİNMEMELİ — silinirse kullanıcı hesabını silip ödülü tekrar
 *     alabilir (aynı gerekçe `banned_users` için de geçerli).
 *   • Kimlik hesap silindikten sonra DURMAMALI — "kullanıcı verisini sil".
 * SHA-256 özeti ikisini birden karşılıyor: çakışma denetimi aynen çalışır,
 * geriye okunabilir bir kimlik kalmaz. Bu yüzden koleksiyon hesap silme
 * kapsamından gerekçeyle muaf.
 */

const crypto = require("crypto");

const COLL = "invite_redeems";

/** Kimliğin geri döndürülemez özeti — ham kimlik saklanmıyor. */
const ozet = (uid) =>
  crypto.createHash("sha256").update(String(uid || "").trim().toLowerCase()).digest("hex");

let _indexPromise = null;

/** ⚠️ Bayrak değil SÖZ önbelleklenir; bayrak, indeks kurulmadan ikinci
 *  çağrının "kuruldu" sanmasına yol açar (aynı hata diğer depolarda bulundu). */
function ensureIndexes(db) {
  if (!db) return Promise.resolve();
  if (_indexPromise) return _indexPromise;
  _indexPromise = (async () => {
    try {
      await db.collection(COLL).createIndex(
        { anahtar: 1 },
        { unique: true, background: true }
      );
    } catch (e) {
      console.error("[davet-odul] indeks kurulamadi:", e?.message || e);
      _indexPromise = null;
    }
  })();
  return _indexPromise;
}

/**
 * Davet ödülünü bu kullanıcı için MÜHÜRLER.
 *
 * @returns {Promise<boolean>} true ise ödül BU çağrıda verilmeli;
 *   false ise daha önce verilmiş (ya da mühür alınamadı → ödeme yapma).
 */
async function odulMuhurle(invitedUserId, db) {
  if (!db) return false;                       // sayamıyorsak basma (fail-closed)
  const ham = String(invitedUserId || "").trim();
  if (!ham) return false;

  await ensureIndexes(db);
  try {
    // Yalnızca özet + zaman: ham kimlik ya da davet eden saklanmıyor.
    await db.collection(COLL).insertOne({ anahtar: ozet(ham), at: new Date() });
    return true;
  } catch (e) {
    if (e?.code === 11000) return false;       // zaten almış — normal akış
    console.error("[davet-odul] muhur alinamadi:", e?.message || e);
    return false;                              // belirsizse ödeme yapma
  }
}

module.exports = { odulMuhurle, ensureIndexes, COLL };
