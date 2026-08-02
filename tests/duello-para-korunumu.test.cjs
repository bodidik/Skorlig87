"use strict";

/**
 * DÜELLO PARASI KORUNUR — VE BERABERLİKTE KASA PAYI ALINMAZ.
 *
 * ⚠️ BU TURDA KUSUR BULUNAMADI, açıkça yazıyorum. Ölçülenler:
 *     1..200 bahis aralığında `winAmount + houseCut > pot` olan hiçbir değer yok
 *     beraberlik: iki tarafa da TAM iade, kesinti yok (routes/duels.cjs)
 *
 * ⚠️ AMA İKİSİ DE SESSİZCE BOZULUR. Yuvarlama yönü değişirse (yukarı) her
 * düelloda yoktan LC üretilir; beraberlikte kesinti uygulanırsa oyuncular her
 * berabere maçta %5 kaybeder ve HİÇBİR hata görünmez — bakiye biraz eksik olur,
 * o kadar. Bu yüzden nöbetçi.
 *
 * ⚠️ AYNI SINIFIN BUGÜNKÜ ÖRNEĞİ: turnuvada `PAYOUT_TABLE[1]` olmadığı için
 * tek katılımcı havuzun %20'sini kaybediyordu ve kodun kendi notu o durumun
 * "yok" olduğunu söylüyordu. Para yollarında "olamaz" denen durum sınanmalı.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(KOK, "routes", "duels.cjs"), "utf8");

/** Üretimdeki kesinti oranını KAYNAKTAN oku — kopyalamak testi bağımsızlaştırır
 *  ve oran değişince test sessizce eski değeri sınamaya devam ederdi. */
function houseCutPct() {
  const m = SRC.match(/const\s+HOUSE_CUT_PCT\s*=\s*([0-9.]+)/);
  assert.ok(m, "HOUSE_CUT_PCT bulunamadi — kaynak bicimi degismis, test bir sey olcmuyor");
  return Number(m[1]);
}

/** Üretimdeki hesabın aynısı (routes/duels.cjs pot/houseCut/winAmount). */
function hesapla(stake, pct) {
  const pot = stake * 2;
  const houseCut = Math.round(pot * pct * 10) / 10;
  const winAmount = Math.round((pot - houseCut) * 10) / 10;
  return { pot, houseCut, winAmount };
}

describe("düello para korunumu", () => {
  test("kurulum sınandı: kesinti oranı okunabiliyor", () => {
    const p = houseCutPct();
    assert.ok(p > 0 && p < 0.5, `HOUSE_CUT_PCT=${p} makul araligin disinda`);
  });

  test("ödül + kasa payı havuzu AŞMAZ (enflasyon yönü)", () => {
    const pct = houseCutPct();
    for (let s = 1; s <= 300; s++) {
      const { pot, houseCut, winAmount } = hesapla(s, pct);
      const toplam = Math.round((winAmount + houseCut) * 10) / 10;
      assert.ok(toplam <= pot, `bahis=${s}: odul ${winAmount} + kasa ${houseCut} = ${toplam} > havuz ${pot}`);
    }
  });

  test("kazanan bahsinden AZ almaz (oyun anlamını yitirmesin)", () => {
    /* ⚠️ Kesinti bir gün %50'ye çıkarsa kazanan kendi yatırdığından az alır
     * ve düello oynamak matematiksel olarak anlamsızlaşır. */
    const pct = houseCutPct();
    for (const s of [1, 5, 10, 25, 100]) {
      const { winAmount } = hesapla(s, pct);
      assert.ok(winAmount > s, `bahis=${s}: kazanan ${winAmount} aliyor — yatirdigindan fazla olmali`);
    }
  });

  test("BERABERLİKTE tam iade, kasa payı YOK", () => {
    /**
     * ⚠️ ASIL KORUNAN DAVRANIŞ. Beraberlikte kesinti uygulanırsa oyuncular
     * her berabere maçta sessizce kaybeder — hata çıkmaz, yalnızca bakiye
     * biraz eksilir. Kaynakta iki tarafa da `duel.stake` (bahsin TAMAMI)
     * iade ediliyor; `winAmount` değil.
     */
    const i = SRC.indexOf("duel_tie_refund");
    assert.ok(i > 0, "beraberlik iadesi bulunamadi — test bir sey olcmuyor");
    const govde = SRC.slice(Math.max(0, i - 400), i + 400);
    const iadeler = [...govde.matchAll(/duel_tie_refund/g)].length;
    assert.ok(iadeler >= 2, `beraberlikte ${iadeler} iade var — IKI taraf da geri almali`);
    assert.ok(/duel\.stake,\s*"duel_tie_refund"/.test(govde),
      "beraberlikte BAHSIN TAMAMI iade edilmiyor — kesinti uygulaniyor olabilir");
    assert.ok(!/winAmount[\s\S]{0,80}duel_tie_refund/.test(govde),
      "beraberlikte kesintili tutar iade ediliyor — tam iade olmali");
  });
});
