"use strict";

/**
 * İKİZ TESPİTİ ÜLKEYİ KANONİK KARŞILAŞTIRIR.
 *
 * ⚠️ BULUNAN KUSUR (2026-08-03, lib/fikstur-ikiz.cjs): ülke `ad()` ile ham
 * karşılaştırılıyordu ve `ad()` yalnızca küçültüp noktalama atıyor. Oysa
 * fikstür koleksiyonunda AYNI ülke iki yazımla birden duruyor.
 *
 * ÖLÇÜLDÜ (2026-08-03, üretim): 86 ham ülke değeri → 77 kanonik, 9 ülke
 * bölünmüş:
 *
 *     Beyaz Rusya(13) + Belarus(16)          Galler(17) + Wales(8)
 *     Lüksemburg(2)   + Luxembourg(6)        Gürcistan(4) + Georgia(4)
 *     İrlanda Cumhuriyeti(2) + Ireland(17)   Ermenistan(3) + Armenia(4) ...
 *
 * Kova anahtarı da ham ülkeyi kullandığı için aynı maçın iki kaydı FARKLI
 * KOVAYA düşüyor ve hiç karşılaştırılmıyordu bile.
 *
 * ÖNCE/SONRA (aynı üretim verisi): farklı yazımda yakalanan ikiz 0 → 5.
 *
 *     [Beyaz Rusya] Gomel - Vitebsk   ↔ [Belarus] Gomel - FK Vitebsk
 *     [Galler] Haverfordwest-Broughton ↔ [Wales] Haverfordwest-Airbus UK Broughton
 *     [Lüksemburg] Niederkorn - Esch  ↔ [Luxembourg] FC Progres Niederkorn - AS Jeunesse Esch
 *     [İrlanda Cumhuriyeti] Bray Wand.-Kerry ↔ [Ireland] Bray Wanderers - Kerry FC
 *     [Luxembourg] FC Wiltz 71-FC Etzella ↔ [Lüksemburg] Wiltz - Etzella
 *
 * Zararı ikiz modülünün kendi notunda ölçülü: ikizin biri FT olup öderken
 * öbürü hiç uzlaşmıyor; o kayda tahmin yapan giriş bedelini ödeyip ödülünü
 * hiç alamıyor.
 *
 * ⚠️ AYNI İŞ BORU HATTINDA ZATEN DOĞRUYDU: `lib/fixture-priority.cjs`
 * içindeki `sameCountry` ham eşitlik tutmazsa `normalizeCountry`ye düşüyor ve
 * kupon ülke süzgeci onu kullanıyor. Savunma bir yerde var, öbüründe yok.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
const { ikizMi, ikizleriAyikla } = require("../lib/fikstur-ikiz.cjs");
const { normalizeCountry } = require("../lib/countries.cjs");

const KO = "2026-08-01T18:00:00.000Z";
const mac = (country, home, away, id) => ({
  fixtureId: id || `${country}-${home}`.replace(/\s+/g, ""),
  country, home, away, kickoffISO: KO,
});

describe("ikiz tespiti — ülke yazımı", () => {
  test("kurulum sınandı: kanonikleştirme GERÇEKTEN iki yazımı birleştiriyor", () => {
    /* ⚠️ Bu olmadan aşağıdaki her iddia boş: normalizeCountry bu çiftleri
     * tanımıyorsa düzeltmenin dayanağı yok demektir. */
    for (const [tr, en] of [
      ["Beyaz Rusya", "Belarus"], ["Galler", "Wales"], ["Lüksemburg", "Luxembourg"],
      ["Gürcistan", "Georgia"], ["İrlanda Cumhuriyeti", "Ireland"],
    ]) {
      assert.equal(normalizeCountry(tr), normalizeCountry(en),
        `${tr} ve ${en} kanonikte ayrisiyor — test bir sey olcmuyor`);
    }
  });

  test("AYNI ülke farklı yazımda → ikiz YAKALANIR", () => {
    /* Ölçülen gerçek vakanın birebir kopyası. */
    assert.equal(
      ikizMi(mac("Beyaz Rusya", "Gomel", "Vitebsk"), mac("Belarus", "Gomel", "FK Vitebsk")),
      true, "Beyaz Rusya/Belarus ikizi kaciyor");
    assert.equal(
      ikizMi(mac("Galler", "Haverfordwest", "Broughton"),
             mac("Wales", "Haverfordwest", "Airbus UK Broughton")),
      true, "Galler/Wales ikizi kaciyor");
  });

  test("TERS RİSK: gerçekten farklı ülkeler BİRLEŞMEZ", () => {
    /**
     * ⚠️ ASIL TEHLİKE AŞIRI DÜZELTME. Aynı saatte farklı ülkelerde oynanan
     * iki maç ortak takım adı taşıyabilir; birleştirmek GERÇEK bir maçı yok
     * ederdi — modülün kendi notu bunu "kopyayı bırakmaktan daha kötü" diye
     * yazıyor.
     */
    assert.equal(
      ikizMi(mac("Georgia", "Dinamo", "Torpedo"), mac("Armenia", "Dinamo", "Torpedo FC")),
      false, "farkli ulkeler ikiz sayildi — gercek mac yok edilir");
  });

  test("BİLİNMEYEN ülke kendi adıyla gruplanır (eleme yok)", () => {
    /* ⚠️ `normalizeCountry` tanımadığı adı KIRPILMIŞ hâliyle döndürüyor.
     * Tanınmayan ülkeler birbirine karışmamalı ama kendi içinde çalışmalı. */
    assert.equal(ikizMi(mac("Wakanda", "Alfa", "Beta"), mac("Wakanda", "Alfa", "Beta FC")),
      true, "bilinmeyen ulkede ayni mac ikiz sayilmiyor");
    assert.equal(ikizMi(mac("Wakanda", "Alfa", "Beta"), mac("Latveria", "Alfa", "Beta FC")),
      false, "iki bilinmeyen ulke birlestirilmis");
  });

  test("AYIKLAMA yolu da kanonik kovaya düşürüyor", () => {
    /**
     * ⚠️ İKİ YER VAR, İKİSİ DE GEÇMELİ. `ikizMi` düzelse bile KOVA ANAHTARI
     * ham ülkeyi kullanırsa çiftler hiç karşılaştırılmaz — kusur aynen kalır,
     * üstelik `ikizMi` testleri yeşil görünür. İlk kusurun asıl sebebi buydu.
     */
    const { dusenler } = ikizleriAyikla(
      [mac("Beyaz Rusya", "Gomel", "Vitebsk", "A"), mac("Belarus", "Gomel", "FK Vitebsk", "B")],
      new Set() // ikisi de yeni: biri düşmeli
    );
    assert.equal(dusenler.length, 1,
      "farkli yazimdaki ikizler ayni kovaya dusmuyor — hic karsilastirilmiyorlar");
  });

  test("NÖBETÇİ: ülke karşılaştıran HER yer kanonik (ham ad() kalmadı)", () => {
    /**
     * ⚠️ SINIF TARAMASI. Kusur iki ayrı satırdaydı; birini düzeltip ötekini
     * bırakmak bu üründe defalarca yaşandı.
     */
    const src = fs.readFileSync(path.join(KOK, "lib", "fikstur-ikiz.cjs"), "utf8")
      .split(/\r?\n/)
      .filter((l) => { const t = l.trim(); return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*"); })
      .join("\n");
    assert.ok(!/ad\(\s*[ab]\.country\s*\)/.test(src),
      "karsilastirmada ham ad(x.country) kalmis");
    assert.ok(!/ad\(\s*f\.country\s*\)/.test(src),
      "kova anahtarinda ham ad(f.country) kalmis");
    assert.ok(/ulkeAnahtari\(/.test(src), "kanonik yardimci hic kullanilmiyor");
  });

  test("NÖBETÇİ: bakım betiği kuralı KOPYALAMIYOR, modülden alıyor", () => {
    /**
     * ⚠️ DÜZELTMEYİ TEK BAŞINA YAPMAK YETMEDİ. `scripts/ikiz-birlestir.cjs`
     * kendi kovalamasını yazıyor ve ham ülke kullanıyordu; modül düzeldikten
     * SONRA bile 5 çifti göremedi. Kuru koşuda ölçüldü: kanonik anahtara
     * geçince gördüğü çift 63 → 68, birleştirilebilir 0 → 2.
     *
     * Kural kopyalanınca ayrışır — bu üründe defalarca yaşandı.
     */
    const p = path.join(KOK, "scripts", "ikiz-birlestir.cjs");
    if (!fs.existsSync(p)) return; // betik yoksa iddia atlanır
    const src = fs.readFileSync(p, "utf8")
      .split(/\r?\n/)
      .filter((l) => { const t = l.trim(); return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*"); })
      .join("\n");
    assert.ok(!/\$\{_ad\(f\.country\)\}/.test(src),
      "betik kova anahtarinda ham _ad(f.country) kullaniyor — modulun kanonik kuralindan ayrisir");
    assert.ok(/_ulkeAnahtari/.test(src),
      "betik modulun kanonik anahtarini kullanmiyor");
  });

  test("countries.cjs yoksa ÇÖKMEZ, ham ada düşer", () => {
    /* ⚠️ Fikstür yazımı kritik yol: kanonik tablo yüklenemezse ikiz
     * ayıklaması çökmemeli, en kötü ihtimalle ESKİ davranışa dönmeli. */
    const src = fs.readFileSync(path.join(KOK, "lib", "fikstur-ikiz.cjs"), "utf8");
    const i = src.indexOf("function ulkeAnahtari");
    assert.ok(i > 0, "ulkeAnahtari bulunamadi");
    const govde = src.slice(i, i + 320);
    assert.ok(/try\s*\{/.test(govde) && /catch/.test(govde),
      "kanonik tablo yuklenemezse cokme korumasi yok");
  });
});
