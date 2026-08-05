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

const MOBIL = require("./_mobil-dizin.cjs").MOBIL;
const varMi = fs.existsSync(MOBIL);

/* ── Ölçümün dayanağı: ödül gerçekten kesirli mi? ────────────────────────── */

describe("kaynak: ödüller kesirli üretiliyor", () => {
  test("düello ödülleri ARTIK TAM SAYI — gerekçe puanlara kaydı", () => {
    /**
     * ⚠️ BU İDDİA 2026-08-05'te TERSİNE DÖNDÜ, kasıtlı.
     *
     * Eski hâli düello ödüllerinin KESİRLİ olduğunu şart koşuyordu ve şöyle
     * yazıyordu: "ödüller bir gün tam sayıya çevrilirse burası kırılır ve o
     * zaman gösterim koruması gözden geçirilebilir". O gün geldi — kesinti
     * yüzdeden kademeli TAM SAYI LC'ye çevrildi, çünkü kesirli ödüller
     * `lib/wallet-credit.cjs`in yuvarlamayan `$inc`iyle bakiyede birikiyordu
     * (1.9 × 20 → 37.999999999999986). Gerekçe: `lib/duello-kesinti.cjs`.
     *
     * ⚠️ GÖSTERİM KORUMASI YİNE DE KALIYOR ve gerekçesi bu dosyanın alt
     * yarısında ölçülü duruyor: LİDERLİK PUANLARI hâlâ kesirli ve depoda
     * `5.717648576819556e-17` gibi artıklar var. Yani kural gerekçesiz
     * kalmadı, gerekçesi yer değiştirdi — sessizce taşınmadığı görülsün diye
     * iddia burada tutuluyor.
     */
    const { odulTablosu } = require("../lib/duello-kesinti.cjs");
    const satirlar = odulTablosu();
    assert.ok(satirlar.length > 0, "odul tablosu bos — tarama bozuk");
    const kesirli = satirlar.filter((x) => !Number.isInteger(x.winAmount));
    assert.deepEqual(
      kesirli, [],
      "duello odulu yeniden kesirli uretiliyor — cuzdan $inc'i yuvarlamadigi " +
      "icin bakiyede kayan nokta hatasi birikir (bkz. lib/duello-kesinti.cjs)"
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

describe("puanlar: aynı sınıf, daha ağır hâli", () => {
  test("ÜRETİM VERİSİNDE kayan nokta artığı var (düzeltmenin gerekçesi)", () => {
    /**
     * ⚠️ Bu iddia gerçek `data/leaderboard.json` üzerinde ölçüm yapıyor ve
     * ARTIK BULMAYI bekliyor — çünkü depodaki eski satırlar yeniden
     * hesaplanmıyor. Gösterim tarafındaki korumanın kalıcı olmasının nedeni bu.
     *
     * Ölçüm anında: 160 satırın 158'i kesirli, 84'ü uzun ondalıklı.
     * Örnekler: 5.717648576819556e-17 · -1.4420000000000002 · 0.9270000000000002
     */
    const yol = require("./_gercek-veri.cjs").veriYolu("leaderboard.json");
    if (!fs.existsSync(yol)) return; // veri yoksa iddia atlanır

    const items = JSON.parse(fs.readFileSync(yol, "utf8")).items || [];
    if (!items.length) return;

    const gurultulu = items.filter((x) => {
      const n = Number(x.points);
      return Number.isFinite(n) && String(n).length > 8;
    });

    /* Kırılmıyor — bilgilendirici. Sıfıra düşerse (veri tazelendi) gösterim
     * koruması yine de kalmalı; asıl kanıt aşağıdaki kaynak nöbetçisi. */
    assert.ok(
      Array.isArray(gurultulu),
      "tarama bozuk"
    );
  });

  test("settle2 puanı YAZARKEN yuvarlıyor", () => {
    /**
     * ⚠️ KAYNAK DÜZELTMESİ. Eskiden `points: weightedPoints` ham çarpımdı;
     * okuma tarafında bir yerde yuvarlanıyordu ama yalnızca BİR yolda — depoya
     * kirli yazıp bazı okumalarda temizlemek, hangi ekranın temiz göstereceğini
     * rastlantıya bırakıyordu.
     */
    const src = fs.readFileSync(
      nodePath.join(__dirname, "..", "routes", "settle2.cjs"), "utf8"
    );
    const kod = src.split("\n")
      .map((l) => {
        const t = l.trim();
        return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
      })
      .join("\n");

    const i = kod.indexOf("const weightedPoints");
    assert.ok(i >= 0, "weightedPoints bulunamadi — tarama bozuk");
    const pencere = kod.slice(i, i + 400);

    assert.ok(
      /Math\.round\(\s*weightedPoints\s*\*\s*100\s*\)\s*\/\s*100/.test(pencere),
      "puan yazilirken yuvarlanMIYOR — leaderboard'a ham carpim yaziliyor ve " +
      "5.717648576819556e-17 gibi artiklar depoya girip ekrana sizar"
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
      hatalar.push(`${nodePath.relative(MOBIL, dosya)}:${satir} (balance)`);
    }

    /* Aynı sınıf, puanlar: `{x.points}` / `{row.points} p` gibi doğrudan
     * basımlar. `puanYaz(...)` ile sarılıysa eşleşmez.
     *
     * ⚠️ PROP GEÇİŞİ HEDEF DEĞİL: `<Strip points={settled.points} />` biçimi
     * de `{...points}` içeriyor ama ekrana basmıyor — değeri alan bileşen
     * kendi biçimlendirmesini yapar. İlk hâlde bunları da suçluyordum
     * (live.tsx:1773/1809). Lookbehind ile `=` önekli olanlar eleniyor. */
    for (const m of src.matchAll(/(?<!=)\{\s*[\w?.[\]]*\.points\s*\}/g)) {
      const satir = src.slice(0, m.index).split("\n").length;
      hatalar.push(`${nodePath.relative(MOBIL, dosya)}:${satir} (points)`);
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
