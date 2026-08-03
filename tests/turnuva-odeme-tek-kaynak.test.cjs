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

  test("NÖBETÇİ: settle2'de PUANLAMA kopyası da yok", () => {
    /**
     * ⚠️ AYNI FONKSİYONDA İKİNCİ KOPYA. Ödeme hesabıyla birlikte puanlama
     * döngüsü de burada yaşıyordu ve servis tarafıyla AYRIŞMIŞTI:
     *     servis : t.fixtures.find(...)          → alan yoksa TypeError
     *     settle2: (t.fixtures || []).find(...)  → tolere eder
     * Yani aynı turnuva, hangi yoldan sonuçlandığına göre ya puanlanıyor ya
     * patlıyordu.
     */
    const src = kodSatirlari(path.join("routes", "settle2.cjs"));
    const bas = src.indexOf("tryAutoSettleTournaments");
    const govde = src.slice(bas);
    assert.ok(!/Math\.round\(\s*10\s*\*/.test(govde),
      "settle2 puanlamayi kendi hesabiyla yapiyor — kopya geri geldi");
    assert.ok(!/calcOdds\(/.test(govde),
      "settle2 odds'u kendi hesapliyor — puanlama tek kaynakta degil");
    assert.ok(/puanlariHesapla\(/.test(govde),
      "settle2 ortak puanlamayi kullanmiyor");
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
    assert.ok(/puanlariHesapla\(t,/.test(govde), "settle() ortak puanlamayi kullanmiyor");
    assert.ok(!/Math\.round\(\s*10\s*\*/.test(govde), "settle() kendi puanlamasina donmus");
  });
});

describe("turnuva puanlaması — tek kaynak", () => {
  const { calcOdds } = require(path.join(KOK, "services", "odds-engine.cjs"));

  /** İki maçlık örnek turnuva. */
  function turnuva(ekle = {}) {
    return {
      fixtureIds: ["f1", "f2"],
      fixtures: [
        { fixtureId: "f1", home: "Manchester City", away: "Ipswich Town" },
        { fixtureId: "f2", home: "Galatasaray", away: "Fenerbahçe" },
      ],
      participants: [
        { userId: "dogruIki", predictions: { f1: { outcome: "H" }, f2: { outcome: "A" } } },
        { userId: "dogruBir", predictions: { f1: { outcome: "A" }, f2: { outcome: "A" } } },
        { userId: "hicbiri", predictions: { f1: { outcome: "D" }, f2: { outcome: "D" } } },
      ],
      ...ekle,
    };
  }
  const SONUC = { f1: { outcome: "H" }, f2: { outcome: "A" } };

  test("kurulum sınandı: örnek GERÇEKTEN ayırt ediyor", () => {
    /* ⚠️ Üç katılımcı farklı sayıda doğru bilmeli; hepsi eşit çıkarsa
     * sıralama ve puan iddiaları hiçbir şey ölçmez. */
    const s = require(path.join(KOK, "services", "tournament.cjs"))
      .puanlariHesapla(turnuva(), SONUC);
    const puanlar = s.map((p) => p.totalScore);
    assert.equal(new Set(puanlar).size, 3, `puanlar ayrismiyor: ${puanlar.join(",")}`);
  });

  test("kural: doğru maç başına 10 × odds, yanlış 0", () => {
    const s = T.puanlariHesapla(turnuva(), SONUC);
    const bul = (id) => s.find((p) => p.userId === id).totalScore;

    const o1 = calcOdds("Manchester City", "Ipswich Town");
    const o2 = calcOdds("Galatasaray", "Fenerbahçe");
    assert.equal(bul("dogruIki"), Math.round(10 * o1.home) + Math.round(10 * o2.away));
    assert.equal(bul("dogruBir"), Math.round(10 * o2.away), "yalnizca dogru bilinen mac sayilmali");
    assert.equal(bul("hicbiri"), 0, "hic dogru bilmeyen 0 almali (ceza yok)");
  });

  test("ÖLÇÜLEN AYRIŞMA: `fixtures` alanı yoksa PATLAMAZ", () => {
    /**
     * ⚠️ İKİ KOPYANIN GERÇEK FARKI BUYDU. Servis kopyası `t.fixtures.find(...)`
     * yazıyordu ve alan yoksa TypeError atıyordu; settle2 kopyası
     * `(t.fixtures || [])` ile tolere ediyordu. Aynı turnuva, hangi yoldan
     * sonuçlandığına göre farklı davranıyordu.
     *
     * Doğru davranış tolere etmek: patlamak sonuçlandırmanın TAMAMINI
     * (ödeme dahil) düşürür, turnuva askıda kalır ve giriş bedelleri
     * kilitlenir.
     */
    const t = turnuva();
    delete t.fixtures;
    const s = T.puanlariHesapla(t, SONUC);
    // Varsayılan odds {home:2, draw:3, away:2} → doğru maç başına 20 puan
    assert.equal(s.find((p) => p.userId === "dogruIki").totalScore, 40);
    assert.equal(s.find((p) => p.userId === "hicbiri").totalScore, 0);
  });

  test("TERS RİSK: `predictions` taşımayan katılımcı 0 alır, patlatmaz", () => {
    /* ⚠️ İKİ kopya da burada TypeError atıyordu — tek bozuk katılımcı tüm
     * turnuvanın kapanmasını engellerdi. */
    const t = turnuva();
    t.participants.push({ userId: "bozuk" });
    const s = T.puanlariHesapla(t, SONUC);
    assert.equal(s.find((p) => p.userId === "bozuk").totalScore, 0);
    assert.equal(s.length, 4, "bozuk katilimci listeden dusmemeli");
  });

  test("sıralama puana göre AZALAN (ödeme sırası buna bağlı)", () => {
    /* ⚠️ Ödeme yüzdeleri sıraya göre veriliyor; ters sıra parayı sonuncuya
     * yazardı. */
    const s = T.puanlariHesapla(turnuva(), SONUC);
    for (let i = 1; i < s.length; i++) {
      assert.ok(s[i - 1].totalScore >= s[i].totalScore,
        `sira bozuk: ${s.map((p) => p.totalScore).join(",")}`);
    }
    assert.equal(s[0].userId, "dogruIki");
  });

  test("sonucu gelmemiş maç puanlanmaz (kısmi sonuç sızmasın)", () => {
    /* Yalnızca f1'in sonucu var; f2 doğru tahmin edilmiş olsa bile sayılmamalı. */
    const s = T.puanlariHesapla(turnuva(), { f1: { outcome: "H" } });
    const o1 = calcOdds("Manchester City", "Ipswich Town");
    assert.equal(s.find((p) => p.userId === "dogruIki").totalScore, Math.round(10 * o1.home));
    assert.equal(s.find((p) => p.userId === "dogruBir").totalScore, 0);
  });
});
