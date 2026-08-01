"use strict";

/**
 * "BU MAÇ GERÇEKTEN BİTTİ Mİ?" — kazıyıcı satırından karar.
 *
 * ⚠️ BULUNAN: Mackolik ayrıştırıcısı bitmişliği YALNIZCA satır sınıfından
 * çıkarıyordu:
 *
 *     const isFinished = /match-not-play|finished/.test(cls);
 *     ...
 *     status: isFinished ? "MS" : status      // ← ham durum EZİLİYOR
 *
 * `match-not-play` "oynanmıyor" demek — ERTELENEN, İPTAL EDİLEN ve TATİL
 * EDİLEN maçlar da bu sınıfta. Üçü de "bitmiş" sayılıp `MS` damgası yiyordu.
 *
 * Zincir para dağıtıyor: `services/livescore-sync.cjs` `isFinished` ise
 * `status: "FT"` yazıyor, `routes/settle2.cjs` de `status === "FT"` görünce
 * maçı sonuçlandırıp LC ödüyor.
 *
 * ⚠️ MEVCUT KORUMA YARISINI TUTUYORDU: sync tarafında "FT ama skor yok"
 * denetimi var (uydurulmuş 0-0 hatasından kalma), yani ertelenen maçlar
 * (skor kutusu boş) yakalanıyordu. YARIDA KESİLEN maç yakalanmıyordu: skor
 * gerçek (örn. 1-0), sınıf `match-not-play`, sonuç "bitti" — ve o skor
 * üzerinden ödeme yapılıyordu.
 *
 * ⚠️ KAPALI TARAFTA HATA YAPMAK BURADA DOĞRU: bitmiş bir maçı "bitmedi"
 * saymak parayı geciktirir ama kaybetmez — `lib/bayat-mac.cjs` 48 saat sonra
 * iade ediyor. Ters yönde hata ise oynanmamış bir maç üzerinden ödeme demek,
 * geri dönüşü yok.
 */

/**
 * Oynanmadığını söyleyen durum metinleri.
 *
 * Mackolik Türkçe rozet basıyor; diğer kaynaklar için yaygın İngilizce/kısa
 * kodlar da var. Karşılaştırma büyük/küçük harf ve nokta duyarsız.
 */
const OYNANMADI = [
  "ert",        // Ertelendi
  "erteledi",
  "iptal",      // İptal
  "tatil",      // Tatil edildi
  "t.e",        // T.E. (tatil edildi kısaltması)
  "hukmen",     // Hükmen
  "hükmen",
  "pst",        // postponed
  "post",
  "abd",        // abandoned
  "aban",
  "canc",       // cancelled
  "susp",       // suspended
  "int",        // interrupted
  "awd",        // awarded (hükmen)
  "wo",         // walkover
];

/**
 * Metni karşılaştırma için sadeleştirir.
 *
 * ⚠️ TÜRKÇE `İ` TUZAĞI. İlk sürüm yalnızca `toLowerCase()` yapıyordu ve
 * "İptal" EŞLEŞMİYORDU: `"İ".toLowerCase()` düz `i` değil, `i` + birleşik
 * nokta (U+0307) üretir, yani `"i̇ptal".startsWith("iptal")` false. Ölçümde
 * yakalandı — iptal edilen maç hâlâ "bitti" sayılıyordu.
 *
 * NFD'ye ayırıp birleşik işaretleri atmak hem bunu hem `ü`/`ğ`/`ş` gibi
 * harfleri çözüyor; noktasız `ı`nın birleşik işareti olmadığı için ayrıca
 * eşleniyor.
 */
function sadelestir(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ı/g, "i")
    .toLowerCase()
    .replace(/[.\s']/g, "")
    .trim();
}

/**
 * Durum metni "oynanmadı/yarıda kaldı" diyor mu?
 *
 * ⚠️ KISALTMALAR KAÇIYORDU — EŞLEŞME TEK YÖNLÜYDÜ.
 *
 * Eski kural yalnızca `gelen.startsWith(anahtar)` idi. Ama kaynak tam kelime
 * değil ÜÇ HARFLİK ROZET basıyor: "ERT", "İPT", "TAT", "HÜK". "ERT" tesadüfen
 * çalışıyordu (listede kısaltma olarak zaten vardı); ötekiler çalışmıyordu,
 * çünkü "ipt".startsWith("iptal") false.
 *
 * ÖLÇÜLDÜ (gerçek data/livescore-cache.json, 76 tekil durum metni):
 *     "ERT"  6 maç → oynanmadı ✓
 *     "İPT"  2 maç → oynanmadı ✗  (bitmiş sayılıyordu)
 * `bittiMi("match-not-play", "İPT")` TRUE dönüyordu, yani İPTAL EDİLEN maç
 * `FT` damgası alıp settle'a giriyor ve gerçek skoru üzerinden LC ödeniyordu.
 * Dosyanın kendi başlığı tam bu zinciri anlatıyor.
 *
 * ÇÖZÜM: eşleşme çift yönlü, ama gelen metin EN AZ 3 HARF olmak şartıyla.
 * Şart olmasaydı "İY" (ilk yarı) ya da "MS" (maç sonu) gibi iki harfli
 * rozetler anahtarların önekine denk gelip maçı yanlışlıkla "oynanmadı"
 * sayabilirdi — kapalı tarafa hata burada da bedava değil: bitmiş maçın
 * ödemesi 48 saat gecikir.
 */
function oynanmadiMi(statusText) {
  const t = sadelestir(statusText);
  if (!t) return false;
  return OYNANMADI.some((ham) => {
    const k = sadelestir(ham);
    if (!k) return false;
    if (t.startsWith(k)) return true;              // "iptal edildi" → "iptal"
    return t.length >= 3 && k.startsWith(t);       // "ipt" → "iptal"
  });
}

/**
 * Satır sınıfı + HAM durum metninden bitmişlik.
 *
 * `finished` sınıfı açık ve kesin — olduğu gibi kabul edilir.
 * `match-not-play` belirsiz: yalnızca durum metni oynanmadığını SÖYLEMİYORSA
 * bitmiş sayılır.
 */
function bittiMi(cls, statusText) {
  const c = String(cls || "");
  if (/\bfinished\b/.test(c)) return true;
  if (!/match-not-play/.test(c)) return false;
  return !oynanmadiMi(statusText);
}

module.exports = { bittiMi, oynanmadiMi, OYNANMADI };
