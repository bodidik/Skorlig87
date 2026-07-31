"use strict";

/**
 * PAYLAŞILAN KOD ÜRETİMİ — tahmin edilebilir olmamalı.
 *
 * ⚠️ BULUNAN: grup kodu `Math.random()` ile üretiliyordu. Kod tabanındaki
 * diğer İKİ kod üreticisi (arkadaş davet kodu, mini turnuva kodu) zaten
 * `crypto.randomInt` kullanıyordu — yalnızca grup kodu ayrışıyordu.
 *
 * Neden önemli: `Math.random()` V8'de ardışık çıktılardan iç durumu geri
 * kazanılabilecek bir PRNG. Birkaç grup kurup kendi kodlarını gören biri,
 * AYNI SÜREÇte üretilen başka grupların kodlarını kestirebilir. Grup kodu iki
 * şey veriyor: `/groups/:code/board` (kimliksiz okunur — üye listesi ve
 * puanlar) ve `/groups/join`.
 *
 * ⚠️ NÖBETÇİ ASIL İŞ. Tek bir üreticiyi düzeltmek yetmez; tekrar eden hata
 * "yeni bir kod üreticisi eklendi ve güvenli rastgelelik unutuldu" biçimi.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");

/** Paylaşılan/gizli kod üreten dosyalar ve o kodun ne verdiği. */
const KOD_URETICILERI = [
  { dosya: "lib/social-store.cjs", ad: "grup kodu", verir: "gruba katilim + kimliksiz board okuma" },
  { dosya: "routes/friends.cjs", ad: "davet kodu", verir: "arkadaslik + LC odulu" },
  { dosya: "routes/mini.cjs", ad: "mini turnuva kodu", verir: "turnuvaya katilim" },
];

/**
 * Kod üretimi yapan satırları bulur: bir alfabeden karakter seçen döngü.
 * Örn. `s += A[crypto.randomInt(A.length)]` ya da `A[Math.floor(Math.random()...)]`
 */
function kodSecimSatirlari(kaynak) {
  return kaynak
    .split("\n")
    .map((satir, i) => ({ satir, no: i + 1 }))
    .filter(({ satir }) => /\[\s*(crypto\.randomInt|Math\.floor\s*\(\s*Math\.random)/.test(satir));
}

test("NÖBETÇİ: paylaşılan kodlar güvenli rastgelelikle üretilir", () => {
  const kusurlu = [];
  let bakilan = 0;

  for (const { dosya, ad, verir } of KOD_URETICILERI) {
    const kaynak = fs.readFileSync(path.join(KOK, dosya), "utf8");
    const satirlar = kodSecimSatirlari(kaynak);
    assert.ok(
      satirlar.length > 0,
      `${dosya}: kod uretimi bulunamadi — tarama kalibi bozulmus olabilir`
    );
    for (const { satir, no } of satirlar) {
      bakilan++;
      if (satir.includes("Math.random")) {
        kusurlu.push(`${dosya}:${no} (${ad} — ${verir})`);
      }
    }
  }

  assert.ok(bakilan >= 3, `cok az uretici bulundu (${bakilan})`);
  assert.deepStrictEqual(
    kusurlu,
    [],
    "Bu kodlar Math.random ile uretiliyor (ongorulebilir) — crypto.randomInt kullan:\n" +
      kusurlu.join("\n")
  );
});

test("kod alfabeleri karıştırılabilir karakter içermez", () => {
  /**
   * Kodlar elle yazılıyor ve sözlü/görsel paylaşılıyor. I/O/0/1 karışması
   * "kod yanlış" şikayeti üretir. Üç üreticinin de aynı alfabeyi kullanması
   * ayrıca tutarlılık sağlıyor.
   */
  const karisan = ["I", "O", "0", "1"];
  const kusurlu = [];

  for (const { dosya, ad } of KOD_URETICILERI) {
    const kaynak = fs.readFileSync(path.join(KOK, dosya), "utf8");
    // Kod alfabesi: yalnızca büyük harf+rakam, 24+ karakter, tek satır string.
    const alfabeler = [...kaynak.matchAll(/"([A-Z0-9]{24,})"/g)].map((m) => m[1]);
    for (const a of alfabeler) {
      const bulunan = karisan.filter((c) => a.includes(c));
      if (bulunan.length) kusurlu.push(`${dosya} (${ad}): ${bulunan.join(", ")}`);
    }
  }

  assert.deepStrictEqual(
    kusurlu,
    [],
    "Kod alfabesinde karistirilabilir karakter var:\n" + kusurlu.join("\n")
  );
});

test("grup kodu gerçekten üretiliyor ve biçimi doğru", async () => {
  // Davranış kontrolü: nöbetçiler metne bakıyor, bu üretilen değere bakıyor.
  const SocialStore = require("../lib/social-store.cjs");
  const uretici = SocialStore._code6;
  if (typeof uretici !== "function") return; // disa aktarilmamis; metin testleri yeterli

  const gorulen = new Set();
  for (let i = 0; i < 200; i++) {
    const k = uretici();
    assert.match(k, /^[A-Z2-9]{6}$/, `bicim bozuk: ${k}`);
    gorulen.add(k);
  }
  assert.ok(gorulen.size > 190, `200 uretimde ${gorulen.size} benzersiz — carpisma cok yuksek`);
});
