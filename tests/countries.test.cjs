"use strict";

/**
 * Ülke adı kanonikleştirme.
 *
 * NEDEN VAR: Ülke elemesi kaldırıldıktan sonra tanınmayan adlar ham hâliyle
 * geçmeye başladı ve aynı ülke KAYNAĞA GÖRE farklı isimle görünür oldu.
 * Gerçek ölçüm (2026-07-29, 142 maçlık havuz):
 *
 *     USA            4 maç
 *     United States  4 maç    ← aynı ülke, sıralama ikiye bölünmüş
 *     İzlanda       10 maç    ← mackolik Türkçe, goal İngilizce gönderiyor
 *
 * Bozulma SESSİZ: hata üretilmez, yalnızca kullanıcının ülkesi maçın ülkesiyle
 * eşleşmez ve ülke sıralaması bölünür.
 *
 * Çalıştırma:  npm test
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeCountry, isKnownCountry, flagOf, selectableCountries, ULKELER,
} = require("../lib/countries.cjs");

describe("aynı ülke tek isimde birleşir", () => {
  const ciftler = [
    ["USA", "United States"],
    ["ABD", "USA"],
    ["İzlanda", "Iceland"],
    ["Ekvador", "Ecuador"],
    ["Kolombiya", "Colombia"],
    ["Türkiye", "Turkey"],
    ["Güney Kore", "South Korea"],
    ["Özbekistan", "Uzbekistan"],
    ["Çekya", "Czechia"],
    ["İskoçya", "Scotland"],
    ["Şili", "Chile"],
  ];

  for (const [a, b] of ciftler) {
    test(`${a} = ${b}`, () => {
      const x = normalizeCountry(a);
      const y = normalizeCountry(b);
      assert.equal(x, y, `"${a}" ve "${b}" aynı kanonik ada çözülmeli`);
    });
  }

  test("Türkiye kanonik ad olarak Türkçe kalır", () => {
    // Kullanıcıya gösterilen ad; "Turkey" değil.
    assert.equal(normalizeCountry("Turkey"), "Türkiye");
    assert.equal(normalizeCountry("TR"), "Türkiye");
  });
});

describe("aksan ve harf farkları", () => {
  test("Türkçe harfler eşleşmeyi bozmaz", () => {
    // "İ" ve "I" ayrımı bu projede daha önce arama kutusunu kırmıştı.
    assert.equal(normalizeCountry("izlanda"), "Iceland");
    assert.equal(normalizeCountry("İZLANDA"), "Iceland");
    assert.equal(normalizeCountry("Izlanda"), "Iceland");
  });

  test("baştaki/sondaki boşluk yok sayılır", () => {
    assert.equal(normalizeCountry("  Brezilya  "), "Brazil");
  });

  test("ISO iki harf kodu tanınır", () => {
    assert.equal(normalizeCountry("BR"), "Brazil");
    assert.equal(normalizeCountry("de"), "Germany");
  });
});

describe("kıta kovaları", () => {
  test("kıtasal turnuvalar World kovasına düşer", () => {
    // Bunlar ÜLKE değil; ayrı sıralama havuzu açmamalılar.
    for (const k of ["Güney Amerika", "Kuzey / Orta Amerika", "Afrika", "Dünya", "International"]) {
      assert.equal(normalizeCountry(k), "World", `${k} → World olmalı`);
    }
  });

  test("Avrupa ayrı kova", () => {
    assert.equal(normalizeCountry("Avrupa"), "Europe");
    assert.equal(normalizeCountry("UEFA"), "Europe");
  });

  test("kovalar SEÇİLEBİLİR ülke listesinde YOK", () => {
    // Kullanıcı "Dünya"yı ülkesi olarak seçemez.
    const liste = selectableCountries();
    for (const k of ["World", "Europe"]) {
      assert.equal(liste.includes(k), false, `${k} seçilebilir olmamalı`);
    }
  });
});

describe("tanınmayan ad", () => {
  test("ham hâliyle döner — ELENMEZ", () => {
    // Eleme lib/fixture-priority.cjs'te kaldırıldı; burada da elemiyoruz,
    // yoksa o ülkenin maçları havuzdan düşerdi.
    assert.equal(normalizeCountry("Wakanda"), "Wakanda");
  });

  test("isKnownCountry ayrımı yapar", () => {
    assert.equal(isKnownCountry("Brezilya"), true);
    assert.equal(isKnownCountry("Wakanda"), false);
  });

  test("boş girdi null döner", () => {
    assert.equal(normalizeCountry(""), null);
    assert.equal(normalizeCountry(null), null);
    assert.equal(isKnownCountry(""), false);
  });
});

describe("bayraklar", () => {
  test("her seçilebilir ülkenin bayrağı var", () => {
    const eksik = selectableCountries().filter((c) => !flagOf(c));
    assert.deepEqual(eksik, [], "bayraksız ülke kalmamalı");
  });

  test("takma addan da bayrak bulunur", () => {
    assert.equal(flagOf("Brezilya"), flagOf("Brazil"));
    assert.equal(flagOf("ABD"), flagOf("USA"));
  });

  test("kovaların kendi simgesi var", () => {
    assert.equal(flagOf("World"), "🌍");
    assert.equal(flagOf("Europe"), "🇪🇺");
  });
});

describe("tablo tutarlılığı", () => {
  test("takma adlar birbirini EZMEZ", () => {
    // Aynı takma ad iki ülkeye atanmışsa biri sessizce kaybolur.
    const gorulen = new Map();
    for (const [kanonik, bilgi] of Object.entries(ULKELER)) {
      for (const a of bilgi.aliases || []) {
        const k = a.toLocaleLowerCase("tr");
        assert.equal(
          gorulen.has(k), false,
          `"${a}" hem ${gorulen.get(k)} hem ${kanonik} için tanımlı`
        );
        gorulen.set(k, kanonik);
      }
    }
  });

  test("her ülke kendi adına çözülür", () => {
    for (const c of selectableCountries()) {
      assert.equal(normalizeCountry(c), c, `${c} kendine çözülmeli`);
    }
  });
});
