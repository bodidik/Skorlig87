"use strict";

/**
 * TEST MAĞAZA MODU (`mock`) ÜRETİMDE ÇALIŞMAZ.
 *
 * ⚠️ CANLI KUSUR DEĞİLDİ, SERTLEŞTİRME — ayrımı açıkça yapıyorum. Ölçüldü
 * (2026-08-03, canlı sunucu): mağaza modu `disabled` ve varsayılan da o.
 *
 * ⚠️ AMA AÇIKÇA `SKORLIG_STORE_MODE=mock` YAZILMIŞ BİR ÜRETİM DAĞITIMI
 * ödemesiz LC yüklerdi: kimliği olan her kullanıcı `/purchase` ile `lc_200`ü
 * (200 LC) alır, hız sınırı 5/dk olduğu için hesap başına dakikada 1000 LC.
 * Günlük hak 3-7 LC — oyun ekonomisi anında anlamsızlaşır.
 *
 * Bu bir yapılandırma KAZASINA karşı savunma: staging'den kopyalanan bir env,
 * unutulmuş bir deneme bayrağı. `routes/lc-wallet.cjs`in kendi notu aynı
 * dersi zaten yazıyor — varsayılan bir kez `mock`tan `disabled`a çevrilmişti
 * ("yapılandırma eksikse KAPALI kal"). Bu, o düzeltmenin eksik kalan yarısı:
 * eksik yapılandırma kapatıldı ama YANLIŞ yapılandırma açık kalmıştı.
 *
 * ⚠️ GERÇEK SATIN ALMAYI ENGELLEMİYOR: Google Play / App Store makbuz
 * doğrulaması geldiğinde `provider` dalı kullanılacak, `mock` değil.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
const NL = String.fromCharCode(10);

/** Ortam değişkenlerini kurup modülü TAZE yükler, sonra eski hâle döner. */
function modu(storeMode, uretim) {
  const eskiStore = process.env.SKORLIG_STORE_MODE;
  const eskiNode = process.env.NODE_ENV;
  const eskiRender = process.env.RENDER;
  try {
    process.env.SKORLIG_STORE_MODE = storeMode;
    if (uretim) { process.env.NODE_ENV = "production"; }
    else { delete process.env.NODE_ENV; delete process.env.RENDER; }

    /* Gerçek modülü yüklüyoruz — mantığı teste KOPYALAMAK sahte yeşil test
     * üretirdi; bugün o tuzağa bir kez düşülmüştü. */
    const yol = require.resolve(path.join(KOK, "routes", "lc-wallet.cjs"));
    const ortamYol = require.resolve(path.join(KOK, "lib", "ortam.cjs"));
    delete require.cache[yol];
    delete require.cache[ortamYol];
    require(yol);
    // Modül STORE_MODE'u dışa aktarmıyor; kaynaktan değil DAVRANIŞTAN okuyoruz:
    // /store ucu modu yanıtta bildiriyor.
    const express = require("express");
    const app = express();
    app.use((q, _r, n) => { q.app.locals.db = null; n(); });
    app.use("/api/rt", require(yol));
    return app;
  } finally {
    if (eskiStore === undefined) delete process.env.SKORLIG_STORE_MODE; else process.env.SKORLIG_STORE_MODE = eskiStore;
    if (eskiNode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = eskiNode;
    if (eskiRender === undefined) delete process.env.RENDER; else process.env.RENDER = eskiRender;
  }
}

async function magazaModu(app) {
  const srv = app.listen(0);
  try {
    await new Promise((r) => (srv.listening ? r() : srv.once("listening", r)));
    const j = await fetch(`http://127.0.0.1:${srv.address().port}/api/rt/lc-wallet/store`,
      { signal: AbortSignal.timeout(8000) }).then((r) => r.json());
    return j.mode;
  } finally { srv.close(); }
}

describe("mağaza üretim kapısı", () => {
  test("kurulum sınandı: uç modu GERÇEKTEN bildiriyor", async () => {
    /* ⚠️ Bu olmadan "uretimde disabled" iddiasi bir sey kanitlamaz: uc modu
     * hic dondurmuyorsa her senaryo undefined doner ve testler yaniltir. */
    const m = await magazaModu(modu("disabled", false));
    assert.equal(m, "disabled", `uc modu bildirmiyor (${m}) — test bir sey olcmuyor`);
  });

  test("ÜRETİMDE mock YOKSAYILIR, mağaza kapalı kalır", async () => {
    const m = await magazaModu(modu("mock", true));
    assert.equal(m, "disabled",
      `URETIMDE mock etkin (${m}) — odemesiz LC yuklenir, hesap basina dakikada 1000 LC`);
  });

  test("GELİŞTİRMEDE mock çalışmaya devam eder (aşırı kilitleme değil)", async () => {
    /* ⚠️ Ters risk: kapiyi her ortamda uygulamak yerel gelistirmeyi ve
     * magaza testlerini kirardi. */
    const m = await magazaModu(modu("mock", false));
    assert.equal(m, "mock", "gelistirmede mock kapatilmis — asiri kilitleme");
  });

  test("GERÇEK sağlayıcı dalı üretimde engellenmiyor", async () => {
    /* Makbuz dogrulamali gercek satin alma geldiginde `provider` kullanilacak;
     * kapi yalnizca `mock`u hedefliyor. */
    const m = await magazaModu(modu("provider", true));
    assert.equal(m, "provider", "gercek saglayici modu uretimde engellenmis");
  });

  test("kaynakta üretim kapısı VAR (davranış tesadüfen doğru olmasın)", () => {
    const src = fs.readFileSync(path.join(KOK, "routes", "lc-wallet.cjs"), "utf8")
      .split(/\r?\n/)
      .map((l) => { const t = l.trim(); return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l; })
      .join(NL);
    assert.ok(/uretimMi\s*\(\s*\)/.test(src), "uretim tespiti kullanilmiyor — kapi yok");
    assert.ok(/mock/.test(src) && /disabled/.test(src), "mock/disabled esleme mantigi yok");
  });
});
