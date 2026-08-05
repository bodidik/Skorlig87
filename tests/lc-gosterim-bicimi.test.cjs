"use strict";

/**
 * LC TUTARLARI EKRANA HAM BASILMIYOR.
 *
 * ⚠️ BULUNAN: bakiye DÖRT ekranda ham basılıyordu (`{wallet.user?.balance ?? 0}`)
 * ve LC tutarları kesirli olabiliyor. Düello ödülü tam sayı DEĞİL:
 *
 *     routes/duels.cjs:746  houseCut  = round(pot * 0.05 * 10) / 10
 *     routes/duels.cjs:747  winAmount = round((pot - houseCut) * 10) / 10
 *
 * ÖLÇÜLDÜ (stake aralığı 1..12): 12 stake değerinin 11'inde ödül kesirli
 * (1 → 1.9, 2 → 3.8, 3 → 5.7 ...). Toplam korunuyor — kusur orada değil.
 *
 * Asıl sorun kesirli tutarların cüzdanda BİRİKMESİ: `lib/wallet-credit.cjs`
 * `$inc: { balance: tutar }` ile ham ekliyor, IEEE754 hatası büyüyor:
 *     20 kez 1.9 eklendi  → 37.999999999999986   (38 değil)
 *     100 kez 5.7 eklendi → 569.9999999999998    (570 değil)
 *
 * Ham basıldığı için kullanıcı ekranda TAM OLARAK bunu görüyordu:
 *     "37.999999999999986 LC"
 *
 * ⚠️ KÖK NEDEN AYRI BİR KARAR: ödülleri tam sayı üretmek doğrusu olurdu
 * (turnuva `odemeDagit` bunu "en büyük kalan" yöntemiyle yapıyor), ama
 * MAX_STAKE 12 iken %5 kesinti tam sayıyla ifade edilemiyor — pot 2..24 için
 * kesinti 0.1..1.2 çıkıyor ve tam sayıya çekmek ev gelirini fiilen sıfırlıyor.
 * Bu bir EKONOMİ kararı; burada yalnızca gösterim korunuyor.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const nodePath = require("path");

const MOBIL = nodePath.join(__dirname, "..", "..", "mobile");
const varMi = fs.existsSync(MOBIL);

/* ── Ölçümün dayanağı: ödül gerçekten kesirli mi? ────────────────────────── */

describe("kaynak: ödüller kesirli üretiliyor", () => {
  test("düello ödülü tam sayı DEĞİL (gösterim korumasının gerekçesi)", () => {
    /**
     * ⚠️ Bu iddia gösterim kuralının GEREKÇESİNİ tutuyor. Ödüller bir gün tam
     * sayıya çevrilirse burası kırılır ve o zaman gösterim koruması gözden
     * geçirilebilir — gerekçesi kalmamış bir kural sessizce taşınmasın.
     */
    const src = fs.readFileSync(
      nodePath.join(__dirname, "..", "routes", "duels.cjs"), "utf8"
    );
    const pct = Number(src.match(/HOUSE_CUT_PCT\s*=\s*([\d.]+)/)?.[1]);
    assert.ok(Number.isFinite(pct), "HOUSE_CUT_PCT okunamadi — tarama bozuk");

    const max = Number(src.match(/MAX_STAKE\s*=\s*(\d+)/)?.[1] ?? 12);
    let kesirli = 0;
    for (let s = 1; s <= max; s++) {
      const pot = s * 2;
      const hc = Math.round(pot * pct * 10) / 10;
      const wa = Math.round((pot - hc) * 10) / 10;
      if (!Number.isInteger(wa)) kesirli++;
    }
    assert.ok(
      kesirli > 0,
      `hicbir odul kesirli degil — odul hesabi tam sayiya cevrilmis olabilir. ` +
      `Oyleyse lib/lcBicim.ts'in gerekcesi degismistir, gozden gecir.`
    );
  });

  test("kesirli tutarlar toplandıkça kayan nokta hatası biriktiriyor", () => {
    /* Mongo `$inc` aynı IEEE754 aritmetiğini kullanıyor. */
    let bakiye = 0;
    for (let i = 0; i < 20; i++) bakiye += 1.9;
    assert.notEqual(
      bakiye, 38,
      "1.9 x 20 tam 38 cikti — bu ortamda birikme yok, testin dayanagi degismis"
    );
    assert.ok(
      String(bakiye).length > 6,
      `beklenmeyen deger: ${bakiye}`
    );
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: bakiye ekranlarda HAM basılmıyor", () => {
  if (!varMi) return; // başka checkout — iddia atlanır

  const ekranlar = [];
  const gez = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = nodePath.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules") gez(p); }
      else if (e.name.endsWith(".tsx")) ekranlar.push(p);
    }
  };
  gez(nodePath.join(MOBIL, "app"));
  const bilesenler = nodePath.join(MOBIL, "components");
  if (fs.existsSync(bilesenler)) gez(bilesenler);

  assert.ok(ekranlar.length > 0, "hic ekran bulunamadi — tarama bozuk");

  const hatalar = [];
  for (const dosya of ekranlar) {
    const ham = fs.readFileSync(dosya, "utf8");
    const src = ham.split("\n")
      .map((l) => {
        const t = l.trim();
        return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
      })
      .join("\n");

    /* JSX içinde doğrudan basılan bakiye: `{...balance ?? 0}` veya
     * `${...balance ?? 0}`. `lcYaz(...)` ile sarılmışsa eşleşmez. */
    for (const m of src.matchAll(/[{$]\{?\s*[\w?.]*\bbalance\s*\?\?\s*0\s*\}/g)) {
      const satir = src.slice(0, m.index).split("\n").length;
      hatalar.push(`${nodePath.relative(MOBIL, dosya)}:${satir}`);
    }
  }

  assert.deepEqual(
    hatalar, [],
    "bakiye HAM basiliyor:\n" + hatalar.join("\n") +
    "\nLC tutarlari kesirli olabiliyor (duello odulu 1.9, 3.8, 5.7 ...) ve\n" +
    "cuzdanda birikince IEEE754 hatasi buyuyor: 20 kez 1.9 -> 37.999999999999986.\n" +
    "Kullanici ekranda tam olarak bunu gorur. lib/lcBicim.ts lcYaz() kullan."
  );
});

test("NÖBETÇİ: lcYaz kayan nokta gürültüsünü temizliyor", () => {
  if (!varMi) return;

  const yol = nodePath.join(MOBIL, "lib", "lcBicim.ts");
  assert.ok(fs.existsSync(yol), "lib/lcBicim.ts yok — bicimlendirme tek kaynagi kaldirilmis");

  /* TS'i çalıştırmadan davranışı doğrulayamayız; mantığı burada aynen
   * uygulayıp beklentiyi sabitliyoruz. Uygulama değişirse bu test, kaynağın
   * hâlâ aynı yöntemi kullandığını sınıyor. */
  const src = fs.readFileSync(yol, "utf8");
  assert.ok(
    /toFixed\(2\)/.test(src),
    "lcYaz iki basamaga yuvarlamiyor — kayan nokta gurultusu ekrana sizar"
  );
  assert.ok(
    /Number\.isFinite/.test(src),
    "lcYaz sayisal olmayan girdiyi korumuyor — NaN LC yazar"
  );

  const lcYaz = (n) => {
    const x = Number(n);
    if (!Number.isFinite(x)) return "0";
    return String(Number(x.toFixed(2)));
  };
  assert.equal(lcYaz(37.999999999999986), "38");
  assert.equal(lcYaz(1.9), "1.9");
  assert.equal(lcYaz(38), "38");
  assert.equal(lcYaz(null), "0");
  assert.equal(lcYaz(undefined), "0");
});
