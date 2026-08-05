"use strict";

/**
 * KULLANICIYA GÖRÜNEN HATA KODLARININ TÜRKÇE KARŞILIĞI OLMALI.
 *
 * ⚠️ `mobile/lib/hataMesaji.ts` tam bu iş için yazılmış ve kendi başlığı
 * gerekçesini söylüyor: "ekranlar sunucudan gelen kodu olduğu gibi basıyordu —
 * kullanıcı bunu okuyamaz; okuyamadığı bir hatada yapabileceği bir şey de
 * yoktur, çıkar."
 *
 * ÖLÇÜLDÜ: kullanıcı uçlarının döndürdüğü 192 koddan 37'si ne sözlükte ne de
 * kalıp geri düşüşünde karşılık buluyordu — hepsi tek bir "Bir şeyler ters
 * gitti" cümlesine düşüyordu. Sık karşılaşılan 25'i eklendi, kalan 12'si
 * iç/yönetici yollarında.
 *
 * ⚠️ İKİ KEZ FAZLA SAYDIM, İKİSİNİ DE ÖLÇÜM DÜZELTTİ:
 *   1) İlk tarama sözlüğü hiç okuyamadı (anahtarlar tırnaksız) ve "223/223
 *      kapsanmıyor" dedi.
 *   2) Sonra `kalipla()` geri düşüşünü hesaba katmadım ve 70 dedim; oysa o
 *      fonksiyon `_REQUIRED`/`_MISSING`/`_NOT_FOUND`/`_FAILED` kalıplarını
 *      zaten karşılıyor. Gerçek sayı 37'ydi.
 * Ölçmeden yazsaydım bulguyu altı kat abartacaktım.
 */

const test = require("node:test");
const describe = require("node:test").describe;
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
const MOBIL = require("./_mobil-dizin.cjs").MOBIL;
const SOZLUK_DOSYA = path.join(MOBIL, "lib", "hataMesaji.ts");

/** Yorumları boşaltır — sözlükteki örnek kodlar sayıma girmesin. */
function kodu(s) {
  return s.split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");
}

/** Sözlükte açıkça karşılığı olan kodlar. */
function sozluk() {
  const s = kodu(fs.readFileSync(SOZLUK_DOSYA, "utf8"));
  return new Set([...s.matchAll(/^\s*([A-Z][A-Z0-9_]{3,})\s*:/gm)].map((m) => m[1]));
}

/**
 * Kalıp geri düşüşü — `kalipla()` ile AYNI olmalı.
 * Kaynaktan türetilemiyor (fonksiyon TS içinde), o yüzden burada tekrar
 * yazılıyor; aşağıdaki nöbetçi ikisinin ayrışmadığını denetliyor.
 */
const KALIP = /_REQUIRED$|_MISSING$|^REQ$|^REQUIRED$|_NOT_FOUND$|_FAILED$|_ERR$/;

/** Kullanıcı uçlarının döndürdüğü kodlar (yönetici/altyapı hariç). */
function sunucuKodlari() {
  const out = new Map();
  for (const f of fs.readdirSync(path.join(KOK, "routes"))) {
    if (!f.endsWith(".cjs")) continue;
    if (/^admin|provider|config|db\./.test(f)) continue;      // kullanıcı görmez
    const src = kodu(fs.readFileSync(path.join(KOK, "routes", f), "utf8"));
    for (const m of src.matchAll(/error:\s*"([A-Z][A-Z0-9_]{3,})"/g)) {
      if (!out.has(m[1])) out.set(m[1], f);
    }
  }
  return out;
}

/**
 * Karşılıksız kalması KABUL EDİLEN kodlar — hepsi iç/altyapı yolları.
 * Liste yalnızca KÜÇÜLEBİLİR (aşağıdaki test bunu zorluyor).
 */
/* ⚠️ `BAD_SID` ve `SERVER` ÇIKARILDI: ikisi de artık hiçbir yerden dönmüyor
 * (routes/lib/services/middleware taramasında sıfır eşleşme) ve sözlükte de
 * yok. Aşağıdaki bayatlık testi tam bunu söylüyordu — ama mobil depo
 * worktree'den çözülemediği için ATLANIYORDU ve kimse göremedi. Yol tek
 * kaynağa bağlanınca (bkz. tests/_mobil-dizin.cjs) iddia ilk kez koştu ve
 * ikisini de bildirdi. Bayat muafiyet, aynı kodun sessizce geri gelmesinin
 * önünü açar. */
const KABUL = new Set([
  "BAD_WEEK_KEY", "INVALID_SCORE", "MISSING_FIELDS", "NOT_FINISHED", "NOT_FOUND",
  "NOT_FOUND_OR_ALREADY_DELETED", "NOT_FOUND_OR_NOT_DELETED", "NO_BOT_PROFILES",
  "SKORLIG_EVENTS_ERROR", "SKORLIG_SUMMARY_ERROR", "UNKNOWN",
]);

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("sözlük okunabiliyor", (t) => {
    if (!fs.existsSync(SOZLUK_DOSYA)) return t.skip("mobil depo yan klasorde yok");
    const s = sozluk();
    assert.ok(s.size >= 50, `sozlukten yalnizca ${s.size} kod okundu — ayristirma bozuk`);
  });

  test("sunucu kodları toplanabiliyor", () => {
    assert.ok(sunucuKodlari().size >= 100, "kod taramasi bozuk");
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("kapsam", () => {
  test("karşılıksız kod listesi BÜYÜMÜYOR", (t) => {
    if (!fs.existsSync(SOZLUK_DOSYA)) return t.skip("mobil depo yok");
    const bilinen = sozluk();
    const yeni = [...sunucuKodlari().entries()]
      .filter(([k]) => !bilinen.has(k) && !KALIP.test(k) && !KABUL.has(k))
      .map(([k, f]) => `${k}  (${f})`);

    assert.deepStrictEqual(
      yeni, [],
      "Bu kodlarin Turkce karsiligi yok; kullanici 'Bir seyler ters gitti'\n" +
        "goruyor ve ne yapacagini bilemiyor. hataMesaji.ts'e ekle ya da\n" +
        "gercekten ic bir yolsa KABUL listesine gerekcesiyle yaz:\n" + yeni.join("\n")
    );
  });

  test("KABUL listesi bayat değil", (t) => {
    if (!fs.existsSync(SOZLUK_DOSYA)) return t.skip("mobil depo yok");
    const kodlar = sunucuKodlari();
    const bilinen = sozluk();
    const gereksiz = [...KABUL].filter((k) => !kodlar.has(k) || bilinen.has(k));
    assert.deepStrictEqual(
      gereksiz, [],
      "Bu kodlar artik donmuyor ya da sozluge eklenmis — KABUL'den cikar:\n" +
        gereksiz.join("\n")
    );
  });

  test("sözlükte artık dönmeyen kod kalmamış", (t) => {
    if (!fs.existsSync(SOZLUK_DOSYA)) return t.skip("mobil depo yok");
    /**
     * Ters yön: silinmiş bir kodun cümlesi sözlükte kalırsa liste güvenilmez
     * olur. İstemci kendi ürettiği kodları da (NETWORK, BAD_JSON...) sözlükte
     * tutuyor — onlar sunucuda aranmaz.
     */
    const ISTEMCI_URETIMI = new Set([
      "NETWORK", "BAD_JSON", "EMPTY_RESPONSE", "TIMEOUT", "ABORTED",
    ]);
    const kodlar = sunucuKodlari();
    const oksuz = [...sozluk()].filter((k) => !kodlar.has(k) && !ISTEMCI_URETIMI.has(k));
    // Bilgi amaçlı: sözlükte fazladan kod olması zarar vermez, ama çok
    // birikirse liste gerçeklikten kopar.
    assert.ok(
      oksuz.length <= 40,
      `sozlukte artik donmeyen ${oksuz.length} kod var — liste gerceklikten kopuyor:\n` +
        oksuz.slice(0, 20).join(", ")
    );
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: kalıp geri düşüşü testtekiyle aynı", (t) => {
  /**
   * `kalipla()` TS içinde; testteki KALIP onun kopyası. Ayrışırsa test ya
   * yanlış alarm verir ya da gerçek boşluğu kaçırır — bu oturumda kopyalanan
   * mantık iki kez yeşil-ama-ölü test üretti.
   */
  if (!fs.existsSync(SOZLUK_DOSYA)) return t.skip("mobil depo yok");
  /* ⚠️ REGEX BAĞLAMINDA ARANIYOR, ALT DİZE OLARAK DEĞİL. İlk sürüm
   * `src.includes("_NOT_FOUND")` diyordu ve negatif kontrolde kalıbı bozmak
   * testi KIRMADI — çünkü aynı metin sözlük anahtarında da geçiyor
   * (`WALLET_NOT_FOUND:`). `$` çapası yalnızca regex'te bulunur. */
  const src = kodu(fs.readFileSync(SOZLUK_DOSYA, "utf8"));
  for (const parca of ["_REQUIRED$", "_MISSING$", "_NOT_FOUND$", "_FAILED$", "_ERR$"]) {
    assert.ok(
      src.includes(parca),
      `kalipla() artik ${parca} kalibini karsilamiyor — testteki KALIP guncellenmeli`
    );
  }
});
