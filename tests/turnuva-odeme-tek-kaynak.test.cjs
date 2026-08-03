"use strict";

/**
 * TURNUVA ÖDEMESİ TEK KAYNAKTAN — İKİ YOL AYNI SAYILARI ÜRETİR.
 *
 * ⚠️ BULUNAN KUSUR (2026-08-03): turnuva ödeme hesabının İKİ kopyası vardı:
 *   • services/tournament.cjs settle()          → düzeltilmiş (en büyük kalan)
 *   • routes/settle2.cjs tryAutoSettleTournaments → ESKİ kural:
 *         lcWon: Math.round(t.pool * pct)
 *
 * Üstelik CANLI yol kopyaydı: settle2 her maç sonuçlandığında otomatik
 * tetikleniyor ve mührü (claimTournamentSettle) neredeyse hep o alıyor; elle
 * çağrılan POST /tournaments/:code/settle nadir. Yani fazla-ödeme ve n=1
 * buharlaşma düzeltmeleri NADİR yolda, kusur CANLI yolda duruyordu.
 *
 * ÖLÇÜLDÜ (1536 senaryo, n=1..16 × giriş=5..100, kopyanın kuralıyla):
 *     %23.4 havuzdan FAZLA ödeme   ← yoktan LC (ör. 3×5=15 havuz → 11+5=16)
 *     %6.6  havuzdan EKSİK ödeme   ← yakılan LC (n=1 giriş=99 → 30 LC kayıp)
 *     %70.0 tam eşit
 * Ortak hesap (odemePaylari) 1536/1536 senaryoda havuza TAM eşit.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
const T = require(path.join(KOK, "services", "tournament.cjs"));

/** Yorum satırları soyulur — kusurun TARİHÇESİNİ anlatan yorum nöbetçiyi
 * tetiklememeli (ilk koşuda tam bu oldu: kendi açıklamamı yakaladım). */
function kodSatirlari(rel) {
  return fs.readFileSync(path.join(KOK, rel), "utf8")
    .split(/\r?\n/)
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");
}

describe("turnuva ödemesi — tek kaynak", () => {
  test("kurulum sınandı: ortak hesap GERÇEKTEN dışa açık ve pay üretiyor", () => {
    /* ⚠️ Bu olmadan iddialar boş: fonksiyon yoksa iki yol da onu kullanamaz. */
    assert.equal(typeof T.odemePaylari, "function", "odemePaylari disa acik degil");
    const { paylar } = T.odemePaylari(100, 4);
    assert.ok(Array.isArray(paylar) && paylar.length === 3, "4 kisilik tablo 3 kalem odemeli");
  });

  test("1536 senaryoda dağıtılan = havuz (ne yoktan LC ne yakma)", () => {
    /**
     * ⚠️ ASIL PARA KURALI. Eski kopya %23.4 senaryoda havuzdan FAZLA
     * ödüyordu — her turnuvada +1..+2 LC yoktan basılıyordu; n=1'de ise
     * havuzun %30'u kimseye gitmiyordu.
     */
    for (let n = 1; n <= 16; n++) {
      for (let giris = 5; giris <= 100; giris++) {
        const havuz = n * giris;
        const { paylar } = T.odemePaylari(havuz, n);
        const dagitilan = paylar.reduce((a, b) => a + b, 0);
        assert.equal(dagitilan, havuz,
          `n=${n} giris=${giris}: havuz ${havuz}, dagitilan ${dagitilan}`);
      }
    }
  });

  test("ölçülen örnekler: eski kuralın yanlış verdiği yerler doğru", () => {
    // 3×5=15 havuz: eski kural round(10.5)+round(4.5)=16 basıyordu.
    const uc = T.odemePaylari(15, 3);
    assert.deepEqual(uc.paylar, [11, 4], "en buyuk kalan: 11+4=15 olmali");
    // n=1: eski kural havuzun %70'ini verip %30'u buharlaştırıyordu.
    const bir = T.odemePaylari(50, 1);
    assert.deepEqual(bir.paylar, [50], "tek katilimci TUM havuzu almali");
  });

  test("sıra korunur: üst sıra hiçbir zaman alt sıradan az almaz", () => {
    /* ⚠️ TERS RİSK: en büyük kalan dağıtımı kesirleri dağıtırken sırayı
     * bozarsa 2. olan 1.'den çok kazanabilirdi — yarışın anlamı kalmazdı. */
    for (let n = 2; n <= 16; n++) {
      for (const havuz of [7, 23, 99, 1000]) {
        const { paylar } = T.odemePaylari(havuz, n);
        for (let i = 1; i < paylar.length; i++) {
          assert.ok(paylar[i - 1] >= paylar[i],
            `n=${n} havuz=${havuz}: ${i}. sira ${paylar[i - 1]} < ${i + 1}. sira ${paylar[i]}`);
        }
      }
    }
  });

  test("NÖBETÇİ: settle2'de ödeme hesabının KOPYASI yok", () => {
    /**
     * ⚠️ ASIL KIRILGANLIK VE KUSURUN KÖKÜ. Kopya bir kez ayrıştı ve düzeltme
     * canlı yola hiç ulaşmadı. Biri "küçük bir hesap, yerinde dursun" diye
     * geri koyarsa aynı ayrışma sessizce geri gelir.
     */
    const src = kodSatirlari(path.join("routes", "settle2.cjs"));
    const bas = src.indexOf("tryAutoSettleTournaments");
    assert.ok(bas > 0, "auto-settle bulunamadi — test bir sey olcmuyor");
    const govde = src.slice(bas);
    assert.ok(!/Math\.round\(\s*t\.pool\s*\*/.test(govde),
      "settle2 odemeyi kendi hesabiyla yuvarliyor — fazla odeme kusuru geri geldi");
    assert.ok(!/const PAYOUT_TABLE\s*=/.test(govde),
      "settle2 kendi odeme tablosunu tasiyor — tek kaynak bozuldu");
    assert.ok(/odemePaylari\(/.test(govde),
      "settle2 ortak hesabi (odemePaylari) kullanmiyor");
  });

  test("NÖBETÇİ: servis tarafı da aynı ortak hesabı kullanıyor", () => {
    /* İki yolun 'aynı sayılar' garantisi ancak ikisi de tek fonksiyona
     * bağlıyken var. Servis kendi kopyasına dönerse garanti tek yönlü kalır. */
    const src = kodSatirlari(path.join("services", "tournament.cjs"));
    const bas = src.indexOf("async function settle(");
    assert.ok(bas > 0, "settle bulunamadi");
    const govde = src.slice(bas, src.indexOf("async function getByCode"));
    assert.ok(/odemePaylari\(t\.pool/.test(govde), "settle() ortak hesabi kullanmiyor");
    assert.ok(!/Math\.round\(\s*t\.pool\s*\*/.test(govde), "settle() kendi yuvarlamasina donmus");
  });
});
