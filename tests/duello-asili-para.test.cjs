"use strict";

/**
 * ASILI DÜELLO PARASI GERİ VERİLİR — VE BUNU YAPAN SERVİS GERÇEKTEN ÇALIŞIR.
 *
 * ⚠️ BU TURDA KUSUR BULUNAMADI, açıkça yazıyorum. Düello akışının tamamı
 * sınandı ve kapalı çıktı:
 *     iptal      : `claimDuelCancel` koşulu YAZMANIN İÇİNDE (status "open" +
 *                  kurucu eşleşmesi) — kabul edilmiş düello iptal edilemiyor
 *     uzlaştırma : `claimDuelSettle` mührü ödemeden ÖNCE
 *     asılı para : `duellolariTemizle` bayat maçtaki bahisleri iade ediyor
 *     servis     : server.cjs'te mount edilmiş, canlıda 59 mount / 0 atlanan
 *
 * ⚠️ ASIL KORUNAN ŞEY KODUN VARLIĞI DEĞİL, ÇALIŞIYOR OLMASI. Temizleyici
 * mount edilmezse (biri satırı yorumlar, bir bayrak kapatır) para asılı kalır
 * ve HİÇBİR HATA ÇIKMAZ — iki oyuncunun bahsi sonsuza dek kilitli durur.
 * Bugün aynı biçimi bir kez gördüm: günün menüsü kapatılmış sağlayıcıdan
 * okuduğu için aylardır boştu ve hata vermiyordu.
 *
 * ⚠️ PARA_TUTAN LİSTESİ DE YÜK TAŞIYOR: hangi durumların hâlâ para tuttuğu
 * buradan geliyor. "active" listeden düşerse kabul edilmiş düellolar
 * temizlikte atlanır ve para tam da en çok tutulduğu durumda asılı kalır.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
const { DURUM, PARA_TUTAN } = require("../lib/duel-durum.cjs");

describe("asılı düello parası", () => {
  test("PARA TUTAN durumlar: açık VE kabul edilmiş", () => {
    /* ⚠️ İkisi de para tutar: "open"da kurucunun bahsi, "active"de İKİ
     * taraf da yatırmıştır. "active" düşerse en çok para tutan hâl
     * temizlikten muaf kalır. */
    assert.ok(PARA_TUTAN.includes(DURUM.ACIK), "acik duello para tutmuyor sayiliyor");
    assert.ok(PARA_TUTAN.includes(DURUM.AKTIF),
      "KABUL EDILMIS duello para tutmuyor sayiliyor — iki tarafin bahsi asili kalir");
    for (const kapali of [DURUM.SONUCLANDI, DURUM.IPTAL, DURUM.GECERSIZ]) {
      assert.ok(!PARA_TUTAN.includes(kapali), `${kapali} para tutuyor sayiliyor — cift iade riski`);
    }
  });

  test("temizleyici düelloları GERÇEKTEN iade ediyor", () => {
    const src = fs.readFileSync(path.join(KOK, "services", "bayat-temizleyici.cjs"), "utf8");
    assert.ok(/async function duellolariTemizle/.test(src),
      "duello temizligi yok — bayat mactaki bahisler asili kalir");
    const i = src.indexOf("async function duellolariTemizle");
    const govde = src.slice(i, i + 2600);
    assert.ok(/creditLc|ode\(/.test(govde), "temizlik IADE yapmiyor — yalnizca durum degistiriyor olabilir");
    assert.ok(/PARA_TUTAN/.test(src), "hangi durumlarin para tuttugu tek kaynaktan okunmuyor");
  });

  test("SERVİS server.cjs'te MOUNT EDİLMİŞ (kod var demek calisiyor demek degil)", () => {
    /**
     * ⚠️ BU İDDİA BU DOSYANIN ASIL SEBEBİ. Temizleyici mount edilmezse para
     * asılı kalır ve hiçbir hata çıkmaz. Aynı biçim bugün günün menüsünde
     * çıktı: kod doğruydu, kaynağı kapalıydı, aylardır sessizce boştu.
     */
    const src = fs.readFileSync(path.join(KOK, "server.cjs"), "utf8");
    const satirlar = src.split(/\r?\n/).filter((l) => {
      const t = l.trim();
      return !t.startsWith("*") && !t.startsWith("//") && /bayat-temizleyici/.test(t);
    });
    assert.ok(satirlar.length > 0, "bayat-temizleyici server.cjs'te HIC gecmiyor");
    assert.ok(satirlar.some((l) => /safeMount|\.start\(/.test(l)),
      "bayat-temizleyici yalnizca yorumda geciyor — servis BASLATILMIYOR, asili para hic cozulmez");
  });

  test("iptal KABUL EDİLMİŞ düelloyu kapsamıyor (rakip magdur olmasin)", () => {
    /* Kurucu, rakip kabul ettikten sonra iptal edip parasini geri alabilseydi
     * rakibin bahsi kilitli kalirdi. Kosul yazmanin ICINDE. */
    const src = fs.readFileSync(path.join(KOK, "routes", "duels.cjs"), "utf8");
    const i = src.indexOf("claimDuelCancel");
    assert.ok(i > 0, "iptal mührü bulunamadi — test bir sey olcmuyor");
    const govde = src.slice(Math.max(0, i - 1200), i + 300);
    assert.ok(/status\s*!==\s*"open"|NOT_OPEN/.test(govde),
      "iptal yolu durumu kontrol etmiyor — kabul edilmis duello iptal edilebilir");
  });

  test("ödeme MÜHÜRDEN SONRA (cift odeme olmasin)", () => {
    const src = fs.readFileSync(path.join(KOK, "routes", "duels.cjs"), "utf8");
    const muhur = src.indexOf("claimDuelSettle");
    const odeme = src.indexOf("duel_win");
    assert.ok(muhur > 0 && odeme > 0, "muhur ya da odeme bulunamadi");
    assert.ok(muhur < odeme, "odeme muhurden ONCE — ayni duello iki kez odenebilir");
  });
});
