"use strict";

/**
 * BELİRSİZ TAKIM ADI YANLIŞ ÜLKEYE ATANMAZ.
 *
 * ⚠️ BULUNAN: `lib/team-country.cjs teamCountry` tam eşleşme bulamayınca
 * "içerme" aramasına düşüyor ve İLK eşleşmede duruyordu. Yani sonuç, Map'in
 * ekleme sırasına — dolayısıyla `data/countries-teams.json` içindeki ülke
 * sırasına — bağlıydı.
 *
 * ÖLÇÜLDÜ (gerçek veri: 1944 takım adı; 218 tam + 149 içerme eşleşmesi):
 * içerme eşleşmelerinin 7'sinde BİRDEN ÇOK ülke adayı vardı ve tek biri
 * seçiliyordu —
 *     "Inter"        → Italy    (adaylar: Italy, Switzerland, USA, Brazil)
 *     "Atlético"     → Spain    (adaylar: Spain, Brazil, Mexico)
 *     "Port"         → Spain    (adaylar: Spain, Portugal, Switzerland, USA)
 *     "Union"        → Belgium  (adaylar: Belgium, Germany, USA)
 *     "Lokomotiv"    → Russia   (adaylar: Russia, Croatia)
 *     "Aris", "Athletic Club" — benzer
 * Kabaca yarısı doğru, yarısı yanlıştı: yazı tura.
 *
 * Dosyanın kendi notu bunu zaten uyarıyordu: "yanlış eşleşme, maçı yanlış
 * ülkeye atar ki bu SESSİZ bir hata olur."
 *
 * ⚠️ BEDELİ ÖLÇÜLDÜ: ülkesi bulunan takım 367 → 360. Yani doğru tahmin edilen
 * birkaç ad da (ör. "Athletic Club" → Spain) artık ülkesiz kalıyor. Ülke
 * burada ELEME değil SIRALAMA ölçütü, yani maç kaybolmuyor — yalnızca "kendi
 * ülkem" grubuna girmiyor. Yanlış ülkeye atamaktansa atamamak yeğdir; aynı
 * karar bu oturumda `services/odds-engine.cjs getRating` için de verilmişti.
 *
 * ⚠️ KAPSAM DIŞI KALAN, DÜRÜSTÇE: "EC Vitória" hâlâ Portugal dönüyor. Bu bir
 * BELİRSİZLİK değil VERİ EKSİĞİ — Brezilya'nın Vitória'sı
 * `data/countries-teams.json` içinde yok, o yüzden tek aday Portekiz. Veri
 * dosyasına körlemesine takım eklemedim; aşağıda nöbetçi olarak işaretli.
 */

const test = require("node:test");
const describe = require("node:test").describe;
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
const TC = require("../lib/team-country.cjs");

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("bilinen takımlar hâlâ bulunuyor", () => {
    for (const [ad, ulke] of [
      ["Fenerbahçe", "Türkiye"],
      ["Galatasaray", "Türkiye"],
      ["Real Madrid CF", "Spain"],
      ["CR Flamengo", "Brazil"],
    ]) {
      assert.equal(TC.teamCountry(ad), ulke, `${ad} artik bulunamiyor — duzeltme fazla kesti`);
    }
  });

  test("ad varyantları hâlâ eşleşiyor (içerme yolu ölmedi)", () => {
    // Kaynaklar "Fenerbahçe SK", "FC Fenerbahce" gibi varyantlar gönderiyor.
    for (const ad of ["Fenerbahce SK", "FC Fenerbahce", "Fenerbahçe A.Ş."]) {
      assert.equal(TC.teamCountry(ad), "Türkiye", `${ad} eslesmedi — icerme yolu kirilmis`);
    }
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("belirsiz adlar tahmin edilmiyor", () => {
  const BELIRSIZ = ["Inter", "Atlético", "Port", "Union", "Lokomotiv", "Athletic Club", "Aris"];

  for (const ad of BELIRSIZ) {
    test(`"${ad}" ülke ATAMIYOR`, () => {
      assert.equal(
        TC.teamCountry(ad), null,
        `${ad} bir ulkeye atandi — birden cok aday varken tahmin ediliyor, ` +
          "mac yanlis kullanicinin 'kendi ulkem' grubuna girer"
      );
    });
  }

  test("belirsiz ad hiçbir ülkenin maçı sayılmıyor", () => {
    const mac = { home: "Inter", away: "Union", league: "Friendly", country: "World" };
    for (const u of ["Italy", "Germany", "Belgium", "United States", "Brazil"]) {
      assert.equal(
        TC.fixtureHasCountryTeam(mac, u), false,
        `belirsiz adli mac ${u} kullanicisinin kendi ulkesi sayildi`
      );
    }
  });
});

describe("sonuç ekleme sırasına bağlı değil", () => {
  test("aynı ad her çağrıda AYNI sonucu veriyor", () => {
    /**
     * Eski kodun asıl kusuru determinizm eksikliğiydi: sonuç veri
     * dosyasındaki ülke sırasına bağlıydı. Sıra değişmese bile bu değişmezi
     * yazmak, "ilk eşleşen kazanır" mantığının geri gelmesini görünür kılar.
     */
    for (const ad of ["Inter", "Fenerbahçe", "Real Madrid CF", "Port"]) {
      const ilk = TC.teamCountry(ad);
      for (let i = 0; i < 5; i++) assert.equal(TC.teamCountry(ad), ilk, `${ad} kararsiz`);
    }
  });
});

/* ── Gerçek veriyle ──────────────────────────────────────────────────────── */

test("gerçek fikstürlerde kapsam makul kaldı", (t) => {
  /**
   * ⚠️ TAM SAYI DONDURULMUYOR. Ölçüm anında 1944 takım adının 360'ı ülke
   * buluyordu (düzeltmeden önce 367). Aralık iki yönlü: çok düşerse eşleşme
   * kırılmış, çok yükselirse belirsizlik koruması gevşemiş demektir.
   */
  const dosya = path.join(KOK, "data", "fixtures.json");
  if (!fs.existsSync(dosya)) return t.skip("fikstur verisi yok");
  const items = JSON.parse(fs.readFileSync(dosya, "utf8")).fixtures || [];
  if (items.length < 100) return t.skip("yeterli fikstur yok");

  const adlar = new Set();
  for (const f of items) { if (f?.home) adlar.add(f.home); if (f?.away) adlar.add(f.away); }
  const bulunan = [...adlar].filter((a) => TC.teamCountry(a)).length;

  assert.ok(bulunan >= 300, `yalnizca ${bulunan} takim ulke buluyor — olcum aninda 360 idi, eslestirme kirilmis`);
  assert.ok(bulunan <= 500, `${bulunan} takim ulke buluyor — belirsizlik korumasi gevsemis olabilir`);
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: içerme araması ilk eşleşmede DURMUYOR", () => {
  const src = fs.readFileSync(path.join(KOK, "lib", "team-country.cjs"), "utf8")
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");

  assert.ok(/adaylar\.size > 1\) return null/.test(src), "belirsizlik korumasi kalkmis");
  assert.ok(
    !/if \(k\.includes\(bilinen\) \|\| bilinen\.includes\(k\)\) return ulke;/.test(src),
    "ilk-eslesen-kazanir mantigi geri gelmis"
  );
});

test("NÖBETÇİ: EC Vitória veri eksiği hâlâ açık (bilinen sınır)", () => {
  /**
   * ⚠️ BU TEST BİR KUSURU KİLİTLEMİYOR, BİLİNEN BİR SINIRI İŞARETLİYOR.
   * "EC Vitória" Brezilya kulübü ama `countries-teams.json` içinde yalnızca
   * Portekiz'in Vitória'sı var — tek aday olduğu için belirsizlik koruması
   * devreye girmiyor ve Portugal dönüyor. Veri dosyasına körlemesine takım
   * eklemek, ölçmediğim başka eşleşmeleri bozabilirdi.
   *
   * Brezilya listesine Vitória eklenirse bu test kırılır ve o an SİLİNMELİDİR
   * — kırılması iyi haberdir.
   */
  assert.equal(
    TC.teamCountry("EC Vitória"), "Portugal",
    "EC Vitoria artik Portugal donmuyor — veri duzeltilmis olabilir, bu testi SIL"
  );
});
