"use strict";

/**
 * Nesine zenginleştirmesi — ülke ayrıştırma + tarih tamamlama.
 *
 * NEDEN TEST EDİLİYOR: Bu katmanın bozulma biçimi sessizdir. Ülke çözülemezse
 * fikstür senkronu (TR_TO_COUNTRY[""]) maçları hata vermeden eler; sonuç
 * "sıfır maç" olur ve kaynak ölmüş gibi görünür. Aynı şekilde tarih boş
 * kalırsa normalize() null döner. İkisi de günlerce fark edilmeyebilir.
 *
 * Ağ yok: saf fonksiyonlar sınanıyor, Puppeteer başlatılmıyor.
 *
 * Çalıştırma:  npm test
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const {
  enrichNesine,
  nesineCountryFromTitle,
  istanbulToday,
} = require("../services/livescore-scraper.cjs");

/** Nesine'nin ürettiği ham satır şekli. */
function row(over = {}) {
  return {
    homeTeam: "A", awayTeam: "B",
    startTime: "20:00", matchDate: "",
    isLive: false, isFinished: false,
    compTitle: "Brezilya Serie B", compCountry: "",
    ...over,
  };
}

describe("nesineCountryFromTitle", () => {
  test("ülke adı başlığın başındayken çözülür", () => {
    assert.equal(nesineCountryFromTitle("Brezilya Serie B"), "Brezilya");
    assert.equal(nesineCountryFromTitle("Arjantin Primera Nacional"), "Arjantin");
    assert.equal(nesineCountryFromTitle("Türkiye Süper Lig"), "Türkiye");
  });

  test("UEFA turnuvaları ülkeye değil Avrupa'ya yazılır", () => {
    assert.equal(nesineCountryFromTitle("Uefa Şampiyonlar Ligi Elemeleri"), "Avrupa");
    assert.equal(nesineCountryFromTitle("Uefa Avr. Konferans Ligi Elemeleri"), "Avrupa");
  });

  test("Türkçe büyük/küçük harf: İ ve I ayrımı doğru", () => {
    // "İSPANYA".toLowerCase() → "i̇spanya" (birleşik nokta) — tr-TR kullanılmazsa
    // eşleşme kaçar ve İspanya ligi sessizce kapsam dışı kalırdı.
    assert.equal(nesineCountryFromTitle("İSPANYA LA LIGA"), "İspanya");
    assert.equal(nesineCountryFromTitle("İNGİLTERE PREMIER LIG"), "İngiltere");
  });

  test("kapsam dışı ülke boş döner (sıralaması olmayan ülke eklenmemeli)", () => {
    assert.equal(nesineCountryFromTitle("Ekvador Pro Lig"), "");
    assert.equal(nesineCountryFromTitle("Faroe Adaları Premier Lig"), "");
    assert.equal(nesineCountryFromTitle("Nikaragua Prmr Ligi, Açılış"), "");
  });

  test("boş / anlamsız başlık patlamaz", () => {
    assert.equal(nesineCountryFromTitle(""), "");
    assert.equal(nesineCountryFromTitle(null), "");
    assert.equal(nesineCountryFromTitle("Kulüplerarası Hazırlık Maçları"), "");
  });

  test("ülke adı yalnızca BAŞTA aranır", () => {
    // Ortada geçen ülke adı ligi yanlış ülkeye yazmamalı.
    assert.equal(nesineCountryFromTitle("Kupa: Almanya Kulüpleri Turnuvası"), "");
  });
});

describe("enrichNesine", () => {
  // 2026-07-28 09:00 İstanbul = 06:00 UTC
  const NOW = Date.parse("2026-07-28T06:00:00Z");

  test("başlamamış maça bugünün tarihi + saati yazılır", () => {
    const [m] = enrichNesine([row({ startTime: "20:00" })], NOW);
    assert.equal(m.matchDate, "2026-07-28 20:00");
    assert.equal(m.compCountry, "Brezilya");
  });

  test("tek haneli saat sıfırla doldurulur", () => {
    const [m] = enrichNesine([row({ startTime: "9:30" })], NOW);
    assert.equal(m.matchDate, "2026-07-28 09:30");
  });

  test("gece yarısı kayması: çok geride kalan saat ertesi güne alınır", () => {
    // 22:00 İstanbul'dayken sayfada görünen 00:30'luk maç yarınındır.
    const gece = Date.parse("2026-07-28T19:00:00Z"); // 22:00 İstanbul
    const [m] = enrichNesine([row({ startTime: "00:30" })], gece);
    assert.equal(m.matchDate, "2026-07-29 00:30");
  });

  test("az önce başlamış maç bugüne yazılı kalır (erken kaydırma yok)", () => {
    // 09:00'da 08:00 maçı: 1 saat geride, eşiğin (6sa) içinde → bugün.
    const [m] = enrichNesine([row({ startTime: "08:00" })], NOW);
    assert.equal(m.matchDate, "2026-07-28 08:00");
  });

  test("canlı/bitmiş maçta saat yok — tarih boş bırakılır", () => {
    const [m] = enrichNesine([row({ startTime: "", isLive: true })], NOW);
    assert.equal(m.matchDate, "");
  });

  test("hazır gelen matchDate ezilmez", () => {
    const [m] = enrichNesine(
      [row({ matchDate: "2026-08-01 21:45", startTime: "20:00" })],
      NOW
    );
    assert.equal(m.matchDate, "2026-08-01 21:45");
  });

  test("bozuk saat biçimi yok sayılır", () => {
    const [m] = enrichNesine([row({ startTime: "MS" })], NOW);
    assert.equal(m.matchDate, "");
  });

  test("dizi olmayan girdi boş dizi döner", () => {
    assert.deepEqual(enrichNesine(null, NOW), []);
    assert.deepEqual(enrichNesine(undefined, NOW), []);
  });

  test("özgün alanlar korunur", () => {
    const [m] = enrichNesine([row({ homeTeam: "Botafogo", awayTeam: "Vasco" })], NOW);
    assert.equal(m.homeTeam, "Botafogo");
    assert.equal(m.awayTeam, "Vasco");
    assert.equal(m.isFinished, false);
  });
});

describe("istanbulToday", () => {
  test("UTC günü henüz dönmemişken İstanbul'da dönmüş olabilir", () => {
    // 22:30 UTC = ertesi gün 01:30 İstanbul (UTC+3)
    assert.equal(istanbulToday(Date.parse("2026-07-28T22:30:00Z")), "2026-07-29");
  });

  test("gün içi sabit", () => {
    assert.equal(istanbulToday(Date.parse("2026-07-28T06:00:00Z")), "2026-07-28");
  });
});
