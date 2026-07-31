"use strict";

/**
 * YARIDA KESİLEN / ERTELENEN MAÇ "BİTMİŞ" SAYILMAZ.
 *
 * ⚠️ BULUNAN: Mackolik ayrıştırıcısı bitmişliği yalnızca satır sınıfından
 * çıkarıyordu —
 *
 *     const isFinished = /match-not-play|finished/.test(cls);
 *     status: isFinished ? "MS" : status        // ham durum EZİLİYOR
 *
 * `match-not-play` "oynanmıyor" demek: ERTELENEN, İPTAL, TATİL EDİLEN ve
 * HÜKMEN sonuçlanan maçlar da bu sınıfta. Hepsi "bitti" sayılıp `MS` damgası
 * yiyordu ve zincir para dağıtıyor:
 *     scraper isFinished → livescore-sync `status:"FT"` → settle2 ödeme
 *
 * ⚠️ MEVCUT KORUMA YARISINI TUTUYORDU: sync tarafında "FT ama skor yok"
 * denetimi var (uydurulmuş 0-0 hatasından kalma), yani ertelenen maç (skor
 * kutusu boş) yakalanıyordu. YARIDA KESİLEN maç yakalanmıyordu — skoru
 * gerçek (örn. 1-0), sınıfı `match-not-play`, sonuç "bitti".
 *
 * ÖLÇÜLDÜ (11 gerçekçi satır): 7'sinin sınıflandırması değişti; normal biten
 * maçlar ve canlı/başlamamış satırlar aynı kaldı.
 *
 * ⚠️ KAPALI TARAFTA HATA BURADA DOĞRU: bitmiş maçı "bitmedi" saymak parayı
 * geciktirir ama kaybetmez (`lib/bayat-mac.cjs` 48 saatte iade eder). Ters
 * yönde hata oynanmamış maç üzerinden ödeme demek — geri dönüşü yok.
 */

const test = require("node:test");
const describe = require("node:test").describe;
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { bittiMi, oynanmadiMi } = require("../lib/mac-durumu.cjs");

/** Düzeltmeden önceki kural — karşılaştırma tabanı. */
const eskiKural = (cls) => /match-not-play|finished/.test(cls);

const SATIRLAR = [
  { cls: "extra-time unliveData finished", st: "MS",        bitti: true,  ad: "normal biten" },
  { cls: "match-not-play unliveData",      st: "MS",        bitti: true,  ad: "biten (MS rozeti)" },
  { cls: "match-not-play unliveData",      st: "Ert.",      bitti: false, ad: "ertelenen" },
  { cls: "match-not-play unliveData",      st: "İptal",     bitti: false, ad: "iptal" },
  { cls: "match-not-play unliveData",      st: "Tatil",     bitti: false, ad: "tatil edilen" },
  { cls: "match-not-play unliveData",      st: "T.E.",      bitti: false, ad: "T.E. kisaltmasi" },
  { cls: "match-not-play unliveData",      st: "Hükmen",    bitti: false, ad: "hukmen" },
  { cls: "match-not-play unliveData",      st: "PST",       bitti: false, ad: "postponed" },
  { cls: "match-not-play unliveData",      st: "Abandoned", bitti: false, ad: "abandoned" },
  { cls: "live liveData",                  st: "67",        bitti: false, ad: "canli" },
  { cls: "not-started unliveData",         st: "20:00",     bitti: false, ad: "baslamamis" },
];

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("bitmişlik kararı", () => {
  for (const s of SATIRLAR) {
    test(`${s.ad} [${s.st}] → ${s.bitti ? "bitti" : "bitmedi"}`, () => {
      assert.equal(bittiMi(s.cls, s.st), s.bitti);
    });
  }

  test("BİTEN maçlar için davranış DEĞİŞMEDİ", () => {
    /**
     * Kapalı tarafa fazla kaçmadığımızın kanıtı: gerçekten biten maçlar hâlâ
     * biter. Aksi hâlde ödemeler durur ve para 48 saat kilitli kalırdı.
     */
    const bitenler = SATIRLAR.filter((s) => s.bitti);
    assert.ok(bitenler.length >= 2, "biten ornek yetersiz — test bir sey olcmuyor");
    for (const s of bitenler) {
      assert.equal(eskiKural(s.cls), true, `${s.ad}: eski kural da bitti demeliydi`);
      assert.equal(bittiMi(s.cls, s.st), true, `${s.ad}: yeni kural bozdu`);
    }
  });

  test("davranış YALNIZCA oynanmayan maçlarda değişti", () => {
    const degisen = SATIRLAR.filter((s) => eskiKural(s.cls) !== bittiMi(s.cls, s.st));
    assert.ok(degisen.length >= 5, `beklenenden az degisim (${degisen.length})`);
    for (const s of degisen) {
      assert.equal(s.bitti, false, `${s.ad} degisti ama oynanmis bir mac`);
      assert.ok(oynanmadiMi(s.st), `${s.ad}: durum metni oynanmadigini soylemiyor`);
    }
  });
});

/* ── Türkçe büyük İ ──────────────────────────────────────────────────────── */

test("Türkçe İ doğru sadeleşiyor", () => {
  /**
   * ⚠️ İlk sürüm yalnızca `toLowerCase()` yapıyordu ve "İptal" EŞLEŞMİYORDU:
   * `"İ".toLowerCase()` düz `i` değil, `i` + birleşik nokta (U+0307) üretir.
   * Ölçümde yakalandı — iptal edilen maç hâlâ "bitti" sayılıyordu.
   */
  assert.equal(oynanmadiMi("İptal"), true, "buyuk I ile baslayan durum eslesmiyor");
  assert.equal(oynanmadiMi("iptal"), true);
  assert.equal(oynanmadiMi("Hükmen"), true, "u-umlaut cozulmuyor");
  // Yanlış pozitif olmamalı: benzeyen ama geçerli durumlar.
  assert.equal(oynanmadiMi("MS"), false);
  assert.equal(oynanmadiMi("İY"), false, "ilk yari 'oynanmadi' sayilmis");
  assert.equal(oynanmadiMi("90+2"), false);
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: kazıyıcı ham durumu koruyup Node tarafında karar veriyor", () => {
  const ham = fs.readFileSync(path.join(__dirname, "..", "services", "livescore-scraper.cjs"), "utf8");
  const src = ham
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");

  /* ⚠️ KALIP TAM EŞLEŞMELİ. İlk sürüm `/_rawStatus/` arıyordu ve negatif
   * kontrolde alanı `_rawStatusYok` diye yeniden adlandırmak testi KIRMADI —
   * alt dize hâlâ eşleşiyordu. Hem yazan hem okuyan taraf sınanıyor. */
  assert.ok(
    /_rawStatus\s*:/.test(src),
    "ham durum metni satira eklenmiyor — Node tarafi karar veremez"
  );
  assert.ok(
    /\b_rawStatus\b(?!\w)/.test(src) && /r\._rawStatus/.test(src),
    "ham durum okunmuyor"
  );
  assert.ok(/bittiMi\s*\(/.test(src), "Node tarafinda bittiMi cagrilmiyor");
  assert.ok(
    /require\(["']\.\.\/lib\/mac-durumu\.cjs["']\)/.test(src),
    "ortak modul yerine kopya mantik yazilmis olabilir"
  );
});

test("NÖBETÇİ: bitmişlik kuralı ikinci bir yerde kopyalanmamış", () => {
  /**
   * Sayfa bağlamı `require` edemediği için kural iki kez yazılabilir; o zaman
   * biri düzeltilip öteki unutulur. Karar Node tarafında TEK yerde.
   */
  const KOK = path.join(__dirname, "..");
  const kusurlu = [];
  for (const alt of ["routes", "lib", "services"]) {
    const d = path.join(KOK, alt);
    if (!fs.existsSync(d)) continue;
    for (const dosya of fs.readdirSync(d)) {
      if (!dosya.endsWith(".cjs")) continue;
      if (`${alt}/${dosya}` === "lib/mac-durumu.cjs") continue;
      const src = fs.readFileSync(path.join(d, dosya), "utf8")
        .split("\n")
        .map((l) => {
          const t = l.trim();
          return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
        })
        .join("\n");
      // Ertelenmeyi ayırt etmeye çalışan ikinci bir liste.
      if (/OYNANMADI|oynanmadiMi\s*=/.test(src)) kusurlu.push(`${alt}/${dosya}`);
    }
  }
  assert.deepStrictEqual(
    kusurlu, [],
    "Oynanmadi listesi kopyalanmis — biri guncellenip oteki unutulur:\n" + kusurlu.join("\n")
  );
});
