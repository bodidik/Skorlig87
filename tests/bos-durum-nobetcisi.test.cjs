"use strict";

/**
 * BOŞ DURUM NÖBETÇİSİ — sezon arası kullanıcı deneyimi koruması.
 *
 * ⚠️ NEDEN VAR (2026-08-06): TR Süper Lig 14 Ağustos'ta başlıyor.
 * Arada Türk kullanıcı ana ekranda boş bir deneyimle karşılaşıyordu:
 *   - /open (tahmin sekmesi) yalnızca 96 saat ileri bakıyor → TR maçı yok
 *   - Kupon kartı kendini gizliyor → üstteki alan boş
 *   - countryFallback şeridi "Ülkenizde maç yok" → ama ne zaman olacağı yok
 *
 * Düzeltme: sunucu countryFallback yanında nextCountryMatchISO gönderiyor.
 * Mobil bu tarihi alınca "Lig X gün sonra başlıyor" diyor.
 *
 * ⚠️ BU TEST SUNUCU KODU VE MOBİL KODUN TUTARLI KALMASINI KİLİTLİYOR.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { mobilYol, mobilVarMi } = require("./_mobil-dizin.cjs");
const mobilVar = mobilVarMi();

test("live2.cjs sonrakiUlkeMaciISO fonksiyonu tanımlı", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "routes", "live2.cjs"), "utf8"
  );
  assert.ok(
    /async function sonrakiUlkeMaciISO/.test(src),
    "sonrakiUlkeMaciISO fonksiyonu live2.cjs icinde tanimli olmali"
  );
});

test("/schedule yanıtı countryFallback ve nextCountryMatchISO içeriyor", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "routes", "live2.cjs"), "utf8"
  );
  const scheduleBlok = src.slice(
    src.indexOf('router.get("/schedule"'),
    src.indexOf('router.get("/open"')
  );
  assert.ok(scheduleBlok.includes("countryFallback"),
    "/schedule yaniti countryFallback icermeli");
  assert.ok(scheduleBlok.includes("nextCountryMatchISO"),
    "/schedule yaniti nextCountryMatchISO icermeli");
});

test("/open yanıtı countryFallback ve nextCountryMatchISO içeriyor", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "routes", "live2.cjs"), "utf8"
  );
  const openBlok = src.slice(src.indexOf('router.get("/open"'));
  assert.ok(openBlok.includes("countryFallback"),
    "/open yaniti countryFallback icermeli");
  assert.ok(openBlok.includes("nextCountryMatchISO"),
    "/open yaniti nextCountryMatchISO icermeli");
});

test("Live2Resp tipi nextCountryMatchISO alanı içeriyor", (t) => {
  if (!mobilVar) return t.skip("mobil depo yan klasorde yok");
  const src = fs.readFileSync(mobilYol("app", "(tabs)", "live.tsx"), "utf8");
  assert.ok(src.includes("nextCountryMatchISO"),
    "live.tsx Live2Resp tipinde nextCountryMatchISO olmali");
});

test("loadOpen countryFallback okuyor (eski hata)", (t) => {
  if (!mobilVar) return t.skip("mobil depo yan klasorde yok");
  const src = fs.readFileSync(mobilYol("app", "(tabs)", "live.tsx"), "utf8");

  const loadOpenStart = src.indexOf("const loadOpen");
  const loadOpenEnd = src.indexOf("// eslint-disable-next-line", loadOpenStart);
  const loadOpenBody = src.slice(loadOpenStart, loadOpenEnd);

  assert.ok(
    loadOpenBody.includes("setCountryFallback"),
    "loadOpen icinde setCountryFallback OLMALI — eksikse countryFallback\n" +
    "seridi schedule'dan kalma bayat degerle gorunur, /open sonucunu yansitmaz"
  );
  assert.ok(
    loadOpenBody.includes("setNextCountryMatchISO"),
    "loadOpen icinde setNextCountryMatchISO OLMALI"
  );
});

test("seasonStartsIn i18n anahtarı tr ve en dillerinde var", (t) => {
  if (!mobilVar) return t.skip("mobil depo yan klasorde yok");
  const src = fs.readFileSync(mobilYol("lib", "i18n.ts"), "utf8");
  assert.ok(/seasonStartsIn:\s*".*\{n\}/.test(src),
    "seasonStartsIn anahtari {n} yer tutucusu icermeli");

  const trIdx = src.indexOf("  tr: {");
  const enIdx = src.indexOf("  en: {");
  assert.ok(trIdx >= 0 && enIdx >= 0, "tr ve en bloklari olmali");

  const trBlok = src.slice(trIdx, src.indexOf("  }", trIdx) + 3);
  const enBlok = src.slice(enIdx, src.indexOf("  }", enIdx) + 3);
  assert.ok(trBlok.includes("seasonStartsIn"), "tr blogunda seasonStartsIn olmali");
  assert.ok(enBlok.includes("seasonStartsIn"), "en blogunda seasonStartsIn olmali");
});

test("fallback şeridi nextCountryMatchISO ile geri sayım gösteriyor", (t) => {
  if (!mobilVar) return t.skip("mobil depo yan klasorde yok");
  const src = fs.readFileSync(mobilYol("app", "(tabs)", "live.tsx"), "utf8");

  assert.ok(src.includes('seasonStartsIn'),
    "live.tsx icinde seasonStartsIn i18n anahtari kullanilmali");
  assert.ok(src.includes('nextCountryMatchISO'),
    "live.tsx icinde nextCountryMatchISO durumu okunmali");
});
