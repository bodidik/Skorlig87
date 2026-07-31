"use strict";

/**
 * EKRANDA YAZAN ÖDÜL, CÜZDANA GEÇENLE AYNI OLMALI.
 *
 * ⚠️ BULUNAN: `routes/daily-picks.cjs` kullanıcıya gösterdiği LC ödülünü
 * ödemeyle İLGİSİZ bir formülle hesaplıyordu — `Math.round(10 * ham_oran)` —
 * oysa ödemeyi `settle2` yapıyor ve sabit bir merdivenden en fazla 15 LC
 * veriyor.
 *
 * ÖLÇÜLDÜ (ekranda yazan → cüzdana geçen):
 *     Galatasaray–Fenerbahçe (dep)    38 LC → ≤15   (2.5 kat)
 *     Beşiktaş–Trabzonspor  (dep)     51 LC → ≤15   (3.4 kat)
 *     Real Madrid–Erokspor  (dep)   3009 LC → ≤15   (200 kat)
 *
 * Kök neden: puanlama ham oranı [0.34, 4.0] aralığına SIKIŞTIRIYOR
 * (`services/match-weights.cjs` oddsMultiplier), gösterim sıkıştırmıyordu.
 * settle2'nin kendi yorumu zaten "tahmin ekranının puan önizlemesi de aynı
 * fonksiyonları kullanıyor" diyordu — daily-picks o zinciri hiç kullanmıyordu.
 *
 * ⚠️ İKİNCİ HAYALET: `allCorrectBonus` alanı "4/4 → +N LC" rozeti olarak
 * gösteriliyordu ama sunucuda dörtlüyü ödeyen hiçbir yol yok (settle2'nin tek
 * bonusu `streak_bonus`). Ayrıca dörtlü ekranı ödülleri `QUAD_BONUS_MULTIPLIER`
 * ile çarpıyordu — ödeme maç başına tek tek yapıldığı için o çarpanın da
 * karşılığı yoktu.
 */

const test = require("node:test");
const describe = require("node:test").describe;
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");

const MW = require("../services/match-weights.cjs");
const { macOdulu, SONUC_TABAN_PUAN } = require("../lib/ekonomi.cjs");
const { calcOdds } = require("../services/odds-engine.cjs");

/**
 * ⚠️ ROTANIN GERÇEK FONKSİYONU — kopya DEĞİL.
 *
 * İlk sürümde bu satır `macOdulu(SONUC_TABAN_PUAN * MW.oddsMultiplier(...))`
 * diye teste kopyalanmıştı ve negatif kontrol yakaladı: rotadaki formülü eski
 * ham-oran hâline çevirmek testi KIRMIYORDU — test kendi kopyasını ölçüyordu.
 * Aynı tuzağa bu turda ikinci düşüş (turnuva ödemesinde de olmuştu).
 */
const sonucOdulu = require("../routes/daily-picks.cjs")._sonucOdulu;

const MACLAR = [
  ["Galatasaray", "Fenerbahce"],
  ["Besiktas", "Trabzonspor"],
  ["Kasimpasa", "Alanyaspor"],
  ["Real Madrid", "Erokspor"],
  ["Erokspor", "Real Madrid"],
  ["Bilinmeyen A", "Bilinmeyen B"],
];

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("merdiven ve çarpan gerçekten çalışıyor", () => {
    assert.equal(macOdulu(0), 0);
    assert.ok(macOdulu(3) > 0, "3 puan hic odul vermiyor — merdiven bozuk");
    assert.ok(SONUC_TABAN_PUAN > 0, "taban puan sifir — test bir sey olcmuyor");
    assert.ok(MW.oddsMultiplier("Galatasaray", "Fenerbahce", "H") > 0);
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("vaat = ödeme", () => {
  test("gösterilen ödül ödeme tavanını AŞMIYOR", () => {
    const TAVAN = macOdulu(Number.MAX_SAFE_INTEGER);   // merdivenin en üstü
    assert.ok(TAVAN > 0 && TAVAN < 1000, `merdiven tavani beklenmedik: ${TAVAN}`);

    const asan = [];
    for (const [h, a] of MACLAR) {
      for (const oc of ["H", "D", "A"]) {
        const vaat = sonucOdulu(h, a, oc);
        if (vaat > TAVAN) asan.push(`${h}-${a} ${oc}: ${vaat} > ${TAVAN}`);
      }
    }
    assert.deepStrictEqual(asan, [], "Gosterilen odul odenebilecek tavani asiyor:\n" + asan.join("\n"));
  });

  test("ESKİ formül tavanı aşıyordu (bulgunun büyüklüğü)", () => {
    /**
     * Düzeltmeyi değil, açığın neden önemli olduğunu ölçüyor. Fark küçük
     * olsaydı bulgu da küçük olurdu.
     */
    const eski = (oran) => Math.round(10 * oran);
    const TAVAN = macOdulu(Number.MAX_SAFE_INTEGER);
    let enBuyukKat = 0;
    for (const [h, a] of MACLAR) {
      const o = calcOdds(h, a);
      for (const oran of [o.home, o.draw, o.away]) {
        enBuyukKat = Math.max(enBuyukKat, eski(oran) / TAVAN);
      }
    }
    assert.ok(
      enBuyukKat >= 100,
      `eski formul tavani yalnizca ${enBuyukKat.toFixed(1)} kat asiyordu — ` +
      "aciklamadaki '200 kat' bayatlamis olabilir"
    );
  });

  test("ödül ham orana değil SIKIŞTIRILMIŞ çarpana bağlı", () => {
    /**
     * Aynı takım çifti için ham oran 300'e çıkabiliyor ama `oddsMultiplier`
     * [0.34, 4.0] aralığına sıkıştırıyor. Gösterim ham oranı kullanırsa bu
     * test kırılır.
     */
    const o = calcOdds("Real Madrid", "Erokspor");
    assert.ok(o.away > 100, `ham oran beklenenden kucuk (${o.away}) — olcum bayat`);
    assert.ok(
      sonucOdulu("Real Madrid", "Erokspor", "A") <= macOdulu(SONUC_TABAN_PUAN * 4.0),
      "gosterim ham orani kullaniyor"
    );
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

/** Yorumları boşaltır. */
function kodu(p) {
  return fs.readFileSync(p, "utf8")
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");
}

test("NÖBETÇİ: gösterim kendi ödül formülünü kurmuyor", () => {
  const src = kodu(path.join(KOK, "routes", "daily-picks.cjs"));
  assert.ok(/macOdulu|sonucOdulu/.test(src), "gosterim ortak zinciri kullanmiyor");
  assert.ok(
    !/lcReward\s*\(/.test(src),
    "`lcReward(BASE_LC, odds)` geri gelmis — odeme ile ilgisiz formul"
  );
  assert.ok(
    !/QUAD_BONUS_MULTIPLIER/.test(src),
    "dortlu carpani geri gelmis — settle2 dortlu diye fazla odemiyor"
  );
});

test("NÖBETÇİ: ödeme merdiveni tek yerde", () => {
  /**
   * Merdiven `lib/ekonomi.cjs`'e taşındı. İkinci bir kopya, gösterim ile
   * ödemenin yeniden ayrışması demektir — bulgunun kök nedeni tam buydu.
   */
  const kusurlu = [];
  for (const alt of ["routes", "lib", "services"]) {
    const d = path.join(KOK, alt);
    if (!fs.existsSync(d)) continue;
    for (const dosya of fs.readdirSync(d)) {
      if (!dosya.endsWith(".cjs")) continue;
      if (`${alt}/${dosya}` === "lib/ekonomi.cjs") continue;      // tek kaynak
      const src = kodu(path.join(d, dosya));
      // Merdivenin imzası: `>= 30` ve `>= 20` aynı dosyada, dönüş değerleriyle.
      if (/base\s*>=\s*30/.test(src) && /base\s*>=\s*20/.test(src)) {
        kusurlu.push(`${alt}/${dosya}`);
      }
    }
  }
  assert.deepStrictEqual(
    kusurlu, [],
    "Odul merdiveni kopyalanmis — gosterim ile odeme yeniden ayrisir:\n" + kusurlu.join("\n")
  );
});

test("NÖBETÇİ: hayalet dörtlü bonusu geri gelmedi", () => {
  const src = kodu(path.join(KOK, "routes", "daily-picks.cjs"));
  const m = /allCorrectBonus:\s*([^,\n]+)/.exec(src);
  assert.ok(m, "allCorrectBonus alani kaldirilmis — istemci sozlesmesi bozulur");
  assert.equal(
    m[1].trim(), "0",
    "dortlu bonusu yine hesaplaniyor; sunucuda odeyen yol yok (settle2'nin tek bonusu streak_bonus)"
  );

  // Dayanak: gerçekten dörtlü ödeyen bir yol var mı?
  const settle = kodu(path.join(KOK, "routes", "settle2.cjs"));
  const bonusSebepleri = [...settle.matchAll(/reason:\s*"([a-z_0-9]*bonus[a-z_0-9]*)"/g)].map((x) => x[1]);
  assert.ok(bonusSebepleri.length > 0, "settle2'de hic bonus bulunamadi — tarama bozuk");
  assert.ok(
    !bonusSebepleri.some((s) => /quad|dortlu|all_correct/.test(s)),
    `settle2 artik dortlu bonusu oduyor (${bonusSebepleri}) — alan yeniden doldurulabilir`
  );
});
