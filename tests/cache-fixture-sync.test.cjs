"use strict";

/**
 * Cache → fikstür senkronu: ülke çözümleme.
 *
 * NEDEN TEST EDİLİYOR: Şelalenin hangi kaynakta durduğu ülke adının DİLİNİ
 * belirliyor — Maçkolik/nesine Türkçe, goal/espn İngilizce üretiyor. Çözümleme
 * yalnızca bir dili tanırsa maçlar HATA VERMEDEN elenir; kaynak sağlıklı
 * görünürken fikstür sıfır kalır. Production'da tam olarak bu yaşandı:
 * goal 50 maç buluyordu, fikstüre 0 tanesi geçiyordu.
 *
 * Çalıştırma:  npm test
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { resolveCountry, normalize } = require("../services/mackolik-fixture-sync.cjs");

describe("resolveCountry", () => {
  test("Türkçe adlar (Maçkolik / nesine)", () => {
    assert.equal(resolveCountry("Brezilya"), "Brazil");
    assert.equal(resolveCountry("İngiltere"), "England");
    assert.equal(resolveCountry("Türkiye"), "Türkiye");
    assert.equal(resolveCountry("Avrupa"), "Europe");
  });

  test("İngilizce adlar (goal / espn)", () => {
    assert.equal(resolveCountry("Brazil"), "Brazil");
    assert.equal(resolveCountry("Argentina"), "Argentina");
    assert.equal(resolveCountry("Bulgaria"), "Bulgaria");
    assert.equal(resolveCountry("Europe"), "Europe");
  });

  test("İngilizcesi kanonikten farklı olanlar", () => {
    // "Turkey" ALLOWED'da yok — kanonik ad "Türkiye". Eşlenmezse Türk
    // kullanıcının maçları elenirdi ki asıl derdimiz oydu.
    assert.equal(resolveCountry("Turkey"), "Türkiye");
    assert.equal(resolveCountry("International"), "World");
    assert.equal(resolveCountry("United States"), "USA");
    assert.equal(resolveCountry("Czechia"), "Czech Republic");
  });

  test("kapsam dışı ülke null döner", () => {
    // Sıralaması olmayan ülkeyi kabul etmek lig filtresini bozar.
    assert.equal(resolveCountry("Ecuador"), null);
    assert.equal(resolveCountry("Iceland"), null);
    assert.equal(resolveCountry("Uzbekistan"), null);
    assert.equal(resolveCountry("South Korea"), null);
  });

  test("boş / bozuk girdi null döner", () => {
    assert.equal(resolveCountry(""), null);
    assert.equal(resolveCountry(null), null);
    assert.equal(resolveCountry(undefined), null);
    assert.equal(resolveCountry("   "), null);
  });
});

describe("normalize — kaynak bağımsızlığı", () => {
  const yarin = new Date(Date.now() + 26 * 3600 * 1000)
    .toISOString().slice(0, 10);

  function mac(country) {
    return {
      country,
      homeTeam: "Botafogo", awayTeam: "Vasco",
      league: "Serie A", isFinished: false, isLive: false,
      matchDate: `${yarin} 21:00`,
    };
  }

  test("Türkçe ve İngilizce girdi AYNI fikstürü üretir", () => {
    const tr = normalize(mac("Brezilya"));
    const en = normalize(mac("Brazil"));
    assert.ok(tr, "Türkçe girdi fikstür üretmeli");
    assert.ok(en, "İngilizce girdi fikstür üretmeli");
    assert.equal(tr.country, "Brazil");
    assert.equal(en.country, "Brazil");
    // Kimlik kaynaktan bağımsız olmalı: aynı maç iki kaynaktan gelirse
    // fixtures.json'da çift kayıt oluşmasın.
    assert.equal(tr.fixtureId, en.fixtureId);
  });

  test("bitmiş maç fikstür olmaz", () => {
    assert.equal(normalize({ ...mac("Brazil"), isFinished: true }), null);
  });

  test("geçmiş maç fikstür olmaz", () => {
    assert.equal(
      normalize({ ...mac("Brazil"), matchDate: "2020-01-01 21:00" }),
      null
    );
  });

  test("tarihi olmayan maç fikstür olmaz", () => {
    assert.equal(normalize({ ...mac("Brazil"), matchDate: "" }), null);
  });

  test("kapsam dışı ülke fikstür olmaz", () => {
    assert.equal(normalize(mac("Ecuador")), null);
  });
});
