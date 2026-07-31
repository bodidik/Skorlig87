"use strict";

/**
 * TAHMİN KOLEKSİYONU İNDEKSLERİ — çalışma zamanında, kendi kendine.
 *
 * ⚠️ NEDEN VAR: `predictions` kod tabanının EN BÜYÜK koleksiyonu (yerel
 * ölçümde 36.331 kayıt) ve her settle `{fixtureId}` ile, her geçmiş sorgusu
 * `{userIdLower}` ile tarıyor. Ama indeksleri YALNIZCA `scripts/ensure-indexes.cjs`
 * kuruyordu — yani birinin o betiği elle çalıştırmasına bağlıydı.
 *
 * Diğer BÜTÜN depolar (cüzdan, kupon, düello, havuz, seri, bildirim...) ilk
 * erişimde `ensureIndexes()` çağırıp kendini onarıyor. En çok sorgulanan
 * koleksiyon bu davranışa sahip değildi: yeni bir ortamda ya da koleksiyon
 * yeniden oluşturulduğunda indeksler sessizce yok olur ve her settle tüm
 * koleksiyonu tarar. Belirti "hata" değil — sadece yavaşlık, ve kimse bakmaz.
 *
 * ⚠️ BAYRAK DEĞİL SÖZ ÖNBELLEKLENİR. Bayrak kullanılsaydı `await createIndex`
 * tamamlanmadan gelen ikinci çağrı "kuruldu" sanıp devam ederdi. Aynı hata
 * diğer depolarda da bulunmuştu; burada da aynı biçim kullanılıyor.
 *
 * ⚠️ BENZERSİZLİK İDDİA EDİLMİYOR. `scripts/migrate-preds-to-mongo.cjs`
 * `{fixtureId, userIdLower}` üzerinde UNIQUE kuruyor; burada aynısını unique
 * kurmak, mevcut veride kopya varsa çalışma zamanında HATA verirdi. İndeks
 * kurulumu bir onarım yolu, bir veri doğrulama aracı değil — benzersizlik
 * kararı geçiş betiğinde kalıyor.
 */

let _soz = null;

/**
 * @param {*} db Mongo bağlantısı (yoksa sessizce geçer)
 * @returns {Promise<void>}
 */
function ensurePredIndexes(db) {
  if (!db) return Promise.resolve();
  if (_soz) return _soz;
  _soz = (async () => {
    try {
      const col = db.collection("predictions");
      // Settle: bir maçın tüm tahminleri.
      await col.createIndex({ fixtureId: 1 }, { background: true });
      // Geçmiş/profil: bir kullanıcının tahminleri.
      await col.createIndex({ userIdLower: 1 }, { background: true });
      // Tekil okuma (bir kullanıcının bir maçtaki tahmini) — en sık çift.
      await col.createIndex({ fixtureId: 1, userIdLower: 1 }, { background: true });
    } catch (e) {
      console.error("[preds-index] indeks kurulamadi:", e?.message || e);
      _soz = null;   // bir sonraki çağrı yeniden denesin
    }
  })();
  return _soz;
}

/**
 * ⚠️ ÖNBELLEK KALICI. Söz bir kez çözülünce indeksler yeniden kurulmaz —
 * üretimde doğru davranış (her erişimde `createIndex` çağırmak boşuna yük).
 * Ama koleksiyon çalışma sırasında DÜŞÜRÜLÜRSE indeksler geri gelmez.
 * Üretimde koleksiyon düşürülmüyor; testte gerekiyor, o yüzden sıfırlama
 * yalnızca test için dışa açık.
 */
function _sifirla() {
  _soz = null;
}

module.exports = { ensurePredIndexes, _sifirla };
