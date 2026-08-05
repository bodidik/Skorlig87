"use strict";

/**
 * SEZON LİDERLERİ EKRANI HANGİ SEZONA BAKTIĞINI SÖYLER.
 *
 * ⚠️ BULUNAN KUSUR (2026-08-03): `GET /api/rt/totals` yalnızca İÇİNDE
 * BULUNULAN sezonun toplamlarını döndürüyor (lib/season-totals.cjs) ama hangi
 * sezon olduğunu SÖYLEMİYORDU. Tek tüketicisi `app/(tabs)/kings.tsx` ve
 * başlığı "Sezon Liderleri" — ekran sezon kavramını gösteriyor, veri kaynağı
 * göstermiyordu.
 *
 * ÖLÇÜLDÜ (gerçek rota, üretim Mongo'su):
 *     GET /api/rt/totals?limit=300 → alanlar {ok, items, updatedAt, limited}
 *     season / seasonLabel / isCurrentSeason: HİÇBİRİ YOK
 *     GET /api/leaderboard         → scope.season "2026-08", "Ağustos 2026"
 *
 * ⚠️ AYNI SAVUNMA KOMŞUSUNDA VARDI. `stats.tsx` bu bilgiyi `/api/leaderboard`
 * scope'undan okuyup gösteriyor ve oradaki not aynen şöyle: "sezon aylık,
 * yani ayın 1'inde tablo SESSİZCE boşalıyor ve kullanıcı ne olduğunu anlamadan
 * bir aylık emeğini kayıp sanıyor". kings.tsx'te o uyarı hiç görünemiyordu:
 * ayın 1'inde liste boşalıyor, ekranda hiçbir açıklama yok.
 *
 * Alanlar EKLENDİ, hiçbiri değiştirilmedi — eski istemciler etkilenmez.
 */

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const express = require("express");

const KOK = path.join(__dirname, "..");
const MOBIL = require("./_mobil-dizin.cjs").MOBIL;
const Season = require(path.join(KOK, "lib", "season.cjs"));

let srv = null, port = 0;

before(async () => {
  const app = express();
  app.locals.db = null;          // dosya/boş yol: sezon bilgisi yine gelmeli
  app.use("/api/rt", require(path.join(KOK, "routes", "totals-read.cjs")));
  await new Promise((r) => { srv = app.listen(0, r); });
  port = srv.address().port;
});

after(() => { srv?.close(); });

const g = async (u) => (await fetch(`http://127.0.0.1:${port}${u}`)).json();

describe("sezon liderleri — sezon etiketi", () => {
  test("kurulum sınandı: uç GERÇEKTEN yanıt veriyor", async () => {
    /* ⚠️ Bu olmadan alan kontrolleri boş: uç 404 dönse de "alan yok" derdik. */
    const j = await g("/api/rt/totals?limit=5");
    assert.equal(j.ok, true, "uc yanit vermiyor — test bir sey olcmuyor");
    assert.ok(Array.isArray(j.items), "items dizi degil");
  });

  test("yanıt sezonu SÖYLÜYOR", async () => {
    const j = await g("/api/rt/totals?limit=5");
    assert.equal(j.season, Season.seasonKey(), "season alani yok/yanlis");
    assert.equal(j.seasonLabel, Season.label(Season.seasonKey()), "seasonLabel yok/yanlis");
    assert.equal(j.isCurrentSeason, true,
      "bu uc yalnizca guncel sezonu doner — isCurrentSeason bunu bildirmeli");
  });

  test("ESKİ ALANLAR KORUNDU (eski istemci kırılmasın)", () => {
    /**
     * ⚠️ TERS RİSK. Yanıtı "düzenlerken" mevcut alanları yeniden adlandırmak,
     * güncellemeyi almamış istemcilerde boş tablo demek olurdu. Ekleme yapıldı,
     * değişiklik değil.
     */
    const src = fs.readFileSync(path.join(KOK, "routes", "totals-read.cjs"), "utf8");
    for (const alan of ["ok:", "items:", "updatedAt,", "limited:"]) {
      assert.ok(src.includes(alan), `eski alan kaybolmus: ${alan}`);
    }
  });

  test("EKRAN bu bilgiyi GERÇEKTEN gösteriyor (ucu döv)", () => {
    /**
     * ⚠️ BU OTURUMUN DEFALARCA ÖĞRENDİĞİ DERS: sunucunun alanı göndermesi
     * yetmez, ekranın okuduğunu ve ÇİZDİĞİNİ de sınamak gerekir. Alan
     * gönderilip istemcide düşen bir eşleme bu depoda daha önce oldu
     * (bkz. stats.tsx `qualified`/`minPlayed` notu).
     */
    const p = path.join(MOBIL, "app", "(tabs)", "kings.tsx");
    if (!fs.existsSync(p)) return;    // mobil depo yoksa bu sınama atlanır
    const src = fs.readFileSync(p, "utf8");
    assert.ok(/seasonLabel/.test(src), "kings.tsx seasonLabel'i hic okumuyor");
    assert.ok(/setSezonEtiket\(/.test(src), "okunan deger duruma yazilmiyor");
    assert.ok(/t\("seasonOf"/.test(src), "sezon etiketi ekranda cizilmiyor");
    assert.ok(/newSeasonReset/.test(src),
      "tablo bosken sifirlanma aciklamasi yok — asil kafa karisikligi tam orada");
  });
});
