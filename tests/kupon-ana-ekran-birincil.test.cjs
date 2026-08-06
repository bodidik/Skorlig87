"use strict";

/**
 * KUPON ANA EKRANDA BİRİNCİL — SIRA NÖBETÇİSİ.
 *
 * ⚠️ ÜRÜN KARARI (2026-08-06): kupon `OyunModlari` içinde altı moddan biriydi
 * ve yatay kaydırma şeridinde duruyordu; ana ekranın ilk eylemi tek maçlık
 * "günün maçı" kartıydı. Haftanın 8 maçlık asıl oyunu, keşfedilmesi gereken
 * bir yan özellik gibi sunuluyordu.
 *
 * Yeni sıra: KUPON → GÜNÜN MAÇI. Genişlik ligdeki maç sayısıyla verilir
 * (kupon 8 maç, günün maçı 1); günün maçı ikincil kalır çünkü 1987 grubunun
 * tepki katmanını taşıyor.
 *
 * ⚠️ NEDEN NÖBETÇİ GEREKİYOR: sıra tek bir JSX satırının yerine bağlı. Biri
 * kartı aşağı alırsa ya da `OyunModlari` üstüne çıkarsa hiçbir test kırılmaz,
 * tsc uyarmaz — karar sessizce geri alınmış olur.
 *
 * ⚠️ i18n ANAHTARLARI: kart `t("kuponJoinFor")` gibi anahtarlar kullanıyor.
 * `t()` bilinmeyen anahtarda ANAHTARIN KENDİSİNİ basar (çökmez), yani eksik
 * çeviri ekranda "kuponJoinFor" olarak görünür ve testsiz fark edilmez —
 * tepki katmanında aynı sınıf yaşandı (bkz. tepki-istemci-uyumu.test.cjs).
 */

const test = require("node:test");
const { describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

/* ⚠️ MOBİL YOL TEK KAYNAKTAN. Elle `path.join(KOK, "..", "mobile")` yazmak
 * worktree'de çözülmez ve iddia SESSİZCE atlanır — yeşil görünür, hiçbir şey
 * ölçmez. Bu testin ilk sürümü tam olarak o hatayı yapmıştı ve
 * `mobil-yol-nobetcisi` yakaladı. bkz. tests/_mobil-dizin.cjs */
const { mobilYol, mobilVarMi } = require("./_mobil-dizin.cjs");

const LIVE = mobilYol("app", "(tabs)", "live.tsx");
const KART = mobilYol("components", "KuponKarti.tsx");
const I18N = mobilYol("lib", "i18n.ts");

const mobilVar = mobilVarMi();

describe("kupon kartı ana ekrana bağlı", () => {
  test("KuponKarti import edilmiş ve render ediliyor", (t) => {
    if (!mobilVar) return t.skip("mobil depo yan klasorde yok");
    const src = fs.readFileSync(LIVE, "utf8");
    assert.ok(/import\s+KuponKarti\s+from/.test(src),
      "KuponKarti import edilmemis");
    assert.ok(/<KuponKarti\s*\/?>/.test(src),
      "KuponKarti hic render edilmiyor — kart olu kod");
  });

  test("KUPON, GÜNÜN MAÇI'NDAN ÖNCE geliyor", (t) => {
    if (!mobilVar) return t.skip("mobil depo yan klasorde yok");
    const src = fs.readFileSync(LIVE, "utf8");

    /* ⚠️ ASIL DEĞİŞMEZ. Import satırları değil, RENDER sırası ölçülüyor —
     * import sırası ekranda hiçbir şey ifade etmez. */
    const govde = src.slice(src.indexOf("ListHeaderComponent"));
    const kuponIx = govde.indexOf("<KuponKarti");
    const gunIx = govde.indexOf("<DailyMatchCard");

    assert.ok(kuponIx >= 0, "KuponKarti baslikta render edilmiyor");
    assert.ok(gunIx >= 0, "DailyMatchCard baslikta render edilmiyor");
    assert.ok(
      kuponIx < gunIx,
      "SIRA BOZULMUS: gunun maci kupondan ONCE geliyor. Urun karari kuponun\n" +
      "birincil eylem olmasiydi (8 mac vs 1 mac) — bkz. KuponKarti basligi."
    );
  });

  test("kart kupon yokken KENDİNİ GİZLİYOR", (t) => {
    if (!mobilVar) return t.skip("mobil depo yan klasorde yok");
    const src = fs.readFileSync(KART, "utf8");
    assert.ok(
      /if\s*\(!kupon\)\s*return null/.test(src),
      "kupon yokken null donmuyor — ana ekranin tepesinde bos kutu kalir\n" +
      "(sezon arasi ve yeni ulke eklendiginde gercekten oluyor)"
    );
  });

  test("kalan süre SUNUCUDAN okunuyor, cihaz saatinden değil", (t) => {
    if (!mobilVar) return t.skip("mobil depo yan klasorde yok");
    const src = fs.readFileSync(KART, "utf8");
    /* Cihaz saati yanlissa geri sayim yalan soyler ve "daha var" derken
     * kilit kapanir. app/kupon.tsx ayni kurali yaziyor. */
    assert.ok(/kupon\.kalanSaniye/.test(src),
      "kalanSaniye kullanilmiyor — cihaz saatiyle hesaplaniyor olabilir");
    assert.ok(!/Date\.now\(\)\s*-\s*new Date\(kupon\.kilitISO\)/.test(src),
      "kilit suresi cihaz saatinden hesaplaniyor");
  });

  test("yalnızca AÇIK kupon gösteriliyor", (t) => {
    if (!mobilVar) return t.skip("mobil depo yan klasorde yok");
    const src = fs.readFileSync(KART, "utf8");
    assert.ok(/durum\s*===\s*"open"/.test(src),
      "kilitli/sonuclanmis kupon da gosteriliyor — kullanici katilamayacagi\n" +
      "bir kupona yonlendirilir");
  });
});

describe("kupon kartı i18n kapsamı", () => {
  /** Kaynaktaki `t("anahtar")` çağrılarını çıkarır. */
  function kullanilanAnahtarlar(src) {
    return [...new Set(
      [...src.matchAll(/\bt\(\s*"([A-Za-z0-9_]+)"/g)].map((m) => m[1])
    )];
  }

  /** i18n.ts içindeki `tr` ve `en` bloklarını kabaca ayırır. */
  function bloklar() {
    const src = fs.readFileSync(I18N, "utf8");
    const enIx = src.indexOf("nMin:", src.indexOf("nMin:") + 10);
    return { tr: src.slice(0, enIx), en: src.slice(enIx), tam: src };
  }

  test("kartın kullandığı her anahtar tr VE en'de tanımlı", (t) => {
    if (!mobilVar) return t.skip("mobil depo yan klasorde yok");
    const anahtarlar = kullanilanAnahtarlar(fs.readFileSync(KART, "utf8"));
    assert.ok(anahtarlar.length >= 6,
      `cok az anahtar bulundu (${anahtarlar.length}) — tarama bozulmus olabilir`);

    const { tr, en } = bloklar();
    const eksik = [];
    for (const k of anahtarlar) {
      const re = new RegExp(`^\\s*${k}:`, "m");
      if (!re.test(tr)) eksik.push(`tr: ${k}`);
      if (!re.test(en)) eksik.push(`en: ${k}`);
    }

    assert.deepStrictEqual(
      eksik, [],
      "Bu anahtarlarin cevirisi YOK. `t()` bilinmeyen anahtarda anahtarin\n" +
      "KENDISINI basar — ekranda \"kuponJoinFor\" gorunur, hata uretmez:\n" +
      eksik.join("\n")
    );
  });

  test("başlık kupon ekranıyla AYNI anahtarı kullanıyor", (t) => {
    if (!mobilVar) return t.skip("mobil depo yan klasorde yok");
    /* Iki yuzey ayni kuponu farkli adlandirirsa kullanici iki ayri oyun sanir. */
    const kart = fs.readFileSync(KART, "utf8");
    const ekran = fs.readFileSync(mobilYol("app", "kupon.tsx"), "utf8");
    for (const anahtar of ["kuponEurope", "kuponCountryLeague"]) {
      assert.ok(kart.includes(anahtar), `kart ${anahtar} kullanmiyor`);
      assert.ok(ekran.includes(anahtar), `kupon ekrani ${anahtar} kullanmiyor`);
    }
  });
});
