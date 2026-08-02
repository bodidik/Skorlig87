"use strict";

/**
 * BİR TAKIM KENDİSİYLE OYNAYAMAZ.
 *
 * ⚠️ NEREDEN ÇIKTI: kullanıcı deneyimi turu (2026-08-03). Tahmine açık
 * listede `Qingdao - Qingdao` maçı vardı ve Türk kullanıcıya **4. sırada**
 * gösteriliyordu. Kaynak (Maçkolik) iki farklı Qingdao kulübünün adını aynı
 * dizeye indirmiş.
 *
 * ÜÇ ZARARI:
 *   1) Kullanıcı anlamsız bir maç görüyor ve tahmin girebiliyor.
 *   2) ASLA UZLAŞAMAZ: `findLiveMatch` ev VE deplasman adını ayrı ayrı
 *      eşlemek zorunda; hiçbir canlı kayıt "Qingdao vs Qingdao" olmayacağı
 *      için sonuç hiç gelmez.
 *   3) Skor gelse bile "hangi Qingdao kazandı" sorusunun cevabı yok.
 *
 * ÖLÇÜLDÜ (üretim): 1907 fikstürün 1'i bu durumda. 40 tahmin almış ama
 * hepsi BOT (insan 0), düello ve sonuç kaydı yok — yani para riski yoktu,
 * bot kotası ve ekran yeri harcanıyordu.
 */

const test = require("node:test");
const describe = require("node:test").describe;
const assert = require("node:assert/strict");
const { isAcceptableFixture } = require("../lib/fixture-priority.cjs");

const mac = (home, away, league = "Süper Lig") => ({ home, away, league });

describe("aynı takım fikstürü elenir", () => {
  test("birebir aynı ad REDDEDİLİR", () => {
    assert.equal(isAcceptableFixture(mac("Qingdao", "Qingdao")), false);
  });

  test("harf/boşluk farkı da yakalanır", () => {
    assert.equal(isAcceptableFixture(mac("Qingdao", "qingdao")), false);
    assert.equal(isAcceptableFixture(mac("  Qingdao  ", "Qingdao")), false);
    assert.equal(isAcceptableFixture(mac("İSTANBULSPOR", "İstanbulspor")), false);
  });
});

describe("meşru maçlar ELENMİYOR", () => {
  test("farklı takımlar geçer", () => {
    assert.equal(isAcceptableFixture(mac("Galatasaray", "Fenerbahçe")), true);
  });

  test("AYNI ŞEHRİN farklı kulüpleri geçer", () => {
    /**
     * ⚠️ TESTİN ASIL İŞİ. Karşılaştırma bilerek NORMALİZE EDİLMİYOR:
     * ek atma / çekirdek çıkarma kuralları bu adları aynı anahtara
     * indirebilir ve meşru derbileri elerdi. Aranan şey kaynağın ürettiği
     * BİREBİR aynı ad.
     */
    assert.equal(isAcceptableFixture(mac("Manchester United", "Manchester City")), true);
    assert.equal(isAcceptableFixture(mac("Qingdao Hainiu", "Qingdao Red Lions")), true);
    assert.equal(isAcceptableFixture(mac("Inter", "Inter Miami")), true);
    assert.equal(isAcceptableFixture(mac("Real Madrid", "Real Sociedad")), true);
  });

  test("eksik ad kuralı bozulmadı", () => {
    assert.equal(isAcceptableFixture(mac("", "")), false);
    assert.equal(isAcceptableFixture(mac("A", "")), false);
    assert.equal(isAcceptableFixture(null), false);
  });
});
