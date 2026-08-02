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
 * ⚠️ SONRADAN KAPATILDI: "EC Vitória" bir süre Portugal dönüyordu ve burada
 * "bilinen sınır" olarak işaretliydi. Brezilya'nın Vitória'sı veri dosyasına
 * eklendi, ama tek başına yetmedi — ek atma iki kulübü aynı çekirdeğe
 * indiriyordu. Tam-ad katmanıyla çözüldü; aşağıdaki testte ayrıntısı var.
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
  /**
   * ⚠️ "Aris" BU LİSTEDEN ÇIKARILDI — ve nedeni bu testin iddiasını
   * güçlendiriyor. Ölçüm sırasında "Aris" iki adaylıydı (Greece, France) ama
   * Fransa adayı UYDURMAYDI: "aris" çekirdeği "p-ARIS" içinde, sözcüğün
   * ORTASINDA eşleşiyordu. Sonraki turda içerme kuralı sözcük başına
   * bağlanınca sahte aday düştü ve "Aris" → Greece tek doğru cevap oldu
   * (bkz. tests/takim-eki-ve-sozcuk-basi.test.cjs).
   *
   * Yani belirsizlik korumasının kendisi doğru; girdi belirsiz DEĞİLDİ.
   */
  const BELIRSIZ = ["Inter", "Atlético", "Port", "Union", "Lokomotiv", "Athletic Club"];

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
   * ⚠️ ORAN, MUTLAK SAYI DEĞİL — VE BU BİR KEZ YANLIŞ YAPILDI. İlk yazım
   * [300, 500] mutlak aralığı donduruyordu; ölçüm anında 1944 benzersiz adın
   * 360'ı (%18.5) ülke buluyordu. Arka plan senkronu hafta sonu maçlarını
   * çekince ad sayısı 3203'e çıktı, bulunan 519 oldu (%16.2 — oran AYNI
   * bölgede) ve test "koruma gevşemiş" diye YANLIŞ alarm verdi. Canlı veri
   * dosyasında mutlak sayı dondurmak, testi veri hacmine bağlar; aynı tuzağa
   * `takim-aksan-normallestirme` testinde de düşülmüştü.
   *
   * Aralık iki yönlü: oran çok düşerse eşleştirme kırılmış, çok yükselirse
   * belirsizlik koruması gevşemiş demektir (katalog ~460 takım; fikstürdeki
   * binlerce adın çoğunluğunun ülke BULAMAMASI beklenen durum).
   */
  const dosya = path.join(KOK, "data", "fixtures.json");
  if (!fs.existsSync(dosya)) return t.skip("fikstur verisi yok");
  const items = JSON.parse(fs.readFileSync(dosya, "utf8")).fixtures || [];
  if (items.length < 100) return t.skip("yeterli fikstur yok");

  const adlar = new Set();
  for (const f of items) { if (f?.home) adlar.add(f.home); if (f?.away) adlar.add(f.away); }
  const bulunan = [...adlar].filter((a) => TC.teamCountry(a)).length;
  const oran = bulunan / adlar.size;

  assert.ok(oran >= 0.08,
    `adlarin yalnizca %${(100 * oran).toFixed(1)}'i ulke buluyor (${bulunan}/${adlar.size}) — eslestirme kirilmis (olculen taban ~%16-18)`);
  assert.ok(oran <= 0.40,
    `adlarin %${(100 * oran).toFixed(1)}'i ulke buluyor (${bulunan}/${adlar.size}) — belirsizlik korumasi gevsemis olabilir`);
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

test("İKİ AYRI VITÓRIA kendi ülkesine gidiyor", () => {
  /**
   * ⚠️ BU TEST ESKİDEN BİLİNEN BİR SINIRI İŞARETLİYORDU: "EC Vitória"
   * (Brezilya) Portugal dönüyordu ve testte "veri düzelince beni SİL" yazılıydı.
   * Düzeltildi — ama beklediğimden başka bir yerden.
   *
   * VERİYE EKLEMEK TEK BAŞINA YETMİYORDU: ek atma iki kulübü aynı çekirdeğe
   * indiriyor —
   *     "EC Vitória" ("ec" atılır) → "vitoria"
   *     "Vitória SC" ("sc" atılır) → "vitoria"
   * Çekirdek indeksinde ilk gelen kazandığı için, Brezilya'yı listeye eklemek
   * dosya sırası yüzünden sessizce yok sayılıyordu.
   *
   * ÇÖZÜM: ek ATILMADAN önceki tam ad da indeksleniyor ve önce ona bakılıyor
   * (bkz. lib/team-country.cjs indeks()). İkisi de gerçek veride var —
   * "EC Vitória" 5 maç, "Vitória SC" 3 maç — yani biri uğruna ötekini feda
   * etmek gerçek bir bedeldi.
   */
  assert.equal(TC.teamCountry("EC Vitória"), "Brazil", "Brezilya kulubu yanlis ulkede");
  assert.equal(TC.teamCountry("Vitória SC"), "Portugal", "Portekiz kulubu yanlis ulkede");
  // Aksansız yazımlar da aynı yere gitmeli (kaynaklar iki biçimi de gönderiyor).
  assert.equal(TC.teamCountry("EC Vitoria"), "Brazil");
  assert.equal(TC.teamCountry("Vitoria SC"), "Portugal");
});

test("NÖBETÇİ: belirsiz çekirdek indeksten DÜŞÜRÜLÜYOR", () => {
  /**
   * Tam-ad katmanı eklenirken çekirdek indeksine de belirsizlik koruması
   * kondu: bir çekirdek birden çok ülkeye denk geliyorsa hiçbirine sayılmaz.
   * Olmasaydı "Vitória" gibi çıplak bir ad, dosya sırasına göre rastgele bir
   * ülkeye giderdi.
   */
  const src = fs.readFileSync(path.join(KOK, "lib", "team-country.cjs"), "utf8")
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");
  assert.ok(/for \(const k of cakisan\) cekirdekIx\.delete\(k\);/.test(src), "cakisan cekirdek dusurulmuyor");
  assert.ok(/tamIx\.has\(tamAd\)/.test(src), "tam ad katmani kalkmis");
});
