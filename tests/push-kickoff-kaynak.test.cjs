"use strict";

/**
 * KICKOFF HATIRLATMASI TAHMİNLERİ MONGO'DAN OKUR, 22 MB DOSYADAN DEĞİL.
 *
 * ⚠️ BULUNAN KUSUR (2026-08-03, services/push-scheduler.cjs):
 *
 *     const preds = asArray(await readJson(PREDS, null), "items", "preds");
 *
 * Üç ayrı sebeple yanlış:
 *
 *  1) MİGRASYON TUZAĞI — `SKORLIG_PREDS_FILE_MIRROR=0` yapıldığında
 *     `data/preds.json` artık YAZILMIYOR. Hatırlatma kimseye gitmez ve
 *     hiçbir yerde hata görünmez. `routes/duels.cjs` bu tuzağı adıyla
 *     yazmış ve Mongo'ya geçmiş; AYNI DOSYADAKİ günlük hatırlatma da aynı
 *     sebeple geçirilmiş. Kickoff yolu atlanmış — yani bu, aynı sınıfın
 *     üçüncü tekrarı ve ikincisi bu dosyanın içinde.
 *
 *  2) RENDER — disk kalıcı değil, her deploy'da dosya boş. Senkron onu
 *     doldurana kadar başlayan maçların hatırlatması kaçar.
 *
 *  3) MALİYET — ÖLÇÜLDÜ: dosya 22.5 MB, ayrıştırması 122 ms, ve bu iş
 *     5 DAKİKADA BİR yapılıyor. duels.cjs aynı notu 17 MB'ken yazmış;
 *     dosya büyümeye devam ediyor.
 *
 * Mongo yolu ölçüldü: 60 maç için 335 ms, dosyaya hiç dokunmadan.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
const NL = String.fromCharCode(10);

function satirlar(rel) {
  return fs.readFileSync(path.join(KOK, rel), "utf8")
    .split(/\r?\n/)
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    });
}

const SCHED = path.join("services", "push-scheduler.cjs");

describe("kickoff hatırlatması kaynağı", () => {
  test("kurulum sınandı: kickoff hatırlatması GERÇEKTEN tahmin okuyor", () => {
    /* ⚠️ Bu olmadan "Mongo'dan okuyor" iddiası boş: fonksiyon tahmin hiç
     * okumuyorsa yanlış kaynak da olamaz. */
    const s = satirlar(SCHED).join(NL);
    assert.ok(/async function runKickoffReminders/.test(s), "kickoff fonksiyonu yok");
    assert.ok(/macTahminleri\(/.test(s), "tahmin okuma cagrisi yok — test bir sey olcmuyor");
  });

  test("kickoff DOĞRUDAN preds.json okumuyor", () => {
    /**
     * ⚠️ ASIL KIRILGANLIK. Biri "basitleştireyim" diye dosya okumasını geri
     * koyarsa mirror kapalıyken hatırlatma sessizce kimseye gitmez — çökme
     * yok, log yok, yalnızca bildirim yok.
     */
    const s = satirlar(SCHED);
    const bas = s.findIndex((l) => /async function runKickoffReminders/.test(l));
    const son = s.findIndex((l, i) => i > bas && /^\/\* =====/.test(l.trim()));
    assert.ok(bas > 0, "kickoff fonksiyonu bulunamadi — test bir sey olcmuyor");
    const govde = s.slice(bas, son > bas ? son : bas + 60).join(NL);
    assert.ok(!/readJson\(PREDS/.test(govde),
      "kickoff dogrudan preds.json okuyor — mirror kapaliyken hatirlatma kimseye gitmez");
  });

  test("Mongo yolu ÖNCE, dosya YALNIZCA yedek", () => {
    const s = satirlar(SCHED);
    const i = s.findIndex((l) => /async function macTahminleri/.test(l));
    assert.ok(i > 0, "macTahminleri bulunamadi");
    const govde = s.slice(i, i + 45).filter((l) => l.trim() !== "").join(NL);
    const mongoSira = govde.indexOf('collection("predictions")');
    const dosyaSira = govde.indexOf("readJson(PREDS");
    assert.ok(mongoSira > 0, "Mongo sorgusu yok");
    assert.ok(dosyaSira > 0, "dosya yedegi kaldirilmis — Mongo erisilemezken hatirlatma tumden durur");
    assert.ok(mongoSira < dosyaSira, "dosya yolu Mongo'dan once geliyor");
  });

  test("BOŞ SONUÇ dosyaya DÜŞMEZ (düzeltme kendi amacını boşa çıkarmasın)", () => {
    /**
     * ⚠️ İLK YAZIMIM BU TUZAĞA DÜŞTÜ. Kardeş fonksiyon `cuzdanKullanicilari`
     * "boş gelirse dosyayı dene" kalıbını kullanıyor ve orada mantıklı:
     * cüzdan hiç boş olmaz. Burada DEĞİL — "bu maçlara henüz kimse tahmin
     * yapmamış" normal ve bugünün gerçek hâli (60 maça 2400 tahmin, hepsi
     * bot → insan süzgecinden sonra 0). Boşta dosyaya düşseydik kaçınmak
     * istediğimiz 22 MB okumayı EN SIK durumda yapardık.
     */
    const s = satirlar(SCHED);
    const i = s.findIndex((l) => /async function macTahminleri/.test(l));
    const govde = s.slice(i, i + 45).join(NL);
    assert.ok(!/if \(docs\.length\)\s*return/.test(govde),
      "bos sonucta dosyaya dusuluyor — en sik durumda 22 MB okunur, duzeltme etkisiz kalir");
    assert.ok(/return docs\.filter/.test(govde),
      "Mongo sonucu kosulsuz donmuyor");
  });

  test("BOTLAR hedef listesinden elenir", () => {
    /* ⚠️ Botların jetonu yok, gönderim zaten atlanıyordu — ama hedef
     * listesine girmeleri boşuna iş. Ölçüldü: yakın 60 maça 2400 tahmin,
     * tamamı bot. */
    const s = satirlar(SCHED);
    const i = s.findIndex((l) => /async function macTahminleri/.test(l));
    const govde = s.slice(i, i + 45).join(NL);
    const kez = (govde.match(/botMu\(/g) || []).length;
    assert.ok(kez >= 2, `bot suzgeci ${kez} yolda uygulanmis — Mongo ve dosya yollarinin ikisinde de olmali`);
  });

  test("TAHMİNLER MÜHÜRDEN SONRA çekilir (boşa sorgu atılmasın)", () => {
    /**
     * ⚠️ SIRA ÖNEMLİ. Mühür başka bir instance'a gittiyse bu instance hiç
     * bildirim göndermeyecek; tahminleri önceden çekmek saf israf olurdu.
     * Çok instance'lı üretimde bu her tick'te tekrarlanır.
     */
    const s = satirlar(SCHED);
    const bas = s.findIndex((l) => /async function runKickoffReminders/.test(l));
    const govde = s.slice(bas, bas + 60);
    const muhurSira = govde.findIndex((l) => /await claimKeys\(/.test(l));
    const tahminSira = govde.findIndex((l) => /await macTahminleri\(/.test(l));
    assert.ok(muhurSira >= 0 && tahminSira >= 0, "muhur/tahmin cagrilari bulunamadi");
    assert.ok(muhurSira < tahminSira,
      "tahminler muhurden ONCE cekiliyor — muhur baskasina gittiyse sorgu bosa gider");
  });

  test("NÖBETÇİ: bu dosyada preds.json okuyan BAŞKA yol kalmadı", () => {
    /**
     * ⚠️ SINIF TARAMASI. Aynı kusur bu dosyada üçüncü kez çıktı; tekil
     * düzeltme yetmiyor. `PREDS` sabiti yalnızca `macTahminleri`nin yedek
     * dalında geçmeli.
     */
    const s = satirlar(SCHED);
    const gecen = [];
    s.forEach((l, i) => { if (/readJson\(PREDS/.test(l)) gecen.push(i); });
    assert.equal(gecen.length, 1,
      `preds.json ${gecen.length} yerde okunuyor — yedek dali disinda kopya var`);
    const i = s.findIndex((l) => /async function macTahminleri/.test(l));
    assert.ok(gecen[0] > i && gecen[0] < i + 45,
      "tek okuma macTahminleri disinda — baska bir yol dosyaya bagli kalmis");
  });
});
