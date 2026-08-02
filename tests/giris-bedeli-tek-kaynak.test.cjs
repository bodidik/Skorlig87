"use strict";

/**
 * MAÇ GİRİŞ BEDELİ TEK KAYNAKTAN — TAHSİLAT VE İADE AYNI SAYIYI KULLANIR.
 *
 * ⚠️ BULUNAN KUSUR (2026-08-02, routes/settle2.cjs):
 *     const LC_ENTRY_COST = 3;      <- SABIT KODLU
 * Bu değer İADE hesabında kullanılıyor. Tahsilat ise `routes/pred.cjs`
 * üzerinden `lib/ekonomi.cjs`in `LC_MATCH_COST`unu kullanıyor ve o
 * `SKORLIG_MATCH_COST` ile yapılandırılabiliyor.
 *
 * Operatör bedeli 5 yaparsa:
 *     tahsilat : 5 LC   (ekonomi.cjs)
 *     iade     : 3 LC   (settle2'deki sabit)
 * ve her iadede 2 LC SESSİZCE kaybolurdu.
 *
 * ⚠️ KUSUR YALNIZCA VARSAYILAN DIŞINDA GÖRÜNÜR — bugün aynı biçim
 * `SKORLIG_DAILY_FLOOR` için de bulundu: ödeme yolu `|| 3`, satış ekranı
 * `|| 6` okuyordu; değişken set edilmezse 2 kat ayrışıyor, set edilirse
 * tesadüfen uyuşuyordu. Sabitin bugün doğru olması güvence değil.
 *
 * ⚠️ `routes/weekly-picks.cjs` bu sabitin DÖRDÜNCÜ adını taşıdığını zaten
 * not etmiş (LC_MATCH_COST / MATCH_ENTRY_COST / ...). Tek kaynağa bağlamak
 * o zincirin son halkasıydı.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
const { MAC_GIRIS_BEDELI, LC_MATCH_COST } = require("../lib/ekonomi.cjs");

/** Yorum satırlarını atarak kaynak metni verir (çıpa kendi notuna düşmesin). */
function kodu(rel) {
  return fs.readFileSync(path.join(KOK, rel), "utf8")
    .split(/\r?\n/)
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
    })
    .join(" ");
}

describe("giriş bedeli tek kaynak", () => {
  test("kurulum sınandı: ekonomi.cjs bedeli veriyor", () => {
    assert.ok(Number.isFinite(MAC_GIRIS_BEDELI) && MAC_GIRIS_BEDELI > 0,
      `MAC_GIRIS_BEDELI gecersiz: ${MAC_GIRIS_BEDELI}`);
    assert.equal(LC_MATCH_COST, MAC_GIRIS_BEDELI, "eski ad ile yeni ad ayrismis");
  });

  test("settle2 bedeli SABİT KODLAMIYOR (iade tahsilatla ayni olsun)", () => {
    const src = kodu(path.join("routes", "settle2.cjs"));
    assert.ok(!/const\s+LC_ENTRY_COST\s*=\s*\d/.test(src),
      "settle2 giris bedelini sabit kodluyor — SKORLIG_MATCH_COST degisince iade tahsilattan AZ olur");
    assert.ok(/ekonomi\.cjs/.test(src),
      "settle2 ekonomi.cjs'i yuklemiyor — bedel ikinci bir yerde tanimli");
  });

  test("ORTAM DEĞİŞKENİ değişince settle2 de değişir", () => {
    /**
     * ⚠️ ASIL İDDİA BU. Sabitin bugün 3 olması yetmez; tahsilatla İADE aynı
     * kaynağı okumalı. Modülü taze yükleyip değişkenin geçtiğini kanıtlıyoruz.
     */
    const eski = process.env.SKORLIG_MATCH_COST;
    try {
      process.env.SKORLIG_MATCH_COST = "7";
      const yol = require.resolve(path.join(KOK, "lib", "ekonomi.cjs"));
      delete require.cache[yol];
      const taze = require(yol);
      assert.equal(taze.MAC_GIRIS_BEDELI, 7, "ekonomi.cjs ortam degiskenini okumuyor");
      assert.equal(taze.LC_MATCH_COST, 7, "eski ad ortam degiskenini takip etmiyor");
    } finally {
      if (eski === undefined) delete process.env.SKORLIG_MATCH_COST;
      else process.env.SKORLIG_MATCH_COST = eski;
      delete require.cache[require.resolve(path.join(KOK, "lib", "ekonomi.cjs"))];
      require(path.join(KOK, "lib", "ekonomi.cjs"));
    }
  });

  test("TAHSİLAT yolu da tek kaynaktan okuyor", () => {
    /* İade tarafını düzeltip tahsilatı unutmak, kusuru ters yöne çevirirdi. */
    const src = kodu(path.join("routes", "pred.cjs"));
    assert.ok(/LC_MATCH_COST|MAC_GIRIS_BEDELI/.test(src),
      "tahsilat yolu bedeli tek kaynaktan okumuyor");
    assert.ok(!/const\s+(LC_MATCH_COST|MATCH_ENTRY_COST)\s*=\s*\d/.test(src),
      "tahsilat yolunda sabit kodlu bedel var");
  });
});
