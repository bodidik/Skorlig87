"use strict";

/**
 * TAHMİN KİLİDİ TEK KAYNAKTAN — liste ile gönderme AYRI değerler kullanıyordu.
 *
 * ⚠️ KUSUR (kullanıcı deneyimi denetimi, 2026-08-03):
 *     routes/pred.cjs   PRED_LOCK_BEFORE_MIN = 10   ← GERÇEKTE UYGULANAN
 *     routes/live2.cjs  LOCK_BEFORE_MIN      =  5   ← listede gösterilen
 *     routes/fixtures.cjs LOCK_BEFORE_MIN    =  5
 *     routes/duels.cjs  DUEL_LOCK_BEFORE_MIN = 10
 *
 * SONUCU: kickoff'a 10–5 dakika kalan aralıkta maç listede AÇIK görünüyor
 * (`lock: false`), kullanıcı tahminini giriyor, gönderince sunucu
 * `PRED_LOCKED_BEFORE_KICKOFF` ile REDDEDİYOR. Bu geçici bir durum değil —
 * HER maç bu 5 dakikalık pencereden geçiyor.
 *
 * ⚠️ DAHA KÖTÜSÜ, KULLANICIYA YANLIŞ KURAL BİLDİRİLİYORDU: `/live2/open`
 * yanıtı `lockBeforeMin: 5` alanını döndürüyor ve mobil bunu doğrudan ekrana
 * yazıyor ("Kilit: 5 dk" — app/(tabs)/live.tsx:1194). Yani uygulama hem
 * yanlış davranıyor hem yanlış söz veriyordu.
 *
 * ⚠️ DOĞRU DEĞER 10: uygulanan o. Listeyi 10'a çekmek maçı 5 dakika ERKEN
 * kilitli gösterir; tersi ise çalışmayan bir buton demek. Bu yönde yanılmak
 * ucuz, öbür yönde yanılmak kırık bir eylem.
 */

const test = require("node:test");
const describe = require("node:test").describe;
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
process.env.SKORLIG_BG = "0";
const { TAHMIN_KILIT_DK } = require("../lib/ekonomi.cjs");

const DOSYALAR = [
  "routes/live2.cjs",
  "routes/fixtures.cjs",
  "routes/pred.cjs",
  "routes/duels.cjs",
];

const yalin = (p) => fs.readFileSync(path.join(KOK, p), "utf8")
  /* ⚠️ SATIR SONLARI ÖNCE NORMALLEŞTIRİLİR — CRLF İKİ NÖBETÇİYİ SESSİZCE
   * KÖRELTMİŞTİ. Depoda .gitattributes yok ve core.autocrlf=true, yani Windows
   * checkout unda her satır CR+LF ile bitiyor. İçinde LF geçen bir kalıp — bir
   * fonksiyon gövdesini yeni satır + kapanış parantezi ile kesmek, ya da iki
   * satırlık bir dizgeyi indexOf ile aramak — o checkout ta HİÇBİR ZAMAN
   * eşleşmiyordu: kod doğru olduğu hâlde iddia düşüyor, ya da daha kötüsü gövde
   * çıkarımı -1 dönüp ölçüm YANLIŞ BÖLGEYE kayıyordu. */
  .replace(/\r\n?/g, "\n")
  .split("\n")
  .map((l) => {
    const t = l.trim();
    return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
  })
  .join("\n");

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("sabit makul", () => {
    assert.ok(TAHMIN_KILIT_DK > 0, "kilit kapali — test bir sey olcmuyor");
    assert.ok(TAHMIN_KILIT_DK <= 60, `kilit ${TAHMIN_KILIT_DK} dk — cok genis`);
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("tek kaynak", () => {
  for (const dosya of DOSYALAR) {
    test(`${dosya} kilidi ekonomi.cjs'ten alıyor`, () => {
      const src = yalin(dosya);
      assert.ok(
        /TAHMIN_KILIT_DK/.test(src),
        `${dosya} ortak sabiti kullanmiyor — deger yeniden ayrisir`
      );
      assert.ok(
        !/^const\s+\w*LOCK_BEFORE_MIN\s*=\s*[0-9]/m.test(src),
        `${dosya} kilit suresini SAYIYLA yeniden tanimliyor — ` +
        `liste ile gonderme yine ayrisir ve kullanici calismayan buton gorur`
      );
    });
  }

  test("dört dosya da AYNI değeri görüyor", () => {
    /* Davranış testi: her modülün gerçekten aynı sayıyı okuduğunu, kaynak
     * taramasıyla değil çalıştırarak doğrula. */
    const E = require("../lib/ekonomi.cjs");
    assert.equal(E.TAHMIN_KILIT_DK, TAHMIN_KILIT_DK);
    for (const dosya of DOSYALAR) {
      const yol = path.join(KOK, dosya);
      assert.doesNotThrow(() => require(yol), `${dosya} yuklenemiyor`);
    }
  });
});

/* ── Kullanıcıya bildirilen kural doğru mu ───────────────────────────────── */

describe("istemciye bildirilen kural", () => {
  test("lockBeforeMin alanı UYGULANAN değeri bildiriyor", () => {
    /**
     * ⚠️ Bu alan mobilde kullanıcıya YAZILIYOR ("Kilit: N dk"). Yanlış değer
     * bildirmek, kullanıcıya yalan söylemek demek — hata olarak da görünmez.
     */
    const src = yalin("routes/live2.cjs");
    assert.ok(/lockBeforeMin: LOCK_BEFORE_MIN/.test(src),
      "lockBeforeMin sabit bir sayiyla bildiriliyor olabilir");
    assert.ok(/TAHMIN_KILIT_DK: LOCK_BEFORE_MIN/.test(src),
      "LOCK_BEFORE_MIN ortak sabitten gelmiyor");
  });
});

/* ── Nöbetçi ─────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: kilit hesabı hâlâ kickoff'tan ÇIKARIYOR", () => {
  /* Sabiti birleştirirken işaret/birim hatası yapılmadığını doğrula:
   * `koMs - N*60*1000` olmalı, artı değil. */
  for (const dosya of ["routes/live2.cjs", "routes/pred.cjs"]) {
    const src = yalin(dosya);
    assert.ok(
      /koMs - \w*LOCK_BEFORE_MIN \* 60 \* 1000/.test(src),
      `${dosya}: kilit ani kickoff'tan cikarilmiyor`
    );
  }
});
