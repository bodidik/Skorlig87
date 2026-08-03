"use strict";

/**
 * TURNUVA HAVUZU TAM DAĞITILIR — TEK KATILIMCIDA BİLE.
 *
 * ⚠️ ÖLÇÜLDÜ (2026-08-02): n=1 turnuvada havuz 10 LC, dağıtılan 8, KAYIP 2 LC.
 * Tek katılımcı kendi giriş bedelinin %20'sini kaybediyordu.
 *
 * KÖK NEDEN: `PAYOUT_TABLE[1]` yok; kod `PAYOUT_TABLE[2]`ye ([0.70, 0.30])
 * düşüyor ve `table.slice(0, sorted.length)` onu tek kaleme indiriyor —
 * yüzdeler artık 0.70, yani havuzun %30'u kimseye gitmiyor. `settle` için
 * asgari katılımcı kapısı da yok, yani bu durum erişilebilir.
 *
 * ⚠️ KODUN KENDİ NOTU BU DURUMU YOK SAYIYORDU: "ödeme sayısı tablo uzunluğuna
 * eşit — n < tablo durumu yok, çünkü tablo katılımcı sayısına göre seçiliyor."
 * n>=2 için doğru; n=1 istisnası gözden kaçmış. Dilimleme satırının VARLIĞI
 * zaten o durumun mümkün olduğunu söylüyordu.
 *
 * ⚠️ TASARIMDA KASA PAYI YOK: n>=2'de yüzdeler her zaman 1.00'e toplanıyor
 * (düellodaki `houseCutPct` gibi bir kesinti turnuvada bulunmuyor). Yani bu
 * yakma bilinçli bir kesinti değil, ele alınmamış bir durumdu.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const T = require("../services/tournament.cjs");
const dagit = T._odemeDagit;
const TABLO = T._PAYOUT_TABLE;
const TABLO8 = T._PAYOUT_8PLUS;

/** settle içindeki tablo seçimiyle AYNI kural (services/tournament.cjs). */
const tabloSec = (n) => (n >= 8 ? TABLO8 : (TABLO[n] || TABLO[2]));

/** settle içindeki normalleştirmenin aynısı — davranışı burada da tutuyoruz. */
function normalle(kesik) {
  const t = kesik.reduce((a, b) => a + Number(b || 0), 0);
  return t > 0 && Math.abs(t - 1) > 1e-9 ? kesik.map((x) => Number(x || 0) / t) : kesik;
}

describe("turnuva havuz dağıtımı", () => {
  test("kurulum sınandı: tablolar okunabiliyor", () => {
    assert.ok(TABLO && TABLO[2] && Array.isArray(TABLO8), "odeme tablolari disa aktarilmamis");
    assert.equal(TABLO[1], undefined, "PAYOUT_TABLE[1] eklenmis — bu testin gerekcesi degismis, gozden gecir");
  });

  test("TEK katılımcı havuzun TAMAMINI alır", () => {
    const n = 1, havuz = 10;
    const pay = dagit(havuz, normalle(tabloSec(n).slice(0, n)));
    assert.deepEqual(pay, [10], `tek katilimci ${pay} aldi — kendi giris bedelinden kayip var`);
  });

  test("hiçbir katılımcı sayısında LC BUHARLAŞMAZ", () => {
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 13, 100]) {
      for (const giris of [5, 7, 10, 33, 100]) {
        const havuz = n * giris;
        const pay = dagit(havuz, normalle(tabloSec(n).slice(0, n)));
        const toplam = pay.reduce((a, b) => a + b, 0);
        assert.equal(toplam, havuz, `n=${n} giris=${giris}: havuz ${havuz}, dagitilan ${toplam}`);
      }
    }
  });

  test("hiçbir durumda havuz AŞILMAZ (enflasyon yönü)", () => {
    /* ⚠️ Normalleştirme yukarı doğru hata yaparsa yoktan LC üretir — bu yön
     * kayıptan daha kötü. `odemeDagit` en büyük kalan yöntemiyle tam sayıya
     * oturtuyor ve toplamı havuza eşitliyor; burada ayrıca tutuluyor. */
    for (let n = 1; n <= 60; n++) {
      for (const giris of [1, 3, 5, 9, 17]) {
        const havuz = n * giris;
        const toplam = dagit(havuz, normalle(tabloSec(n).slice(0, n))).reduce((a, b) => a + b, 0);
        assert.ok(toplam <= havuz, `n=${n} giris=${giris}: dagitilan ${toplam} > havuz ${havuz}`);
      }
    }
  });

  test("n>=2 dağılımları DEĞİŞMEDİ (gerileme yok)", () => {
    /**
     * ⚠️ Normalleştirme yalnızca yüzdeler 1.00 etmediğinde devreye girmeli.
     * n>=2'de zaten 1.00 ediyor; oraya dokunmak mevcut ödemeleri kaydırırdı.
     */
    assert.deepEqual(dagit(20, normalle(tabloSec(2).slice(0, 2))), [14, 6]);
    assert.deepEqual(dagit(50, normalle(tabloSec(5).slice(0, 5))), [30, 13, 7]);
    assert.deepEqual(dagit(80, normalle(tabloSec(8).slice(0, 8))), [40, 20, 12, 8]);
  });

  test("settle GERÇEKTEN normalleştiriyor (kaynak kapısı)", () => {
    /* ⚠️ Yukarıdaki testler kuralı yeniden yazıyor; bu iddia üretim kodunun
     * da aynısını yaptığını tutuyor. Bugün bir kez kendi kopyasını sınayan
     * sahte yeşil test bulunmuştu. */
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "..", "services", "tournament.cjs"), "utf8");
    /* GÜNCELLENDİ (2026-08-03): normalleştirme + odemeDagit çağrısı artık
     * `odemePaylari` içinde yaşıyor — settle2'deki İKİNCİ kopya ayrışıp canlı
     * yolda fazla-ödeme bırakınca hesap tek fonksiyona toplandı (bkz.
     * tests/turnuva-odeme-tek-kaynak.test.cjs). Korunan özellik aynı:
     * dağıtım NORMALLEŞTİRİLMİŞ tabloyla yapılmalı. */
    const i = src.indexOf("function odemePaylari(");
    assert.ok(i > 0, "odemePaylari bulunamadi — test bir sey olcmuyor");
    assert.ok(/odemePaylari\(t\.pool,\s*sorted\.length\)/.test(src),
      "settle() ortak hesabi (odemePaylari) kullanmiyor");
    /**
     * ⚠️ ÇAĞRININ KENDİSİNE BAK, değişkenin VARLIĞINA değil.
     *
     * İlk yazımım `yuzdeToplam`/`normalTablo` kaynakta GEÇİYOR MU diye
     * bakıyordu. Negatif kontrolde çağrıyı `odemeDagit(havuz, kesikTablo)`
     * yaptım — değişkenler yerinde durduğu için test YEŞİL KALDI, yani
     * kusuru hiç korumuyordu. Üstelik yukarıdaki testler normalleştirmeyi
     * KENDİ yeniden yazıyor; onlar da üretim yolunu sınamıyor.
     * Bugün boyunca uyardığım "sahte yeşil test" tuzağının aynısı.
     */
    assert.ok(/odemeDagit\([^,]+,\s*normalTablo\s*\)/.test(src),
      "odemeDagit NORMALLESTIRILMIS tablo ile cagrilmiyor — tek katilimcida havuz buharlasir");
  });
});
