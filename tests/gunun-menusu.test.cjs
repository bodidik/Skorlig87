"use strict";

/**
 * GÜNÜN MENÜSÜ BOŞ KALMAZ — SAĞLAYICI KAPALIYKEN BİLE.
 *
 * ⚠️ ÖZELLİK AY(LAR)DIR ÖLÜYDÜ. `GET /api/live/daily-menu` fikstürleri
 * doğrudan API-Football'dan çekiyordu ve `fetchPlayable` ilk satırında
 * `if (!AF_KEY) return []` diyor. AF askıya alındığından beri (bkz.
 * services/af-sync.cjs — anahtar yokken start erken dönüyor) uç HERKESE boş
 * liste veriyordu.
 *
 * ÖLÇÜLDÜ (2026-08-02, canlı sunucu):
 *     daily-menu                 -> 0 maç
 *     daily-menu?country=Türkiye -> 0 maç
 *     daily-menu?country=England -> 0 maç
 * Aynı anda depoda 1963 fikstür ve 629 tahmin edilebilir (NS) maç vardı.
 * `components/DailyMenuStrip.tsx` bu listeyi basıyor — ana ekrandaki şerit
 * boş kalıyordu ve HATA DA GÖRÜNMÜYORDU.
 *
 * ⚠️ VERİ YOKLUĞU DEĞİL, KAPATILMIŞ SAĞLAYICIDAN OKUMA. Uygulamanın kendi
 * fikstür deposu (Maçkolik + FDO) doluydu; uç oraya hiç bakmıyordu.
 *
 * ⚠️ SIRALAMA UYDURULMADI: `lib/fixture-priority.cjs` zaten "hangi maç daha
 * çekici" kuralını taşıyor (kullanıcının ülkesi > global > büyük lig) ve ana
 * ekran onu kullanıyor. Aynı kuralı burada kullanmak iki yerin ayrışmasını
 * önlüyor.
 */

const test = require("node:test");
const describe = require("node:test").describe;
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const KOK = path.join(__dirname, "..");
const KUM = fs.mkdtempSync(path.join(os.tmpdir(), "skorlig-menu-"));
process.env.SKORLIG_DATA_DIR = KUM;
process.env.SKORLIG_BG = "0";

const BUGUN = new Date().toISOString().slice(0, 10);
const mk = (id, h, a, c, saat) => ({
  fixtureId: id, home: h, away: a, country: c, league: `${c} Ligi`,
  status: "NS", kickoffISO: `${BUGUN}T${saat}:00:00.000Z`,
});

fs.writeFileSync(path.join(KUM, "fixtures.json"), JSON.stringify([
  mk("F1", "Galatasaray", "Fenerbahçe", "Türkiye", "18"),
  mk("F2", "Real Madrid", "Barcelona", "Spain", "19"),
  mk("F3", "Ali FK", "Veli SK", "Türkiye", "20"),
  mk("F4", "X United", "Y City", "England", "21"),
  mk("F5", "Z Kulup", "W Kulup", "Brazil", "22"),
  // ⚠️ Elenmeli: dünkü maç
  { fixtureId: "F6", home: "Dun", away: "Mac", country: "Türkiye", status: "NS", kickoffISO: "2020-01-01T18:00:00.000Z" },
  // ⚠️ Elenmeli: bitmiş maç
  { fixtureId: "F7", home: "Bitmis", away: "Mac", country: "Türkiye", status: "FT", kickoffISO: `${BUGUN}T10:00:00.000Z` },
]));

describe("günün menüsü", () => {
  let srv, port;

  test("kur", async () => {
    const express = require("express");
    const app = express();
    app.use((q, _r, n) => { q.app.locals.db = null; n(); });
    app.use("/api/live", require(path.join(KOK, "routes", "fixtures.cjs")));
    await new Promise((r) => { srv = app.listen(0, r); });
    port = srv.address().port;
  });

  const menu = (q = "") =>
    fetch(`http://127.0.0.1:${port}/api/live/daily-menu${q}`, { signal: AbortSignal.timeout(15000) })
      .then(async (r) => ({ s: r.status, j: await r.json().catch(() => null) }));

  test("AF anahtarı YOKKEN bile maç döner (asıl kusur)", async () => {
    /* ⚠️ Testin ortamında AF_KEY yok — üretimdeki askıya alınmış durumun
     * aynısı. Eski kod burada 0 maç döndürüyordu. */
    const r = await menu();
    assert.equal(r.s, 200);
    assert.ok((r.j.fixtures || []).length > 0,
      "gunun menusu BOS — saglayici kapaliyken depo yedegi devreye girmiyor");
  });

  test("BUGÜN dışı ve BİTMİŞ maçlar elenir", async () => {
    const r = await menu();
    const idler = (r.j.fixtures || []).map((x) => x.fixtureId);
    assert.ok(!idler.includes("F6"), "dunku mac menude — tarih suzgeci calismiyor");
    assert.ok(!idler.includes("F7"), "bitmis mac menude — durum suzgeci calismiyor");
  });

  test("KULLANICININ ÜLKESİ öne alınır", async () => {
    /* ⚠️ Sıralama `lib/fixture-priority.cjs`ten geliyor; ana ekranla aynı
     * kural. Burada ayrı bir sıralama yazmak ikisini ayrıştırırdı. */
    const tr = await menu("?country=Türkiye");
    assert.equal((tr.j.fixtures || [])[0]?.country, "Türkiye",
      "Turk kullaniciya Turk maci once gelmiyor");
    const es = await menu("?country=Spain");
    assert.equal((es.j.fixtures || [])[0]?.country, "Spain",
      "Ispanyol kullaniciya Ispanyol maci once gelmiyor");
  });

  test("slot sınırı aşılmaz", async () => {
    const r = await menu();
    assert.ok((r.j.fixtures || []).length <= 4, `menude ${r.j.fixtures.length} mac — 4 slot bekleniyor`);
  });

  test("yanıt istemcinin beklediği alanları taşır", async () => {
    /* `components/DailyMenuStrip.tsx` bu alanları basıyor; eksikse ekranda
     * bos satir ya da undefined gorunur. */
    const f = (await menu()).j.fixtures[0];
    for (const alan of ["fixtureId", "home", "away", "kickoffISO", "status"]) {
      assert.ok(f[alan] != null, `yanitta ${alan} yok — ekran eksik basar`);
    }
  });

  test("kapat", () => {
    srv?.close();
    try { fs.rmSync(KUM, { recursive: true, force: true }); } catch {}
  });
});
