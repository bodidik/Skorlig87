"use strict";

/**
 * AÇILIŞTA ELLE EKLENEN FİKSTÜRLERİ GERİ YÜKLE.
 *
 * `data/fixtures.json` Render'da her deploy'da siliniyor (kalıcı disk yok).
 * FDO/MK senkronları kendi kayıtlarını API'den yeniden çeker; elle girilen
 * maçların ise başka kaynağı yok — kalıcı depoda (Mongo `manual_fixtures`)
 * tutuluyorlar ve buradan dosyaya geri konuyorlar.
 *
 * Sıra önemli: fixture-sync'ten ÖNCE çalışmalı. merge() yalnızca kendi
 * `ownedSource`'una ait kayıtları temizler, MANUAL olanlara dokunmaz — yani
 * geri yükleme önce yapılırsa sağlayıcı senkronu onları korur.
 */

const { readFixtures, writeFixtures } = require("./fixture-sync.cjs");
const { withFileLock } = require("../lib/fileLock.cjs");
const path = require("path");

const FIXTURES_FILE = path.join(
  process.env.SKORLIG_DATA_DIR || path.join(__dirname, "..", "data"),
  "fixtures.json"
);

const r2 = (s) => String(s || "").trim();

/**
 * Kalıcı depodaki elle eklenen maçları dosyaya geri koyar.
 * @returns {Promise<{restored:number, alreadyThere:number, total:number}>}
 */
async function restoreOnce(db) {
  if (!db) return { restored: 0, alreadyThere: 0, total: 0, reason: "MONGO_YOK" };

  const kalicilar = await require("../lib/manual-fixtures.cjs").list(db, 30);
  if (!kalicilar.length) return { restored: 0, alreadyThere: 0, total: 0 };

  return withFileLock(FIXTURES_FILE, async () => {
    const mevcut = await readFixtures();
    const varOlan = new Set(mevcut.map((f) => r2(f?.fixtureId)));

    const eklenecek = kalicilar.filter((f) => !varOlan.has(r2(f.fixtureId)));
    if (eklenecek.length) await writeFixtures(mevcut.concat(eklenecek));

    return {
      restored: eklenecek.length,
      alreadyThere: kalicilar.length - eklenecek.length,
      total: kalicilar.length,
    };
  });
}

/**
 * server.cjs'den çağrılır. Mongo bağlantısı açılışta gecikebildiği için
 * kısa bir bekleme sonrası çalışır; bağlanamazsa bir kez daha dener.
 */
function start(app, gecikmeMs = 15_000) {
  const calistir = async (deneme) => {
    const db = app?.locals?.db || null;
    try {
      const r = await restoreOnce(db);
      if (r.reason === "MONGO_YOK") {
        if (deneme < 2) {
          // mongo-health canlı bağlanmayı sürdürüyor olabilir; bir şans daha.
          setTimeout(() => calistir(deneme + 1), 45_000).unref?.();
        } else {
          console.warn("[manual-fixtures] Mongo yok — elle eklenen maclar geri yuklenemedi");
        }
        return;
      }
      if (r.total) {
        console.log(
          `[manual-fixtures] ${r.restored} mac geri yuklendi (${r.alreadyThere} zaten vardi)`
        );
      }
    } catch (e) {
      console.error("[manual-fixtures] geri yukleme hatasi:", e?.message || e);
    }
  };

  setTimeout(() => calistir(1), gecikmeMs).unref?.();
}

module.exports = { start, restoreOnce };
