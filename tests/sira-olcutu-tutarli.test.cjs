"use strict";

/**
 * TABLO SIRASI İLE "KENDİ SIRAM" AYNI ÖLÇÜTÜ KULLANIYOR.
 *
 * ⚠️ BULUNAN: `routes/weekly-picks.cjs` haftalık liderlik ucunda sıralama İKİ
 * KEZ yapılıyordu ve ölçütler ayrışmıştı:
 *
 *     tablo      : b.points - a.points || b.correct - a.correct
 *     kendi sıram: b.points - a.points                  ← `correct` YOK
 *
 * Eşit puanlı iki kişide sıra, `Array.sort` kararlı olduğu için Map ekleme
 * sırasına düşüyordu.
 *
 * ÖLÇÜLDÜ (eşit puan, farklı doğru sayısı, top-N dışı):
 *     ali  → tabloya göre 4., kendi kartında 5. gösteriliyor
 *     veli → tabloya göre 5., kendi kartında 4. gösteriliyor
 *
 * İkisi de yanlış ve ikisi de BİRBİRİNİN sırasını görüyordu. Daha çok maç
 * bilen kişi daha kötü sıra görebiliyordu.
 *
 * ⚠️ `me` yalnızca kullanıcı top-N'de YOKKEN ayrıca hesaplanıyor — yani kusur
 * tam da listede görünmeyen, sırasını yalnızca kendi kartından öğrenebilen
 * kullanıcıyı vuruyordu.
 *
 * ⚠️ AYNI SINIF BU DEPODA DAHA ÖNCE YAŞANDI: `services/tournament.cjs`
 * yorumu, ödeme hesabının ikinci kopyasının ayrışıp canlı yolda fazla/eksik
 * ödeme bıraktığını anlatıyor. Hesabın ikinci kopyası er geç ayrışıyor.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const nodePath = require("path");

/* ── Değişmez: iki hesap aynı sonucu vermeli ─────────────────────────────── */

describe("sıra hesabı tutarlı", () => {
  /**
   * Uç, Mongo snapshot'ları üzerinden çalışıyor; burada ÖLÇÜTÜN KENDİSİNİ
   * sınıyoruz. Kaynaktaki ölçüt kopyalanmadan, aşağıdaki nöbetçi tek kaynak
   * olduğunu ayrıca doğruluyor.
   */
  const siraOlcutu = (a, b) => b.points - a.points || b.correct - a.correct;

  function kur() {
    const m = new Map();
    const ekle = (userId, points, correct) =>
      m.set(userId, { userId, points, correct, matches: 10 });
    ekle("lider1", 30, 10);
    ekle("lider2", 25, 8);
    ekle("lider3", 20, 6);
    /* Top-3 dışı, BERABERE puanlı ama farklı doğru sayılı.
     * Ekleme sırası bilerek "correct'i düşük olan önce" — beraberlik bozma
     * ölçütü uygulanmazsa bu sıra korunur ve yanlış sonuç verir. */
    ekle("veli", 10, 1);
    ekle("ali", 10, 7);
    ekle("cem", 5, 2);
    return m;
  }

  test("beraberlikte doğru sayısı ayırıyor", () => {
    const sirali = Array.from(kur().values()).sort(siraOlcutu);
    const ali = sirali.findIndex((u) => u.userId === "ali");
    const veli = sirali.findIndex((u) => u.userId === "veli");
    assert.ok(
      ali < veli,
      `esit puanda daha cok dogru bilen (ali, 7) geride kaldi: ` +
      `${JSON.stringify(sirali.map((u) => u.userId))}`
    );
  });

  test("top-N dışındaki kullanıcının sırası tablonun DEVAMI", () => {
    const LIMIT = 3;
    const tumSirali = Array.from(kur().values()).sort(siraOlcutu);
    const tablo = tumSirali.slice(0, LIMIT).map((u, i) => ({ rank: i + 1, ...u }));

    /* Tablonun son sırası ile ilk "dışarıdaki" sıra ardışık olmalı. */
    const sonRank = tablo[tablo.length - 1].rank;
    const ilkDisari = tumSirali.findIndex(
      (u) => !tablo.some((t) => t.userId === u.userId)
    ) + 1;
    assert.equal(
      ilkDisari, sonRank + 1,
      `tablo ${sonRank}'te bitiyor ama ilk disaridaki ${ilkDisari}. sirada — ` +
      `iki hesap ayni diziden gelmiyor`
    );
  });

  test("İKİ ÖLÇÜT kullanılsaydı sıralar çakışırdı (kusurun kanıtı)", () => {
    /**
     * ⚠️ Bu iddia DÜZELTİLMİŞ davranışı değil, KUSURUN varlığını gösteriyor:
     * ölçüt ayrışırsa iki kullanıcı birbirinin sırasını görür. Düzeltme
     * doğruysa yukarıdaki iki iddia geçer; bu iddia ise "neden önemli"yi
     * kayıt altına alıyor.
     */
    const eksikOlcut = (a, b) => b.points - a.points; // correct yok
    const dogru = Array.from(kur().values()).sort(siraOlcutu);
    const eksik = Array.from(kur().values()).sort(eksikOlcut);

    const dogruAli = dogru.findIndex((u) => u.userId === "ali") + 1;
    const eksikAli = eksik.findIndex((u) => u.userId === "ali") + 1;
    assert.notEqual(
      dogruAli, eksikAli,
      "iki olcut ayni sonucu verdi — kurgu kusuru gostermiyor, senaryo bozuk"
    );
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: weekly-picks tek sıralama ölçütü kullanıyor", () => {
  const src = fs.readFileSync(
    nodePath.join(__dirname, "..", "routes", "weekly-picks.cjs"), "utf8"
  );
  const kod = src.split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");

  /**
   * ⚠️ ÖLÇÜTÜ İFADE OLARAK ARIYORUZ, `.sort(...)` ÇAĞRISI OLARAK DEĞİL.
   *
   * İlk hâlim yalnızca inline `.sort((a,b) => ...)` biçimini tanıyordu ve
   * düzeltmenin kendisi (ölçütü `siraOlcutu` değişkenine almak) nöbetçiyi
   * kör etti: "puan siralamasi bulunamadi" diye düştü. Aranması gereken şey
   * çağrının biçimi değil, KARŞILAŞTIRMA İFADESİNİN kaç kez yazıldığı.
   */
  const gecisler = [...kod.matchAll(/b\.points\s*-\s*a\.points[^;\n]*/g)]
    .map((m) => m[0].replace(/\s+/g, " ").trim().replace(/[,)]+$/, ""));

  assert.ok(
    gecisler.length > 0,
    "puan siralama ifadesi bulunamadi — tarama bozuk (bicim degisti mi?)"
  );

  assert.equal(
    gecisler.length, 1,
    `weekly-picks'te puan siralama olcutu ${gecisler.length} KEZ yazilmis:\n` +
    gecisler.map((o) => "  " + o).join("\n") +
    "\nTablo ile 'kendi siram' ayri olcut kullanirsa esit puanli kullanicilar\n" +
    "birbirinin sirasini gorur (olculdu: ali 4. yerine 5., veli 5. yerine 4.).\n" +
    "Olcut TEK degiskene alinip iki yerde de kullanilmali."
  );

  /* Beraberlik bozma ölçütü de korunmalı — tek yazım ama `correct` düşerse
   * eşit puanlılar yine rastgele sıralanır. */
  assert.ok(
    /b\.correct\s*-\s*a\.correct/.test(gecisler[0]),
    `siralama olcutu beraberlik bozma tasimIYOR: "${gecisler[0]}" — esit ` +
    `puanli kullanicilar Map ekleme sirasina gore siralanir`
  );
});
