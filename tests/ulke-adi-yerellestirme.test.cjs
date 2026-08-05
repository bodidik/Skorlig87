"use strict";

/**
 * ÜLKE ADI KULLANICININ DİLİNDE GÖSTERİLİR — ALIAS TABLOSU KIRILMADAN.
 *
 * ⚠️ BULUNAN KUSUR (2026-08-03, mobile/app/livescores.tsx):
 * ekran ülke adını sunucudan geldiği gibi basıyordu:
 *
 *     <Text ...>{league.country}</Text>
 *
 * Sunucu adı bazen İngilizce ("Turkey"), bazen Türkçe ("Türkiye")
 * gönderiyor — hangisi geleceği o anki kaynağa bağlı (bkz. bayrak
 * haritasında iki yazımın da anahtar olması). Yani Japon kullanıcı ekranda
 * ya "Türkiye" ya "Turkey" görüyordu; İngilizce yedeğe bile düşmüyordu.
 *
 * ⚠️ HARİTA "ÇEVRİLEREK" DÜZELTİLEMEZ — İLK REFLEKS YANLIŞTI. Haritanın
 * anahtarları KULLANICININ DİLİYLE değil SUNUCUNUN GÖNDERDİĞİ metinle
 * eşleşmek zorunda; `t()` anahtarına çevirmek aramayı kırar ve bayrak
 * yedek sembole düşerdi. Doğru katmanlama üç adımlı:
 *     ham ad --(alias)--> kanonik anahtar --(t)--> gösterilecek ad
 *
 * Bu test o üç adımın hepsini ayrı ayrı sınar; biri kopunca kırılır.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const MOBIL = require("./_mobil-dizin.cjs").MOBIL;
const ULKELER = path.join(MOBIL, "lib", "ulkeler.ts");
const I18N = path.join(MOBIL, "lib", "i18n.ts");
const LIVESCORES = path.join(MOBIL, "app", "livescores.tsx");

/** ulkeler.ts içindeki tabloyu ayrıştırır: [{k, bayrak, adlar}] */
function tabloOku() {
  const src = fs.readFileSync(ULKELER, "utf8");
  const out = [];
  for (const m of src.matchAll(/\{\s*k:\s*"([^"]+)",\s*bayrak:\s*"([^"]*)",\s*adlar:\s*\[([^\]]*)\]\s*\}/g)) {
    const adlar = [...m[3].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]);
    out.push({ k: m[1], bayrak: m[2], adlar });
  }
  return out;
}

/** i18n.ts içindeki bir dil bloğunun anahtar->değer eşlemesi. */
function sozluk(dil) {
  const src = fs.readFileSync(I18N, "utf8");
  const i = src.indexOf(`  ${dil}: {`);
  const j = src.indexOf("\n  },", i);
  const out = new Map();
  for (const m of src.slice(i, j).matchAll(/^\s{4}([A-Za-z0-9_]+):\s+"((?:[^"\\]|\\.)*)"/gm)) {
    out.set(m[1], m[2]);
  }
  return out;
}

describe("ülke adı yerelleştirme", () => {
  test("kurulum sınandı: tablo GERÇEKTEN okunuyor", () => {
    /* ⚠️ Ayrıştırma bozulursa aşağıdaki her iddia boş kümede gezinir ve
     * yalancı yeşil verir. Bugün bir kez bu tuzağa düşüldü. */
    if (!fs.existsSync(ULKELER)) return;
    const t = tabloOku();
    assert.ok(t.length >= 50, `yalnizca ${t.length} ulke ayristirildi — tarama bozuk`);
    const tr = t.find((x) => x.k === "ulke_turkey");
    assert.ok(tr, "ulke_turkey bulunamadi");
    assert.deepEqual(tr.adlar, ["Turkey", "Türkiye"], "Turkiye alias listesi beklenen degil");
  });

  test("ADIM 1 — alias: sunucunun İKİ yazımı da aynı anahtara düşer", () => {
    /**
     * ⚠️ ASIL KIRILGANLIK BURADA. Biri "sadeleştireyim" diye Türkçe
     * yazımları silerse arama sessizce başarısız olur: ad ham kalır,
     * bayrak yedek sembole düşer. Hata vermez, yalnızca yanlış görünür.
     */
    if (!fs.existsSync(ULKELER)) return;
    const tablo = tabloOku();
    const ciftYazimli = tablo.filter((x) => x.adlar.length > 1);
    assert.ok(ciftYazimli.length >= 40,
      `yalnizca ${ciftYazimli.length} ulkenin ikinci yazimi var — alias listesi budanmis olabilir`);

    // Aynı ad iki farklı anahtara düşmemeli (belirsizlik = rastgele bayrak).
    const gorulen = new Map();
    const cakisan = [];
    for (const u of tablo) {
      for (const ad of u.adlar) {
        const n = ad.toLocaleLowerCase("tr");
        if (gorulen.has(n) && gorulen.get(n) !== u.k) cakisan.push(`${ad}: ${gorulen.get(n)} vs ${u.k}`);
        gorulen.set(n, u.k);
      }
    }
    assert.deepEqual(cakisan, [], "ayni ad iki ulkeye baglanmis: " + cakisan.join(", "));
  });

  test("ADIM 2 — çeviri: HER kanonik anahtarın tr ve en karşılığı var", () => {
    /* ⚠️ Eksik anahtar t()'yi anahtarın KENDİSİNİ basmaya iter:
     * kullanıcı ekranda "ulke_turkey" görür. */
    if (!fs.existsSync(ULKELER)) return;
    const tablo = tabloOku();
    const tr = sozluk("tr"), en = sozluk("en");
    const eksikTr = tablo.filter((u) => !tr.has(u.k)).map((u) => u.k);
    const eksikEn = tablo.filter((u) => !en.has(u.k)).map((u) => u.k);
    assert.deepEqual(eksikTr, [], "tr sozlugunde eksik ulke: " + eksikTr.join(", "));
    assert.deepEqual(eksikEn, [], "en sozlugunde eksik ulke: " + eksikEn.join(", "));
  });

  test("ADIM 2b — tr ve en GERÇEKTEN farklı (yer tutucu kopyala-yapıştır değil)", () => {
    /**
     * ⚠️ Sözlükleri doldururken en'i tr'den kopyalamak testi geçirir ama
     * kullanıcıya hiçbir şey kazandırmaz. Türkçe adı İngilizceden farklı
     * olan ülkelerde iki sözlük AYNI olamaz.
     */
    if (!fs.existsSync(ULKELER)) return;
    const tablo = tabloOku();
    const tr = sozluk("tr"), en = sozluk("en");
    const farkli = tablo.filter((u) => u.adlar.length > 1 && tr.get(u.k) !== en.get(u.k));
    assert.ok(farkli.length >= 40,
      `yalnizca ${farkli.length} ulkede tr/en farkli — sozluklerden biri otekinden kopyalanmis olabilir`);
    // Örnek doğrulama: bilinen çiftler
    assert.equal(tr.get("ulke_england"), "İngiltere");
    assert.equal(en.get("ulke_england"), "England");
  });

  test("ADIM 3 — ekran: ülke adı HAM basılmıyor, ulkeAdi()'nden geçiyor", () => {
    /**
     * ⚠️ İLK İKİ ADIM DOĞRU OLSA DA EKRAN HAM BASARSA KUSUR DURUYOR
     * demektir — bu ürün o dersi bugün defalarca yaşadı ("fonksiyonu
     * düzeltmek yetmez, UCU döv").
     */
    if (!fs.existsSync(LIVESCORES)) return;
    const src = fs.readFileSync(LIVESCORES, "utf8")
      .split(/\r?\n/)
      .filter((l) => { const k = l.trim(); return !k.startsWith("//") && !k.startsWith("*") && !k.startsWith("/*") && !k.startsWith("{/*"); })
      .join("\n");
    assert.ok(/from ["'][^"']*ulkeler["']/.test(src), "livescores ulkeler modulunu yuklemiyor");
    assert.ok(!/>\{league\.country\}</.test(src),
      "lig satirinda ulke adi HAM basiliyor — kullanici sunucunun dilini gorur");
    assert.ok(/ulkeAdi\(league\.country\)/.test(src), "lig satiri ulkeAdi()'nden gecmiyor");
    assert.ok(/ulkeAdi\(c\)/.test(src), "ulke cipi ulkeAdi()'nden gecmiyor");
  });

  test("ADIM 3b — ülke adı basan DİĞER ekranlar da ulkeAdi()'nden geçiyor", () => {
    /**
     * ⚠️ SINIF TARAMASI, TEKİL DÜZELTME DEĞİL. Aynı ham-gösterim livescores
     * dışında sekiz yerde daha vardı (lig grubu başlığı, sıralama kapsam
     * çipi, profil rozeti, 1987 kartı, kupon başlığı, iki ülke seçici...).
     * Yalnızca birini düzeltmek bu ürünün en sık tekrarlayan hatası.
     */
    if (!fs.existsSync(MOBIL)) return;
    const hedefler = [
      ["components/GroupHeader.tsx", /ulkeAdi\(country\)/],
      ["app/(tabs)/stats.tsx", /ulkeAdi\(myCountry\)/],
      ["app/(tabs)/live.tsx", /ulkeAdi\(league\.country\)/],
      ["app/profile/[userId].tsx", /ulkeAdi\(profile\.country\)/],
      ["components/Picks1987.tsx", /ulkeAdi\(pick\.country\)/],
      ["app/kupon.tsx", /ulkeAdi\(k\.ulke\)/],
      ["app/index.tsx", /ulkeAdi\(c\.country\)/],
      ["components/CountryBackfillPrompt.tsx", /ulkeAdi\(c\.country\)/],
    ];
    const eksik = [];
    for (const [rel, desen] of hedefler) {
      const p = path.join(MOBIL, rel);
      if (!fs.existsSync(p)) continue;
      const src = fs.readFileSync(p, "utf8");
      if (!desen.test(src)) eksik.push(rel);
    }
    assert.deepEqual(eksik, [],
      "ulke adini HAM basan ekran(lar): " + eksik.join(", "));
  });

  test("SEÇİCİ TUZAĞI: süzgeç de yerelleştirilmiş adda arıyor", () => {
    /**
     * ⚠️ EN SİNSİ KIRILMA BURADA OLURDU. Gösterimi yerelleştirip süzgeci
     * ham adda bırakmak, kullanıcının EKRANDA OKUDUĞU adı yazınca "eşleşen
     * ülke yok" görmesi demek. countrySort.ts'in kendi notu aynı sınıfı
     * zaten bir kez yaşamış: Türk kullanıcı "tur" yazınca kendi ülkesini
     * bulamıyordu.
     *
     * İki seçici de süzgeci `ulkeAdi(...)` üstünden kurmalı.
     */
    if (!fs.existsSync(MOBIL)) return;
    const onb = fs.readFileSync(path.join(MOBIL, "app", "index.tsx"), "utf8");
    assert.ok(/filterAndRankCountries\([\s\S]{0,200}ulkeAdi\(/.test(onb),
      "onboarding suzgeci ham adda ariyor — kullanici gordugu adi yazinca sonuc alamaz");

    const bf = fs.readFileSync(path.join(MOBIL, "components", "CountryBackfillPrompt.tsx"), "utf8");
    const i = bf.indexOf("const filtered");
    assert.ok(i > 0, "backfill suzgeci bulunamadi — test bir sey olcmuyor");
    assert.ok(/ulkeAdi\(/.test(bf.slice(i, i + 400)),
      "backfill suzgeci ham adda ariyor");
  });

  test("SEÇİM DEĞERİ HAM KALIR (sunucuya yerelleştirilmiş ad yazılmaz)", () => {
    /**
     * ⚠️ TERS RİSK — ASIL TEHLİKE BU. Gösterimi yerelleştirirken seçilen
     * DEĞERİ de yerelleştirseydik sunucuya "Turquía" gibi bir ad yazılırdı;
     * `canonicalCountry` onu tanımaz ve kullanıcı ülkesiz kalırdı. Bu ürün
     * ülkesiz kullanıcı sorununu bir kez yaşadı (837 kişi).
     */
    if (!fs.existsSync(MOBIL)) return;
    const onb = fs.readFileSync(path.join(MOBIL, "app", "index.tsx"), "utf8");
    assert.ok(/setCountry\(c\.country\)/.test(onb),
      "onboarding secilen degeri HAM yazmiyor — sunucu ulkeyi tanimayabilir");
    const bf = fs.readFileSync(path.join(MOBIL, "components", "CountryBackfillPrompt.tsx"), "utf8");
    assert.ok(/choose\(c\.country\)/.test(bf),
      "backfill secilen degeri HAM yazmiyor");
  });

  test("bilinmeyen ülke HAM adıyla gösterilir (yanlış çeviri yerine gerçek veri)", () => {
    /* ⚠️ Sunucu listede olmayan bir ülke gönderdiğinde ekranın boş kalması
     * ya da anahtar basması kabul edilemez; ham ad en az yanlış olandır. */
    if (!fs.existsSync(ULKELER)) return;
    const src = fs.readFileSync(ULKELER, "utf8");
    const g = src.slice(src.indexOf("export function ulkeAdi"));
    assert.ok(/String\(ham \|\| ""\)\.trim\(\)/.test(g.slice(0, 300)),
      "ulkeAdi bilinmeyen ulkede ham ada dusmuyor");
  });
});
