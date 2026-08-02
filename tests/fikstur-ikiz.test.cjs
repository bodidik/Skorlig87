"use strict";

/**
 * AYNI MAÇ İKİ KEZ KAYDEDİLMESİN.
 *
 * ⚠️ ÖLÇÜLDÜ (2026-08-02, 1930 gerçek fikstür): aynı maç iki farklı ad
 * yazımıyla İKİ AYRI fixtureId olarak duruyordu — 115 çift, 230 fikstür.
 *
 * ⚠️ ZARARI DA ÖLÇÜLDÜ, VARSAYIM DEĞİL: 115 çiftin 23'ünde durum dosyası
 * YALNIZCA BİRİNDE vardı:
 *
 *     MK-MARSEI-2026-07-30-NIMES  Marseille-Nimes  [durum yok]
 *     MK-MARSIL-2026-07-30-NIMES  Marsilya-Nimes   [FT]
 *
 * Yani ikizin biri sonuçlanıp ödüyor, öbürü HİÇ uzlaşmıyor. O kayda tahmin
 * yapan kullanıcı giriş bedelini ödemiş, ödülü hiçbir zaman gelmeyecek.
 * Aynı gün "uzlaşmamış maç" diye görülen sorunun kaynağı da buydu.
 *
 * ⚠️ ASIL RİSK YANLIŞ POZİTİF. İki gerçek maçı birleştirmek, kopya bırakmaktan
 * DAHA KÖTÜ: bir maç tümden yok olur. Aşağıdaki testler ölçümde görülen
 * gerçek yanlış-pozitif adayını (aynı saat, aynı ülke, ORTAK deplasman takımı,
 * FARKLI ev sahibi) ayrıca sınıyor.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { ikizMi, ikizleriAyikla } = require("../lib/fikstur-ikiz.cjs");

const m = (id, h, a, k = "2026-07-30T19:00:00.000Z", c = "world") =>
  ({ fixtureId: id, home: h, away: a, kickoffISO: k, country: c });

describe("fikstür ikizi", () => {
  test("GERÇEK ölçülen kopyalar ikiz sayılır", () => {
    // Hepsi 2026-08-02'de gerçek veride bulundu.
    const ciftler = [
      [m("a", "Marseille", "Nimes"), m("b", "Marsilya", "Nimes")],                        // TR/EN ad
      [m("a", "Toulouse", "R. Sociedad"), m("b", "Toulouse", "Real Sociedad")],           // kisaltma
      [m("a", "Sporting CP", "Not. Forest"), m("b", "Sporting CP", "Nottingham Forest")], // kisaltma
      [m("a", "Den Haag", "Asteras"), m("b", "ADO Den Haag", "Asteras Tripolis")],        // onek + uzun ad
      [m("a", "FC Jazz", "KuPS Akatemia"), m("b", "Jazz", "KuPS Ak.")],
      [m("a", "Inter Turku II", "VJS"), m("b", "FC Inter Turku II", "VJS")],
    ];
    for (const [x, y] of ciftler) {
      assert.equal(ikizMi(x, y), true, `ikiz sayilmadi: ${x.home}-${x.away} || ${y.home}-${y.away}`);
    }
  });

  test("GERÇEK yanlış pozitif adayı ikiz SAYILMAZ", () => {
    /* ⚠️ Ölçümde çıktı: aynı dakika, aynı ülke, AYNI deplasman takımı ama
     * FARKLI ev sahibi — bunlar iki AYRI maç. Birleştirmek birini yok ederdi. */
    assert.equal(
      ikizMi(m("a", "Hradec Kralove", "NK Varazdin"), m("b", "Jablonec", "NK Varazdin")),
      false, "farkli iki mac ikiz sayildi — bir mac yok olurdu");
  });

  test("saat veya ülke farklıysa ikiz DEĞİL", () => {
    assert.equal(ikizMi(m("a", "Marseille", "Nimes"), m("b", "Marsilya", "Nimes", "2026-07-30T21:00:00.000Z")), false);
    assert.equal(ikizMi(m("a", "Marseille", "Nimes"), m("b", "Marsilya", "Nimes", "2026-07-30T19:00:00.000Z", "france")), false);
  });

  test("kısa ortak kelime EŞLEŞTİRMEZ (fc, sk, ii, b)", () => {
    /* "FC Ali" ve "FC Veli" ortak "fc" tasir ama ayri kuluplerdir. */
    assert.equal(ikizMi(m("a", "FC Ali", "SK Veli"), m("b", "FC Kemal", "SK Hasan")), false);
  });

  test("DEPODA OLAN kayıt her zaman kazanır (tahminler öksüz kalmasın)", () => {
    const mevcut = m("ESKI", "Marseille", "Nimes");
    const gelen = m("YENI", "Marsilya", "Nimes");
    const r = ikizleriAyikla([mevcut, gelen], new Set(["ESKI"]));
    assert.deepEqual(r.list.map((x) => x.fixtureId), ["ESKI"], "bilinen kayit dusuruldu — tahminler oksuz kalir");
    assert.equal(r.dusenler[0].dusen, "YENI");
  });

  test("İKİSİ DE depodaysa İKİSİ DE kalır — geriye dönük silme YOK", () => {
    /**
     * ⚠️ BU TESTİ İLK YAZIMIM KIRIYORDU ve ölçüm yakaladı: gerçek listede
     * 116 MEVCUT kayıt siliniyordu. Her birine tahmin, havuz bahsi ya da
     * düello bağlanmış olabilir — silmek onları öksüz bırakırdı, yani
     * kopyadan çok daha kötü bir sonuç. Bu fonksiyonun işi YENİ kopyayı
     * önlemek; geçmiş temizliği ayrı bir karar.
     */
    const a = m("ESKI1", "Marseille", "Nimes");
    const b = m("ESKI2", "Marsilya", "Nimes");
    const r = ikizleriAyikla([a, b], new Set(["ESKI1", "ESKI2"]));
    assert.equal(r.list.length, 2, "mevcut kayitlardan biri SILINDI — tahminler oksuz kalir");
    assert.equal(r.dusenler.length, 0);
  });

  test("karar DETERMİNİSTİK (iki senkron turu birbirini bozmasın)", () => {
    const a = m("A", "Marseille", "Nimes");
    const b = m("B", "Marsilya", "Nimes");
    const r1 = ikizleriAyikla([a, b], new Set());
    const r2 = ikizleriAyikla([b, a], new Set());   // sira degistirildi
    assert.deepEqual(r1.list.map((x) => x.fixtureId), r2.list.map((x) => x.fixtureId),
      "girdi sirasi sonucu degistiriyor — her senkronda baska kayit kalir");
  });

  test("ikiz olmayan liste HİÇ dokunulmadan geçer", () => {
    const liste = [m("1", "A", "B"), m("2", "C", "D", "2026-07-30T21:00:00.000Z"), m("3", "E", "F", "2026-07-31T19:00:00.000Z")];
    const r = ikizleriAyikla(liste, new Set());
    assert.equal(r.list.length, 3);
    assert.equal(r.dusenler.length, 0);
  });

  test("saveAll ikiz ayıklamayı ÇAĞIRIYOR (bagli degilse kusur geri gelir)", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "..", "lib", "fixtures-store.cjs"), "utf8");
    const govde = src.slice(src.indexOf("async function saveAll"), src.indexOf("async function saveAll") + 2500);
    /* ⚠️ SADECE ADI ARAMAK YETMEZ. İlk iddiam `ikizleriAyikla` GEÇİYOR MU
     * diye bakıyordu; negatif kontrolde çağrıyı yerel bir sahte fonksiyonla
     * (`const ikizleriAyikla = (l)=>({list:l})`) değiştirdim ve test YEŞİL
     * KALDI. Modülün GERÇEKTEN yüklendiğini sına. */
    assert.ok(/require\(["'\.\/]*fikstur-ikiz\.cjs["']\)/.test(govde),
      "saveAll fikstur-ikiz modulunu yuklemiyor — koruma bagli degil");
    assert.ok(/ikizleriAyikla\(/.test(govde), "ayiklama cagrilmiyor");
  });
});
