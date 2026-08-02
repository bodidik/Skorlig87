"use strict";

/**
 * ARKADAŞ LİSTESİ VE TABLOSU YALNIZCA SAHİBİNE.
 *
 * ⚠️ ÖLÇÜLDÜ (2026-08-02): 215 uç gerçek mount önekleriyle kimliksiz dövüldü
 * ve bu ikisi 200 döndü. `userId` doğrudan YOL PARAMETRESİNDEN alınıyordu;
 * ne `verifyToken` vardı ne sahiplik kontrolü. Bir kullanıcı kimliğini bilen
 * (ya da açık bir sıralama ucundan toplayan) herkes o kişinin TÜM sosyal
 * grafiğini okuyabiliyordu: arkadaşları, bekleyen istekleri, adları,
 * bayrakları, puanları.
 *
 * ⚠️ AYNI SINIFIN YEDİNCİ ÖRNEĞİ. Bugün havuzda (`myBet`), `weekly-picks`te,
 * `stats/user`da, profilde ve 1987 üyeliğinde aynı kusur bulundu: "kimlik
 * gövdeden/parametreden geliyor, jetondan değil". `lib/kimlik-kontrol.cjs`
 * bu dersi zaten yazmış — eksik olan onu ÇAĞIRMAKTI.
 *
 * ⚠️ BU UÇLARI GREP BULAMAZDI: `routes/groups.cjs`'in notu üçüncü kör noktayı
 * anlatıyor (adlandırılmış handler'lar kalıba uymuyor). Bunlar satır içi
 * ok fonksiyonuydu ama listede DÖRT rota altında görünüyorlar (legacy +
 * alias, /api/friends ve /api/users/friends). Kusur uçları GERÇEKTEN
 * döverek bulundu.
 */

const test = require("node:test");
const describe = require("node:test").describe;
const assert = require("node:assert/strict");
const path = require("path");
const os = require("os");
const fs = require("fs");

const KOK = path.join(__dirname, "..");
const KUM = fs.mkdtempSync(path.join(os.tmpdir(), "skorlig-arkadas-"));
process.env.SKORLIG_DATA_DIR = KUM;

/* Gerçek `verifyToken` istemci başlığına güvenmiyor; taklit ediliyor —
 * depodaki diğer uç testlerinin kullandığı desenin aynısı. */
const _vt = require.resolve(path.join(KOK, "middleware", "verifyToken.cjs"));
require.cache[_vt] = { id: _vt, filename: _vt, loaded: true, exports: {
  verifyToken: (q, r, n) => {
    if (!q.headers["x-user-id"]) return r.status(401).json({ ok: false, error: "AUTH" });
    q.uid = q.headers["x-user-id"]; n();
  },
  optionalToken: (q, _r, n) => { q.uid = q.headers["x-user-id"] || null; n(); },
  getFirebaseAuth: () => null, kimlikModu: () => "test",
} };

describe("arkadaş listesi sızıntısı", () => {
  let srv, port;

  test("kur", async () => {
    const express = require("express");
    const app = express();
    app.use((q, _r, n) => { q.app.locals.db = null; n(); });
    app.use("/api/friends", require(path.join(KOK, "routes", "friends.cjs")));
    await new Promise((r) => { srv = app.listen(0, r); });
    port = srv.address().port;
  });

  const iste = (yol, uid) =>
    fetch(`http://127.0.0.1:${port}${yol}`, { headers: uid ? { "x-user-id": uid } : {} })
      .then(async (r) => ({ s: r.status, j: await r.json().catch(() => null) }));

  test("SAHİBİ okuyabiliyor (kurulum sınandı)", async () => {
    /* ⚠️ Bu olmadan aşağıdaki "reddedildi" iddiaları hiçbir şey kanıtlamaz:
     * uç tümden bozuksa da her istek reddedilir. */
    for (const yol of ["/api/friends/list/SAHIBI", "/api/friends/board/SAHIBI"]) {
      const r = await iste(yol, "SAHIBI");
      assert.equal(r.s, 200, `${yol} sahibine de kapali — uc bozuk, test bir sey olcmuyor`);
    }
  });

  test("BAŞKASI okuyamaz", async () => {
    for (const yol of ["/api/friends/list/SAHIBI", "/api/friends/board/SAHIBI"]) {
      const r = await iste(yol, "SALDIRGAN");
      assert.notEqual(r.s, 200, `${yol} BASKASINA aciik — sosyal grafik siziyor`);
    }
  });

  test("KİMLİKSİZ okuyamaz", async () => {
    for (const yol of ["/api/friends/list/SAHIBI", "/api/friends/board/SAHIBI"]) {
      const r = await iste(yol, null);
      assert.equal(r.s, 401, `${yol} KIMLIKSIZ okunabiliyor (${r.s})`);
    }
  });

  test("büyük/küçük harf farkı sahipliği bozmaz", async () => {
    /* Firebase kimlikleri karışık harfli; sahiplik kontrolü harf duyarlı
     * olsaydı kullanıcı KENDİ listesinden kilitlenirdi. */
    const r = await iste("/api/friends/list/SaHiBi", "sahibi");
    assert.equal(r.s, 200, "sahibi kendi listesinden kilitlendi");
  });

  test("kapat", () => {
    srv?.close();
    try { fs.rmSync(KUM, { recursive: true, force: true }); } catch {}
  });
});
