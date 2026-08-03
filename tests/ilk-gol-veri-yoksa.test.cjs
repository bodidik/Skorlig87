"use strict";

/**
 * İLK GOL BAHSİ: VERİ YOKKEN PUANLANMAZ.
 *
 * ⚠️ BULUNAN KUSUR (2026-08-03, routes/settle2.cjs): ilk gol kalemi verinin
 * gelip gelmediğine BAKMIYORDU. `fg` null iken karşılaştırma `"H" === ""`
 * olup daima yanlış çıkıyor ve oyuncu cezayı yiyordu.
 *
 * ÖLÇÜLDÜ (üretim, 1356 uzlaşmış maçın puan detayları):
 *     ilk gol kalemi yazılan tahmin : 14518
 *     ödül alan (>0)                :     0    ← tek bir tane bile yok
 *     ceza alan (<0)                : 14518 (%100)
 *     toplam kaybedilen puan        : -2891.6
 * Yani beceriyle KAZANILMASI İMKÂNSIZ bir bahisti. Aynı ölçümde diğer
 * kalemler: firstHalf %34.6, outcome %39.6, exact %8.0, redAny %12.0.
 *
 * SEBEP ZİNCİRİ: `st.firstGoal`ü yalnızca `services/af-sync.cjs` dolduruyor
 * (API-Football events) ve o kaynak askıda. Tahmin ekranı ise bahsi teklif
 * etmeye ve "kazanabileceğin puanı" göstermeye devam ediyor
 * (mobile app/(tabs)/predict.tsx:714).
 *
 * ⚠️ AYNI SAVUNMA KOMŞU KALEMDE VARDI: ilk yarı `hasHT` ile korunuyor. İlk gol
 * o korumayı almamıştı — bu deponun tekrar eden biçimi.
 *
 * UÇTAN UCA DOĞRULANDI (gerçek `scoreFixture`, üretim maçları, yazma yok):
 *     6 maç, önce 240 ceza (-48 puan) → sonra 0 kalem.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
const NL = String.fromCharCode(10);

function kodSatirlari(rel) {
  return fs.readFileSync(path.join(KOK, rel), "utf8")
    .split(/\r?\n/)
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    });
}

const SETTLE2 = path.join("routes", "settle2.cjs");

describe("ilk gol — veri yoksa puanlanmaz", () => {
  test("kurulum sınandı: ilk gol kalemi GERÇEKTEN puanlanıyor", () => {
    /* ⚠️ Bu olmadan iddia boş: kalem hiç puanlanmıyorsa "veri yokken
     * puanlanmaz" demek bir şey ölçmez. */
    const s = kodSatirlari(SETTLE2).join(NL);
    assert.ok(/detail\.firstGoal\s*=/.test(s), "ilk gol kalemi hic yazilmiyor");
    assert.ok(/pts \+= detail\.firstGoal/.test(s), "ilk gol puana eklenmiyor");
  });

  test("VERİ KAPISI VAR: fg bilinmiyorsa kalem hiç yazılmaz", () => {
    /**
     * ⚠️ ASIL KIRILGANLIK. Koşuldan `hasFG` çıkarılırsa kusur aynen geri gelir
     * ve HATA VERMEZ — yalnızca oyuncular kazanamayacakları bir bahiste puan
     * kaybeder. Ceza sessiz, tablo "çalışıyor" görünür.
     */
    const s = kodSatirlari(SETTLE2);
    const i = s.findIndex((l) => /detail\.firstGoal\s*=/.test(l));
    assert.ok(i > 0, "ilk gol blogu bulunamadi");
    const pencere = s.slice(Math.max(0, i - 6), i).filter((l) => l.trim() !== "");
    const kosul = pencere.find((l) => /if \(.*p\.firstGoal\)/.test(l));
    assert.ok(kosul, "ilk gol kosulu bulunamadi");
    assert.ok(/hasFG/.test(kosul),
      "ilk gol kosulu veriyi sinamiyor — veri yokken oyuncu daima ceza alir");
  });

  test("BOŞ DİZEYE DÜŞÜREN KARŞILAŞTIRMA KALMADI", () => {
    /**
     * ⚠️ KUSURUN TAM MEKANİĞİ: `String(fg || "")`. Veri yokken karşılaştırma
     * `"H" === ""` oluyordu — hata değil, sessizce YANLIŞ. Bu kalıp geri
     * gelirse kapı da anlamını yitirir.
     */
    const s = kodSatirlari(SETTLE2);
    const i = s.findIndex((l) => /detail\.firstGoal\s*=/.test(l));
    const govde = s.slice(Math.max(0, i - 4), i + 1).join(NL);
    assert.ok(!/String\(fg \|\| ""\)/.test(govde),
      "fg bos dizeye dusuruluyor — veri yoklugu 'yanlis tahmin' gibi puanlaniyor");
  });

  test("KOMŞU KALEM KORUMASINI KAYBETMEDİ (ilk yarı hâlâ hasHT'li)", () => {
    /* ⚠️ TERS RİSK: bu düzeltmeyi yaparken komşu kalemin korumasını bozmak,
     * kusuru yer değiştirmiş olurdu. `hasHT` bu blogun ÖNCEKİ hâliydi ve
     * doğru davranışın kanıtı. */
    const s = kodSatirlari(SETTLE2).join(NL);
    assert.ok(/if \(hasHT && p\.firstHalf\)/.test(s),
      "ilk yari veri korumasi kaybolmus");
  });

  test("SINIF NÖBETÇİSİ: puanlanan HER kalem veri kapısına sahip", () => {
    /**
     * ⚠️ ASIL DERS. Kusur tek bir kalemde değil, "yeni kalem eklerken veri
     * kapısını unutmak" alışkanlığındaydı. Kalemler ve kapıları:
     *   outcome    → skor her zaman var (maç FT ise zorunlu)
     *   exact      → hasScorePred + skor
     *   firstGoal  → hasFG        (bu düzeltme)
     *   firstHalf  → hasHT
     *   redAny     → yokluk "kırmızı yok" demek (ölçüldü: %12 ödül alıyor)
     *   penaltyAny → yokluk "penaltı yok" demek (ölçüldü: %14.7 ödül alıyor)
     * Kırmızı/penaltı bilinçli olarak kapısız: yokluk anlamlı bir varsayılan
     * ve İKİSİ DE gerçekten ödül dağıtıyor. İlk golde öyle değildi.
     */
    const s = kodSatirlari(SETTLE2).join(NL);
    for (const [kalem, kapi] of [["firstGoal", "hasFG"], ["firstHalf", "hasHT"], ["exact", "hasScorePred"]]) {
      const re = new RegExp(`if \\(${kapi} && p\\.${kalem}\\)|if \\(${kapi}\\)`);
      assert.ok(re.test(s), `${kalem} kalemi ${kapi} kapisini kullanmiyor`);
    }
  });
});
