"use strict";

/**
 * FİKSTÜRDE GEÇEN HER ÜLKE ADI KANONİK KARŞILIĞINI BULUR.
 *
 * ⚠️ BULUNAN: `lib/countries.cjs` tablosunda 77 ülke vardı ama gerçek fikstür
 * verisinde geçen 15 ülke adı tanınmıyordu — ve çoğu TÜRKÇE/İNGİLİZCE ÇİFT,
 * yani AYNI ülke İKİ AYRI ülke sayılıyordu:
 *
 *     "Beyaz Rusya"  9 maç   ile  "Belarus"       6 maç
 *     "Galler"       4       ile  "Wales"         6
 *     "Güney Afrika" 1       ile  "South Africa"  5
 *     "Ermenistan"   1       ile  "Armenia"       3
 *     "İrlanda Cumhuriyeti" 2 —  Ireland tabloda VARDI, bu yazım eksikti
 *   ayrıca: Zimbabve, Luxembourg, Kırgızistan, Uganda, Moldova, Montenegro
 *
 * Tanınmayan ad `normalizeCountry`'den KIRPILMIŞ HÂLİYLE geri dönüyor (dosyanın
 * kendi kararı: eleme yapma). Yani iki yazım hiç birleşmiyor — kullanıcı birini
 * seçtiğinde ötekinin maçları "kendi ülkem" grubuna girmiyor ve ülke sıralaması
 * ikiye bölünüyor. Dosyanın kendi başlığı bu hatayı zaten anlatıyor
 * ("USA 4 maç / United States 4 maç ← AYNI ÜLKE, sıralama ikiye bölünmüş");
 * kusur, aynı hatanın kapatılmamış kalan örnekleriydi.
 *
 * ÖLÇÜLDÜ: tanınmayan ülke adı 15 → 0.
 *
 * ⚠️ SADECE VERİDE GÖRÜLENLER EKLENDİ. Dünyanın tüm ülkelerini eklemek
 * `selectableCountries()` listesini oyunda karşılığı olmayan seçeneklerle
 * şişirirdi.
 */

const test = require("node:test");
const describe = require("node:test").describe;
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
const C = require("../lib/countries.cjs");

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("tablo dolu ve kanonik adlar kendini buluyor", () => {
    const adlar = Object.keys(C.ULKELER);
    assert.ok(adlar.length > 70, `yalnizca ${adlar.length} ulke — tablo beklenenden kucuk`);
    for (const a of adlar) {
      assert.equal(C.normalizeCountry(a), a, `${a} kendi kanonik adina cozulmuyor`);
    }
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("Türkçe/İngilizce çiftler birleşiyor", () => {
  const CIFTLER = [
    ["Beyaz Rusya", "Belarus"],
    ["Galler", "Wales"],
    ["Güney Afrika", "South Africa"],
    ["Ermenistan", "Armenia"],
    ["Zimbabve", "Zimbabwe"],
    ["Lüksemburg", "Luxembourg"],
    ["Kırgızistan", "Kyrgyzstan"],
    ["Karadağ", "Montenegro"],
    ["İrlanda Cumhuriyeti", "Ireland"],
    // daha önce kapatılmış olanlar — gerilemesin
    ["ABD", "USA"],
    ["İzlanda", "Iceland"],
    ["Almanya", "Germany"],
  ];

  for (const [tr, en] of CIFTLER) {
    test(`"${tr}" ile "${en}" AYNI ülke`, () => {
      const a = C.normalizeCountry(tr);
      const b = C.normalizeCountry(en);
      assert.equal(a, b, `${tr} -> ${a}, ${en} -> ${b} — siralama ikiye bolunur`);
      assert.ok(C.isKnownCountry(tr), `${tr} taninmiyor`);
      assert.ok(C.isKnownCountry(en), `${en} taninmiyor`);
    });
  }
});

describe("aksansız yazımlar da tanınıyor", () => {
  /* Kaynaklar Türkçe adı aksansız gönderebiliyor. */
  for (const [ham, kanonik] of [
    ["Guney Afrika", "South Africa"],
    ["Kirgizistan", "Kyrgyzstan"],
    ["Karadag", "Montenegro"],
    ["Luksemburg", "Luxembourg"],
    ["Irlanda Cumhuriyeti", "Ireland"],
  ]) {
    test(`"${ham}" → ${kanonik}`, () => {
      assert.equal(C.normalizeCountry(ham), kanonik);
    });
  }
});

describe("yeni girişler tabloyu bozmuyor", () => {
  test("bayrak ve iso2 alanları dolu", () => {
    for (const ad of ["Belarus", "Wales", "South Africa", "Armenia", "Zimbabwe",
      "Luxembourg", "Kyrgyzstan", "Uganda", "Moldova", "Montenegro"]) {
      const b = C.ULKELER[ad];
      assert.ok(b, `${ad} tabloda yok`);
      assert.ok(b.flag && b.flag.length > 0, `${ad} bayraksiz`);
      assert.equal(C.flagOf(ad), b.flag, `${ad} bayragi cozulmuyor`);
    }
  });

  test("iki ülke aynı kanonik ada çökmüyor", () => {
    /**
     * ⚠️ Takma ad eklemenin gerçek riski bu: bir takma ad başka bir ülkeye
     * de denk gelirse iki ülke birleşir ve sıralama sessizce karışır.
     */
    const gorulen = new Map();
    for (const [kanonik, bilgi] of Object.entries(C.ULKELER)) {
      for (const a of [kanonik, ...(bilgi.aliases || [])]) {
        const n = C.normalizeCountry(a);
        const onceki = gorulen.get(a.toLocaleLowerCase("tr"));
        if (onceki && onceki !== n) {
          assert.fail(`"${a}" hem ${onceki} hem ${n} icin kullanilmis`);
        }
        gorulen.set(a.toLocaleLowerCase("tr"), n);
      }
    }
    assert.ok(gorulen.size > 100, `yalnizca ${gorulen.size} ad tarandi`);
  });

  test("seçilebilir ülke listesi büyüdü ama kıta kovaları girmedi", () => {
    const sec = C.selectableCountries().map((x) => (typeof x === "string" ? x : x.name || x.kanonik || x.id));
    assert.ok(sec.includes("Belarus"), "yeni ulkeler secilebilir listede yok");
    for (const kova of ["Europe", "World", "Asia"]) {
      assert.ok(!sec.includes(kova), `${kova} kitasal kova secilebilir listeye sizmis`);
    }
  });
});

/* ── Gerçek veriyle ──────────────────────────────────────────────────────── */

test("gerçek fikstürde tanınmayan ülke adı yok", (t) => {
  /**
   * ⚠️ VERİ DEĞİŞTİKÇE YENİ AD GELEBİLİR — bu test o zaman kırılır ve
   * kırılması DOĞRU olur: yeni ad tabloya eklenmeli. Ölçüm anında 75 tekil
   * addan 0'ı tanınmıyordu (düzeltmeden önce 15).
   */
  const dosya = path.join(KOK, "data", "fixtures.json");
  if (!fs.existsSync(dosya)) return t.skip("fikstur verisi yok");
  const items = JSON.parse(fs.readFileSync(dosya, "utf8")).fixtures || [];
  if (items.length < 100) return t.skip("yeterli fikstur yok");

  const sayac = new Map();
  for (const f of items) {
    if (!f?.country) continue;
    const a = String(f.country);
    sayac.set(a, (sayac.get(a) || 0) + 1);
  }
  assert.ok(sayac.size > 20, `yalnizca ${sayac.size} ulke adi — tarama bozuk`);

  const taninmayan = [...sayac].filter(([a]) => !C.isKnownCountry(a));
  assert.deepEqual(
    taninmayan.map(([a, n]) => `${a} (${n} mac)`), [],
    "tabloda karsiligi olmayan ulke adi var — o maclar kimsenin 'kendi ulkem' grubuna girmez"
  );
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: tanınmayan ad ELENMİYOR, kırpılmış hâliyle dönüyor", () => {
  /**
   * Dosyanın kendi kararı: `normalizeCountry` tanınmayanı `null` DEĞİL,
   * kırpılmış hâliyle döndürür — çünkü ülke eleme ölçütü değil sıralama
   * ölçütü (bkz. lib/fixture-priority.cjs). Bu ters çevrilirse tanınmayan
   * ülkenin maçları listeden düşer.
   */
  assert.equal(C.normalizeCountry("  Atlantis  "), "Atlantis");
  assert.equal(C.isKnownCountry("Atlantis"), false);
  assert.equal(C.normalizeCountry(""), null, "bos ad null donmeli");
});
