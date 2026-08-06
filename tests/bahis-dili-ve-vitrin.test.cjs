"use strict";

/**
 * BAHİS DİLİ KULLANICIYA GÖRÜNMEZ + BAHİS BENZERİ MODLAR VİTRİNDE ÖNDE DEĞİL.
 *
 * ⚠️ NEDEN VAR (2026-08-06): ölçüldü — kullanıcıya görünen Türkçe metinde
 * "Bahis için giriş yapmalısın", "Birebir bahis, kazanan alır", "{n} LC kasa
 * payı düşüldü" gibi ifadeler vardı; "kupon" 58 kez geçiyordu.
 *
 * Bu kozmetik bir sorun değil, İKİ somut riski var:
 *
 *   1. GOOGLE PLAY DERECELENDİRMESİ. IARC anketi "simulated gambling"
 *      soruyor. Bahis arayüzü gibi görünen uygulama ya 18+ derecelendirme
 *      alır (erişim çöker) ya da yanlış beyandan kaldırılma riski taşır.
 *   2. TÜRKİYE'DE ALGI. Bahis/iddia çağrışımı kullanıcıda "dolandırılıyor
 *      muyum" hissi yaratıyor. Ürün ücretsiz ve sanal para ile çalışıyor.
 *
 * KONUMLANMA: tahmin bilgi yarışması. Ödül havuzdan değil BAŞARIDAN üretilir
 * (api/lib/kupon.cjs başlığı bunu zaten yazıyor).
 *
 * ⚠️ ANAHTARLAR DEĞİL DEĞERLER DENETLENİYOR. `kuponJoinFor` gibi anahtar
 * adları kod; kullanıcı onları görmez. Anahtarları yeniden adlandırmak
 * gereksiz büyük bir değişiklik olurdu ve hiçbir riski azaltmazdı.
 */

const test = require("node:test");
const { describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");

const { mobilYol, mobilVarMi } = require("./_mobil-dizin.cjs");

const I18N = mobilYol("lib", "i18n.ts");
const MODLAR = mobilYol("components", "OyunModlari.tsx");
const mobilVar = mobilVarMi();

/** Bir dil bloğunun `anahtar: "değer"` çiftleri. */
function degerler(dil) {
  const src = fs.readFileSync(I18N, "utf8");
  const idx = [...src.matchAll(/^ {2}([a-z]{2}(?:-[A-Z]{2})?):\s*\{/gm)];
  const i = idx.findIndex((m) => m[1] === dil);
  if (i < 0) return [];
  const govde = src.slice(idx[i].index, i + 1 < idx.length ? idx[i + 1].index : src.length);

  const out = [];
  for (const satir of govde.split("\n")) {
    const m = satir.match(/^\s*([A-Za-z0-9_]+):\s*"(.*)",?\s*$/);
    if (m) out.push({ anahtar: m[1], deger: m[2] });
  }
  return out;
}

/**
 * Yasaklı ifadeler — kullanıcıya GÖRÜNEN metinde geçmemeli.
 *
 * ⚠️ "oran" TEK BAŞINA yasaklı DEĞİL: "isabet oranı" bir beceri ölçüsü ve
 * kalması doğru. Yasaklanan, bahis oranı anlamına gelen kalıplar.
 */
const YASAK_TR = [
  { re: /\bbahis\b/i,        ad: "bahis" },
  { re: /\bbahsi\b/i,        ad: "bahsi" },
  { re: /\bkupon/i,          ad: "kupon" },
  { re: /kasa pay/i,         ad: "kasa payı" },
  { re: /\biddia\b/i,        ad: "iddia" },
  { re: /oranına göre/i,     ad: "oranına göre (bahis oranı)" },
];

const YASAK_EN = [
  { re: /\bbets?\b/i,        ad: "bet" },
  { re: /\bbetting\b/i,      ad: "betting" },
  { re: /\bwager/i,          ad: "wager" },
  { re: /\bcoupons?\b/i,     ad: "coupon" },
  { re: /house cut/i,        ad: "house cut" },
  { re: /by the odds/i,      ad: "by the odds" },
  { re: /\bgambl/i,          ad: "gambling" },
];

describe("kullanıcıya görünen metinde bahis dili yok", () => {
  for (const [dil, yasak] of [["tr", YASAK_TR], ["en", YASAK_EN]]) {
    test(`${dil}: yasaklı ifade geçmiyor`, (t) => {
      if (!mobilVar) return t.skip("mobil depo yan klasorde yok");

      const bulgular = [];
      for (const { anahtar, deger } of degerler(dil)) {
        for (const y of yasak) {
          if (y.re.test(deger)) bulgular.push(`${anahtar}: "${deger}"   ← ${y.ad}`);
        }
      }

      assert.deepStrictEqual(
        bulgular, [],
        `Bu metinler kullaniciya GORUNUYOR ve bahis dili tasiyor.\n` +
        `Google Play IARC anketi simulated gambling soruyor; bahis arayuzu\n` +
        `18+ derecelendirme ya da yanlis beyan riski demek:\n  ` +
        bulgular.join("\n  ")
      );
    });
  }

  test("tarama gerçekten çalışıyor (boş sonuç kanıt değil)", (t) => {
    if (!mobilVar) return t.skip("mobil depo yan klasorde yok");
    /* Kalip bir gun kirilirsa nobetci sessizce yesil kalir ve dil geri gelir. */
    assert.ok(YASAK_TR.some((y) => y.re.test("Bahis için giriş yapmalısın.")),
      "tr kalibi bilinen ornegi yakalamiyor");
    assert.ok(YASAK_TR.some((y) => y.re.test("Kuponu al — 10 LC")),
      "tr kalibi kupon ornegini yakalamiyor");
    assert.ok(YASAK_EN.some((y) => y.re.test("{n} LC house cut deducted")),
      "en kalibi bilinen ornegi yakalamiyor");
    /* Mesru kullanimlar yanlislikla yakalanmamali. */
    assert.ok(!YASAK_TR.some((y) => y.re.test("İsabet oranı")),
      "isabet orani bir beceri olcusu, yakalanmamali");
    assert.ok(!YASAK_EN.some((y) => y.re.test("Better luck next time")),
      "\"better\" kelimesi yanlislikla yakalaniyor");
  });

  test("değer taraması anlamlı sayıda satır görüyor", (t) => {
    if (!mobilVar) return t.skip("mobil depo yan klasorde yok");
    for (const dil of ["tr", "en"]) {
      const n = degerler(dil).length;
      assert.ok(n >= 200, `${dil} blogunda yalnizca ${n} deger bulundu — tarama bozulmus`);
    }
  });
});

describe("vitrin sırası: bahis benzeri modlar önde değil", () => {
  /**
   * ⚠️ DÜELLO ve HAVUZ yapısal olarak farklı: düelloda pottan kesinti var
   * (api/lib/duello-kesinti.cjs), havuz pari-mutuel — ödül diğer oyuncuların
   * LC'sinden geliyor. Ötekiler ödülü BAŞARIDAN üretiyor.
   *
   * Kaldırılmadılar, yalnızca geriye alındılar. Bu test kaldırıldıklarını
   * değil, ÖNE ALINMADIKLARINI kilitliyor.
   */
  test("düello ve havuz, tek maç ve haftalık tahminden SONRA geliyor", (t) => {
    if (!mobilVar) return t.skip("mobil depo yan klasorde yok");
    const src = fs.readFileSync(MODLAR, "utf8");

    const sira = [...src.matchAll(/key:\s*"([a-z0-9]+)"/gi)].map((m) => m[1]);
    assert.ok(sira.length >= 6, `mod listesi okunamadi: ${sira.join(",")}`);

    const ix = (k) => sira.indexOf(k);
    for (const riskli of ["duello", "havuz"]) {
      assert.ok(ix(riskli) >= 0, `${riskli} modu kaybolmus — kaldirma amaclanmadi`);
      for (const guvenli of ["tek", "kupon"]) {
        assert.ok(
          ix(guvenli) < ix(riskli),
          `VITRIN SIRASI BOZULMUS: "${riskli}" (${ix(riskli)}) "${guvenli}" (${ix(guvenli)})\n` +
          `modundan ONCE geliyor. Bahis benzeri mekanik one cikinca uygulama\n` +
          `bahis simulatoru gibi gorunur — bkz. OyunModlari.tsx sira notu.`
        );
      }
    }
  });

  test("her iki mod da hâlâ erişilebilir", (t) => {
    if (!mobilVar) return t.skip("mobil depo yan klasorde yok");
    const src = fs.readFileSync(MODLAR, "utf8");
    /* Amac ilk izlenimi degistirmek, ozelligi kismak degil. */
    assert.ok(/key:\s*"duello"/.test(src), "duello modu silinmis");
    assert.ok(/key:\s*"havuz"/.test(src), "havuz modu silinmis");
  });
});
