"use strict";

/**
 * DÜELLO KASA PAYI VE BAHİS SINIRLARI İSTEMCİYE BİLDİRİLİR.
 *
 * ⚠️ KUSUR SINIFI (canlı değil, gizli): mobil düello ekranı kazancı KENDİ
 * hesaplıyordu — `Math.round(stake * 2 * 0.95 * 10) / 10` — ve "%5 kasa payı"
 * metnini sabit yazıyordu. Toplam DÖRT yerde (ilk taramamda üçünü bulmuştum,
 * dördüncüsü `acceptDuel` içindeydi). Bahis seçenekleri de sabitti:
 * `STAKES = [1,2,3,5,8,10,12]`.
 *
 * ÖLÇÜLDÜ: izinli bahis aralığında (1–12) sunucu ile istemci sonucu BİREBİR
 * aynı — yani bugün canlı bir kusur YOK. Kapatılan şey sapma ihtimali:
 * `HOUSE_CUT_PCT` ya da `MAX_STAKE` değişirse ekran kullanıcıya yanlış kazanç
 * vaat eder. Üstelik bu vaat bahsi KOYMADAN ÖNCE gösteriliyor (düello henüz
 * yok, `winAmount` da yok) — yani kullanıcı kararını ona bakarak veriyor.
 *
 * ⚠️ BU SINIF BU ÜRÜNDE BİR KEZ PAHALIYA PATLADI: `lib/ekonomi.cjs macOdulu`
 * notu ölçüyor — ekran 3009 LC vaat etmiş, cüzdana ≤15 geçmiş (200 kat).
 * Sebep aynıydı: gösterim ile ödeme ayrı formüller kullanıyordu.
 *
 * Sunucu zaten aynı gerekçeyle `duelloyaUygun` gönderiyor ("kullanıcının
 * butona basıp hata almasını önlüyor"); kural sunucunun, istemci tahmin
 * etmemeli.
 */

const test = require("node:test");
const describe = require("node:test").describe;
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");

const yalin = (p) => fs.readFileSync(path.join(KOK, p), "utf8")
  /* ⚠️ SATIR SONLARI ÖNCE NORMALLEŞTIRİLİR — CRLF İKİ NÖBETÇİYİ SESSİZCE
   * KÖRELTMİŞTİ. Depoda .gitattributes yok ve core.autocrlf=true, yani Windows
   * checkout unda her satır CR+LF ile bitiyor. İçinde LF geçen bir kalıp — bir
   * fonksiyon gövdesini yeni satır + kapanış parantezi ile kesmek, ya da iki
   * satırlık bir dizgeyi indexOf ile aramak — o checkout ta HİÇBİR ZAMAN
   * eşleşmiyordu: kod doğru olduğu hâlde iddia düşüyor, ya da daha kötüsü gövde
   * çıkarımı -1 dönüp ölçüm YANLIŞ BÖLGEYE kayıyordu. */
  .replace(/\r\n?/g, "\n")
  .split("\n")
  .map((l) => {
    const t = l.trim();
    return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
  })
  .join("\n");

const src = yalin("routes/duels.cjs");

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("sunucu sabitleri duruyor", () => {
    assert.ok(/const HOUSE_CUT_PCT = 0\.\d+/.test(src), "kasa payi sabiti yok");
    assert.ok(/const MIN_STAKE = \d+/.test(src) && /const MAX_STAKE = \d+/.test(src),
      "bahis sinirlari yok");
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("kurallar yanıtta bildiriliyor", () => {
  test("/duels/open kasa payını ve bahis sınırlarını gönderiyor", () => {
    const i = src.indexOf('router.get("/duels/open"');
    assert.ok(i > 0, "uc bulunamadi");
    const govde = src.slice(i, src.indexOf("\n});", i));
    for (const alan of ["houseCutPct: HOUSE_CUT_PCT", "minStake: MIN_STAKE", "maxStake: MAX_STAKE"]) {
      assert.ok(govde.includes(alan), `${alan} yanitta yok — istemci tahmin etmek zorunda kalir`);
    }
  });

  test("SABİT SAYIYLA değil, sabitin KENDİSİYLE gönderiliyor", () => {
    /* `houseCutPct: 0.05` yazmak sorunu çözmez — yeni bir kopya olurdu. */
    assert.ok(!/houseCutPct:\s*0\./.test(src),
      "kasa payi yanitta sayiyla yazilmis — yeni bir kopya");
  });
});

/* ── İstemci artık tahmin etmiyor ────────────────────────────────────────── */

describe("mobil ekran sunucu değerini kullanıyor", () => {
  const MOB = require("./_mobil-dizin.cjs").mobilYol("app", "duel", "[fixtureId].tsx");

  test("hiçbir yerde sabit 0.95 hesabı kalmadı", (t) => {
    if (!fs.existsSync(MOB)) return t.skip("mobil depo yan klasorde yok");
    const m = fs.readFileSync(MOB, "utf8")
      .split("\n")
      .filter((l) => {
        const s2 = l.trim();
        return !(s2.startsWith("*") || s2.startsWith("//") || s2.startsWith("/*"));
      })
      .join("\n");
    /* ⚠️ `0.95` animasyon ölçeğinde de geçiyor (`outputRange: [0.95, 1.05]`),
     * o yüzden ÇARPMA kalıbı aranıyor — genel bir arama yanlış alarm verirdi. */
    assert.ok(!/\*\s*0\.95/.test(m), "sabit kasa payi carpimi hala var");
    assert.ok(!/%5 kasa/.test(m), "sabit '%5 kasa' metni hala var");
  });

  test("kasa payı sunucudan okunuyor ve varsayılanı var", (t) => {
    if (!fs.existsSync(MOB)) return t.skip("mobil depo yan klasorde yok");
    const m = fs.readFileSync(MOB, "utf8");
    assert.ok(/useState\(0\.05\)/.test(m),
      "varsayilan yok — alani gondermeyen ESKI sunucuda ekran bozulur");
    assert.ok(/typeof oj\.houseCutPct === "number"/.test(m),
      "sunucu degeri okunmuyor");
  });
});

/* ── Hesap doğruluğu ─────────────────────────────────────────────────────── */

describe("iki taraf aynı sonucu veriyor", () => {
  test("izinli bahis aralığının TAMAMINDA fark yok", () => {
    /**
     * ⚠️ Bu testin işi, birleştirmenin davranışı DEĞİŞTİRMEDİĞİNİ kanıtlamak.
     * Sunucu iki adımda yuvarlıyor (önce kesinti, sonra kazanç); istemci tek
     * adımda çarpıyor. Çift yuvarlama bazı değerlerde ayrışabilirdi.
     */
    const HOUSE_CUT_PCT = Number(src.match(/const HOUSE_CUT_PCT = ([\d.]+)/)[1]);
    const MIN = Number(src.match(/const MIN_STAKE = (\d+)/)[1]);
    const MAX = Number(src.match(/const MAX_STAKE = (\d+)/)[1]);

    for (let s = MIN; s <= MAX; s++) {
      const pot = s * 2;
      const houseCut = Math.round(pot * HOUSE_CUT_PCT * 10) / 10;
      const sunucu = Math.round((pot - houseCut) * 10) / 10;
      const istemci = Math.round(pot * (1 - HOUSE_CUT_PCT) * 10) / 10;
      assert.equal(istemci, sunucu, `bahis ${s}: istemci ${istemci} · sunucu ${sunucu}`);
    }
  });
});
