"use strict";

/**
 * SKOR GÜVENİLİRLİĞİ — ayrıştırılamayan skorla FT yazılmamalı.
 *
 * ⚠️ BULUNAN: `livescore-sync` skoru okuyamadığında `0` UYDURUYOR:
 *
 *     home: hasScore ? parseInt(liveMatch.homeScore, 10) : 0
 *
 * Tek başına zararsız (canlı durumda 0-0 görünür, sonraki tur düzeltir) ama
 * `isFinished` de doğruysa bu **0-0 FİNAL** olarak yazılıp settle tetikliyordu.
 *
 * Ulaşılabilir yol: FT işareti gelmiş, HT skoru ayrışmış, FT skoru ayrışmamış
 * (kaynak işaretlemesi değişti / hücre boş). Sonuç: herkesin tahmini 0-0'a
 * göre puanlanır, LC yanlış dağıtılır — ve `claimAward` mührü atıldığı için
 * KENDİ KENDİNE DÜZELMEZ.
 *
 * ⚠️ SETTLE TETİĞİNİ KAPATMAK YETMİYOR. `settle2` skoru CANLI DURUM
 * DOSYASINDAN okuyor (`fx.score.home`). `status:"FT", score:{0,0}` yazılsaydı,
 * settle'ı başka bir yol tetiklediği anda (af-sync, admin paneli, elle
 * `/rt/settle`) yine 0-0 uzlaştırılırdı. O yüzden güvenilmez veri HİÇ
 * yazılmıyor.
 *
 * Aynı sınıfta bir hata bu dosyada zaten yaşanmıştı: `normalizeTeam` yanlış
 * takım eşleştiriyordu (1411 takımın 30'u) ve başka bir maçın skoru bizim
 * fikstüre yazılıyordu.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KAYNAK = fs.readFileSync(
  path.join(__dirname, "..", "services", "livescore-sync.cjs"),
  "utf8"
);

/** Yorumları ayıklar — metin testleri kendi açıklamalarına takılmasın. */
function kodu(metin) {
  return metin
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith("*") || t.startsWith("//") || t.startsWith("/*"));
    })
    .join("\n");
}

test("güvenilmez FT erken çıkışla engelleniyor", () => {
  const kod = kodu(KAYNAK);
  assert.ok(
    /if\s*\(\s*scores\.isFT\s*&&\s*!hasScore\s*\)/.test(kod),
    "FT + skor yok durumu icin koruma yok — 0-0 final yazilabilir"
  );
});

test("koruma, canlı durum yazımından ÖNCE geliyor", () => {
  const kod = kodu(KAYNAK);
  const koruma = kod.search(/if\s*\(\s*scores\.isFT\s*&&\s*!hasScore\s*\)/);
  const yazim = kod.indexOf("await writeLiveState(");
  assert.ok(koruma > 0 && yazim > 0, "beklenen parcalar bulunamadi");
  assert.ok(
    koruma < yazim,
    "koruma writeLiveState'ten SONRA — settle2 skoru canli durum dosyasindan " +
      "okudugu icin baska bir yol 0-0 uzlastirabilir"
  );
});

test("korumanın gövdesi `continue` ile çıkıyor", () => {
  // `writeResultsEntry`yi atlamak yetmez: canli durum da yazilmamali.
  const kod = kodu(KAYNAK);
  const i = kod.search(/if\s*\(\s*scores\.isFT\s*&&\s*!hasScore\s*\)/);
  const blok = kod.slice(i, i + 600);
  assert.ok(/continue;/.test(blok), "koruma yalnizca loglayip devam ediyor");
});

test("settle tetiği güvenilir FT'ye bağlı", () => {
  const kod = kodu(KAYNAK);
  assert.ok(
    /if\s*\(\s*ftGuvenilir\s*&&/.test(kod),
    "settle tetigi hala ham scores.isFT kullaniyor"
  );
});

/* ── Davranış ────────────────────────────────────────────────────────────── */

test("mantık tablosu: hangi girdi ne üretmeli", () => {
  /**
   * Korumanın kararını burada bağımsız olarak modelliyoruz. Kaynak metnine
   * bakan testler biçimi kilitler; bu test KURALI kilitler.
   */
  const karar = (isFT, hasScore, htVar) => {
    if (!hasScore && !htVar) return "atla";           // maç başlamadı
    if (isFT && !hasScore) return "guvenilmez-atla";  // ⬅ bulunan hata
    if (isFT && hasScore) return "ft-yaz-ve-settle";
    return "canli-yaz";
  };

  assert.equal(karar(false, false, false), "atla");
  assert.equal(karar(true, false, true), "guvenilmez-atla", "FT + skor yok yazilmamali");
  assert.equal(karar(true, true, true), "ft-yaz-ve-settle");
  assert.equal(karar(false, true, true), "canli-yaz");
  // Skor var ama HT yok — normal canlı akış.
  assert.equal(karar(false, true, false), "canli-yaz");
});
