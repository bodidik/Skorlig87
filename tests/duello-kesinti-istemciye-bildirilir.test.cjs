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

const KESINTI = require("../lib/duello-kesinti.cjs");

describe("kurulum", () => {
  test("sunucu kuralı TEK KAYNAKTAN geliyor", () => {
    /* Sabitler 2026-08-05'te `lib/duello-kesinti.cjs`e taşındı; kesinti artık
     * yüzde değil kademeli tam sayı. Rota kendi kopyasına dönerse bu dosyanın
     * ölçtüğü şey kalmaz. */
    assert.ok(/require\("\.\.\/lib\/duello-kesinti\.cjs"\)/.test(src),
      "duels.cjs kesinti modulunu kullanmiyor");
    assert.ok(!/const HOUSE_CUT_PCT\s*=/.test(src),
      "duels.cjs hala kendi yuzde sabitini tasiyor");
    assert.ok(Number.isFinite(KESINTI.MIN_STAKE) && Number.isFinite(KESINTI.MAX_STAKE),
      "bahis sinirlari okunamadi");
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("kurallar yanıtta bildiriliyor", () => {
  test("/duels/open kasa payını ve bahis sınırlarını gönderiyor", () => {
    const i = src.indexOf('router.get("/duels/open"');
    assert.ok(i > 0, "uc bulunamadi");
    const govde = src.slice(i, src.indexOf("\n});", i));
    for (const alan of ["odulTablosu: odulTablosu()", "minStake: MIN_STAKE", "maxStake: MAX_STAKE"]) {
      assert.ok(govde.includes(alan), `${alan} yanitta yok — istemci tahmin etmek zorunda kalir`);
    }
  });

  test("SABİT SAYIYLA değil, hesabın KENDİSİYLE gönderiliyor", () => {
    /* `houseCutPct: 0.05` yazmak sorunu çözmez — yeni bir kopya olurdu. */
    assert.ok(!/houseCutPct:\s*0\./.test(src),
      "kasa payi yanitta sayiyla yazilmis — yeni bir kopya");
    assert.ok(!/odulTablosu:\s*\[/.test(src),
      "odul tablosu yanitta elle yazilmis — hesapla ayrisir");
  });

  test("gönderilen tablo, kaydedilen ödülle AYNI", () => {
    /**
     * ⚠️ ASIL DEĞİŞMEZ. Tablo ekrana bahis KONMADAN ÖNCE gösteriliyor;
     * `winAmount` ise düello kurulurken cüzdana yazılacak tutar. İkisi ayrı
     * hesaplansaydı ekran yanlış vaat ederdi — kapatılan kusur sınıfı bu.
     */
    for (const satir of KESINTI.odulTablosu()) {
      const kayit = KESINTI.duelloPaylari(satir.stake);
      assert.deepEqual(
        { pot: satir.pot, houseCut: satir.houseCut, winAmount: satir.winAmount },
        kayit,
        `bahis ${satir.stake}: gonderilen tablo ile kaydedilen odul ayristi`
      );
    }
  });

  test("ESKİ istemciler için gönderilen oran ödülü FAZLA göstermez", () => {
    /**
     * ⚠️ Sahadaki eski sürümler `houseCutPct`i okuyup kazancı kendi hesaplıyor
     * (`pot * (1 - pct)`). Alan hiç gönderilmezse kendi varsayılanlarına (0.05)
     * düşerler ve bahis 5'te 9.5 LC vaat ederler — gerçek ödül 9. FAZLA vaat.
     * Bu yüzden aralıktaki EN YÜKSEK efektif oran gönderiliyor: eski ekran
     * ödülü olduğundan AZ gösterir, asla fazla.
     */
    const pct = KESINTI.eskiIstemciKesintiOrani();
    for (const { stake, pot, winAmount } of KESINTI.odulTablosu()) {
      const eskiEkran = Math.round(pot * (1 - pct) * 10) / 10;
      assert.ok(eskiEkran <= winAmount,
        `bahis ${stake}: eski ekran ${eskiEkran} vaat ediyor, gercek odul ${winAmount} — FAZLA vaat`);
    }
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

  test("ödül tablosu sunucudan okunuyor ve eski sunucuda yedeği var", (t) => {
    if (!fs.existsSync(MOB)) return t.skip("mobil depo yan klasorde yok");
    /* ⚠️ YORUMLAR ÖNCE SİLİNİYOR: kaldırılan formül (`pot * (1 - houseCutPct)`)
     * neden-notlarında ANILIYOR ve ham metinde arasak nöbetçi kendi
     * belgelendirmesine takılırdı. */
    const m = fs.readFileSync(MOB, "utf8")
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((l) => {
        const x = l.trim();
        return x.startsWith("*") || x.startsWith("//") || x.startsWith("/*") ? "" : l;
      })
      .join("\n");
    assert.ok(/Array\.isArray\(oj\.odulTablosu\)/.test(m),
      "sunucu tablosu okunmuyor");
    assert.ok(/YEDEK_STAKES/.test(m),
      "yedek bahis listesi yok — tabloyu gondermeyen ESKI sunucuda ekran bosalir");
    /* ⚠️ Yedek YALNIZCA bahis listesi. Ödül için yedek hesap yazmak, tam da
     * kaldırılan kusuru geri getirmek olurdu: eski sunucunun kuralı bilinmez. */
    assert.ok(!/\(1\s*-\s*houseCutPct\)/.test(m),
      "ekran yeniden kesinti orani ile carpiyor");
  });
});
