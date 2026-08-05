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

/* ⚠️ HESAP ARTIK KAYNAKTAN REGEX'LE OKUNMUYOR, ÜRETİM MODÜLÜ ÇAĞRILIYOR.
 * Eskiden `HOUSE_CUT_PCT` sayısı `routes/duels.cjs`ten okunup formül BURADA
 * yeniden yazılıyordu — yani test, üretimin kopyasını sınıyordu. 2026-08-05'te
 * kesinti kademeli tam sayıya çevrilince (bkz. lib/duello-kesinti.cjs) o kopya
 * sessizce YANLIŞ hesabı sınamaya devam ederdi. Artık aynı fonksiyon. */
const { duelloPaylari, MAX_STAKE } = require("../lib/duello-kesinti.cjs");

describe("düello para korunumu", () => {
  test("kurulum sınandı: üretim rotası bu hesabı kullanıyor", () => {
    assert.ok(/require\("\.\.\/lib\/duello-kesinti\.cjs"\)/.test(SRC),
      "duels.cjs kesinti modulunu kullanmiyor — test bir sey olcmuyor");
    assert.ok(!/HOUSE_CUT_PCT\s*=/.test(SRC),
      "duels.cjs hala kendi kesinti sabitini tasiyor — iki kural ayrisir");
  });

  test("ödül + kasa payı havuzu AŞMAZ (enflasyon yönü)", () => {
    /* ⚠️ İzinli aralığın ÖTESİ de taranıyor: MAX_STAKE yükselirse kademe
     * tablosunun hâlâ tutarlı olduğu burada görülür. */
    for (let s = 1; s <= 300; s++) {
      const { pot, houseCut, winAmount } = duelloPaylari(s);
      assert.ok(winAmount + houseCut <= pot,
        `bahis=${s}: odul ${winAmount} + kasa ${houseCut} > havuz ${pot}`);
    }
  });

  test("kazanan bahsinden AZ almaz (oyun anlamını yitirmesin)", () => {
    /* ⚠️ Kesinti bir gün havuzun yarısına çıkarsa kazanan kendi yatırdığından
     * az alır ve düello oynamak matematiksel olarak anlamsızlaşır. */
    for (const s of [1, 5, 10, 25, 100]) {
      const { winAmount } = duelloPaylari(s);
      assert.ok(winAmount > s, `bahis=${s}: kazanan ${winAmount} aliyor — yatirdigindan fazla olmali`);
    }
  });

  test("izinli aralıkta havuz TAM dağıtılıyor — yakma da yok", () => {
    /**
     * ⚠️ Eski iddia yalnızca "aşmaz" diyordu; eksik ödeme (LC yakma) serbestti.
     * `lib/pay-dagitim.cjs` notu bu yönün de bir kusur olduğunu ölçüyor
     * (turnuvada 1199 senaryoda 3 LC'ye kadar yakılmıştı).
     */
    for (let s = 1; s <= MAX_STAKE; s++) {
      const { pot, houseCut, winAmount } = duelloPaylari(s);
      assert.equal(houseCut + winAmount, pot,
        `bahis=${s}: kasa ${houseCut} + odul ${winAmount} != havuz ${pot}`);
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
