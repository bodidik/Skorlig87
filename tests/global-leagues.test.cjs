"use strict";

/**
 * Küresel lig tespiti.
 *
 * NEDEN TEST EDİLİYOR: Bu liste iki rotada ayrı ayrı tanımlıydı ve ayrışmıştı
 * (fixtures.cjs'te 11 desen eksikti). Bir desenin eksikliği hata üretmez —
 * maç yalnızca ülke filtresine takılır ve o ülkeden olmayan herkesten sessizce
 * gizlenir. Libertadores tam böyle kayboldu: sezon arasında oynanan tek
 * turnuvaydı ve Türk kullanıcı ekranda hiç maç göremiyordu.
 *
 * Çalıştırma:  npm test
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { isGlobalLeagueName, isExcludedLeague, isFriendlyLeague } = require("../lib/global-leagues.cjs");

describe("küresel sayılanlar", () => {
  const kuresel = [
    // Avrupa kulüp — İngilizce ve Türkçe (nesine/mackolik Türkçe gönderiyor)
    "UEFA Champions League",
    "Champions League Qualification",
    "Uefa Şampiyonlar Ligi Elemeleri",
    "Europa League",
    "Conference League Qualification",
    "Uefa Avr. Konferans Ligi Elemeleri",
    // CONMEBOL kulüp — Libertadores'in eksikliği gerçek kesinti yarattı
    "Copa Libertadores",
    "CONMEBOL Libertadores",
    "Copa Sudamericana",
    // Millî takım
    "World Cup",
    "Copa America",
    "UEFA Nations League",
    "Africa Cup of Nations",
  ];

  for (const ad of kuresel) {
    test(ad, () => {
      assert.equal(isGlobalLeagueName(ad), true, `"${ad}" küresel sayılmalı`);
    });
  }
});

describe("hazırlık maçları küresel DEĞİL", () => {
  // DAVRANIŞ DEĞİŞTİ (2026-07-28): Bu desenler GLOBAL_LEAGUES içindeydi ve tek
  // sebebi ülke süzgecini atlatmaktı. Süzgeç kaldırılınca yan etkisi görüldü —
  // hazırlık maçları Şampiyonlar Ligi ile aynı öncelikte sayılıp listenin
  // tepesini kaplıyordu (ölçüldü: ilk 12 maçın 7'si hazırlık).
  // Artık ayrı sınıf: elenmiyorlar ama en sonda sıralanıyorlar.
  const hazirlik = [
    "Kulüplerarası Hazırlık Maçları",
    "Club Friendlies",
    "Pre-Season Cup",
    "Hazırlık Maçları - Öne Çıkanlar",
  ];

  for (const ad of hazirlik) {
    test(ad, () => {
      assert.equal(isGlobalLeagueName(ad), false, `"${ad}" küresel SAYILMAMALI`);
      assert.equal(isFriendlyLeague(ad), true, `"${ad}" hazırlık sayılmalı`);
      // Elenmediğini de doğrula: listede olmalı, sadece sonda.
      assert.equal(isExcludedLeague(ad), false, `"${ad}" elenmemeli`);
    });
  }
});

describe("küresel SAYILMAYANLAR", () => {
  test("ülke ligleri ülke filtresinden geçmeli", () => {
    for (const ad of ["Premier League", "Süper Lig", "Serie A", "Brezilya Serie B"]) {
      assert.equal(isGlobalLeagueName(ad), false, `"${ad}" küresel olmamalı`);
    }
  });

  test("kadın/gençlik turnuvaları küresel etiketle SIZAMAZ", () => {
    // Eleme listesi küresel desenlerden ÖNCE bakılmalı — yoksa "UEFA Women's
    // Champions League" ana listeye girer.
    for (const ad of [
      "UEFA Women's Champions League",
      "U19 Champions League",
      "Brasileiro A1 Kadınlar",
      "World Cup - Women U20",
    ]) {
      assert.equal(isGlobalLeagueName(ad), false, `"${ad}" elenmeliydi`);
    }
  });

  test("boş/bozuk girdi güvenli", () => {
    assert.equal(isGlobalLeagueName(""), false);
    assert.equal(isGlobalLeagueName(null), false);
    assert.equal(isGlobalLeagueName(undefined), false);
  });
});

describe("eleme listesi", () => {
  test("gençlik yaş grupları", () => {
    for (const ad of ["U17 Cup", "U-19 Liga", "U21 Premier", "U23 League"]) {
      assert.equal(isExcludedLeague(ad), true, `"${ad}" elenmeli`);
    }
  });

  test("normal ligler elenmez", () => {
    for (const ad of ["Premier League", "Ligue 1", "Süper Lig"]) {
      assert.equal(isExcludedLeague(ad), false, `"${ad}" elenmemeli`);
    }
  });
});
