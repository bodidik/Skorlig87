"use strict";

/**
 * HIZ SINIRI ÇALIŞIYOR VE İÇ MUAFİYETİ DIŞARIDAN TAKLİT EDİLEMİYOR.
 *
 * ⚠️ BU TURDA KUSUR BULUNAMADI — canlı sunucuda uçtan uca ölçüldü:
 *     dış trafik (x-forwarded-for ile): 120 istek 200, 121. istek 429
 *     429 gövdesi: {"error":"RATE_LIMIT","waitMs":59503,"limit":120,...}
 *     iç trafik (loopback, proxy başlığı yok): 150/150 -> 200 (muaf, TASARIM)
 *
 * ⚠️ İLK ÖLÇÜMÜM YANILTICIYDI ve nota değer: loopback'ten proxy başlığı
 * olmadan 150 istek attım, hepsi 200 döndü ve "sınır çalışmıyor" gibi
 * göründü. Oysa `isInternal()` tam olarak o isteği muaf tutuyor —
 * `services/bot-filler.cjs` her turda kendi API'sine 25 istek atıyor.
 * Sıfır sonuç kanıt değildir; sondanın DIŞ trafiği taklit etmesi gerekiyordu.
 *
 * ⚠️ ASIL KORUNAN ÖZELLİK: muafiyet YALNIZCA başlıkla alınamaz. `isInternal`
 * iki şart birden arıyor — proxy başlığı YOK **ve** soket loopback. Biri
 * "sadeleştirip" tek şarta indirirse (örneğin yalnızca `x-forwarded-for`
 * yokluğuna bakarsa) dışarıdan gelen her istek muaf olurdu ve TÜM hız
 * sınırları — para yolları dahil — atlatılabilirdi.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const KOK = path.join(__dirname, "..");

/* Middleware'i izole çağırmak için sahte istek/yanıt. */
function sahteIstek({ url = "/api/stats/totals", ip = "203.0.113.7", basliklar = {} } = {}) {
  return {
    method: "GET",
    originalUrl: url,
    url,
    path: url,
    headers: basliklar,
    socket: { remoteAddress: ip },
    app: { locals: {} },
  };
}
function sahteYanit() {
  const y = { kod: 200, govde: null, bitti: false, headers: {} };
  y.status = (k) => { y.kod = k; return y; };
  y.json = (g) => { y.govde = g; y.bitti = true; return y; };
  y.setHeader = (k, v) => { y.headers[k] = v; };
  return y;
}

/* MIDDLEWARE ASENKRON (Redis destekli): next() sonraki tick'te cagriliyor.
 * Ilk yazimim eszamanli kontrol ediyordu ve HER istek gecmedi gorunuyordu —
 * kurulum sinamasi bunu yakaladi. */
async function calistir(rateLimit, istek) {
  const y = sahteYanit();
  let gecti = false;
  await rateLimit(istek, y, () => { gecti = true; });
  return { gecti, kod: y.kod, govde: y.govde };
}

describe("hız sınırı muafiyeti", () => {
  test("DIŞ trafik sınırlanıyor", async () => {
    delete require.cache[require.resolve(path.join(KOK, "middleware", "rateLimit.cjs"))];
    const rateLimit = require(path.join(KOK, "middleware", "rateLimit.cjs"));

    const url = "/api/test-hiz-" + process.pid;   // her koşuda temiz anahtar
    let ilk429 = 0, gecen = 0;
    for (let i = 1; i <= 200; i++) {
      const r = await calistir(rateLimit, sahteIstek({ url, basliklar: { "x-forwarded-for": "203.0.113.7" } }));
      if (r.gecti) { gecen++; continue; }
      if (r.kod === 429 && !ilk429) ilk429 = i;
    }
    assert.ok(gecen > 0, "hicbir istek gecmedi — kurulum bozuk, test bir sey olcmuyor");
    assert.ok(ilk429 > 0, "DIS trafik hic sinirlanmadi — 200 istek gecti");
    assert.ok(ilk429 <= 130, `sinir ${ilk429}. istekte devreye girdi — beklenen ~120`);
  });

  test("429 gövdesi kullanıcıya ne kadar bekleyeceğini SÖYLÜYOR", async () => {
    delete require.cache[require.resolve(path.join(KOK, "middleware", "rateLimit.cjs"))];
    const rateLimit = require(path.join(KOK, "middleware", "rateLimit.cjs"));
    const url = "/api/test-govde-" + process.pid;
    let govde = null;
    for (let i = 0; i < 200; i++) {
      const r = await calistir(rateLimit, sahteIstek({ url, basliklar: { "x-forwarded-for": "198.51.100.4" } }));
      if (!r.gecti && r.kod === 429) { govde = r.govde; break; }
    }
    assert.ok(govde, "429 hic uretilmedi — test bir sey olcmuyor");
    assert.equal(govde.error, "RATE_LIMIT");
    assert.ok(Number(govde.waitMs) > 0, "waitMs yok — istemci ne zaman tekrar denecegini bilemez");
    assert.ok(Number(govde.limit) > 0, "limit bildirilmiyor");
  });

  test("İÇ trafik muaf (bot-filler kendi API'sini boğmasın)", async () => {
    delete require.cache[require.resolve(path.join(KOK, "middleware", "rateLimit.cjs"))];
    const rateLimit = require(path.join(KOK, "middleware", "rateLimit.cjs"));
    const url = "/api/test-ic-" + process.pid;
    let hepsiGecti = true;
    for (let i = 0; i < 200; i++) {
      const r = await calistir(rateLimit, sahteIstek({ url, ip: "127.0.0.1", basliklar: {} }));
      if (!r.gecti) { hepsiGecti = false; break; }
    }
    assert.ok(hepsiGecti, "ic trafik sinirlaniyor — bot-filler ve af-sync kendi zamanlayicisini bogar");
  });

  test("MUAFİYET yalnızca BAŞLIKLA alınamaz (taklit edilemez)", async () => {
    /**
     * ⚠️ EN ÖNEMLİ İDDİA. `isInternal` İKİ şart birden arıyor: proxy başlığı
     * YOK **ve** soket loopback. Biri bunu tek şarta indirirse, dış bir
     * istemci sadece başlık göndermeyerek muaf olurdu ve TÜM hız sınırları —
     * para yolları dahil — atlatılabilirdi.
     */
    delete require.cache[require.resolve(path.join(KOK, "middleware", "rateLimit.cjs"))];
    const rateLimit = require(path.join(KOK, "middleware", "rateLimit.cjs"));
    const url = "/api/test-taklit-" + process.pid;
    let sinirlandi = false;
    for (let i = 0; i < 200; i++) {
      // DIŞ ip, proxy başlığı YOK — muafiyeti başlıksızlıkla almaya çalışıyor
      const r = await calistir(rateLimit, sahteIstek({ url, ip: "203.0.113.9", basliklar: {} }));
      if (!r.gecti) { sinirlandi = true; break; }
    }
    assert.ok(sinirlandi,
      "dis IP proxy basligi gondermeyerek muafiyet aldi — TUM hiz sinirlari atlatilabilir");
  });
});
