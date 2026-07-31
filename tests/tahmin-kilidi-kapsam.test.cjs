"use strict";

/**
 * TAHMİN KİLİDİ KAPSAMI — puanlanan bir tahmin, kilitten geçmeden yazılamaz.
 *
 * ⚠️ BULUNAN: `POST /api/weekly-picks/predict` maçın başlayıp başlamadığını
 * YALNIZCA canlı durum DOSYASINDAN kontrol ediyordu:
 *
 *     const live = await getLiveState(fixtureId);
 *     if (live?.status && live.status !== "NS") reddet;
 *
 * Dosya yoksa `live` null olur ve kontrol SESSİZCE GEÇER. Render'da
 * `data/live/` geçici disktir, her deploy'da silinir. Üstelik saat tabanlı bir
 * yedek de yoktu: kickoff çoktan geçmiş olsa bile hiçbir şey durdurmuyordu.
 *
 * Bu uç `predictions` koleksiyonuna yazıyor ve settle2 orayı okuyup PUANLIYOR,
 * LC ÖDÜYOR. Yani bitmiş maça tahmin girip sonucu bilerek kazanmak mümkündü.
 *
 * ⚠️ AYNI SINIF ÜÇÜNCÜ KEZ: `pred.cjs`te `computePredLock` üç yerde açık
 * bırakıyordu (düzeltildi), `duels.cjs`te `isFixtureLocked` aynıydı
 * (düzeltildi), havuzda kilit HİÇ yoktu (eklendi). Tek tek düzeltmek yetmiyor
 * — bu test kapsamı kuralın kendisi hâline getiriyor.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
const ROTA_DIZIN = path.join(KOK, "routes");

/** Tahmin YAZAN çağrılar — settle2 bunları puanlar. */
const TAHMIN_YAZAR = /collection\(\s*"predictions"\s*\)\s*\.\s*(updateOne|insertOne|replaceOne|bulkWrite)|savePred\s*\(/;

/** Kabul edilen kilit çağrıları. */
const KILIT = /(fiksturKilidi|computePredLock|predLock)\s*\(/;

/** Bir dosyadaki router bloklarını (bildirim + gövde) döner. */
function bloklar(dosya) {
  const satirlar = fs.readFileSync(path.join(ROTA_DIZIN, dosya), "utf8").split("\n");
  const baslar = [];
  satirlar.forEach((l, i) => {
    if (/^router\.(get|post|put|patch|delete)\(/.test(l)) baslar.push(i);
  });
  return baslar.map((bas, k) => {
    const son = k + 1 < baslar.length ? baslar[k + 1] : satirlar.length;
    const m = /^router\.(get|post|put|patch|delete)\(\s*"([^"]+)"/.exec(satirlar[bas]);
    return {
      yontem: m ? m[1].toUpperCase() : "?",
      yol: m ? m[2] : "?",
      satir: bas + 1,
      govde: satirlar.slice(bas, son).join("\n"),
    };
  });
}

test("tahmin yazan her uç fikstür kilidinden geçer", () => {
  const kusurlu = [];
  let bakilan = 0;

  for (const dosya of fs.readdirSync(ROTA_DIZIN)) {
    if (!dosya.endsWith(".cjs")) continue;
    for (const b of bloklar(dosya)) {
      if (!TAHMIN_YAZAR.test(b.govde)) continue;
      bakilan++;
      if (!KILIT.test(b.govde)) {
        kusurlu.push(`${dosya}:${b.satir} ${b.yontem} ${b.yol}`);
      }
    }
  }

  assert.ok(bakilan >= 1, `tahmin yazan uc bulunamadi (${bakilan}) — tarama kalibi bozulmus olabilir`);
  assert.deepStrictEqual(
    kusurlu,
    [],
    "Bu uclar kilitten gecmeden tahmin yaziyor; settle2 onlari puanlayip LC oder:\n" +
      kusurlu.join("\n")
  );
});

test("canlı durum dosyası TEK BAŞINA kapanma ölçütü olamaz", () => {
  /**
   * `if (live?.status && live.status !== "NS")` deseni dosya yoksa sessizce
   * geçer. `data/live/` Render'da geçici; deploy sonrası TÜM maçlar "başlamamış"
   * görünür. Bu desen tahmin yazan bir gövdede tek başına duruyorsa hatadır.
   */
  const kusurlu = [];
  const SADECE_DOSYA = /live\??\.status\s*&&\s*live\.status\s*!==\s*"NS"/;

  for (const dosya of fs.readdirSync(ROTA_DIZIN)) {
    if (!dosya.endsWith(".cjs")) continue;
    for (const b of bloklar(dosya)) {
      if (!SADECE_DOSYA.test(b.govde)) continue;
      if (!TAHMIN_YAZAR.test(b.govde)) continue;   // yalnızca gösterim yapan yerler serbest
      if (KILIT.test(b.govde)) continue;           // ortak kilit de varsa sorun yok
      kusurlu.push(`${dosya}:${b.satir} ${b.yontem} ${b.yol}`);
    }
  }

  assert.deepStrictEqual(
    kusurlu,
    [],
    "Bu uclar kapanmayi yalnizca canli durum dosyasina dayiyor (dosya yoksa gecer):\n" +
      kusurlu.join("\n")
  );
});

test("ortak kilit fail-closed kalıyor", () => {
  // Kilidin kendisi açık bırakırsa yukarıdaki kapsam testleri anlamsızlaşır.
  const src = fs.readFileSync(path.join(KOK, "lib", "fikstur-kilit.cjs"), "utf8");
  for (const sebep of [
    "NO_FIXTURE", "FIXTURE_NOT_FOUND", "NO_KICKOFF", "BAD_KICKOFF", "FIXTURE_CHECK_FAILED",
  ]) {
    const re = new RegExp("locked:\\s*false[^}]*" + sebep);
    assert.ok(!re.test(src), `${sebep} icin kilit ACIK donuyor`);
  }
});
