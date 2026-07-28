"use strict";

/**
 * Mongo bağlantı katmanı — arıza davranışı.
 *
 * NEDEN TEST EDİLİYOR: Buradaki hatalar "çalışmıyor" diye görünmez, "yavaş"
 * diye görünür. getDb() istek başına çağrılıyor; bağlantı yokken her çağrı
 * sunucu seçimi zaman aşımını beklerse Mongo kesintisi tüm API'yi sürünmeye
 * çevirir. Soğuma penceresi bunu engelliyor ve sessizce bozulabilecek türden
 * bir davranış — ölçmeden emin olunamaz.
 *
 * Gerçek küme gerekmez: erişilemeyen bir adrese bağlanmaya çalışılır.
 *
 * Çalıştırma:  npm test
 */

// Sabitler modül yüklenirken okunuyor — require'dan ÖNCE ayarlanmalı.
process.env.SKORLIG_MONGO_RETRIES = "1";
process.env.SKORLIG_MONGO_RETRY_MS = "10";
process.env.SKORLIG_MONGO_SELECT_MS = "300";
process.env.SKORLIG_MONGO_CONNECT_MS = "300";
process.env.SKORLIG_MONGO_COOLDOWN_MS = "5000";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const MODUL = path.join(__dirname, "..", "lib", "mongo.cjs");

/** Modülü sıfır durumla yeniden yükler (durum modül kapsamında tutuluyor). */
function tazeModul(uri) {
  delete require.cache[require.resolve(MODUL)];
  if (uri === null) delete process.env.MONGODB_URI;
  else process.env.MONGODB_URI = uri;
  delete process.env.MONGO_URI;
  return require(MODUL);
}

// Kapalı port: DNS beklemeden hızlıca reddedilir.
const ULASILMAZ = "mongodb://127.0.0.1:1/skorlig";

describe("MONGODB_URI tanımsızken", () => {
  test("null döner ve arıza sayılmaz", async () => {
    const m = tazeModul(null);
    assert.equal(await m.getDb(), null);

    const s = m.status();
    assert.equal(s.configured, false, "yapılandırılmamış olarak işaretlenmeli");
    assert.equal(s.connected, false);
    // Yerel geliştirmede URI olmaması normaldir; deneme sayacı artmamalı.
    assert.equal(s.attempts, 0, "denenmemeli");
  });
});

describe("bağlantı kurulamadığında", () => {
  test("hata yutulmaz, sebep saklanır", async () => {
    const m = tazeModul(ULASILMAZ);
    assert.equal(await m.getDb(), null);

    const s = m.status();
    assert.equal(s.configured, true);
    assert.equal(s.connected, false);
    assert.ok(s.failures > 0, "başarısızlık sayılmalı");
    assert.ok(s.lastError, "son hata mesajı saklanmalı");
  });

  test("yeniden denenir (tek denemeyle pes edilmez)", async () => {
    const m = tazeModul(ULASILMAZ);
    await m.getDb();
    // SKORLIG_MONGO_RETRIES=1 → 1 ilk + 1 yeniden = 2 deneme
    assert.equal(m.status().attempts, 2);
  });

  test("soğuma penceresi açılır", async () => {
    const m = tazeModul(ULASILMAZ);
    await m.getDb();
    assert.ok(m.status().cooldownRemainingMs > 0, "soğuma başlamalı");
  });

  test("soğuma sırasında İSTEK BEKLETİLMEZ", async () => {
    const m = tazeModul(ULASILMAZ);
    await m.getDb(); // ilk tur: soğumayı başlatır

    const t0 = Date.now();
    const r = await m.getDb();
    const sure = Date.now() - t0;

    assert.equal(r, null);
    // Asıl mesele bu: yeniden bağlanmayı deneseydi zaman aşımı kadar
    // (yüzlerce ms) beklerdi ve her istek o bedeli öderdi.
    assert.ok(sure < 50, `hemen dönmeliydi, ${sure}ms sürdü`);
  });

  test("soğuma sırasında yeni deneme yapılmaz", async () => {
    const m = tazeModul(ULASILMAZ);
    await m.getDb();
    const once = m.status().attempts;

    await m.getDb();
    await m.getDb();

    assert.equal(m.status().attempts, once, "soğumada denenmemeli");
  });

  test("force soğumayı aşar (sağlık kontrolü için)", async () => {
    const m = tazeModul(ULASILMAZ);
    await m.getDb();
    const once = m.status().attempts;

    await m.getDb({ force: true });

    assert.ok(
      m.status().attempts > once,
      "force ile yeniden denenmeliydi — yoksa mongo-health toparlanmayı fark edemez"
    );
  });
});

describe("close()", () => {
  test("soğumayı sıfırlar (bilinçli eylem, hemen denensin)", async () => {
    const m = tazeModul(ULASILMAZ);
    await m.getDb();
    assert.ok(m.status().cooldownRemainingMs > 0);

    await m.close();
    assert.equal(m.status().cooldownRemainingMs, 0);
  });
});
