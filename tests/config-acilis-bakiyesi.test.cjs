"use strict";

/**
 * /api/config AÇILIŞ BAKİYESİNİ UYDURMAZ.
 *
 * ⚠️ CANLI KUSUR DEĞİLDİ, TUZAKTI — ve bunu açıkça ayırıyorum. Uç
 * `scoring.startBalance: 500` yayınlıyordu; gerçek açılış bakiyesi
 * `lib/ekonomi.cjs` içinde 30 (1987 üyeleri için 60). Ölçüldü (2026-08-02,
 * canlı sunucu):
 *     GET /api/config -> scoring.startBalance: 500
 *     ACILIS_BAKIYESI : 30
 * 16 KAT fark.
 *
 * ⚠️ NEDEN YİNE DE ÖNEMLİ: değer hiçbir ekranda basılmıyordu ama TIPLI,
 * ÇEKİLİYOR ve yetkili görünüyor — `mobile/lib/runtimeConfig.ts` onu model
 * alanı olarak taşıyor ve aynı 500'ü varsayılan yazıyordu. Biri ekrana
 * bağlarsa yeni kullanıcıya 16 kat yanlış rakam söylenirdi. Aynı sınıf bugün
 * premium tablosunda CANLI bir kusur olarak çıktı: ekran sunucuda artık
 * olmayan bir alanı okuyup "undefined LC" basıyordu.
 *
 * ⚠️ SABİT SAYI İDDİA EDİLMİYOR: test "30" demiyor, ucun `lib/ekonomi.cjs`
 * ile AYNI değeri verdiğini söylüyor. Sabit yazmak, ortam değişkeni
 * değişince testi yanlış yere bağlardı.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
const { ACILIS_BAKIYESI } = require("../lib/ekonomi.cjs");

describe("config açılış bakiyesi", () => {
  test("kurulum sınandı: tek kaynak okunabiliyor", () => {
    assert.ok(Number.isFinite(ACILIS_BAKIYESI) && ACILIS_BAKIYESI > 0,
      `ACILIS_BAKIYESI gecersiz: ${ACILIS_BAKIYESI}`);
  });

  test("config ucu TEK KAYNAKTAN okuyor, sabit yazmıyor", () => {
    /* ⚠️ YORUM SATIRLARI DIŞLANIR. İlk yazımda kusuru ANLATAN kendi
     * açıklamam ("startBalance: 500 yayınlıyordu") iddiaya takıldı ve test
     * kırıldı. Bugün üçüncü kez aynı tuzak: çıpa/desen kendi metnine düşmemeli. */
    const ham = fs.readFileSync(path.join(KOK, "routes", "config.cjs"), "utf8");
    const satirlar = ham.split(/\r?\n/).filter((l) => {
      const t = l.trim();
      return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
    });
    const src = satirlar.join(" ");
    assert.ok(/require\(["'][^"']*ekonomi\.cjs["']\)/.test(src),
      "config ucu ekonomi.cjs'i yuklemiyor — acilis bakiyesi ikinci bir yerde tanimli");
    assert.ok(!/startBalance:\s*500/.test(src),
      "config ucunda sabit 500 duruyor — gercek deger ile ayrisir");
    assert.ok(/startBalance:\s*ACILIS_BAKIYESI/.test(src),
      "varsayilan acilis bakiyesi tek kaynaktan gelmiyor");
  });

  test("İSTEMCİ varsayılanı da aynı değerde (yarım düzeltme olmasın)", () => {
    /* ⚠️ Sunucuyu düzeltip istemci varsayılanını bırakmak, sunucu yanıtı
     * gelmediğinde yine yanlış rakam gösterirdi. Bugün üç kez bu
     * yarım-düzeltme biçimi çıktı. */
    const MOBIL = path.join(KOK, "..", "mobile");
    const p = path.join(MOBIL, "lib", "runtimeConfig.ts");
    if (!fs.existsSync(p)) return;
    const src = fs.readFileSync(p, "utf8");
    const m = src.match(/startBalance:\s*(\d+)/);
    assert.ok(m, "istemci varsayilani bulunamadi — dosya bicimi degismis");
    assert.equal(Number(m[1]), ACILIS_BAKIYESI,
      `istemci varsayilani ${m[1]}, sunucudaki tek kaynak ${ACILIS_BAKIYESI} — ayrismis`);
  });

  test("açılış bakiyesi GERÇEKTEN cüzdana yansıyan değer", () => {
    /**
     * ⚠️ Tek kaynağın kendisi de doğru yerde kullanılmalı: yeni kullanıcı
     * cüzdanı bu sabitten açılıyor. Bağ koparsa config doğru, cüzdan yanlış
     * olur — bugün "vaat vs teslim" ekseninde tam bu biçim bulundu.
     */
    const wc = fs.readFileSync(path.join(KOK, "lib", "wallet-credit.cjs"), "utf8");
    const us = fs.readFileSync(path.join(KOK, "lib", "users-store.cjs"), "utf8");
    const ikisi = wc + us;
    assert.ok(/ekonomi\.cjs/.test(ikisi),
      "cuzdan/kullanici deposu acilis bakiyesini ekonomi.cjs'ten almiyor");
  });
});
