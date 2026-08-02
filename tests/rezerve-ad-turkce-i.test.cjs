"use strict";

/**
 * NOKTALI BÜYÜK İ, REZERVE AD VE BENZERSİZLİK KONTROLÜNÜ DELİYORDU.
 *
 * ⚠️ ÖLÇÜLDÜ (2026-08-02, canlı uca istek atarak):
 *     POST /api/users/set-nickname {"nickname":"YÖNETİCİ"} -> 200 KABUL
 *     POST /api/users/set-nickname {"nickname":"yonetici"} -> 409 REZERVE
 * Aynı kelime, biri geçiyor biri geçmiyor.
 *
 * KÖK NEDEN: `normNick` `.toLowerCase()` ile BAŞLIYOR, `.replace(/İ/g,"i")`
 * ondan SONRA geliyordu. Ama JavaScript'te `"İ".toLowerCase()` düz bir "i"
 * üretmez — İKİ kod noktası üretir: "i" + U+0307 (birleşik nokta). Sonraki
 * replace artık eşleşecek bir İ bulamıyor:
 *
 *     "YÖNETİCİ" -> "yoneti̇ci̇"  (79 6f 6e 65 74 69 [307] 63 69 [307])
 *     "yonetici" -> "yonetici"
 *
 * ⚠️ İKİ AYRI ETKİ, İKİSİ DE TAKLİT:
 *   1) REZERVE AD: `ADMİN`, `SİSTEM`, `YÖNETİCİ` kabul ediliyordu — oysa
 *      liste tam olarak personel taklidini önlemek için var. TÜRKÇE bir
 *      uygulamada bu doğrudan sömürülebilir bir açık.
 *   2) BENZERSİZLİK: aynı fonksiyon `isNicknameTaken` için de kullanılıyor,
 *      yani `ALİ` ile `ali` FARKLI normalize oluyor ve görsel olarak aynı ad
 *      iki kişide birden durabiliyordu.
 *
 * ⚠️ ÜRETİMDEKİ ESKİ KAYITLARA DOKUNULMADI (migration çalıştırılmadı).
 * Yerel aynada birleşik işaret içeren normalize kayıt yok (841 kullanıcı,
 * 0 eşleşme) ama üretimde varsa eski hâlinde kalır; düzeltme ileriye dönük.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");

/* Fonksiyon dışa aktarılmıyor; kaynaktan alınıyor ki test GERÇEK kodu
 * ölçsün. Kopyalasaydım kendi kopyamı sınardım — bugün bir kez o tuzağa
 * düşülmüştü (mini-bot-odul-suzgeci). */
function normNickAl() {
  const src = fs.readFileSync(path.join(KOK, "routes", "users.cjs"), "utf8");
  const m = src.match(/function normNick[\s\S]*?\n\}/);
  assert.ok(m, "normNick bulunamadi — kaynak bicimi degismis, test bir sey olcmuyor");
  return new Function("return " + m[0])();
}

const REZERVE = (() => {
  const src = fs.readFileSync(path.join(KOK, "routes", "users.cjs"), "utf8");
  const m = src.match(/const RESERVED_NICKNAMES = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(m, "rezerve liste bulunamadi");
  return new Set([...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
})();

describe("rezerve ad — Türkçe noktalı İ", () => {
  test("kurulum sınandı: liste ve fonksiyon okunabildi", () => {
    assert.ok(REZERVE.size >= 10, `rezerve listede ${REZERVE.size} ad — tarama bozuk`);
    assert.ok(REZERVE.has("yonetici") && REZERVE.has("admin"), "beklenen adlar listede yok");
    assert.equal(typeof normNickAl(), "function");
  });

  test("BÜYÜK harfli Türkçe yazımlar da rezerveye düşer", () => {
    const n = normNickAl();
    /* Kusurun ta kendisi: bunların hepsi KABUL ediliyordu. */
    for (const [girdi, beklenen] of [
      ["YÖNETİCİ", "yonetici"], ["ADMİN", "admin"], ["SİSTEM", "sistem"],
      ["Yönetici", "yonetici"], ["AdMİn", "admin"], ["DESTEK", "destek"],
    ]) {
      assert.equal(n(girdi), beklenen, `"${girdi}" -> "${n(girdi)}" (beklenen "${beklenen}")`);
      assert.ok(REZERVE.has(n(girdi)), `"${girdi}" rezerveye DUSMUYOR — personel taklidi mumkun`);
    }
  });

  test("normalize sonuç BİRLEŞİK İŞARET içermez", () => {
    /**
     * ⚠️ ASIL İDDİA BU. Kusur "yanlış harf" değil, GÖRÜNMEZ bir kod noktası
     * eklenmesiydi: "admi̇n" ekranda "admin" gibi görünür ama eşleşmez.
     * Sonuç birleşik işaret taşımadığı sürece hem rezerve hem benzersizlik
     * kontrolü güvenilir.
     */
    const n = normNickAl();
    for (const girdi of ["YÖNETİCİ", "ADMİN", "İİİ", "Şule", "ÇAĞRI", "ÖZGÜR", "İsmail"]) {
      const c = n(girdi);
      assert.ok(!/[̀-ͯ]/.test(c),
        `"${girdi}" -> "${c}" BIRLESIK ISARET tasiyor (${[...c].map((x) => x.charCodeAt(0).toString(16)).join(" ")})`);
    }
  });

  test("BENZERSİZLİK: görsel olarak aynı ad aynı anahtara düşer", () => {
    /* İkinci etki: `ALİ` ile `ali` farklı normalize olsaydı ikisi birden
     * alınabilir, yani taklit yine mümkün olurdu. */
    const n = normNickAl();
    for (const [a, b] of [["ALİ", "ali"], ["İSMAİL", "ismail"], ["ŞULE", "sule"], ["ÇAĞRI", "cagri"]]) {
      assert.equal(n(a), n(b), `"${a}" ve "${b}" FARKLI normalize oluyor — ayni ad iki kisiye verilebilir`);
    }
  });

  test("normal adlar bozulmadan geçer", () => {
    const n = normNickAl();
    assert.equal(n("normalad"), "normalad");
    assert.equal(n("Kerem_23"), "kerem_23");
    assert.ok(!REZERVE.has(n("Kerem_23")), "normal ad rezerveye dusuyor — kullanicilar kilitlenirdi");
  });

  test("sıra korunuyor: İ dönüşümü toLowerCase'DEN ÖNCE", () => {
    /* ⚠️ Kusur tam olarak SIRA hatasıydı. Biri "sadeleştireyim" diye
     * toLowerCase'i başa alırsa kusur aynen geri gelir. */
    const src = fs.readFileSync(path.join(KOK, "routes", "users.cjs"), "utf8");
    const govde = src.match(/function normNick[\s\S]*?\n\}/)[0];
    const iIdx = govde.indexOf("/İ/g");
    const lowIdx = govde.indexOf(".toLowerCase()");
    assert.ok(iIdx !== -1 && lowIdx !== -1, "beklenen adimlar yok");
    assert.ok(iIdx < lowIdx,
      "toLowerCase, I donusumunden ONCE calisiyor — kusur geri geldi (I -> i + U+0307)");
  });
});
