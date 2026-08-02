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

      /* ⚠️ VAR OLAN İNDEKS YENİDEN KURULMAYA ÇALIŞILMIYOR — VE BU BİR KUSUR
       * DÜZELTMESİ.
       *
       * Geçiş betiği `{fixtureId, userIdLower}` indeksini **unique** kuruyor.
       * Burada aynı anahtar `unique` OLMADAN isteniyordu; Mongo aynı ada
       * farklı seçenek görünce her seferinde hata veriyordu:
       *     "An existing index has the same name as the requested index"
       *
       * Bedeli iki katlıydı:
       *   1) Aşağıdaki `catch` bloğu `_soz = null` yapıyor (geçici hatada
       *      yeniden denensin diye) — yani HATA, ÖNBELLEĞİ KALICI OLARAK
       *      BOZUYORDU. Ölçüldü: çağrı başına **263 ms**, hiç azalmadan.
       *   2) `routes/weekly-picks.cjs` bunu fikstür DÖNGÜSÜNDE çağırıyordu;
       *      240 maçlık pencerede yalnızca indeks denemesi ~63 saniye. Uç
       *      60 saniyede bile yanıt vermiyordu. Sunucu günlüğü de bu hatayla
       *      doluyordu (her istekte iki satır).
       *
       * ⚠️ ÇÖZÜM `unique: true` EKLEMEK DEĞİL — önce onu denedim, YANLIŞTI.
       * `tests/indeks-kapsam.test.cjs` gerekçesini yazmış: "İndeks kurulumu
       * bir ONARIM yolu, veri doğrulama aracı değil; benzersizlik kararı
       * geçiş betiğinde kalıyor." Çalışma zamanında unique kurmak, veride
       * kopya varsa HER AÇILIŞTA patlardı.
       *
       * Doğrusu: anahtarı zaten karşılayan bir indeks VARSA dokunma.
       * Böylece hem çakışma hem "benzersizliği runtime iddia etme" kuralı
       * korunuyor. */
      const mevcut = await col.indexes().catch(() => []);
      const anahtarVar = (key) =>
        mevcut.some((i) => JSON.stringify(i.key) === JSON.stringify(key));

      const kurulacak = [
        { fixtureId: 1 },                       // settle: bir maçın tüm tahminleri
        { userIdLower: 1 },                     // geçmiş/profil
        { fixtureId: 1, userIdLower: 1 },       // tekil okuma — en sık çift
      ];
      for (const key of kurulacak) {
        if (anahtarVar(key)) continue;
        await col.createIndex(key, { background: true });
      }
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
