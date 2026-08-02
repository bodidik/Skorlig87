"use strict";

/**
 * ÖDÜL SİSTEMİ OYUNCUYU SÜREKLİ ZENGİNLEŞTİRMEZ — yapısal güvence.
 *
 * ⚠️ NEDEN VAR: LC arzı bir kez kontrolsüz büyüdü ve ancak ELLE ölçünce
 * görüldü (`lib/economy-report.cjs` notu, 2026-07-29):
 *     toplam giriş 2.182 LC · toplam çıkış 15 LC · oran 145:1
 *     1291 oyuncunun %100'ü her maçta kâr ediyordu
 *
 * Bu dosya o hatanın geri gelmesini engelleyen DEĞİŞMEZLERİ kilitler.
 * Rapor "bugün ne oldu"yu söyler; bu test "yapı buna izin veriyor mu"yu.
 *
 * ⚠️ MEVCUT TEST BOŞ YERE YEŞİLDİ. `tests/economy.test.cjs` günlük hak
 * kuralını kendi yeniden yazıyordu:
 *     const gunluk = (bakiye, taban) => bakiye >= taban ? 0 : taban - bakiye;
 * Üretimdeki `gunlukMiktar` değişse test YİNE geçerdi — yani ekonominin en
 * kritik anti-enflasyon kuralı fiilen denetimsizdi. Bu dosya GERÇEK
 * fonksiyonu çağırıyor.
 *
 * ÖLÇÜLDÜ (üretim, 2563 uzlaşmış tahmin satırı):
 *     ortalama ödül 2.417 LC · giriş bedeli 3 LC → tahmin başına −0.583 LC
 * Yani maç ekonomisi ORTALAMADA net kuyu. Kâr yalnızca beceriyle mümkün ve
 * bu kasıtlı; kilitlenen şey MUSLUKLARIN sınırsız olmaması.
 */

const test = require("node:test");
const describe = require("node:test").describe;
const assert = require("node:assert/strict");

process.env.SKORLIG_BG = "0";

const { macOdulu, MAC_GIRIS_BEDELI } = require("../lib/ekonomi.cjs");
const Wallet = require("../routes/lc-wallet.cjs");
const Regen = require("../lib/lc-regen.cjs");

const gunlukMiktar = Wallet._gunlukMiktar;
const gunlukTaban = Wallet._gunlukTaban;
const TABANLAR = Wallet._TABANLAR;

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("GERÇEK fonksiyonlar dışa açık — test kendi kopyasını kullanmıyor", () => {
    assert.equal(typeof gunlukMiktar, "function",
      "gunlukMiktar disa acilmamis — test yine kendi kopyasini yazmak zorunda kalir");
    assert.equal(typeof gunlukTaban, "function");
    assert.ok(TABANLAR && Object.keys(TABANLAR).length >= 4);
  });

  test("giriş bedeli pozitif", () => {
    assert.ok(MAC_GIRIS_BEDELI > 0, "maca girmek bedavaysa hicbir kuyu yok");
  });
});

/* ── MUSLUK 1: günlük hak ────────────────────────────────────────────────── */

describe("günlük hak zengine AKMAZ", () => {
  test("bakiye tabanın üstündeyse SIFIR verilir", () => {
    /**
     * ⚠️ ASIL ANTİ-ENFLASYON KURALI. Koşulsuz ekleme olsaydı toplam arz
     * zamanla sonsuza giderdi; tamamlama biriktirmez.
     * Ölçülmüştü: eskiden 229 LC'si olan da her gün +5 alıyordu.
     */
    for (const bakiye of [50, 100, 229, 10000]) {
      assert.equal(gunlukMiktar(bakiye, false, 0), 0,
        `${bakiye} LC'si olana gunluk hak veriliyor — arz sinirsiz buyur`);
      assert.equal(gunlukMiktar(bakiye, true, 30), 0,
        `${bakiye} LC'si olan PREMIUM'a gunluk hak veriliyor`);
    }
  });

  test("verilen miktar farkı AŞMAZ", () => {
    for (const seri of [0, 3, 7]) {
      const taban = gunlukTaban(seri, false);
      for (const b of [0, 1, 2, taban - 0.5]) {
        const verilen = gunlukMiktar(b, false, seri);
        assert.ok(verilen <= taban - b + 1e-9,
          `seri ${seri}, bakiye ${b}: ${verilen} verilmis, fark ${taban - b}`);
        assert.ok(b + verilen <= taban + 1e-9,
          "tamamlama tabani asiyor — her gun biraz daha zenginlesir");
      }
    }
  });

  test("günlük hak ARZI oyuncu×taban ile SINIRLI", () => {
    /* Sonsuz büyüme testi: N oyuncu, her gün en fazla N×taban girer. */
    const oyuncular = [0, 2, 5, 15, 50, 229];
    const eklenen = oyuncular.reduce((a, b) => a + gunlukMiktar(b, false, 0), 0);
    assert.ok(eklenen <= oyuncular.length * TABANLAR.DAILY_FLOOR,
      "gunluk ekleme oyuncu x taban'i asiyor");
  });
});

/* ── MUSLUK 2: LC yenilenmesi ────────────────────────────────────────────── */

describe("LC yenilenmesi TAVANLI", () => {
  /* ⚠️ İMZA: applyRegen(user, nowMs, opts) — ikinci parametre SAYI.
   * İlk yazımımda oraya nesne verdim ve `new Date(nowMs)` "Invalid time
   * value" attı; test kod doğruyken kırıldı. İmzayı okumadan çağırma. */
  const SIMDI = Date.now();

  test("tavanın üstünde HİÇ üretmiyor", () => {
    const cap = 15;
    for (const bakiye of [cap, cap + 1, 100, 5000]) {
      const u = { balance: bakiye, lastRegenAt: new Date(SIMDI - 30 * 86400000).toISOString() };
      const kazanc = Number(Regen.applyRegen(u, SIMDI, { cap, hours: 1 })) || 0;
      assert.equal(kazanc, 0,
        `bakiye ${bakiye} (tavan ${cap}) iken ${kazanc} LC uretildi`);
    }
  });

  test("tavanın ALTINDA en fazla tavana kadar üretir", () => {
    /* Bir yıl beklemek bile tavanı aşan LC üretmemeli — aksi hâlde "uzun
     * süre girmeyip zengin dönme" musluğu olurdu. */
    const cap = 15;
    const u = { balance: 0, lastRegenAt: new Date(SIMDI - 365 * 86400000).toISOString() };
    const kazanc = Number(Regen.applyRegen(u, SIMDI, { cap, hours: 1 })) || 0;
    assert.ok(kazanc <= cap, `bir yillik bekleme ${kazanc} LC uretti — tavan ${cap}`);
    /* ⚠️ `applyRegen` BAKİYEYİ KENDİSİ GÜNCELLİYOR (`user.balance = bal +
     * earned`). İlk yazımımda `u.balance + kazanc` diye kontrol ettim ve
     * kazancı iki kez saydım — test kod doğruyken kırıldı. */
    assert.ok(Number(u.balance) <= cap + 1e-9,
      `yenilenme sonrasi bakiye ${u.balance}, tavan ${cap} — tavan asildi`);
  });
});

/* ── MUSLUK 3: maç ödülü ─────────────────────────────────────────────────── */

describe("maç ödülü TAVANLI ve sınırlı", () => {
  test("ödül merdiveni ÜST SINIRLI", () => {
    /**
     * ⚠️ Çarpanlar `base`'i büyütebiliyor; merdiven tavansız olsaydı tek maç
     * keyfi büyüklükte LC üretebilirdi. Ölçüldü: 999 puanlık base bile 15 LC.
     */
    const tavan = macOdulu(999999);
    assert.ok(tavan <= 20, `tek mac odulu ${tavan} LC — tavan yok gibi`);
    for (const b of [0, 5, 50, 5000, 999999]) {
      assert.ok(macOdulu(b) <= tavan, "merdiven monoton degil ya da tavani asiyor");
    }
  });

  test("ödül merdiveni AZALMIYOR (daha iyi tahmin daha az ödememeli)", () => {
    let onceki = -1;
    for (const b of [0, 1, 3, 6, 12, 20, 30, 100]) {
      const o = macOdulu(b);
      assert.ok(o >= onceki, `base ${b} icin odul dustu (${onceki} -> ${o})`);
      onceki = o;
    }
  });

  test("puansız tahmin ödül ALMIYOR", () => {
    assert.equal(macOdulu(0), 0, "yanlis tahmin bile LC kazandiriyor");
    assert.equal(macOdulu(-5), 0, "negatif base odul uretiyor");
  });
});

/* ── Değişmez: taban, kaybı bedava yapmamalı ─────────────────────────────── */

describe("kaybetmek bedava DEĞİL", () => {
  /**
   * `routes/lc-wallet.cjs` kendi notunda yazıyor: taban, günlük oyun
   * bedelinin 3 katından AZ kalmalı — yoksa her şeyini kaybeden oyuncu
   * ertesi gün TAM tamamlanır ve kaybetmek bedava olur.
   */
  const SINIR = MAC_GIRIS_BEDELI * 3;

  test("normal kademeler değişmezi sağlıyor", () => {
    for (const ad of ["DAILY_FLOOR", "DAILY_FLOOR_3", "DAILY_FLOOR_7"]) {
      assert.ok(TABANLAR[ad] < SINIR,
        `${ad}=${TABANLAR[ad]} · sinir ${SINIR} — kaybetmek bedavaya yaklasiyor`);
    }
  });

  test("PREMIUM kademesi bilinçli istisna — ve sınırı belgeleniyor", () => {
    /**
     * ⚠️ ÖLÇÜLDÜ: `DAILY_FLOOR_PREM` = 12, değişmez sınırı 9. Yani premium
     * oyuncu her şeyini kaybetse de ertesi gün 12 LC'ye tamamlanıyor ve
     * günde 4 maçı bedavaya oynayabiliyor.
     *
     * BU BİR KUSUR DEĞİL, ÜCRETLİ ÜRÜNÜN KENDİSİ — ama sessiz de kalmamalı:
     * sınırsız DEĞİL (tamamlama, ekleme değil; zengin premium 0 alır) ama
     * normal kademelerin bağlı olduğu değişmezin DIŞINDA. Test bunu
     * dondurur: premium taban büyütülürse burada görünür.
     */
    assert.ok(TABANLAR.DAILY_FLOOR_PREM >= SINIR,
      "premium taban artik degismezin icinde — istisna notu gozden gecirilmeli");
    assert.ok(TABANLAR.DAILY_FLOOR_PREM <= 6 * MAC_GIRIS_BEDELI,
      `premium taban ${TABANLAR.DAILY_FLOOR_PREM} — gunde ${(TABANLAR.DAILY_FLOOR_PREM / MAC_GIRIS_BEDELI).toFixed(1)} bedava mac, fazla`);
    /* Zengin premium yine SIFIR alıyor — tamamlama semantiği korunuyor. */
    assert.equal(gunlukMiktar(TABANLAR.DAILY_FLOOR_PREM, true, 30), 0);
  });

  test("seri bonusu TABANI yükseltiyor, koşulsuz EKLEME yapmıyor", () => {
    /* Koşulsuz ekleme birikir; tamamlama birikmez. Fark tam da enflasyon. */
    assert.ok(gunlukTaban(7, false) > gunlukTaban(0, false), "seri bonusu yok");
    assert.equal(gunlukMiktar(gunlukTaban(7, false), false, 7), 0,
      "seri sahibi zengin oyuncuya da veriliyor — bonus birikir");
  });
});
