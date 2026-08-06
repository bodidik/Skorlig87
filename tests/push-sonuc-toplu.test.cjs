"use strict";

/**
 * SONUÇ BİLDİRİMİ TEK DEPO OKUMASI İLE GİDİYOR.
 *
 * ⚠️ BULUNAN (2026-08-06): `push-scheduler.cjs runResultNotices` döngüde her
 * kullanıcı için ayrı `push.sendToUsers([row.userId], ...)` çağırıyordu. Her
 * çağrı `loadStore()` yapıyordu (Mongo'dan tam okuma) — N kullanıcılı maçta
 * N depo okuması + N Expo HTTP isteği.
 *
 * `sendBulkPersonalized` tüm mesajları önce topluyor, depoyu BİR KEZ okuyor
 * ve `sendRaw` ile tek seferde gönderiyor.
 *
 * BU TEST İKİ ŞEYİ KORUYOR:
 *
 *   1) Toplu gönderim fonksiyonunun DAVRANIŞI: kişiye özel mesajlar doğru
 *      kullanıcıya gidiyor, tercih süzgeci çalışıyor, geçersiz kullanıcı
 *      atlanıyor.
 *
 *   2) push-scheduler'ın `sendBulkPersonalized` ÇAĞIRDIĞI: tek tek
 *      `sendToUsers` döngüsüne geri dönülmesini engelleyen nöbetçi.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "skorlig-push-toplu-"));
process.env.SKORLIG_DATA_DIR = TMP;
process.env.SKORLIG_BG = "0";
process.env.SKORLIG_PUSH = "0"; // Expo'ya gerçekten gitmek istemiyoruz

/* ⚠️ Expo'ya istek atılmamalı: `sendRaw` kontrol edilemez. Depo katmanını
 * taklit etmek yeterli; `sendBulkPersonalized`'ın KAÇ KEZ `loadStore`
 * çağırdığı asıl ölçülen değer. */

const vt = require.resolve(path.join(KOK, "middleware", "verifyToken.cjs"));
require.cache[vt] = { id: vt, filename: vt, loaded: true, exports: {
  verifyToken: (q, r, n) => {
    if (!q.headers["x-user-id"]) return r.status(401).json({ ok: false, error: "AUTH" });
    q.uid = q.headers["x-user-id"]; n();
  },
  optionalToken: (q, _r, n) => { q.uid = q.headers["x-user-id"] || null; n(); },
  getFirebaseAuth: () => null, kimlikModu: () => "test",
}};

describe("push toplu gönderim", () => {
  test("nöbetçi: push-scheduler sendBulkPersonalized kullanıyor, döngüde sendToUsers YOK", () => {
    /**
     * ⚠️ En kritik iddia. Biri döngüyü eski haline getirirse (her kullanıcı
     * için ayrı `sendToUsers`) bu düşer. Kaynak taraması:
     *
     *   - `sendBulkPersonalized` sonuç bloğunda OLMALI.
     *   - Sonuç bloğunda `sendToUsers` OLMAMALI.
     *
     * Sonuç bloğu: `runResultNotices` fonksiyonunun, `for (const s of settled)`
     * döngüsünün içi.
     */
    const src = fs.readFileSync(path.join(KOK, "services", "push-scheduler.cjs"), "utf8");

    /* Sonuç fonksiyonunun gövdesini bul. */
    const basla = src.indexOf("async function runResultNotices");
    assert.ok(basla > 0, "runResultNotices bulunamadi");
    const sonrakiFn = src.indexOf("\nasync function ", basla + 10);
    const govde = src.slice(basla, sonrakiFn > 0 ? sonrakiFn : undefined);

    assert.ok(
      /sendBulkPersonalized\s*\(/.test(govde),
      "sonuc bildirimi sendBulkPersonalized KULLANMIYOR — " +
      "her kullanici icin ayri loadStore + Expo HTTP yapiliyor"
    );

    /* Döngü içinde sendToUsers kalmadığını doğrula. */
    const dongu = govde.slice(govde.indexOf("for (const s of settled"));
    assert.ok(
      !/sendToUsers\s*\(/.test(dongu),
      "sonuc dongusu hala sendToUsers cagiriyor — toplu gonderim devre disi"
    );
  });

  test("nöbetçi: sendBulkPersonalized EXPORT ediliyor", () => {
    const src = fs.readFileSync(path.join(KOK, "services", "push.cjs"), "utf8");
    assert.ok(/sendBulkPersonalized/.test(src),
      "sendBulkPersonalized push.cjs icinde tanimli degil veya export edilmiyor");
    const exBlok = src.slice(src.lastIndexOf("module.exports"));
    assert.ok(/sendBulkPersonalized/.test(exBlok),
      "sendBulkPersonalized tanimli ama EXPORT edilmiyor — push-scheduler onu goremez");
  });

  test("sendBulkPersonalized: kişiye özel mesajlar doğru kullanıcıya gidiyor", async () => {
    /* SKORLIG_PUSH=0 olduğu için sendRaw { sent:0 } döner ama mesaj OLUŞTURMA
     * yolu tam çalışıyor. Depoyu doldurup sayımı kontrol ediyoruz. */

    /* Sahte token deposu yazılıyor. */
    const tokenler = {
      ali: { userId: "Ali", tokens: ["ExponentPushToken[aaa]"], prefs: { result: true } },
      veli: { userId: "Veli", tokens: ["ExponentPushToken[bbb]", "ExponentPushToken[ccc]"], prefs: { result: true } },
      /* result kapalı: bu kullanıcıya GÖNDERİLMEMELİ. */
      fatma: { userId: "Fatma", tokens: ["ExponentPushToken[ddd]"], prefs: { result: false } },
    };
    fs.writeFileSync(path.join(TMP, "push-tokens.json"), JSON.stringify({ items: tokenler }));

    /* Modül önbelleğini temizle ki depo taze okunması için. */
    for (const k of Object.keys(require.cache)) {
      if (/push-store|push\.cjs/.test(k)) delete require.cache[k];
    }

    /* ⚠️ `sendBulkPersonalized` kapalı kapsamdaki `loadStore`'u çağırıyor;
     * modül export'unu monkeypatch etmek ETKİSİZDİR (closure, referans
     * değişmiyor). Ölçümü DEPO KATMANINDA yapıyoruz: `PushStore.loadStore`
     * modül export'u olarak çağrılıyor, o referans değiştirilebilir. */
    const PushStore = require(path.join(KOK, "lib", "push-store.cjs"));
    let loadStoreCagrisi = 0;
    const orijinalPS = PushStore.loadStore;
    PushStore.loadStore = async function (...a) {
      loadStoreCagrisi++;
      return orijinalPS.apply(this, a);
    };

    /* ⚠️ `sendBulkPersonalized` closure-captured `sendRaw`'ı çağırıyor;
     * `push.sendRaw =` ile monkeypatch ETKİSİZ (referans değişmiyor).
     * `sendRaw` da closure-captured `fetch`'i çağırıyor — ama `fetch`
     * globaldir ve YERİNE KOYULABİLİR. Expo'ya gerçek istek GÖNDERME. */
    const gonderilen = [];
    const orijinalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, opts) => {
      const govde = JSON.parse(opts.body);
      gonderilen.push(...(Array.isArray(govde) ? govde : [govde]));
      return {
        json: async () => ({
          data: (Array.isArray(govde) ? govde : [govde]).map(() => ({ status: "ok" })),
        }),
      };
    };

    /* Modül önbelleğini temizle ki depo ve push modülü taze yüklensin. */
    for (const k of Object.keys(require.cache)) {
      if (/push\.cjs$/.test(k)) delete require.cache[k];
    }

    process.env.SKORLIG_PUSH = "1"; // mesaj oluşturma yolu çalışsın
    const push = require(path.join(KOK, "services", "push.cjs"));

    const r = await push.sendBulkPersonalized([
      { userId: "Ali", payload: { type: "result", title: "T1", body: "B1" } },
      { userId: "Veli", payload: { type: "result", title: "T2", body: "B2" } },
      { userId: "Fatma", payload: { type: "result", title: "T3", body: "B3" } },
      { userId: "Yok", payload: { type: "result", title: "T4", body: "B4" } },
    ]);

    process.env.SKORLIG_PUSH = "0";
    globalThis.fetch = orijinalFetch;
    PushStore.loadStore = orijinalPS;

    /* Tek loadStore çağrısı: N kullanıcı için N okuma DEĞİL. */
    assert.equal(loadStoreCagrisi, 1,
      `loadStore ${loadStoreCagrisi} kez cagrildi — sendBulkPersonalized TEK cagri yapmali`);

    /* Ali → 1 token, Veli → 2 token, Fatma → 0 (kapalı), Yok → 0 (kayıtsız). */
    assert.equal(gonderilen.length, 3,
      `3 mesaj bekleniyordu (Ali:1 + Veli:2), ${gonderilen.length} gonderildi`);

    const aliMesaj = gonderilen.filter((m) => m.to === "ExponentPushToken[aaa]");
    assert.equal(aliMesaj.length, 1);
    assert.equal(aliMesaj[0].title, "T1", "Ali yanlis mesaj aldi");

    const veliMesaj = gonderilen.filter((m) =>
      m.to === "ExponentPushToken[bbb]" || m.to === "ExponentPushToken[ccc]"
    );
    assert.equal(veliMesaj.length, 2, "Veli'nin iki cihazina da gitmeli");
    assert.ok(veliMesaj.every((m) => m.title === "T2"), "Veli yanlis mesaj aldi");

    const fatmaMesaj = gonderilen.filter((m) => m.to === "ExponentPushToken[ddd]");
    assert.equal(fatmaMesaj.length, 0,
      "result tercihi KAPALI olan kullaniciya mesaj GONDERILDI — tercih suzgeci calismadi");
  });
});
