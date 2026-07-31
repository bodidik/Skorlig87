"use strict";

/**
 * FIREBASE KURULAMAZSA ÜRETİMDE HİÇBİR İSTEK GEÇMEZ.
 *
 * ⚠️ BULUNAN AÇIK — kod tabanındaki en kritik kapı fail-OPEN'dı:
 *
 *     if (!fbAuth) { req.uid = req.headers["x-user-id"] || "dev"; return next(); }
 *
 * `firebase-admin` kurulamazsa (bozuk/eksik `FIREBASE_SERVICE_ACCOUNT_B64`,
 * bir JSON ayrıştırma hatası, geçici arıza) sunucu HER isteği kabul ediyor ve
 * kimliği İSTEMCİNİN GÖNDERDİĞİ başlıktan alıyordu. `x-user-id: kurban` yazan
 * herkes kurbanın cüzdanını harcayabilir, hesabını silebilirdi.
 *
 * ⚠️ VE FARK EDİLMEZDİ: `mobile/lib/apiFetch.ts` zaten HER istekte
 * `x-user-id` gönderiyor — uygulama sorunsuz çalışmaya devam ederdi. Tek
 * belirti açılışta akıp giden bir `console.warn` satırıydı.
 *
 * ⚠️ NEDEN DAVRANIŞ TESTİ: metin taraması "üretimde 503 dönüyor mu" sorusunu
 * cevaplayamaz. Burada `firebase-admin` GERÇEKTEN bozuluyor (modül önbelleği
 * zehirleniyor) ve istek uçtan uca sürülüyor.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

/* ── firebase-admin'i kurulamaz hâle getir ───────────────────────────────────
 *
 * ⚠️ SIRA ÖNEMLİ: `verifyToken` require edilmeden ÖNCE zehirlenmeli. Yerel
 * geliştirmede `firebase-service-account.json` GERÇEKTEN var, yani modül
 * normalde başarıyla kuruluyor (ölçüldü: kimlikModu() -> "firebase"). O yüzden
 * "yapılandırma yok" varsayımıyla test yazmak yeşil-ama-ölü sonuç verirdi.
 */
const appYolu = require.resolve("firebase-admin/app");
require("firebase-admin/app");
require.cache[appYolu].exports = {
  getApps() { return []; },
  initializeApp() { throw new Error("test: firebase-admin kurulamadi"); },
  cert() { return {}; },
  applicationDefault() { return {}; },
};

const { verifyToken, optionalToken, kimlikModu } = require("../middleware/verifyToken.cjs");

/* ── Küçük bir istek sürücüsü (express'e gerek yok) ───────────────────────── */

function istek(basliklar) {
  return { headers: basliklar, app: { locals: {} } };
}

function yanit() {
  const y = { kod: null, govde: null };
  y.status = (k) => { y.kod = k; return y; };
  y.json = (g) => { y.govde = g; return y; };
  return y;
}

/** Ara katmanı çalıştırır; `gecti` = next() çağrıldı mı. */
async function calistir(ara, basliklar) {
  const req = istek(basliklar);
  const res = yanit();
  let gecti = false;
  await ara(req, res, () => { gecti = true; });
  return { req, res, gecti };
}

const BASLIKLAR = { "x-auth-token": "sahte-token", "x-user-id": "kurban" };

/* ── Üretim ──────────────────────────────────────────────────────────────── */

test("ÜRETİM: firebase kurulamazsa istek GEÇMEZ (503)", async () => {
  const eski = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    // Önce testin bir şey ölçtüğünden emin ol: firebase gerçekten bozuk mu?
    assert.equal(kimlikModu(), "kapali", "firebase hala kuruluyor — test bir sey olcmuyor");

    const { res, gecti, req } = await calistir(verifyToken, BASLIKLAR);
    assert.equal(gecti, false, "istek GECTI — fail-open acik hala duruyor");
    assert.equal(res.kod, 503);
    assert.equal(res.govde.error, "AUTH_NOT_CONFIGURED");
    assert.equal(req.uid, undefined, "kimlik istemci basligindan alinmis");
  } finally {
    process.env.NODE_ENV = eski;
  }
});

test("ÜRETİM: optionalToken istemci başlığına GÜVENMEZ", async () => {
  const eski = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const { req, gecti } = await calistir(optionalToken, BASLIKLAR);
    // Anonim geçmek doğru: kimlik doğrulanamıyorsa kimlik YOKTUR.
    assert.equal(gecti, true, "optionalToken istegi durdurmamali");
    assert.equal(req.uid, null, "kimlik x-user-id basligindan alinmis");
  } finally {
    process.env.NODE_ENV = eski;
  }
});

test("ÜRETİM sinyali RENDER değişkeninden de gelir", async () => {
  const eskiN = process.env.NODE_ENV, eskiR = process.env.RENDER;
  delete process.env.NODE_ENV;
  process.env.RENDER = "true";
  try {
    /* NODE_ENV üretimde ayarlanmamış olabiliyor (`.env.example`'a sonradan
     * eklendi). Güvenlik kararını tek bir elle-ayarlanan değişkene bağlamak,
     * o unutulduğunda sessizce gevşek moda düşmek demektir. */
    const { res, gecti } = await calistir(verifyToken, BASLIKLAR);
    assert.equal(gecti, false, "RENDER=true iken de gecirmemeli");
    assert.equal(res.kod, 503);
  } finally {
    if (eskiN === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = eskiN;
    if (eskiR === undefined) delete process.env.RENDER; else process.env.RENDER = eskiR;
  }
});

/* ── Yerel geliştirme ────────────────────────────────────────────────────── */

test("YEREL: geri düşüş korunuyor (servis hesabı olmadan çalışılabilsin)", async () => {
  const eskiN = process.env.NODE_ENV, eskiR = process.env.RENDER;
  delete process.env.NODE_ENV;
  delete process.env.RENDER;
  try {
    assert.equal(kimlikModu(), "yerel-gecis");
    const { req, gecti } = await calistir(verifyToken, BASLIKLAR);
    assert.equal(gecti, true, "yerelde gelistirme akisi kirilmamali");
    assert.equal(req.uid, "kurban");
  } finally {
    if (eskiN === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = eskiN;
    if (eskiR === undefined) delete process.env.RENDER; else process.env.RENDER = eskiR;
  }
});

/* ── Token yokluğu her modda 401 ─────────────────────────────────────────── */

test("token hiç yoksa 401 (mod ne olursa olsun)", async () => {
  for (const mod of ["production", undefined]) {
    const eski = process.env.NODE_ENV;
    if (mod) process.env.NODE_ENV = mod; else delete process.env.NODE_ENV;
    try {
      const { res, gecti } = await calistir(verifyToken, {});
      assert.equal(gecti, false);
      assert.equal(res.kod, 401);
    } finally {
      if (eski === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = eski;
    }
  }
});
