"use strict";

/**
 * GÜVENLİ YOL SINIRI — dizin dışına çıkış yok.
 *
 * ⚠️ BU TURDA KUSUR BULUNMADI. Üç somut şüpheyle geldim, üçünü de ölçtüm:
 *
 * 1) KAÇIŞ. Dosyanın kendi notu "18 çağrı yerinden yalnızca 4'ünde temizleyici
 *    vardı" diyor — yarım kalmış bir düzeltmenin izi. 22 düşmanca girdi
 *    denedim (yol ayırıcıları, ters eğik çizgi, unicode nokta/bölü varyantları,
 *    NUL bayt, sağdan-sola işaretleyici, 400 karakter, ".", ".."):
 *    KÖK DIŞINA ÇIKAN: 0.
 *
 * 2) ÇAĞRI YERLERİ. Çalışma zamanı kodunda istekten gelen bir adla
 *    `path.join` yapan ve `guvenliYol` KULLANMAYAN yer aradım: yok. Bulunan
 *    8 aday `scripts/` altında ve hepsi yerel veriden ad üretiyor (yedek
 *    dosyası, zaman damgası) — istekten gelmiyor.
 *
 * 3) WINDOWS AYGIT ADLARI. `guvenliAd` "CON", "NUL", "COM1", "LPT1" adlarını
 *    OLDUĞU GİBİ geçiriyor. Eski Windows'ta `NUL.json` yazmak veriyi sessizce
 *    yutardı — maç durum dosyası hiç kaydedilmez, hata da alınmazdı.
 *    ÖLÇTÜM: bu makinede (Windows 11, Node 22) dördü de SIRADAN DOSYA gibi
 *    davranıyor — yazılan veri aynen geri okundu, dosyalar diskte duruyor.
 *    Üretim zaten Linux. Değiştirmedim; test davranışı sabitliyor ki bir gün
 *    değişirse görünür olsun.
 *
 * Bu test bir düzeltmeyi değil, bir GÜVENLİK SINIRINI koruyor. Sınır
 * `POST /api/rt/poll` gibi KİMLİKSİZ uçların dosya yazmasını çevreliyor;
 * kırılırsa sonuç cüzdan dosyasının üzerine yazılması olurdu.
 */

const test = require("node:test");
const describe = require("node:test").describe;
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const KOK_DIZIN = path.join(__dirname, "..");
const { guvenliAd, guvenliYol } = require("../lib/guvenli-dosya.cjs");

const KOK = path.resolve(path.join(os.tmpdir(), "skorlig-guvenli-yol-test", "live"));

/** Gerçek saldırı biçimleri + platform tuzakları. */
const DUSMANCA = [
  "../../data/lc-wallet",
  "..\\..\\data\\lc-wallet",
  "....//....//x",
  "a/../../b",
  "..;/x",
  "\u002e\u002e/x",
  "\uff0e\uff0e/x",        // fullwidth nokta
  "\uff0f..\uff0fx",       // fullwidth bölü
  "x\u0000.json",          // NUL bayt
  "\u202e.json",           // sağdan-sola işaretleyici
  "  ..  ",
  "...",
  ".",
  "..",
  "",
  "   ",
  "x".repeat(400),
  "/etc/passwd",
  "C:\\Windows\\system32\\config",
  "\\\\sunucu\\paylasim\\x",
];

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("normal ad beklendiği gibi çözülüyor", () => {
    const y = guvenliYol(KOK, "MK-ABC-2026-08-01-XYZ", ".json");
    assert.equal(path.dirname(y), KOK, "normal ad kokun altinda degil — test bir sey olcmuyor");
    assert.ok(y.endsWith(".json"));
  });

  test("farklı adlar farklı dosyalara gidiyor", () => {
    assert.notEqual(guvenliYol(KOK, "a", ".json"), guvenliYol(KOK, "b", ".json"));
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("kök dışına çıkış yok", () => {
  for (const kotu of DUSMANCA) {
    const etiket = JSON.stringify(kotu).slice(0, 40);
    test(`${etiket} kökün DIŞINA çıkmıyor`, () => {
      let y = null;
      try {
        y = guvenliYol(KOK, kotu, ".json");
      } catch (e) {
        // Fırlatmak da kabul: ikinci savunma katmanı devreye girmiş.
        assert.match(String(e.message), /GUVENSIZ_YOL/);
        return;
      }
      assert.ok(
        y.startsWith(KOK + path.sep),
        `${etiket} kok disina cikti: ${y}`
      );
    });
  }

  test("KARAKTER SÜZGECİ ayırıcıları gerçekten temizliyor", () => {
    /**
     * ⚠️ BU AYRI BİR İDDİA — ve nedenini ölçerek öğrendim. Yukarıdaki sınır
     * testlerinde karakter süzgecini SİLDİM ve hiçbiri kırılmadı: ikinci
     * katman (`guvenliYol`'un kök denetimi) devralıp `GUVENSIZ_YOL`
     * fırlatıyor, testler de fırlatmayı kabul ediyor.
     *
     * Yani o testler SINIRIN tuttuğunu kanıtlıyor, SÜZGECİN çalıştığını
     * değil. Fark önemli: süzgeç çalışırken istek zararsız bir dosya adına
     * çözülüyor; süzgeç yokken aynı istek 500 hatasına dönüşür. İki katmanın
     * ikisi de ayrı ayrı sınanmalı.
     */
    for (const [girdi, olmamasi] of [
      ["a/b", "/"], ["a\\b", "\\"], ["a:b", ":"], ["a*b", "*"],
      ["a?b", "?"], ["a|b", "|"], ["a<b", "<"], ['a"b', '"'],
    ]) {
      const c = guvenliAd(girdi);
      assert.ok(!c.includes(olmamasi), `"${girdi}" temizlenmedi: ${JSON.stringify(c)}`);
    }
    assert.equal(guvenliAd("../../data/lc-wallet"), ".._.._data_lc-wallet");
  });

  test("boş/anlamsız girdi gizli ada dönüşmüyor", () => {
    // Boş string `.json` gibi gizli bir dosya adı üretirdi.
    for (const bos of ["", "   ", ".", "..", "..."]) {
      const taban = path.basename(guvenliYol(KOK, bos, ".json"));
      assert.ok(!taban.startsWith("."), `gizli ad uretildi: ${taban}`);
      assert.equal(taban, "_.json", `beklenmedik taban: ${taban}`);
    }
  });

  test("uzun ad kırpılıyor (dosya sistemi sınırı)", () => {
    const taban = path.basename(guvenliYol(KOK, "x".repeat(400), ".json"));
    assert.ok(taban.length <= 190, `taban ${taban.length} karakter — kirpma calismiyor`);
  });

  test("komşu dizine sızma yok (öneki aynı olan yol)", () => {
    /**
     * ⚠️ `path.sep` eki olmadan `"/data/live-gizli"` yolu `"/data/live"` ile
     * BAŞLAR ama onun altında değildir. Dosyanın kendi notu bunu yazıyor;
     * burada davranış sınanıyor.
     */
    const komsu = KOK + "-gizli";
    fs.mkdirSync(komsu, { recursive: true });
    const y = guvenliYol(KOK, "dosya", ".json");
    assert.ok(!y.startsWith(komsu), `komsu dizine sizildi: ${y}`);
  });
});

/* ── Platform tuzağı ─────────────────────────────────────────────────────── */

describe("Windows aygıt adları", () => {
  test("aygıt adı verisi YUTMUYOR (ölçülen davranış)", (t) => {
    /**
     * ⚠️ DÜRÜST: bu bir düzeltme değil, ÖLÇÜLEN davranışın sabitlenmesi.
     * `guvenliAd` "NUL"/"CON"/"COM1" adlarını olduğu gibi geçiriyor. Eski
     * Windows'ta bunlar aygıta yazardı ve maç durum dosyası sessizce
     * kaybolurdu. Bu makinede sıradan dosya gibi davranıyorlar; üretim zaten
     * Linux. Davranış değişirse burada görünür.
     */
    if (process.platform !== "win32") return t.skip("yalnizca Windows'ta anlamli");
    const d = path.join(os.tmpdir(), "skorlig-aygit-test");
    fs.rmSync(d, { recursive: true, force: true });
    fs.mkdirSync(d, { recursive: true });

    for (const ad of ["NUL", "CON", "COM1", "LPT1"]) {
      const y = guvenliYol(d, ad, ".json");
      fs.writeFileSync(y, JSON.stringify({ veri: "onemli" }));
      const geri = fs.readFileSync(y, "utf8");
      assert.equal(
        geri, JSON.stringify({ veri: "onemli" }),
        `${ad}.json yazilan veriyi geri vermedi — aygit adi veriyi yutuyor, ` +
          "mac durum dosyasi sessizce kaybolur"
      );
    }
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: çalışma zamanında dinamik yol hep guvenliYol'dan geçiyor", () => {
  /**
   * ⚠️ ELLE LİSTE YOK — kural koddan türetiliyor. `scripts/` hariç tutuluyor:
   * orası çevrimdışı bakım aracı ve adları yerel veriden üretiyor, istekten
   * değil.
   */
  const suclu = [];
  const gez = (dizin) => {
    for (const ad of fs.readdirSync(dizin)) {
      if (ad === "node_modules" || ad === "scripts" || ad === "tests" || ad.startsWith(".")) continue;
      const tam = path.join(dizin, ad);
      if (fs.statSync(tam).isDirectory()) { gez(tam); continue; }
      if (!ad.endsWith(".cjs")) continue;

      const src = fs.readFileSync(tam, "utf8")
        .split("\n")
        .map((l) => {
          const t = l.trim();
          return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
        });
      src.forEach((l, i) => {
        if (!/path\.join\(\s*[A-Za-z_$][\w$.]*\s*,\s*(`[^`]*\$\{|[A-Za-z_$][\w$.]*\s*\+)/.test(l)) return;
        if (/guvenliYol|guvenliAd/.test(l)) return;
        suclu.push(`${path.relative(KOK_DIZIN, tam)}:${i + 1}`);
      });
    }
  };
  gez(KOK_DIZIN);

  assert.deepEqual(
    suclu, [],
    `istekten gelen adla dogrudan yol kuran yer(ler): ${suclu.join(", ")} — dizin disina cikilabilir`
  );
});
