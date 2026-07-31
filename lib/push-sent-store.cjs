"use strict";

/**
 * BİLDİRİM ÇİFT-GÖNDERİM MÜHRÜ.
 *
 * ⚠️ NEDEN VAR: koruma yalnızca `data/push-sent.json` DOSYASINDAYDI. İki ayrı
 * biçimde çöküyordu:
 *
 *   1) GEÇİCİ DİSK — Render'da `data/` her deploy'da siliniyor. Anahtarlar
 *      kaybolunca hâlâ pencerede olan maçlar için "başlıyor" ve "sonuç"
 *      bildirimleri TEKRAR gönderiliyordu. Bildirim spam'i, para kaybından
 *      farklı ama uygulamayı sildiren şeydir.
 *
 *   2) TEK SÜREÇ VARSAYIMI — `withFileLock` yalnızca aynı diski paylaşan aynı
 *      süreç için anlamlı. İkinci bir instance açıldığında koruma hiç
 *      çalışmaz. Kod tabanı bu dersi başka yerde zaten almıştı: tr-lig'de
 *      koruma `_finalizingWeek` adlı SÜREÇ-İÇİ bir Set'ti ve aynı sebeple
 *      Mongo mührüne taşındı (bkz. routes/tr-league.cjs claimWeek notu).
 *
 * ⚠️ MÜHÜR YAZMANIN İÇİNDE: benzersiz indeks + `insertOne`. Çakışma (11000)
 * "başkası aldı" demektir. Önce oku-sonra yaz deseni iki eşzamanlı turda
 * ikisinin de anahtarı boş görmesine izin verirdi.
 *
 * ⚠️ DOSYA YEDEĞİ KORUNUYOR: Mongo yoksa eski davranışa düşülür. Yedeği
 * kaldırmak, veritabanı erişilemezken bildirimleri tamamen durdururdu.
 */

const COLL = "push_sent";

/** Anahtarlar bu süre sonunda kendiliğinden silinir (TTL indeksi). */
const TTL_SN = Number(process.env.SKORLIG_PUSH_SENT_TTL_SN || 7 * 24 * 3600);

let _indexPromise = null;

/**
 * ⚠️ BAYRAK DEĞİL SÖZ önbelleklenir: bayrak kullanılırsa `await createIndex`
 * tamamlanmadan gelen ikinci çağrı "kuruldu" sanıp devam eder. Aynı hata
 * diğer depolarda da bulunmuştu.
 */
function ensureIndexes(db) {
  if (!db) return Promise.resolve();
  if (_indexPromise) return _indexPromise;
  _indexPromise = (async () => {
    try {
      const col = db.collection(COLL);
      await col.createIndex({ key: 1 }, { unique: true, background: true });
      // TTL: elle bayat temizliği yapmaya gerek kalmıyor.
      await col.createIndex({ at: 1 }, { expireAfterSeconds: TTL_SN, background: true });
    } catch (e) {
      console.error("[push-sent] indeks kurulamadi:", e?.message || e);
      _indexPromise = null;
    }
  })();
  return _indexPromise;
}

/**
 * Verilen anahtarlardan HENÜZ ALINMAMIŞ olanları alır ve onları döner.
 *
 * @param {string[]} keys
 * @param {*} db  Mongo bağlantısı; yoksa `null` döner ve çağıran dosya yoluna düşer
 * @returns {Promise<string[]|null>} alınan anahtarlar, ya da Mongo yoksa null
 */
async function claimKeys(keys, db) {
  if (!db) return null;
  const liste = [...new Set((keys || []).map((k) => String(k || "").trim()).filter(Boolean))];
  if (!liste.length) return [];

  await ensureIndexes(db);
  const col = db.collection(COLL);
  const at = new Date();
  const alinan = [];

  for (const key of liste) {
    try {
      await col.insertOne({ key, at });
      alinan.push(key);
    } catch (e) {
      // 11000 = başkası (ya da önceki tur) zaten aldı — normal akış.
      if (e?.code !== 11000) {
        console.error("[push-sent] anahtar alinamadi:", key, e?.message || e);
      }
    }
  }
  return alinan;
}

module.exports = { claimKeys, ensureIndexes, COLL, TTL_SN };
