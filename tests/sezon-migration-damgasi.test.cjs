"use strict";

/**
 * SEZON MIGRATION'I KAYDIN KENDİ ZAMANINI DAMGALAR, "ŞİMDİ"Yİ DEĞİL.
 *
 * ⚠️ BULUNAN KUSUR (2026-08-03, scripts/migrate-season-field.cjs):
 *
 *     const sezon = Season.seasonKey();                       // = ŞU AN
 *     await col.updateMany({ season: { $exists: false } },
 *                          { $set: { season: sezon } });      // HEPSİNE
 *
 * Yani script hangi ay çalıştırılırsa sezonsuz kayıtların hepsi O AYA
 * damgalanıyordu.
 *
 * ÖLÇÜLDÜ (üretim): sezonsuz 34 kaydın TAMAMI 2026-07-29 tarihli — Temmuz'a
 * ait. Script bugün (Ağustos) çalıştırılsaydı 195.3 puan ve 45 maç kalıcı
 * olarak AĞUSTOS tablosuna yazılacaktı: Temmuz eksik kalır, Ağustos şişer ve
 * geri alınamazdı (özgün tarih yalnızca `lastAt`ta duruyor).
 *
 * ⚠️ ÜÇÜNCÜ KEZ AYNI SINIF. `routes/settle2.cjs` sezonu maçın kickoff'undan,
 * `lib/kupon-settle.cjs` kuponun kilit anından almaya geçirilmişti (settle2'de
 * 9 gerçek vaka ölçülmüştü). BAKIM BETİĞİ atlanmıştı — kural kopyalanınca
 * ayrışır, betikler de koda dahildir.
 *
 * ⚠️ KURU KOŞU DA KUSURU GİZLİYORDU: yalnızca "34 kayıt sezonsuz" diyip
 * çıkıyor, HANGİ sezona yazacağını söylemiyordu. Çıktı doğru görünüyor, karar
 * yanlış. Plan artık kuru koşuda basılıyor.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
const NL = String.fromCharCode(10);
const Season = require("../lib/season.cjs");

const BETIK = path.join("scripts", "migrate-season-field.cjs");

function satirlar(rel) {
  return fs.readFileSync(path.join(KOK, rel), "utf8")
    .split(/\r?\n/)
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    });
}

describe("sezon migration damgası", () => {
  test("kurulum sınandı: betik GERÇEKTEN sezon alanı yazıyor", () => {
    /* ⚠️ Bu olmadan iddia boş: betik sezon yazmıyorsa yanlış sezon da yazamaz. */
    const s = satirlar(BETIK).join(NL);
    assert.ok(/\$set:\s*\{\s*season:/.test(s), "sezon yazimi yok — test bir sey olcmuyor");
    assert.ok(/season_totals/.test(s), "hedef koleksiyon bulunamadi");
  });

  test("HEPSİNE tek sezon damgalayan updateMany KALMADI", () => {
    /**
     * ⚠️ ASIL KIRILGANLIK. Biri "sadeleştireyim" diye tek `updateMany`ye
     * dönerse kusur aynen geri gelir ve HATA VERMEZ — yalnızca puanlar
     * yanlış ayda görünür, üstelik geri alınamaz.
     */
    const s = satirlar(BETIK).join(NL);
    assert.ok(!/updateMany\(\s*\{\s*season:\s*\{\s*\$exists:\s*false\s*\}\s*\}/.test(s),
      "sezonsuz kayitlarin HEPSINE tek sezon damgalaniyor — kayitlar scriptin calistigi aya yazilir");
  });

  test("sezon KAYDIN kendi zaman damgasından türetiliyor", () => {
    const s = satirlar(BETIK).join(NL);
    assert.ok(/lastAt/.test(s) && /createdAt/.test(s),
      "kaydin kendi zaman damgasi hic okunmuyor");
    assert.ok(/Season\.seasonKey\(new Date\(ms\)\)/.test(s),
      "sezon kaydin zamanindan turetilmiyor");
  });

  test("zaman damgası YOKSA şimdiki sezona düşülür (kayıt kaybolmasın)", () => {
    /**
     * ⚠️ TERS RİSK: damgasız kaydı atlamak onu sonsuza kadar sezonsuz
     * bırakırdı, yani her sezona sızmaya devam ederdi — düzeltmenin
     * önlemeye çalıştığı şeyin ta kendisi.
     */
    const s = satirlar(BETIK).join(NL);
    assert.ok(/damgasiz/.test(s), "damgasiz kayit sayaci yok");
    assert.ok(/else damgasiz\+\+;|else \{\s*damgasiz/.test(s.replace(/\s+/g, " ")) || /let k = sezon;/.test(s),
      "damgasiz kayit simdiki sezona dusmuyor — sonsuza kadar sezonsuz kalir");
  });

  test("KURU KOŞU planı gösteriyor (kusuru gizlemesin)", () => {
    /**
     * ⚠️ Kuru koşunun işi "kaç kayıt" demek değil, NE YAPACAĞINI söylemek.
     * Eski hâli sayıyı doğru veriyordu ama kararı hiç göstermiyordu; kusur
     * tam o boşlukta saklandı.
     */
    const s = satirlar(BETIK);
    const planSira = s.findIndex((l) => /plan \(sezon/.test(l));
    const drySira  = s.findIndex((l) => /if \(DRY\)/.test(l));
    assert.ok(planSira >= 0, "kuru kosu plani basmiyor");
    assert.ok(drySira >= 0, "DRY dali bulunamadi");
    assert.ok(planSira < drySira,
      "plan DRY cikisindan SONRA hesaplaniyor — kuru kosu yine karari gostermez");
  });

  test("davranış: Temmuz kaydı Ağustos'ta çalıştırılsa bile TEMMUZ'a yazılır", () => {
    /**
     * Kuralın kendisi (testte yeniden yazılmıyor, betikteki ifadenin aynısı).
     * Ölçülen gerçek vakanın simülasyonu: kayıt 2026-07-29, script Ağustos'ta.
     */
    const kayit = { lastAt: "2026-07-29T18:42:45.281Z" };
    const ms = Date.parse(String(kayit.lastAt || kayit.updatedAt || kayit.createdAt || ""));
    assert.ok(Number.isFinite(ms), "zaman damgasi ayristirilamadi");
    assert.equal(Season.seasonKey(new Date(ms)), "2026-07",
      "Temmuz kaydi Temmuz sezonuna dusmuyor");

    // Eski kuralın gerçekten farklı sonuç verdiğini göster (senaryo ayrımı).
    assert.notEqual(Season.seasonKey(new Date(ms)), Season.seasonKey(new Date("2026-08-03T10:00:00Z")),
      "senaryo sinirda degil — eski kural da ayni sonucu veriyorsa test bir sey kanitlamaz");
  });

  test("NÖBETÇİ: season_totals'a yazan BAKIM BETİKLERİ de sezonu olaydan alır", () => {
    /**
     * ⚠️ SINIF TARAMASI. `tests/sezon-siniri.test.cjs` yalnızca lib/routes/
     * services'i tarıyor ve `scripts/` HARİÇ — kusur tam o boşlukta yaşadı.
     */
    const dizin = path.join(KOK, "scripts");
    const suclu = [];
    for (const ad of fs.readdirSync(dizin)) {
      if (!ad.endsWith(".cjs")) continue;
      const src = fs.readFileSync(path.join(dizin, ad), "utf8");
      if (!/season_totals/.test(src)) continue;
      if (!/\$set:\s*\{\s*season:/.test(src)) continue;   // yalnızca YAZANLAR
      // Sezonu olaydan türetme izi: seasonKey'e BİR ARGÜMAN veriliyor mu?
      if (!/Season\.seasonKey\(\s*[^)\s]/.test(src)) suclu.push(`scripts/${ad}`);
    }
    assert.deepEqual(suclu, [],
      "sezonu SIMDIDEN alan bakim betigi(leri): " + suclu.join(", "));
  });
});
