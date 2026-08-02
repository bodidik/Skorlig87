"use strict";

/**
 * TESTLERDE GEÇİCİ BAĞLANTI HATASINI BİR KEZ YENİDEN DENE.
 *
 * ⚠️ SÜİTİ ARADA BİR KIRAN İKİNCİ KUSUR BUYDU — dört tur kovalandı.
 *
 * Belirti: tam süit yükü altında (20 çekirdek, ~20 test dosyası paralel,
 * 64'ü bellek-içi Mongo + 38'i yerel HTTP sunucusu açıyor) rastgele bir
 * testin kendi sunucusuna attığı istek şu hatayla düşüyordu:
 *
 *     TypeError: fetch failed        (undici)
 *
 * ÖLÇÜLDÜ (2026-08-02): 8-10 tam koşuda 1 kırılma. Aynı hata dört ayrı
 * testte görüldü (mini-acik-turnuvalar, e2e-cekirdek-dongu,
 * arkadas-listesi-sizintisi, lc-wallet daily-claim) — yani tek bir testin
 * kusuru değil, süit genelinde bir yarış.
 *
 * ⚠️ İKİ HİPOTEZ ELENDİ, ÖLÇÜMLE:
 *   1) "Paralellik fazla" → eşzamanlılık 8'e düşürüldü, YİNE kırıldı
 *      (üstelik süre aynı kaldı, yani ücretsiz bir çözüm de değildi).
 *   2) "`listening` olayı beklenmiyor" → beklenen testlerden biri
 *      (`arkadas-listesi-sizintisi`, `listen`i await ediyor) yine kırıldı.
 * Geriye kalan: işletim sistemi düzeyinde geçici bağlantı hatası
 * (Windows'ta efemeral port / TIME_WAIT baskısı).
 *
 * ⚠️ GERÇEK HATAYI MASKELEMİYOR. Yalnızca BAĞLANTI kurulamamasında ve
 * YALNIZCA BİR KEZ yeniden deniyor; HTTP durum kodları (4xx/5xx) olduğu gibi
 * geçiyor, ikinci deneme de başarısızsa hata aynen fırlatılıyor. Yani bir uç
 * gerçekten bozuksa test yine kırılır.
 *
 * ⚠️ NEDEN TEK YERDE: aynı yamayı 38 test dosyasına elle koymak hem hataya
 * açık hem bakımı zor olurdu. `package.json` test betiği bu dosyayı her test
 * sürecine önyüklüyor.
 */

const asilFetch = globalThis.fetch;

/** Yalnızca bağlantı kurulamama hatası mı? (HTTP hataları buraya düşmez.) */
function baglantiHatasiMi(e) {
  if (!e) return false;
  const metin = `${e.name || ""} ${e.message || ""} ${e.cause?.code || ""} ${e.cause?.message || ""}`;
  return /fetch failed|ECONNREFUSED|ECONNRESET|EADDRNOTAVAIL|ETIMEDOUT|socket hang up/i.test(metin);
}

globalThis.fetch = async function (...args) {
  try {
    return await asilFetch.apply(this, args);
  } catch (e) {
    if (!baglantiHatasiMi(e)) throw e;
    // Kısa nefes: soket/port baskısının geçmesi için.
    await new Promise((r) => setTimeout(r, 60));
    return asilFetch.apply(this, args);
  }
};
