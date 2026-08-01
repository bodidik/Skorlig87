"use strict";

/**
 * ÜLKE EŞLEŞTİRME KANONİK TABLOYU KULLANIR.
 *
 * ⚠️ BULUNAN: `lib/fixture-priority.cjs sameCountry` ELLE YAZILMIŞ tek bir
 * istisna taşıyordu — yalnızca Türkiye'nin dört yazımı. Oysa
 * `lib/countries.cjs` zaten takma ad + ISO2 tablosu tutuyor ve
 * `normalizeCountry` ile kanonik ada çeviriyor. Aynı kuralın iki kopyası,
 * biri eksik: bu oturumun baskın kusur biçimi.
 *
 * ÖLÇÜLDÜ (tablodaki 103 takma ad, her biri kendi kanonik adına karşı):
 *     önce : 99 EŞLEŞMİYOR
 *     sonra: 0
 * "Almanya" ↔ "Germany", "İspanya" ↔ "Spain", "İngiltere" ↔ "England"
 * hepsi başarısızdı.
 *
 * ⚠️ ETKİSİNİ ABARTMIYORUM — ve bunu ölçerek söylüyorum: gerçek
 * `data/fixtures.json` verisinde 77 ülkenin 62'si ZATEN eşleşiyordu
 * (0 başarısız), çünkü hem fikstür hem kullanıcı ülkesi kanonik yazımda
 * tutuluyor. Kusur, kanonik OLMAYAN bir ad geldiğinde ısırıyor: eski kayıt,
 * elle girilen fikstür, ya da Türkçe ad yazan bir istemci. Bu projede tam o
 * durum bir kez yaşandı — 837 kullanıcı Türkçe ad reddi yüzünden ülkesiz
 * kalmıştı.
 *
 * ⚠️ ÜLKE ELEME DEĞİL SIRALAMA ÖLÇÜTÜ (dosya başlığının kendi kararı), yani
 * sonuç "maç kaybolur" değil "kendi ülkesinin maçı üste çıkmaz".
 */

const test = require("node:test");
const describe = require("node:test").describe;
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
const FP = require("../lib/fixture-priority.cjs");
const { ULKELER, selectableCountries, normalizeCountry } = require("../lib/countries.cjs");

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("takma ad tablosu dolu", () => {
    const adet = Object.values(ULKELER).reduce((a, b) => a + (b.aliases?.length || 0), 0);
    assert.ok(adet > 50, `yalnizca ${adet} takma ad — tablo beklenenden kucuk, test bir sey olcmuyor`);
  });

  test("aynı ad kendisiyle eşleşiyor", () => {
    assert.equal(FP.sameCountry("Germany", "Germany"), true);
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("takma adlar", () => {
  test("tablodaki HER takma ad kanonik adıyla eşleşiyor", () => {
    const bozuk = [];
    for (const [kanonik, bilgi] of Object.entries(ULKELER)) {
      for (const a of bilgi.aliases || []) {
        if (!FP.sameCountry(a, kanonik)) bozuk.push(`${a} != ${kanonik}`);
      }
    }
    assert.deepEqual(
      bozuk.slice(0, 8), [],
      `${bozuk.length} takma ad eslesmedi — kanonik tablo kullanilmiyor olabilir`
    );
  });

  test("Türkçe adlar İngilizce karşılıklarıyla eşleşiyor", () => {
    for (const [tr, en] of [
      ["Almanya", "Germany"], ["İspanya", "Spain"], ["İngiltere", "England"],
      ["Fransa", "France"], ["İtalya", "Italy"], ["Türkiye", "Turkey"],
    ]) {
      assert.equal(FP.sameCountry(tr, en), true, `${tr} != ${en}`);
      assert.equal(FP.sameCountry(en, tr), true, `${en} != ${tr} (ters yon)`);
    }
  });
});

describe("yanlış eşleşme üretilmiyor", () => {
  test("FARKLI ülkeler eşleşmiyor", () => {
    /**
     * ⚠️ Gevşetmenin bedeli olmadığının kanıtı. Kanonik tabloya düşmek her
     * şeyi birbirine eşitleseydi, kullanıcı kendi ülkesi diye HERKESİN maçını
     * üstte görürdü — yani öncelik sınıfı fiilen ölürdü.
     */
    for (const [a, b] of [
      ["Germany", "Spain"], ["Almanya", "Fransa"], ["Turkey", "Greece"],
      ["England", "Scotland"], ["Ireland", "Northern Ireland"],
    ]) {
      assert.equal(FP.sameCountry(a, b), false, `${a} ile ${b} yanlis eslesti`);
    }
  });

  test("boş/tanımsız değerler eşleşmiyor", () => {
    for (const v of ["", null, undefined, "   "]) {
      assert.equal(FP.sameCountry(v, "Germany"), false);
      assert.equal(FP.sameCountry("Germany", v), false);
    }
  });

  test("tanınmayan iki ad birbirine eşitlenmiyor", () => {
    // normalizeCountry tanimadigini kirpip geri veriyor; iki farkli bilinmeyen
    // ad aynı sayılmamalı.
    assert.equal(FP.sameCountry("Atlantis", "Wakanda"), false);
    assert.equal(FP.sameCountry("Atlantis", "Atlantis"), true);
  });
});

/* ── Gerçek veriyle ──────────────────────────────────────────────────────── */

test("gerçek fikstürlerde kendi ülkesinin maçı üst sırada", (t) => {
  /**
   * ⚠️ DÜRÜST ÖLÇÜM: bu test düzeltmeden ÖNCE de geçiyordu (62/62), çünkü
   * gerçek veri kanonik yazımda. Yine de duruyor: kanonik yazım bozulursa
   * ya da öncelik sınıfı kaybolursa yakalar.
   */
  const dosya = path.join(KOK, "data", "fixtures.json");
  if (!fs.existsSync(dosya)) return t.skip("fikstur verisi yok");
  const items = (JSON.parse(fs.readFileSync(dosya, "utf8")).fixtures || []).filter((f) => f?.country);
  if (items.length < 100) return t.skip("yeterli fikstur yok");

  const secilebilir = selectableCountries()
    .map((x) => (typeof x === "string" ? x : x.name || x.kanonik || x.id))
    .filter(Boolean);

  let bakilan = 0;
  const basarisiz = [];
  for (const ulke of secilebilir) {
    const ornek = items.find((f) => normalizeCountry(f.country) === normalizeCountry(ulke));
    if (!ornek) continue;
    bakilan++;
    if (FP.priorityOf(ornek, ulke) !== FP.P_COUNTRY) {
      basarisiz.push(`${ulke} (fikstur: "${ornek.country}")`);
    }
  }
  assert.ok(bakilan > 20, `yalnizca ${bakilan} ulke sinandi — tarama bozuk`);
  assert.deepEqual(basarisiz.slice(0, 5), [], `${basarisiz.length} ulkede kendi maci ust siraya cikmiyor`);
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: elle ülke listesi yerine kanonik tablo kullanılıyor", () => {
  const src = fs.readFileSync(path.join(KOK, "lib", "fixture-priority.cjs"), "utf8")
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");

  assert.ok(/normalizeCountry/.test(src), "kanonik esleyici kullanilmiyor");
  assert.ok(
    !/new Set\(\["türkiye"/.test(src),
    "elle yazilmis ulke istisnasi geri gelmis — tablo disinda kalan 99 takma ad yine eslesmez"
  );
});
