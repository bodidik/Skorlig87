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

/**
 * ⚠️ TEK DENEME + 60ms YETMİYORDU. Bugünkü tam-süit koşusu 14 fetch failed
 * yakaladı (arkadas-listesi-sizintisi, baglanti-kesintisi-503,
 * board2-veri-sozlesmesi altında yayılmış). Belge tek deneme ile "kırılma
 * 8-10 kosuda 1" diyordu, üstelik sonrasında `mini-acik-turnuvalar` ve
 * `e2e-cekirdek-dongu` gibi başka testlerde de belge dışına çıktı.
 *
 * Windows TIME_WAIT süresi ~2 dk. 60ms nefes ephemeral port baskısı için
 * anlamlı bir zaman değil; ilk deneme başarısız olduğunda ikinci de aynı
 * anda başarısız oluyor. Üstel geri çekilme (60, 250, 1000ms) baskının
 * biraz azalmasına zaman tanıyor. 3 denemenin üzerine çıkmıyoruz: gerçek
 * bir hatanın uçları toplanabilir olsun. */
const GERI_CEKILME_MS = [60, 250, 1000];

/** Bir sonraki deneme icin ne kadar bekleyecegimizi bildirir; teshis kolaylığı. */
let _sonKod = null;
function _sonBaglantiHatasi() { return _sonKod; }

globalThis.fetch = async function (...args) {
  let sonHata;
  for (let i = 0; i <= GERI_CEKILME_MS.length; i++) {
    try {
      return await asilFetch.apply(this, args);
    } catch (e) {
      sonHata = e;
      if (!baglantiHatasiMi(e)) throw e;
      _sonKod = e?.cause?.code || e?.code || e?.message || "?";
      if (i === GERI_CEKILME_MS.length) break;
      await new Promise((r) => setTimeout(r, GERI_CEKILME_MS[i]));
    }
  }
  /* Son çare de başarısız — hatayı, gerçek `cause`u koruyarak fırlat.
   * Test raporunda "fetch failed" tek başına ne olduğunu söylemiyordu;
   * asıl `cause.code` (ECONNRESET / ECONNREFUSED / …) mesaja işlensin
   * ki bir daha bakan daha az koşum yapmadan sorunu görsün. */
  if (sonHata && sonHata.cause && !/ECONN|EADDR|ETIME|socket hang/i.test(sonHata.message)) {
    sonHata.message = `${sonHata.message} (cause=${sonHata.cause.code || sonHata.cause.message || sonHata.cause})`;
  }
  throw sonHata;
};

module.exports = { _sonBaglantiHatasi };
