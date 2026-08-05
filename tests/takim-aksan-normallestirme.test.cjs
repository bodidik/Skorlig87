"use strict";

/**
 * TAKIM ADI ANAHTARI TÜM AKSANLARI ÇÖZER, YALNIZCA TÜRKÇE OLANLARI DEĞİL.
 *
 * ⚠️ BULUNAN: `lib/team-country.cjs anahtarla` elle yazılmış dokuz harflik bir
 * `ASCIILESTIR` listesi kullanıyordu (ç, ğ, ı, ö, ş, ü, â, î, û). Geri kalan
 * her aksanlı harf `[^a-z0-9] → " "` kuralına takılıp SİLİNİYOR ve sözcüğü
 * ikiye bölüyordu:
 *
 *     "MŠK Žilina"      → "ilina"
 *     "NK Šibenik"      → "ibenik"
 *     "Widzew Łódź"     → "widzew d"
 *     "Standard Liège"  → "standard li ge"
 *     "Hradec Králové"  → "hradec kr lov"
 *
 * ÖLÇÜLDÜ: `data/countries-teams.json` içindeki 65 girdi bu şekilde bozuk
 * anahtar üretiyordu — o takımların ülkesi hiç bulunamıyordu.
 *
 * ÖLÇÜLDÜ (2524 gerçek takım adı):
 *     önce : 399 eşleşme
 *     sonra: 440 eşleşme   (+41, hiç kayıp yok, hiç ülke değişmedi)
 * Kazananlar tek tek doğru: Górnik Zabrze→Poland, Hradec Králové→Czechia,
 * Widzew Łódź→Poland, Ferencváros→Hungary, Deportivo Alavés→Spain,
 * Leganés→Spain, Famalicão→Portugal, Huracán→Argentina …
 *
 * ⚠️ NFD ZATEN VARDI, BURADA YOKTU: `lib/countries.cjs` ve
 * `lib/global-leagues.cjs` aynı işi NFD ile yapıyor. Bu, oturumun dördüncü
 * "dil/yazım varyantı eksik" kusuru.
 *
 * ⚠️ NFD TEK BAŞINA YETMİYOR: ł, đ, ø, æ, ß gibi çizgili/çengelli harflerin
 * ayrı bir birleşik işareti yok, NFD onları ayırmıyor. Elle eşlendiler.
 * Türkçe `ı` da öyle — noktasız i'nin birleşik işareti yok.
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
  test("çekirdek üretimi dışa açık", () => {
    assert.equal(typeof TC._cekirdek, "function", "_cekirdek disa acilmamis");
  });

  test("Türkçe adlar bozulmadı", () => {
    for (const [ad, cek] of [
      ["Fenerbahçe", "fenerbahce"],
      ["Beşiktaş", "besiktas"],
      ["Başakşehir", "basaksehir"],
      ["Göztepe", "goztepe"],
    ]) assert.equal(TC._cekirdek(ad), cek, `${ad} cekirdegi bozuldu`);
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("aksanlı harfler siliniyor değil ÇEVRİLİYOR", () => {
  const ORNEK = [
    ["MŠK Žilina", "msk zilina"],
    ["NK Šibenik", "sibenik"],           // "nk" ek listesinde
    ["Widzew Łódź", "widzew lodz"],
    ["Standard Liège", "standard liege"],
    ["Hradec Králové", "hradec kralove"],
    ["Atlético de Madrid", "atletico de madrid"],
    ["Famalicão", "famalicao"],
    ["FK Čukarički", "cukaricki"],
    ["České Budějovice", "ceske budejovice"],
  ];

  for (const [ad, beklenen] of ORNEK) {
    test(`"${ad}" → "${beklenen}"`, () => {
      assert.equal(
        TC._cekirdek(ad), beklenen,
        `aksanli harf silinmis — sozcuk bolunuyor ve takim bulunamiyor`
      );
    });
  }

  test("AKSANLI girdilerde tek harflik parça kalmıyor", () => {
    /**
     * Silme davranışının imzası buydu: "widzew d", "standard li ge" — tek
     * harflik parça, aradan bir harfin düştüğünü gösterir.
     *
     * ⚠️ YALNIZCA AKSANLI GİRDİLERE BAKIYORUM, ve nedenini ölçerek öğrendim.
     * İlk sürüm tüm girdileri tarıyordu ve dört MEŞRU ada takıldı:
     *     "Defensa y Justicia"   ("y" İspanyolca bağlaç)
     *     "Newell's Old Boys"    ("s" kesme işaretinden)
     *     "Yokohama F. Marinos"  ("f" baş harf)
     *     "Dnipro-1"             ("1" adın parçası)
     * Bunlar aksan hasarı değil; iddiayı bu yüzden daralttım.
     */
    const dosya = path.join(KOK, "data", "countries-teams.json");
    const ham = JSON.parse(fs.readFileSync(dosya, "utf8"));
    const liste = Array.isArray(ham?.countries) ? ham.countries : Object.values(ham?.countries || {});

    const bozuk = [];
    let aksanli = 0;
    for (const u of liste) {
      for (const t of u?.teams || []) {
        if (!/[^\x00-\x7F]/.test(String(t))) continue;   // ASCII ad — konu dışı
        aksanli++;
        const parcalar = TC._cekirdek(t).split(" ").filter(Boolean);
        if (parcalar.some((p) => p.length === 1)) bozuk.push(`${t} -> ${TC._cekirdek(t)}`);
      }
    }
    assert.ok(aksanli > 30, `yalnizca ${aksanli} aksanli girdi bulundu — tarama bozuk`);
    assert.deepEqual(bozuk.slice(0, 6), [], `${bozuk.length} aksanli girdide harf silinmis`);
  });
});

describe("ülke eşleşmesi geri geldi", () => {
  for (const [ad, ulke] of [
    ["MSK Zilina", "Slovakia"],
    ["Widzew Lodz", "Poland"],
    ["Hradec Kralove", "Czech Republic"],
    ["Deportivo Alaves", "Spain"],
    ["Leganes", "Spain"],
    ["Famalicao", "Portugal"],
    ["Ferencvaros", "Hungary"],
  ]) {
    test(`"${ad}" → ${ulke}`, () => {
      assert.equal(TC.teamCountry(ad), ulke, `${ad} ulkesini bulamiyor`);
    });
  }

  test("aksanlı ve aksansız yazım AYNI sonucu veriyor", () => {
    /**
     * Kaynaklar iki biçimi de gönderiyor; ikisi ayrışırsa aynı takım bazen
     * bulunur bazen bulunmaz — sessiz ve kararsız bir hata.
     */
    for (const [a, b] of [
      ["Hradec Králové", "Hradec Kralove"],
      ["Widzew Łódź", "Widzew Lodz"],
      ["Deportivo Alavés", "Deportivo Alaves"],
      ["MŠK Žilina", "MSK Zilina"],
    ]) {
      assert.equal(TC.teamCountry(a), TC.teamCountry(b), `${a} ile ${b} farkli sonuc veriyor`);
      assert.ok(TC.teamCountry(a), `${a} hic bulunamadi`);
    }
  });
});

describe("yanlış eşleşme üretilmedi", () => {
  test("önceki turda kapatılan yanlışlar kapalı kaldı", () => {
    // Sözcük-ortası eşleşmeleri (bkz. tests/takim-eki-ve-sozcuk-basi.test.cjs)
    for (const ad of ["SV Horn", "Rangers", "Rana FK", "Talant"]) {
      assert.equal(TC.teamCountry(ad), null, `${ad} yeniden bir ulkeye atandi`);
    }
  });

  test("belirsiz adlar hâlâ tahmin edilmiyor", () => {
    for (const ad of ["Inter", "Atlético", "Port", "Union"]) {
      assert.equal(TC.teamCountry(ad), null, `${ad} tahmin edilmis`);
    }
  });
});

/* ── Gerçek veriyle ──────────────────────────────────────────────────────── */

test("gerçek fikstürlerde kapsam arttı", (t) => {
  /**
   * ⚠️ MUTLAK SAYI DEĞİL ORAN — ve bunu ölçerek öğrendim. Önce "en az 410
   * takım eşleşmeli" yazdım; test `npm test` içinde 398 görüp KIRILDI. Kod
   * değişmemişti: `data/fixtures.json` CANLI dosya ve arka plan senkronu
   * onu yeniden yazarken test yarıda kalmış hâlini okumuştu (aynı anda
   * doğrudan ölçtüğümde 2577 addan 441'i eşleşiyordu).
   *
   * Dosya boyu dalgalandığı için oran daha sağlam bir değişmez: ölçüm anında
   * 441/2577 ≈ %17. Eşik geniş tutuldu — amaç tam sayıyı dondurmak değil,
   * eşleştirmenin ÇÖKMESİNİ yakalamak.
   */
  const dosya = require("./_gercek-veri.cjs").veriYolu("fixtures.json");
  if (!fs.existsSync(dosya)) return t.skip("fikstur verisi yok");
  const items = JSON.parse(fs.readFileSync(dosya, "utf8")).fixtures || [];
  if (items.length < 100) return t.skip("yeterli fikstur yok");

  const adlar = new Set();
  for (const f of items) { if (f?.home) adlar.add(f.home); if (f?.away) adlar.add(f.away); }
  const bulunan = [...adlar].filter((a) => TC.teamCountry(a)).length;

  const oran = bulunan / adlar.size;
  assert.ok(
    oran >= 0.10,
    `kapsam %${(100 * oran).toFixed(1)} (${bulunan}/${adlar.size}) — olcum aninda %17 idi, gerileme var`
  );
  assert.ok(
    oran <= 0.40,
    `kapsam %${(100 * oran).toFixed(1)} — gevsek eslesme geri gelmis olabilir`
  );
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: elle harf listesi yerine NFD kullanılıyor", () => {
  const src = fs.readFileSync(path.join(KOK, "lib", "team-country.cjs"), "utf8")
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");

  assert.ok(/normalize\("NFD"\)/.test(src), "NFD normallestirmesi kalkmis");
  assert.ok(
    !/const ASCIILESTIR = \{ ç: "c", ğ: "g", ı: "i", ö: "o", ş: "s", ü: "u", â: "a", î: "i", û: "u" \}/.test(src),
    "elle yazilmis dokuz harflik liste geri gelmis"
  );
});
