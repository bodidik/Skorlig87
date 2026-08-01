"use strict";

/**
 * TAKIM ADI EŞLEŞTİRME: EK LİSTESİ TEK, İÇERME SÖZCÜK BAŞINDA.
 *
 * ⚠️ İKİ KUSUR, İKİSİ DE ÖLÇÜLDÜ.
 *
 * 1) EK LİSTELERİ AYRIŞMIŞTI. Aynı iş iki yerde yapılıyor:
 *    `lib/team-country.cjs EKLER` (18 ek) ve `services/odds-engine.cjs
 *    AFFIX_RE` (37 ek). Gerçek fikstür verisinde 48 takım adı, `EKLER`'de
 *    OLMAYAN bir ek taşıyor — "Chapecoense AF", "Clube do Remo",
 *    "RC Celta de Vigo", "Coritiba FBC", "Udinese Calcio". Listeler
 *    birleştirildi.
 *
 * 2) İÇERME ARAMASI SÖZCÜK ORTASINDA DA EŞLEŞİYORDU. Bu, (1)'i düzeltince
 *    GÖRÜNÜR OLDU: ölçüm "SV Horn → Ukraine" üretti. "SV" eki atılınca
 *    çekirdek "horn" oluyor ve düz `includes` bunu "cHORNomorets odesa"
 *    içinde buluyor. SV Horn AVUSTURYA kulübü.
 *    Aynı hata düzeltmeden ÖNCE de vardı ve sessizce çalışıyordu:
 *        "Rangers", "Queens Park Rangers FC", "Cove Rangers" → France
 *            ("angers" ⊂ "r-ANGERS")
 *        "Rana", "Rana FK" → Brazil   ("rana" ⊂ "pa-RANA")
 *        "Talant" → Italy             ("talant" ⊂ "a-TALANT-a")
 *
 * ÇÖZÜM: içerme yalnızca bir SÖZCÜĞÜN BAŞINDA sayılır, sonu serbest.
 *     "lyon" → "olympique LYONnais"  ✓
 *     "horn" → "cHORNomorets odesa"  ✗
 *
 * ⚠️ ARA DENEMEM YANLIŞTI, YAZIYORUM: önce iki yanlı tam sözcük sınırı
 * istedim; ölçüm 37 DOĞRU eşleşmenin kaybolduğunu gösterdi ("Olympique
 * Lyonnais → France", "Lech Poznan → Poland", "Viktoria Plzen → Czech
 * Republic"), çünkü tablo KISA adı tutuyor ve fikstür UZUN adı gönderiyor.
 * Sonu serbest bırakınca düzeldi. Taban da 5'ten 4'e indi: 5'te "Lyon" ve
 * "Nice" kayboluyordu.
 *
 * NET SONUÇ (2524 gerçek takım adı):
 *     önce : 412 eşleşme  (içinde 12 yanlış: Rangers×7, Rana×2, Talant, …)
 *     sonra: 399 eşleşme  (+2 kazanç: "Aris"→Greece, "KS Lechia"→Poland)
 * Kapsam düştü ama DOĞRULUK arttı — yanlış ülke ataması sessiz bir hatadır,
 * eşleşmeme değildir.
 *
 * ⚠️ KAPSAM DIŞI, DÜRÜSTÇE: "Zilina"/"MSK Zilina" (Slovakya) da kayboldu ve
 * bu DOĞRU bir eşleşmeydi. Sebebi ayrı bir kusur: `anahtarla` yalnızca TÜRKÇE
 * aksanları çeviriyor, "Žilina"nın `ž` harfi silinip "ilina" oluyor. Bunu bu
 * turda düzeltmedim — ayrı bir ölçüm ve ayrı bir değişiklik gerektiriyor.
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
  test("bilinen takımlar bulunuyor", () => {
    for (const [ad, ulke] of [
      ["Fenerbahçe", "Türkiye"], ["Fenerbahce SK", "Türkiye"],
      ["Real Madrid CF", "Spain"], ["CR Flamengo", "Brazil"],
    ]) assert.equal(TC.teamCountry(ad), ulke, `${ad} bulunamiyor — test bir sey olcmuyor`);
  });
});

/* ── (1) Ek listesi ──────────────────────────────────────────────────────── */

describe("ek listesi odds-engine ile aynı", () => {
  test("odds-engine'deki her ek burada da var", () => {
    /**
     * ⚠️ ELLE LİSTE YAZMIYORUM — iki kaynaktan da okuyup karşılaştırıyorum.
     * Kusurun kendisi "iki liste ayrıştı" idi; testin kendi üçüncü kopyasını
     * tutması aynı hatayı tekrarlamak olurdu.
     */
    const oe = fs.readFileSync(path.join(KOK, "services", "odds-engine.cjs"), "utf8");
    const m = /AFFIX_RE\s*=\s*\n?\s*\/\\b\(([^)]*)\)\\b\//.exec(oe);
    assert.ok(m, "AFFIX_RE okunamadi — ad ya da bicim degismis");
    const affix = m[1].split("|").map((s) => s.trim()).filter(Boolean);
    assert.ok(affix.length > 20, `AFFIX_RE'de yalnizca ${affix.length} ek — ayristirma bozuk`);

    /* ⚠️ YORUMLAR ÖNCE SİLİNİYOR. İlk sürümde silmemiştim ve liste içindeki
     * `// her iki listede de vardı` satırları parçalara yapışıp "fc" gibi
     * gerçek ekleri süzgeçten düşürdü — test "fc eksik" diye yanlış alarm
     * verdi. Bu oturumun tekrar eden yorum/kod tuzağı. */
    const tc = fs.readFileSync(path.join(KOK, "lib", "team-country.cjs"), "utf8")
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, ""))
      .join("\n");
    const m2 = /const EKLER = new Set\(\[([\s\S]*?)\]\)/.exec(tc);
    assert.ok(m2, "EKLER okunamadi");
    const ekler = new Set(
      [...m2[1].matchAll(/"([a-z]+)"/g)].map((x) => x[1])
    );
    assert.ok(ekler.size > 20, `EKLER'den yalnizca ${ekler.size} ek okundu — ayristirma bozuk`);

    const eksik = affix.filter((a) => !ekler.has(a));
    assert.deepEqual(eksik, [], `odds-engine'de olup burada olmayan ek(ler): ${eksik.join(", ")}`);
  });

  test("ek taşıyan adlar çözülüyor", () => {
    for (const [ad, ulke] of [
      ["Udinese Calcio", "Italy"],
      ["Cruzeiro EC", "Brazil"],
      ["Coritiba FBC", "Brazil"],
    ]) assert.equal(TC.teamCountry(ad), ulke, `${ad} cozulmedi — ek atilmiyor`);
  });
});

/* ── (2) Sözcük başı kuralı ──────────────────────────────────────────────── */

describe("sözcük ORTASINDA eşleşme yok", () => {
  const YANLIS = [
    ["SV Horn", "horn ⊂ cHORNomorets (Ukraine)"],
    ["Rangers", "angers ⊂ r-ANGERS (France)"],
    ["Queens Park Rangers FC", "angers ⊂ r-ANGERS (France)"],
    ["Cove Rangers", "angers ⊂ r-ANGERS (France)"],
    ["Rana FK", "rana ⊂ pa-RANA (Brazil)"],
    ["Talant", "talant ⊂ a-TALANT-a (Italy)"],
  ];

  for (const [ad, neden] of YANLIS) {
    test(`"${ad}" ülke ATAMIYOR (${neden})`, () => {
      assert.equal(
        TC.teamCountry(ad), null,
        `${ad} bir ulkeye atandi — sozcuk ortasi eslesme geri gelmis`
      );
    });
  }
});

describe("sözcük BAŞINDA eşleşme korunuyor", () => {
  /**
   * ⚠️ Düzeltmenin bedeli burada ölçülüyor. Tam sözcük sınırı istemek bu
   * eşleşmelerin HEPSİNİ öldürüyordu (ölçüldü: 37 kayıp).
   */
  for (const [ad, ulke] of [
    ["Olympique Lyonnais", "France"],   // lyon ⊂ LYONnais
    ["Lech Poznan", "Poland"],
    ["Viktoria Plzen", "Czech Republic"],
    ["Lyon", "France"],                 // 4 harf — taban 5 olsaydi kaybolurdu
    ["Nice", "France"],
  ]) {
    test(`"${ad}" → ${ulke}`, () => {
      assert.equal(TC.teamCountry(ad), ulke, `${ad} kayboldu — icerme kurali fazla kati`);
    });
  }
});

/* ── Gerçek veriyle ──────────────────────────────────────────────────────── */

test("gerçek fikstürlerde kapsam makul", (t) => {
  /**
   * ⚠️ Ölçüm anında 2524 takım adının 399'u eşleşiyordu (düzeltmeden önce
   * 412, ama içinde 12 yanlış vardı). Aralık iki yönlü.
   */
  const dosya = path.join(KOK, "data", "fixtures.json");
  if (!fs.existsSync(dosya)) return t.skip("fikstur verisi yok");
  const items = JSON.parse(fs.readFileSync(dosya, "utf8")).fixtures || [];
  if (items.length < 100) return t.skip("yeterli fikstur yok");

  const adlar = new Set();
  for (const f of items) { if (f?.home) adlar.add(f.home); if (f?.away) adlar.add(f.away); }
  const bulunan = [...adlar].filter((a) => TC.teamCountry(a)).length;

  assert.ok(bulunan >= 320, `yalnizca ${bulunan} takim eslesiyor — olcum aninda 399 idi`);
  assert.ok(bulunan <= 600, `${bulunan} takim eslesiyor — gevsek eslesme geri gelmis olabilir`);
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: içerme sözcük başı şartına bağlı", () => {
  const src = fs.readFileSync(path.join(KOK, "lib", "team-country.cjs"), "utf8")
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");

  assert.ok(/uzun\[i - 1\] === " "/.test(src), "sozcuk basi sarti kalkmis");
  assert.ok(
    !/k\.includes\(bilinen\) \|\| bilinen\.includes\(k\)/.test(src),
    "duz includes geri gelmis — sozcuk ortasi eslesir"
  );
});
