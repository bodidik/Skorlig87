"use strict";

/**
 * Ülke süzgeci boş kalınca dünya listesine geri düşme.
 *
 * NEDEN VAR (ölçüldü 2026-07-28): Türk kullanıcı için en yakın maç 14 GÜN
 * sonraydı — Süper Lig sezonu başlamamış, FDO Türkiye'yi kapsamıyor. Aynı anda
 * önümüzdeki 7 günde 12 maç vardı (Brezilya Série A, Arjantin Primera) ama
 * ülke süzgeci hepsini eliyordu. Uygulama iki hafta boyunca boş kalıyordu:
 * kullanıcı tahmin oynayamıyor, geri dönmüyor.
 *
 * İki yönlü risk var ve ikisi de test altında:
 *   - Geri düşüş ÇALIŞMAZSA → boş ekran (asıl sorun)
 *   - Geri düşüş FAZLA çalışırsa → ülkesinde maç olan kullanıcıya da alakasız
 *     maçlar gösterilir; ülke deneyimi bozulur
 *
 * Çalıştırma:  npm test
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { localizeWithFallback } = require("../routes/live2.cjs");

const mac = (country, league) => ({
  fixtureId: `${country}-${league}`, country, league,
  home: "A", away: "B", kickoffISO: "2026-08-01T18:00:00Z",
});

const DUNYA = [
  mac("Brazil", "Campeonato Brasileiro Série A"),
  mac("Argentina", "Primera Division"),
  mac("England", "Premier League"),
];

describe("ülkede maç VARKEN", () => {
  test("yalnızca o ülkenin maçları döner, geri düşüş yok", () => {
    const r = localizeWithFallback(DUNYA, "Brazil", "");
    assert.equal(r.fallback, false);
    assert.equal(r.list.length, 1);
    assert.equal(r.list[0].country, "Brazil");
  });

  test("küresel turnuva ülke maçı sayılır (geri düşüş tetiklenmez)", () => {
    const liste = [...DUNYA, mac("World", "Copa Libertadores")];
    const r = localizeWithFallback(liste, "Türkiye", "");
    assert.equal(r.fallback, false, "Libertadores varken geri düşülmemeli");
    assert.equal(r.list.length, 1);
    assert.equal(r.list[0].league, "Copa Libertadores");
  });
});

describe("ülkede maç YOKKEN", () => {
  test("dünya listesi döner ve bayrak kalkar", () => {
    // Türkiye'nin hiç maçı yok — asıl senaryo.
    const r = localizeWithFallback(DUNYA, "Türkiye", "");
    assert.equal(r.fallback, true, "boş ekran yerine dünya listesi gelmeli");
    assert.equal(r.list.length, 3);
  });

  test("bayrak olmadan kullanıcı neden Brezilya maçı gördüğünü anlayamaz", () => {
    // Bayrağın kendisi sözleşmenin parçası: arayüz buna göre açıklama gösteriyor.
    const r = localizeWithFallback(DUNYA, "Türkiye", "");
    assert.equal(typeof r.fallback, "boolean");
    assert.equal(r.fallback, true);
  });
});

describe("ülke verilmemişse", () => {
  test("süzme yok, geri düşüş kavramı da yok", () => {
    const r = localizeWithFallback(DUNYA, "", "");
    assert.equal(r.fallback, false);
    assert.equal(r.list.length, 3);
  });

  test("tanınmayan ülke adı süzmez (geri düşüş sayılmaz)", () => {
    // canonicalCountry çözemezse zaten süzülmedi — "geri düştük" demek yanlış olur.
    const r = localizeWithFallback(DUNYA, "Atlantis", "");
    assert.equal(r.fallback, false);
    assert.equal(r.list.length, 3);
  });
});

describe("boş girdi", () => {
  test("liste boşsa patlamaz", () => {
    const r = localizeWithFallback([], "Türkiye", "");
    assert.equal(r.list.length, 0);
    // Boş listede "geri düşülmüş" demek yanıltıcı olurdu: gösterilecek maç yok.
    assert.equal(r.fallback, true);
  });
});
