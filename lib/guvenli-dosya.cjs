"use strict";

/**
 * GÜVENLİ DOSYA ADI — dizin dışına çıkmayı engeller.
 *
 * ⚠️ NEDEN VAR: maç durumu dosyaları `path.join(LIVE_DIR, `${fixtureId}.json`)`
 * ile açılıyordu ve `fixtureId` isteğin içinden geliyor. Temizlenmediği yerlerde
 * `../../data/lc-wallet` gibi bir değer LIVE_DIR'in DIŞINA çıkıyordu:
 *
 *   path.join(".../data/live", "../../data/lc-wallet.json")
 *     → .../api/data/lc-wallet.json
 *
 * En ağır sonuç `POST /api/rt/poll`'daydı: kimlik doğrulaması YOK ve dosyayı
 * okuyup ÜZERİNE YAZIYOR. Yani kimliksiz bir istek cüzdan dosyasını yeniden
 * yazdırabiliyordu.
 *
 * ⚠️ BU SINIF ZATEN BİR KEZ FARK EDİLMİŞ AMA YARIM KALMIŞTI: 18 çağrı yerinden
 * yalnızca 4'ünde temizleyici vardı ve üçü birbirinin kopyasıydı (liveSafePart,
 * safeName, safeFilePart). Kopyalanan savunma, kopyalanmayan yerde yok demektir;
 * o yüzden tek kaynak burası.
 *
 * ⚠️ İKİ KATMAN, BİLİNÇLİ:
 *   1) Karakter süzgeci — ayırıcıları ve denetim karakterlerini atar.
 *   2) `guvenliYol()` sonuç yolunun kökün İÇİNDE kaldığını DOĞRULAR.
 * Tek başına kara liste yeterli görünüyor ama gelecekte bir platform farkı ya
 * da unicode oyunu süzgeci aşarsa ikinci katman yakalar. Süzgeç sessizce
 * bozulabilir; sınır kontrolü bozulamaz.
 */

const path = require("path");

/**
 * Bir dosya adı parçasını güvenli hâle getirir.
 *
 * Boş/anlamsız girdi `_` döner — boş string `.json` gibi gizli bir ada yol
 * açardı.
 *
 * @param {*} s
 * @returns {string}
 */
function guvenliAd(s) {
  const temiz = String(s == null ? "" : s)
    .trim()
    // yol ayırıcıları, Windows'ta yasak karakterler, denetim karakterleri
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .slice(0, 180);
  // Yalnızca noktalardan oluşan adlar ("." / "..") dizin anlamına gelir.
  if (!temiz || /^\.+$/.test(temiz)) return "_";
  return temiz;
}

/**
 * Kök dizin altında güvenli bir yol üretir.
 *
 * @param {string} kok    izin verilen kök dizin (mutlak)
 * @param {*} ad          istekten gelen ad parçası
 * @param {string} [uzanti] ".json" gibi — ada eklenir
 * @returns {string} mutlak yol
 * @throws {Error} sonuç kökün dışına çıkarsa (asla olmamalı — son savunma)
 */
function guvenliYol(kok, ad, uzanti = "") {
  const tam = path.join(kok, `${guvenliAd(ad)}${uzanti}`);
  const kokNorm = path.resolve(kok);
  const tamNorm = path.resolve(tam);
  // path.sep eki şart: "/data/live-gizli" yolu "/data/live" ile başlar ama
  // onun ALTINDA değildir.
  if (tamNorm !== kokNorm && !tamNorm.startsWith(kokNorm + path.sep)) {
    throw new Error(`GUVENSIZ_YOL: ${String(ad).slice(0, 80)}`);
  }
  return tamNorm;
}

module.exports = { guvenliAd, guvenliYol };
