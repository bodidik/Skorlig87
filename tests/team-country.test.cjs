"use strict";

/**
 * Takım → ülke eşlemesi ve takım bazlı öncelik.
 *
 * NEDEN VAR: Öncelik maçın `country` alanına bakıyordu; oysa kullanıcıyı
 * ilgilendiren TURNUVANIN ülkesi değil, sahadaki TAKIMIN ülkesidir.
 *
 * Gerçek ölçüm (2026-07-29, mackolik cache): Türk takımlı 5 maç vardı ve
 * hiçbiri "Türkiye" etiketli değildi —
 *   Avrupa | Şampiyonlar Ligi  | Gornik Zabrze - Fenerbahçe
 *   Dünya  | Hazırlık Maçları  | Alanyaspor - Pyramids
 *   Dünya  | Hazırlık Maçları  | AEK - Samsunspor
 *
 * Süper Lig sezon arasındayken Türk kullanıcının ilgisini çeken TEK içerik
 * buydu ve listenin dibinde kalıyordu.
 *
 * İki yönlü risk, ikisi de test altında:
 *   - Eşleşme ÇALIŞMAZSA → kendi takımın dibe düşer (asıl sorun)
 *   - Eşleşme FAZLA çalışırsa → alakasız takım kendi ülken sayılır, sıralama
 *     anlamını yitirir (kısa adlarda "içerir" araması bunu kolayca yapar)
 *
 * Çalıştırma:  npm test
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { teamCountry, fixtureHasCountryTeam } = require("../lib/team-country.cjs");
const { priorityOf, P_COUNTRY, P_GLOBAL, P_FRIENDLY } = require("../lib/fixture-priority.cjs");

describe("takım → ülke", () => {
  test("Türk takımları tanınır", () => {
    for (const t of ["Galatasaray", "Fenerbahçe", "Beşiktaş", "Trabzonspor", "Alanyaspor", "Samsunspor"]) {
      assert.equal(teamCountry(t), "Türkiye", `${t} Türkiye olmalı`);
    }
  });

  test("kaynak varyantları tolere edilir", () => {
    // Sağlayıcılar aynı takımı farklı yazıyor: "Fenerbahçe", "Fenerbahce SK",
    // "FC Fenerbahce". Biri kaçarsa maç yanlış gruba düşer.
    for (const t of ["Fenerbahce", "Fenerbahce SK", "FC Fenerbahce", "Beşiktaş JK", "Galatasaray SK"]) {
      assert.equal(teamCountry(t), "Türkiye", `"${t}" tanınmalı`);
    }
  });

  test("başka ülkelerin takımları doğru ülkeye gider", () => {
    assert.equal(teamCountry("Real Madrid"), "Spain");
    assert.equal(teamCountry("Barcelona"), "Spain");
  });

  test("YANLIŞ eşleşme yok — listede olmayan takım null", () => {
    // Kısa adlarda "içerir" araması kolayca yanlış eşleşir; bu test o riski
    // tutuyor. (Lugano burada YOK: FC Lugano gerçekten İsviçre kulübü ve
    // listede kayıtlı — ilk yazdığımda yanlışlıkla buraya koymuştum.)
    for (const t of ["AEK", "Pyramids", "Al Dhafra", "Thun"]) {
      assert.equal(teamCountry(t), null, `"${t}" hiçbir ülkeye atanmamalı`);
    }
  });

  test("listedeki yabancı takım kendi ülkesine gider", () => {
    assert.equal(teamCountry("Lugano"), "Switzerland");
  });

  test("boş/kısa girdi null döner", () => {
    assert.equal(teamCountry(""), null);
    assert.equal(teamCountry(null), null);
    assert.equal(teamCountry("FC"), null, "yalnızca ek kelimeden ibaret ad eşleşmemeli");
  });
});

describe("maçta ülke takımı var mı", () => {
  const mac = (home, away) => ({ home, away, league: "X", country: "World" });

  test("ev sahibi ya da deplasman yeterli", () => {
    assert.equal(fixtureHasCountryTeam(mac("Alanyaspor", "Pyramids"), "Türkiye"), true);
    assert.equal(fixtureHasCountryTeam(mac("AEK", "Samsunspor"), "Türkiye"), true);
  });

  test("ilgisiz maç false", () => {
    assert.equal(fixtureHasCountryTeam(mac("AEK", "Pyramids"), "Türkiye"), false);
  });

  test("ülke takma adıyla da çalışır", () => {
    assert.equal(fixtureHasCountryTeam(mac("Galatasaray", "X"), "Turkey"), true);
    assert.equal(fixtureHasCountryTeam(mac("Galatasaray", "X"), "TR"), true);
  });
});

describe("öncelik — takım bazlı ülke eşleşmesi", () => {
  const mac = (home, away, league, country) => ({ home, away, league, country });

  test("kendi takımının Şampiyonlar Ligi maçı EN ÜSTTE", () => {
    // "Avrupa" etiketli ama Fenerbahçe oynuyor → kullanıcının ülkesi sayılır.
    const f = mac("Gornik Zabrze", "Fenerbahçe", "Şampiyonlar Ligi", "Europe");
    assert.equal(priorityOf(f, "Türkiye"), P_COUNTRY);
    // Türk olmayan kullanıcı için yalnızca küresel turnuva.
    assert.equal(priorityOf(f, "Spain"), P_GLOBAL);
  });

  test("kendi takımının HAZIRLIK maçı dibe düşmez", () => {
    // Sezon arasında bu, Türk kullanıcının gördüğü tek içerik olabiliyor.
    const f = mac("Alanyaspor", "Pyramids", "Hazırlık Maçları Kulüpler", "World");
    assert.equal(priorityOf(f, "Türkiye"), P_COUNTRY);
  });

  test("YABANCI hazırlık maçı yine en sonda", () => {
    // Hazırlık indirgemesinin asıl amacı buydu: yabancı hazırlıklar listenin
    // tepesini kaplıyordu (ölçüldü: ilk 12 maçın 7'si).
    const f = mac("AEK", "Pyramids", "Hazırlık Maçları Kulüpler", "World");
    assert.equal(priorityOf(f, "Türkiye"), P_FRIENDLY);
  });

  test("kullanıcı ülkesi yoksa takım eşleşmesi devreye girmez", () => {
    const f = mac("Gornik Zabrze", "Fenerbahçe", "Şampiyonlar Ligi", "Europe");
    assert.equal(priorityOf(f, ""), P_GLOBAL);
  });
});
