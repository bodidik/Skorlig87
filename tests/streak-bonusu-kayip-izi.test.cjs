"use strict";

/**
 * ÖDENEMEYEN STREAK BONUSU KALICI İZ BIRAKIR.
 *
 * ⚠️ BULUNAN KUSUR (2026-08-03, routes/settle2.cjs streak bonusu):
 *
 *     } catch (e) {
 *       console.error("[settle2] streak bonus mongo failed:", e);
 *     }
 *
 * Tek iz bir log satırıydı. Oysa `services/streak.cjs` eşik bonusunu TEK KEZ
 * vermek için `lastTier`i ilerletiyor ve BUNU ÖDEMEDEN ÖNCE kalıcılaştırıyor:
 * yazma patlarsa bonus bir daha hesaplanmaz. Kullanıcı eşiği geçti, bakiyesine
 * hiçbir şey yatmadı, kimse göremedi. Render'da log da akıp gider.
 *
 * Aynı yapı kupon, havuz, mini turnuva, düello ve maç ödülünde `failed_awards`e
 * yazılıyor ve `GET /api/health` onu sayıyor (`paraUyarisi`). Eksik olan tek
 * yol buydu.
 *
 * ⚠️ ÖNCEKİ TARAMAM NEDEN KAÇIRDI — nota değer: bu sınıfı `creditLc` çağrı
 * yerlerini tarayarak aramıştım (2026-08-02). Bu yol cüzdana DOĞRUDAN yazıyor,
 * o yüzden kalıba girmiyordu. Sınıf fonksiyon adıyla değil DAVRANIŞLA (para
 * yazan her yol) taranmalı — aşağıdaki nöbetçi öyle yapıyor.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
/* Satir sonu sabiti: Python icinden JS yazarken kacis katmani bozuluyordu. */
const NL = String.fromCharCode(10);

/** Yorumları atarak kaynak satırlarını verir (çıpa kendi notuna düşmesin). */
function satirlar(rel) {
  return fs.readFileSync(path.join(KOK, rel), "utf8")
    .split(/\r?\n/)
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    });
}

describe("streak bonusu kayıp izi", () => {
  test("kurulum sınandı: streak bonusu cüzdana YAZIYOR", () => {
    /* ⚠️ Bu olmadan "iz var" iddiası bir sey kanitlamaz: odeme hic yoksa
     * kaybedilecek para da yoktur. */
    const s = satirlar(path.join("routes", "settle2.cjs")).join("\n");
    assert.ok(/reason:\s*"streak_bonus"/.test(s), "streak bonusu defterine yazilmiyor — test bir sey olcmuyor");
    assert.ok(/lc_wallet_users/.test(s), "cuzdan yazimi yok");
  });

  test("MÜHÜR ödemeden ÖNCE kalıcılaşıyor (izin gerekçesi)", () => {
    /* ⚠️ Bu iddia düşerse iz gereksizleşir: bonus tekrar denenebiliyorsa
     * kayip kalici degildir. `lastTier` ilerletilip kaydediliyorsa kalicidir. */
    const s = satirlar(path.join("services", "streak.cjs")).join("\n");
    assert.ok(/s\.lastTier\s*=\s*tierIdx/.test(s),
      "esik muhru (lastTier) ilerletilmiyor — bonus tekrar odenebilir, farkli bir kusur");
  });

  test("ödeme başarısızsa KALICI İZ yazılıyor", () => {
    const s = satirlar(path.join("routes", "settle2.cjs"));
    const i = s.findIndex((l) => /reason:\s*"streak_bonus"/.test(l));
    assert.ok(i > 0, "streak bonusu yazimi bulunamadi — test bir sey olcmuyor");
    /* PENCERE KOD SATIRINA GORE. Ilk yazimim 40 HAM satira bakiyordu;
     * kusuru ANLATAN kendi aciklama blogum (20+ satir) kodu pencerenin
     * DISINA itti ve test yanlis yere kirildi. Yorumlar zaten
     * bosaltildigi icin bos satirlari eleyip sayiyoruz. */
    const pencere = s.slice(i, i + 140).filter((l) => l.trim() !== "").slice(0, 40).join(NL);
    assert.ok(/catch/.test(pencere), "yazma try/catch icinde degil");
    assert.ok(/kayipOdulKaydet/.test(pencere),
      "odenemeyen streak bonusu KALICI IZ birakmiyor — para sessizce kayboluyor, health sayamiyor");
  });

  test("SINIF NÖBETİ: cüzdana yazan HER yol iz bırakmalı", () => {
    /**
     * ⚠️ FONKSİYON ADIYLA DEĞİL DAVRANIŞLA TARIYORUZ. Önceki tarama
     * `creditLc` çağrılarına bakıyordu ve cüzdana DOĞRUDAN yazan bu yolu
     * kaçırdı. Burada `lc_wallet_users`a yazan her nokta aranıyor.
     */
    const suclu = [];
    for (const dizin of ["lib", "routes", "services"]) {
      const d = path.join(KOK, dizin);
      if (!fs.existsSync(d)) continue;
      for (const ad of fs.readdirSync(d, { withFileTypes: true })) {
        if (!ad.isFile() || !ad.name.endsWith(".cjs")) continue;
        const rel = path.join(dizin, ad.name);
        const s = satirlar(rel);
        s.forEach((l, i) => {
          // Yalnizca YAZMA: koleksiyon tanitici almak sayilmaz.
          if (!/collection\(\s*["`]lc_wallet_users["`]\s*\)\s*\.\s*(updateOne|updateMany|bulkWrite|insertOne)/.test(l)) return;
          const pencere = s.slice(Math.max(0, i - 6), i + 140).filter((x) => x.trim() !== "").slice(0, 46).join(NL);
          if (!/kayipOdulKaydet/.test(pencere)) {
            suclu.push(rel + ":" + (i + 1));
          }
        });
      }
    }
    assert.deepEqual(suclu, [],
      "cuzdana yazip kayip izi birakmayan nokta(lar): " + suclu.join(", ") +
      "  — muhur odemeden once atildigi icin bu para bir daha denenmez");
  });
});
