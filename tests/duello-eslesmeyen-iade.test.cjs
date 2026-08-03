"use strict";

/**
 * KABUL EDİLMEMİŞ DÜELLO MAÇ BİTİNCE İADE EDİLİR.
 *
 * ⚠️ BULUNAN KUSUR (2026-08-03, üretimde ölçüldü): maçı UZLAŞMIŞ olduğu hâlde
 * hâlâ `open` duran bir düello vardı ve kurucunun bahsi 5 gündür kilitliydi:
 *
 *     duel_ms5xhb36_7en8ta  open  MK-UNIVCR-2026-07-29-LEVSKI  3 LC
 *
 * ⚠️ İKİ GÜVENLİK AĞININ ARASINA DÜŞÜYORDU — VE İKİSİ DE KENDİNCE HAKLIYDI:
 *
 *   • `settleDuelsForFixture` `status !== "active"` diye atlıyordu. Haklı:
 *     rakip yok, puanlanacak bir yarış yok.
 *   • `services/bayat-temizleyici.cjs` `bayatMi()`ye soruyor, o da
 *     "SONUC_VAR" deyip bayat SAYMIYOR. O da haklı: temizleyicinin işi
 *     sonucu HİÇ gelmeyen maçlar.
 *
 * Her biri ötekine devrediyor, kimse iade etmiyor. Bu, "savunma bir yerde var
 * öbüründe yok"un daha sinsi biçimi: savunma İKİ yerde de var ama aradaki
 * hücre boş.
 *
 * Maç bittikten sonra düello ARTIK KABUL EDİLEMEZ (arena yalnızca gelecek
 * maçları listeler), dolayısıyla tek doğru sonuç: geçersiz kıl + iade et.
 *
 * ÖNCE/SONRA (gerçek fonksiyon, üretim kaydı): kurucu bakiyesi 18 → 21,
 * durum open → voided (voidReason=KABUL_EDILMEDI), defterde
 * `duel_unmatched_refund` kaydı, ödenemeyen iz yok.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
const NL = String.fromCharCode(10);
const { DURUM, PARA_TUTAN } = require("../lib/duel-durum.cjs");

function satirlar(rel) {
  return fs.readFileSync(path.join(KOK, rel), "utf8")
    .split(/\r?\n/)
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    });
}

const DUELS = path.join("routes", "duels.cjs");

describe("eşleşmeyen düello iadesi", () => {
  test("kurulum sınandı: `open` GERÇEKTEN para tutan bir durum", () => {
    /**
     * ⚠️ Bu olmadan iddia boş: `open` para tutmuyorsa iade edilecek bir şey
     * de yok demektir. Tek kaynak `lib/duel-durum.cjs` bunu yazıyor —
     * "kurucunun bahsi düşülmüş".
     */
    assert.ok(PARA_TUTAN.includes(DURUM.ACIK),
      "open para tutan sayilmiyor — test bir sey olcmuyor");
    assert.equal(DURUM.GECERSIZ, "voided");
  });

  test("uzlaştırma AÇIK düelloları da ele alıyor", () => {
    /**
     * ⚠️ ASIL KIRILGANLIK. Biri "zaten aktif olanları işliyoruz" diye bu
     * bloğu kaldırırsa para sessizce yeniden kilitlenir; hata yok, log yok.
     */
    const s = satirlar(DUELS).join(NL);
    assert.ok(/status:\s*DURUM\.ACIK/.test(s),
      "uzlastirma acik duellolari hic aramiyor — bahis kalici kilitli kalir");
    assert.ok(/duel_unmatched_refund/.test(s), "eslesmeyen iade sebebi yok");
    assert.ok(/KABUL_EDILMEDI/.test(s), "gecersizlik sebebi yazilmiyor");
  });

  test("MÜHÜR ÖNCE, ÖDEME SONRA (çift iade olmasın)", () => {
    /**
     * ⚠️ SIRA PARA ETKİLER — dosyadaki diğer üç ödeme noktasıyla aynı kural.
     * Koşul yazmanın İÇİNDE olmalı: iki tarama aynı anda çalışırsa yalnızca
     * biri `modifiedCount` alır.
     */
    /**
     * ⚠️ İLK YAZIMIM YALANCI YEŞİLDİ — negatif kontrol yakaladı.
     *
     * "modifiedCount metni `duel_unmatched_refund` metninden önce mi geliyor"
     * diye bakıyordum. Ama iade zaten AYRI bir döngüde, yani sıra sabotajdan
     * bağımsız olarak hep doğru görünüyordu: mühür koruması kaldırıldığı
     * hâlde test geçmeye devam etti.
     *
     * Ölçülmesi gereken asıl şey: `iadeEdilen` listesine ekleme, mühür
     * KORUMASINDAN SONRA olmalı. Aksi hâlde mühür başkasına gitse bile
     * düello iade kuyruğuna girer ve aynı bahis iki kez ödenir.
     */
    const s = satirlar(DUELS);
    const bas = s.findIndex((l) => /acikOlanlar/.test(l));
    assert.ok(bas > 0, "acik duello blogu bulunamadi — test bir sey olcmuyor");
    const pencere = s.slice(bas, bas + 45);

    const korumaSatiri = pencere.findIndex((l) => /if \(!m\.modifiedCount\)\s*continue/.test(l));
    const ekleSatiri  = pencere.findIndex((l) => /iadeEdilen\.push\(/.test(l));
    assert.ok(korumaSatiri >= 0, "atomik muhur korumasi yok — cift iade uretilebilir");
    assert.ok(ekleSatiri >= 0, "iade kuyruguna ekleme bulunamadi");
    assert.ok(korumaSatiri < ekleSatiri,
      "muhur KORUMASI iade kuyruguna eklemeden SONRA — muhur baskasina gitse bile ayni bahis iade edilir");

    const govde = pencere.join(NL);
    assert.ok(/id: d\.id, status: DURUM\.ACIK/.test(govde),
      "kosul yazmanin ICINDE degil — yaris penceresi acik");
  });

  test("ÖDENEMEYEN iade KALICI İZ bırakıyor", () => {
    /**
     * ⚠️ Mühür atıldığı için ikinci deneme YOK. İz düşmezse para sessizce
     * buharlaşır; dosyadaki diğer ödeme noktaları `failed_awards`e yazıyor ve
     * `GET /api/health` onu sayıyor.
     */
    const s = satirlar(DUELS);
    const bas = s.findIndex((l) => /duel_unmatched_refund/.test(l));
    assert.ok(bas > 0, "iade cagrisi bulunamadi");
    const govde = s.slice(bas, bas + 14).join(NL);
    assert.ok(/duelloBorcKaydet/.test(govde),
      "odenemeyen iade iz birakmiyor — muhur atildigi icin para kalici kaybolur");
  });

  test("DURUM adları TEK KAYNAKTAN (sabit yazılmamış)", () => {
    /**
     * ⚠️ BU DOSYANIN KENDİ GEÇMİŞİ: temizleyici durumu "accepted" sanmış ve
     * kabul edilmiş düelloları HİÇ görmemişti (bkz. lib/duel-durum.cjs).
     * Yeni blok aynı hatayı tekrarlamamalı.
     */
    const s = satirlar(DUELS);
    const bas = s.findIndex((l) => /acikOlanlar/.test(l));
    const govde = s.slice(bas, bas + 45).join(NL);
    assert.ok(!/status:\s*"open"/.test(govde), "durum sabit yazilmis");
    assert.ok(!/status:\s*"voided"/.test(govde), "gecersiz durumu sabit yazilmis");
    assert.ok(/require\(["']\.\.\/lib\/duel-durum\.cjs["']\)/.test(satirlar(DUELS).join(NL)),
      "duel-durum tek kaynagi yuklenmiyor");
  });

  test("KURUCU bildirilir (sessiz iade kullanıcıyı şaşırtır)", () => {
    /* ⚠️ Bakiyesi kendiliğinden değişen kullanıcı ne olduğunu anlamalı;
     * dosyadaki diğer sonuçlandırmalar da iki tarafa bildirim atıyor. */
    const s = satirlar(DUELS);
    const bas = s.findIndex((l) => /duel_unmatched_refund/.test(l));
    const govde = s.slice(bas, bas + 22).join(NL);
    assert.ok(/notify\(/.test(govde), "kurucuya bildirim gitmiyor");
  });

  test("TERS RİSK: AKTİF düello bu yoldan iade EDİLMEZ", () => {
    /**
     * ⚠️ ASIL TEHLİKE. Aktif düelloda İKİ taraf da bahis yatırmış ve normal
     * uzlaştırma kazananı ödüyor. Burada da iade edilseydi aynı para iki kez
     * dağıtılırdı — sorgu yalnızca `DURUM.ACIK` aramalı.
     */
    const s = satirlar(DUELS);
    const bas = s.findIndex((l) => /acikOlanlar/.test(l));
    const govde = s.slice(bas, bas + 12).join(NL);
    assert.ok(!/DURUM\.AKTIF/.test(govde) && !/PARA_TUTAN/.test(govde),
      "acik duello sorgusu aktifleri de kapsiyor — cifte odeme riski");
  });
});
