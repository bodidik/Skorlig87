"use strict";

/**
 * HAZIR OLMA KAPISI — Mongo bağlanmadan API isteği kabul edilmemeli.
 *
 * ⚠️ BULUNAN: `server.cjs` içindeki Mongo bağlantısı ATEŞLE-UNUT bir async
 * IIFE. Blok `await` görüp dönüyor, modülün geri kalanı senkron devam edip
 * `app.listen` çağırıyor. Yani sunucu Mongo BAĞLANMADAN önce istek kabul
 * ediyor ve o pencerede `app.locals.db` TANIMSIZ.
 *
 * Rotaların çoğu `req.app?.locals?.db || null` okuyup null görünce DOSYA
 * moduna düşüyor. Sonuç: deploy sonrası ilk saniyelerde gönderilen bir tahmin
 * yalnızca dosyaya yazılıyor, settle2 ise `predictions` koleksiyonunu okuyor —
 * oyuncu 3 LC ödemiş ama tahmini hiç sonuçlanmıyor.
 *
 * `/health` koşulsuz 200 döndüğü için Render trafiği hemen yönlendiriyor;
 * pencere kuramsal değil, trafiğe açık.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");

/* ── Davranış ────────────────────────────────────────────────────────────── */

/** server.cjs'deki kapının birebir aynısı — davranışı burada sınanıyor. */
function kapiKur(hazirMi) {
  const express = require("express");
  const app = express();
  app.use((req, res, next) => {
    if (hazirMi()) return next();
    if (!req.path.startsWith("/api")) return next();
    res.set("Retry-After", "1");
    return res.status(503).json({ ok: false, error: "NOT_READY" });
  });
  app.get("/health", (req, res) => res.json({ ok: true }));
  app.get("/__up", (req, res) => res.json({ ok: true }));
  app.get("/api/pred/submit", (req, res) => res.json({ ok: true, yazildi: true }));
  return app;
}

test("hazır değilken /api 503 döner", async () => {
  const app = kapiKur(() => false);
  const s = app.listen(0);
  try {
    const p = s.address().port;
    const r = await fetch(`http://127.0.0.1:${p}/api/pred/submit`);
    assert.equal(r.status, 503);
    assert.equal(r.headers.get("retry-after"), "1");
    const j = await r.json();
    assert.equal(j.error, "NOT_READY");
  } finally {
    s.close();
  }
});

test("hazır değilken /health AÇIK kalır (süreç izleme bozulmasın)", async () => {
  const app = kapiKur(() => false);
  const s = app.listen(0);
  try {
    const p = s.address().port;
    for (const yol of ["/health", "/__up"]) {
      const r = await fetch(`http://127.0.0.1:${p}${yol}`);
      assert.equal(r.status, 200, `${yol} kapatilmis — surec izleme bozulur`);
    }
  } finally {
    s.close();
  }
});

test("hazır olunca istek geçer", async () => {
  let hazir = false;
  const app = kapiKur(() => hazir);
  const s = app.listen(0);
  try {
    const p = s.address().port;
    assert.equal((await fetch(`http://127.0.0.1:${p}/api/pred/submit`)).status, 503);
    hazir = true;
    const r = await fetch(`http://127.0.0.1:${p}/api/pred/submit`);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).yazildi, true);
  } finally {
    s.close();
  }
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: kapı rota montajlarından ÖNCE duruyor", () => {
  const src = fs.readFileSync(path.join(KOK, "server.cjs"), "utf8");

  const kapi = src.indexOf('"NOT_READY"');
  assert.ok(kapi > 0, "hazir-olma kapisi yok — deploy sonrasi istekler dosya moduna duser");

  // İlk `/api` montajı kapıdan SONRA gelmeli; aksi hâlde o router korumasız.
  const ilkMontaj = src.search(/app\.use\(\s*"\/api/);
  assert.ok(ilkMontaj > 0, "api montaji bulunamadi");
  assert.ok(
    kapi < ilkMontaj,
    "kapi ilk /api montajindan SONRA — o rotalar hazir olmadan istek alir"
  );
});

test("NÖBETÇİ: init başarısız olsa bile kapı açılır", () => {
  /**
   * ⚠️ `connectOnce` denemeleri bitince null dönüyor ve uygulama BİLEREK dosya
   * modunda çalışıyor. Bayrak yalnızca başarıda set edilseydi, Mongo
   * erişilemezken uygulama kalıcı 503 verirdi — yani düzeltme, düzelttiği
   * şeyden daha büyük bir arıza üretirdi.
   */
  const src = fs.readFileSync(path.join(KOK, "server.cjs"), "utf8");
  const i = src.indexOf("_mongoInitBitti = true");
  assert.ok(i > 0, "hazir bayragi bulunamadi");

  // Bayrak `finally` içinde olmalı (hem başarı hem hata yolunda çalışsın).
  const oncesi = src.slice(Math.max(0, i - 400), i);
  assert.ok(
    /finally\s*\{/.test(oncesi),
    "hazir bayragi finally disinda — Mongo erisilemezken uygulama kalici 503 verir"
  );
});
