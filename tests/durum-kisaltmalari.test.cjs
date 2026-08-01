"use strict";

/**
 * OYNANMAYAN MAÇIN KISALTMASI DA TANINIR.
 *
 * ⚠️ BULUNAN: `lib/mac-durumu.cjs oynanmadiMi` eşleşmeyi TEK YÖNLÜ yapıyordu:
 * `gelen.startsWith(anahtar)`. Ama kaynak tam kelime değil ÜÇ HARFLİK ROZET
 * basıyor. "ERT" tesadüfen çalışıyordu (listede kısaltma olarak zaten vardı);
 * "İPT" çalışmıyordu, çünkü `"ipt".startsWith("iptal")` false.
 *
 * ÖLÇÜLDÜ (gerçek `data/livescore-cache.json`, 76 tekil durum metni):
 *     "ERT"  6 maç → oynanmadı ✓
 *     "İPT"  2 maç → oynanmadı ✗   (BİTMİŞ sayılıyordu)
 * `bittiMi("match-not-play", "İPT")` TRUE dönüyordu.
 *
 * ⚠️ PARA ZİNCİRİ: dosyanın kendi başlığı anlatıyor — `livescore-sync`
 * bitmiş sayılan maça `status: "FT"` yazıyor, `settle2` de `FT` görünce
 * maçı sonuçlandırıp LC ödüyor. İPTAL EDİLEN bir maçın gerçek skoru
 * (ör. 1-0) üzerinden ödeme yapılabiliyordu; "skor yok" koruması bunu
 * yakalamıyor çünkü skor GERÇEK.
 *
 * ⚠️ ETKİ ÖLÇÜLDÜ, ABARTMIYORUM: mevcut önbellekte 2 maç. Ama iptal/tatil
 * nadir değil ve hata sessiz — ödeme yapılıyor, hiçbir uyarı çıkmıyor.
 *
 * ÇÖZÜM: eşleşme çift yönlü, ama gelen metin EN AZ 3 HARF olmak şartıyla.
 * Şart olmasaydı "İY" (ilk yarı) ve "MS" (maç sonu) gibi iki harfli rozetler
 * anahtar öneklerine denk gelip BİTMİŞ maçı "oynanmadı" sayardı — o yönde
 * hata da bedava değil, ödeme 48 saat gecikir.
 */

const test = require("node:test");
const describe = require("node:test").describe;
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
const MD = require("../lib/mac-durumu.cjs");

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("tam kelimeler zaten tanınıyordu", () => {
    for (const s of ["Ertelendi", "İptal", "Tatil edildi", "Postponed", "Abandoned"]) {
      assert.equal(MD.oynanmadiMi(s), true, `${s} taninmiyor — suzgec hic calismiyor`);
    }
  });

  test("`finished` sınıfı her hâlükârda bitmiş", () => {
    assert.equal(MD.bittiMi("finished", "MS"), true);
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("üç harfli rozetler", () => {
  const KISALTMA = [
    ["İPT", "İptal"],
    ["ERT", "Ertelendi"],
    ["TAT", "Tatil edildi"],
    ["HÜK", "Hükmen"],
    ["PST", "Postponed"],
    ["ABD", "Abandoned"],
  ];

  for (const [kisa, uzun] of KISALTMA) {
    test(`"${kisa}" (${uzun}) oynanmadı sayılıyor`, () => {
      assert.equal(MD.oynanmadiMi(kisa), true, `${kisa} taninmiyor`);
    });

    test(`"${kisa}" BİTMİŞ sayılmıyor (para zinciri)`, () => {
      assert.equal(
        MD.bittiMi("match-not-play", kisa),
        false,
        `${kisa} bitmis sayiliyor — iptal/ertelenen macin skoru uzerinden LC odenir`
      );
    });
  }
});

describe("iki harfli rozetler ETKİLENMİYOR", () => {
  /**
   * ⚠️ Düzeltmenin bedeli burada ölçülüyor. Çift yönlü eşleşme sınırsız
   * olsaydı "İY"/"MS" gibi rozetler anahtarların önekine denk gelip BİTMİŞ
   * maçı "oynanmadı" sayardı; ödeme 48 saat gecikirdi.
   */
  for (const s of ["MS", "İY", "HT", "FT"]) {
    test(`"${s}" oynanmadı SAYILMIYOR`, () => {
      assert.equal(MD.oynanmadiMi(s), false, `${s} yanlislikla oynanmadi sayildi`);
    });
  }

  test("MS ve İY bitmiş tarafta kalıyor", () => {
    assert.equal(MD.bittiMi("match-not-play", "MS"), true);
    assert.equal(MD.bittiMi("match-not-play", "İY"), true);
  });
});

describe("saat ve dakika metinleri", () => {
  for (const s of ["17:00", "45+1", "90'+1", "", "  "]) {
    test(`${JSON.stringify(s)} oynanmadı sayılmıyor`, () => {
      assert.equal(MD.oynanmadiMi(s), false);
    });
  }
});

/* ── Gerçek veriyle ──────────────────────────────────────────────────────── */

test("gerçek önbellekte yalnızca beklenen durumlar eleniyor", (t) => {
  /**
   * ⚠️ YALNIZCA ÜST SINIR — ve bunu ölçerek öğrendim. İlk sürümde "en az bir
   * durum elenmeli" diye yazdım; test kırıldı çünkü önbellek CANLI dosya ve
   * ben çalışırken arka plan senkronu onu değiştirdi (76 tekil durumdan 37'ye
   * düştü, ERT/İPT satırları listeden çıktı). Kusurun kanıtı bu dosyada
   * değil — yukarıdaki birim testlerinde, ki onlar veriden bağımsız.
   *
   * Burada kalan iş tek yönlü: çift yönlü eşleşmenin TAŞMADIĞINI görmek.
   * Taşma olsaydı "MS" gibi sık rozetler elenir ve biten maçların ödemesi
   * dururdu.
   */
  const dosya = path.join(KOK, "data", "livescore-cache.json");
  if (!fs.existsSync(dosya)) return t.skip("onbellek yok");
  const c = JSON.parse(fs.readFileSync(dosya, "utf8"));

  const metinler = new Set();
  for (const lg of Object.values(c.leagues || {})) {
    for (const m of lg.matches || []) {
      const s = String(m.status || m.statusText || "").trim();
      if (s) metinler.add(s);
    }
  }
  if (metinler.size < 10) return t.skip("yeterli durum metni yok");

  const elenen = [...metinler].filter((s) => MD.oynanmadiMi(s));
  assert.ok(
    elenen.length <= Math.max(6, metinler.size * 0.15),
    `${elenen.length}/${metinler.size} durum eleniyor — cift yonlu eslesme tasmis: ${elenen.join(", ")}`
  );
  // MS elenmemeli: en sık görülen ve gerçekten bitmiş demek.
  assert.ok(!elenen.includes("MS"), "MS elenmis — biten maclarin odemesi durur");
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: çift yönlü eşleşme 3 harf şartıyla sınırlı", () => {
  const src = fs.readFileSync(path.join(KOK, "lib", "mac-durumu.cjs"), "utf8")
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");

  assert.ok(/t\.length >= 3 && k\.startsWith\(t\)/.test(src), "kisaltma eslesmesi kalkmis");
  assert.ok(/t\.startsWith\(k\)/.test(src), "tam kelime eslesmesi kalkmis");
});

test("NÖBETÇİ: bitmişlik kararı hâlâ fail-closed", () => {
  /**
   * Dosyanın kararı: `match-not-play` sınıfında durum metni oynanmadığını
   * SÖYLEMİYORSA bitmiş sayılır; `finished` sınıfı kesin. Bu yön korunmalı —
   * ters çevrilirse oynanmamış maça ödeme yapılır.
   */
  assert.equal(MD.bittiMi("", "MS"), false, "sinifsiz satir bitmis sayiliyor");
  assert.equal(MD.bittiMi("match-not-play", "ERT"), false);
  assert.equal(MD.bittiMi("finished", "ERT"), true, "finished sinifi kesin olmali");
});
