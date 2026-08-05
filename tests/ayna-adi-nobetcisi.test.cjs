"use strict";

/**
 * AYNA TAZELEME ÇAĞRILARI GEÇERLİ AD KULLANIYOR.
 *
 * ⚠️ NEDEN VAR: `aynayiTazele(conn, hangi)` bir `if/else if` zinciri ve
 * `else` dalı yoktu — tanınmayan bir ad hiçbir dala girmiyor, fonksiyon
 * hiçbir şey yapmadan dönüyordu. Sessiz no-op.
 *
 * GERÇEK KUSUR ÜRETTİ (2026-08-05): `removeUserFromSocial` yazarken
 * "links"/"requests"/"blocks" geçirmiştim; üçü de sessizce hiçbir şey yapmadı.
 * Sonuç zincirleme ve ağırdı — Mongo'dan silinen kayıt dosya aynasında kaldı,
 * koleksiyon boşalınca okuma tarafındaki TOHUMLAMA onu Mongo'ya geri yazdı ve
 * silinen arkadaşlık DİRİLDİ. Davranış testi yakaladı, ama ancak o kaydı
 * özellikle aradığı için.
 *
 * Bu nöbetçi ucuz ve doğrudan: her çağrıdaki ad, o dosyanın tanıdığı adlar
 * arasında mı? Aynı kontrolü çalışma zamanında `aynayiTazele` de yapıyor
 * (console.error ile iz bırakır); burada geliştirme sırasında yakalanır.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const nodePath = require("path");

const KOK = nodePath.join(__dirname, "..");

/**
 * Ayna tazeleyici tanımlayan depolar ve TANIDIKLARI adlar.
 *
 * ⚠️ Adlar KAYNAKTAN çıkarılıyor, elle yazılmıyor: liste elle tutulsaydı
 * yeni bir ad eklendiğinde bu test yanlışlıkla kırılır ve "listeye ekle"
 * refleksiyle gerçek kontrol körelirdi.
 */
function aynaGovdesi(kod) {
  const bas = kod.indexOf("function aynayiTazele");
  if (bas < 0) return null;
  const kalan = kod.slice(bas);
  const bit = kalan.search(/\n(async )?function /);
  return bit >= 0 ? kalan.slice(0, bit) : kalan;
}

/**
 * Tanınan adlar — YALNIZCA zinciri AÇIK olan (sessiz no-op üretebilen)
 * fonksiyonlar için.
 *
 * ⚠️ İLK HÂLİM YANLIŞ POZİTİF ÜRETTİ: `moderation-store.cjs` zinciri
 * `if (hangi === "admins") ... else ...` biçiminde, yani KAPALI — tanınmayan
 * bir ad `else` dalına düşer ve fonksiyon bir iş yapar. Orada sessiz no-op
 * riski yok, dolayısıyla çağrı adlarını doğrulamanın anlamı da yok.
 * Nöbetçi "yanlış ad" değil, "ADI DÜŞECEK DAL YOK" durumunu aramalı.
 *
 * @returns {string[]|null} null → bu fonksiyon korumalı, doğrulama gereksiz
 */
function korumasizAdlar(kod) {
  const govde = aynaGovdesi(kod);
  if (!govde) return null;

  /* Açık kontrol (social-store) → korumalı. */
  if (/AYNA_ADLARI\.includes\(/.test(govde)) {
    const sabit = kod.match(/const AYNA_ADLARI\s*=\s*\[([^\]]*)\]/);
    /* Kontrol var ama liste okunamadıysa yine de adları doğrulayalım. */
    return sabit ? [...sabit[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : null;
  }

  /* `else` dalı (son `if`in ardından süslü açan bir else) → korumalı. */
  if (/\belse\s*\{/.test(govde)) return null;

  const adlar = [...govde.matchAll(/hangi\s*===\s*"([^"]+)"/g)].map((m) => m[1]);
  return adlar.length ? adlar : null;
}

function kodOku(rel) {
  return fs.readFileSync(nodePath.join(KOK, rel), "utf8");
}

test("aynayiTazele çağrıları TANINAN ad kullanıyor", () => {
  const depolar = fs
    .readdirSync(nodePath.join(KOK, "lib"))
    .filter((f) => f.endsWith(".cjs"))
    .map((f) => `lib/${f}`)
    .filter((rel) => kodOku(rel).includes("function aynayiTazele"));

  assert.ok(
    depolar.length > 0,
    "aynayiTazele tanimlayan hicbir depo bulunamadi — tarama bozuk"
  );

  const hatalar = [];
  let toplamCagri = 0;

  for (const rel of depolar) {
    const kod = kodOku(rel);
    const adlar = korumasizAdlar(kod);

    /* null → ya tek parametreli sürüm (invite-store, tr-league-store), ya da
     * zinciri kapalı/açık kontrollü bir fonksiyon; ikisinde de sessiz no-op
     * riski yok. */
    if (!adlar) continue;

    for (const m of kod.matchAll(/aynayiTazele\(\s*\w+\s*,\s*"([^"]+)"\s*\)/g)) {
      toplamCagri++;
      if (!adlar.includes(m[1])) {
        const satir = kod.slice(0, m.index).split("\n").length;
        hatalar.push(`${rel}:${satir} → "${m[1]}" (tanınan: ${adlar.join(", ")})`);
      }
    }
  }

  /* ⚠️ Sıfır çağrı bulmak "hepsi doğru" demek DEĞİL — desen değişmiş olabilir
   * ve nöbetçi sessizce körelmiş olurdu. */
  assert.ok(
    toplamCagri > 0,
    "hicbir iki parametreli aynayiTazele cagrisi bulunamadi — tarama bozuk"
  );

  assert.deepEqual(
    hatalar, [],
    "aynayiTazele TANINMAYAN ad ile cagriliyor:\n" + hatalar.join("\n") +
    "\nBu cagri SESSIZCE hicbir sey yapmaz: Mongo'dan silinen kayit dosya\n" +
    "aynasinda kalir, koleksiyon bosalinca tohumlama onu GERI YAZAR ve\n" +
    "silinmis veri dirilir."
  );
});

test("bilinmeyen ad çalışma zamanında da iz bırakıyor", () => {
  /**
   * Kaynak taraması dinamik çağrıyı (`aynayiTazele(conn, degisken)`)
   * yakalayamaz. Çalışma zamanı kontrolü o boşluğu kapatıyor; burada onun
   * KALDIRILMADIĞINI sınıyoruz.
   */
  const kod = kodOku("lib/social-store.cjs");
  const bas = kod.indexOf("async function aynayiTazele");
  assert.ok(bas >= 0, "aynayiTazele bulunamadi");
  const kalan = kod.slice(bas + 10);
  const bit = kalan.search(/\n(async )?function /);
  const govde = bit >= 0 ? kalan.slice(0, bit) : kalan;

  assert.ok(
    /AYNA_ADLARI\.includes\(/.test(govde),
    "aynayiTazele bilinmeyen adi kontrol etMIYOR — sessiz no-op geri gelmis. " +
    "Tanınmayan ad hicbir dala girmez ve ayna guncellenmeden doner."
  );
});
