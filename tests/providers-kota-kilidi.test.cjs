"use strict";

/**
 * providers.json KOTA SAYACI EŞZAMANLI ARTIŞTA KAYBETMEZ.
 *
 * ⚠️ BULUNAN KUSUR (2026-08-03): `providers.json`'a ALTI modül yazıyor ve
 * hepsi "oku → değiştir → yaz" yapıyor. Atomik yazma (writeJsonAtomic) hepsine
 * uygulanmıştı — ama atomik yazma YARIM JSON okunmasını engeller, KAYIP
 * ARTIŞI engellemez. İki istek aynı anda okursa ikisi de eski sayacı görür.
 *
 * ÖLÇÜLDÜ (GERÇEK rota, izole veri dizini, üretime dokunmadan):
 *     40 eşzamanlı POST /api/provider/mark?name=TSDB
 *     → hepsi HTTP 200, dosyada `used: 1`. 39 artış KAYIP, tek hata yok.
 *     Kilitten sonra: used 40/40, kayıp 0.
 *
 * ⚠️ SAYAÇ TAM KORUMASIZ OLDUĞU ANDA "HER ŞEY YOLUNDA" DİYOR: `used` düşük
 * göründüğü için kota dolmuş olsa bile sağlayıcıya istek atılmaya devam eder.
 *
 * ⚠️ AYNI SAVUNMA KOMŞUSUNDA VARDI (bu oturumun baskın kusur biçimi):
 * `services/af-sync.cjs` tam bu ölçümü (40 istek → 1) yapıp KENDİ bump'ını
 * `withFileLock` ile sarmış. Aynı dosyaya yazan dört modül atlanmıştı.
 * `lib/providers.cjs` de kilitliydi — ama onu KİMSE require etmiyor, yani
 * koruma fiilen kullanılmayan bir modülde duruyordu.
 *
 * ⚠️ ÜRETİME DOKUNMAZ: her test kendi geçici veri dizininde koşar.
 */

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const KOK = path.join(__dirname, "..");

// ⚠️ ROTA YÜKLENMEDEN ÖNCE: dosya yolu modül düzeyinde hesaplanıyor.
const VERI_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "skorlig-prov-"));
process.env.SKORLIG_DATA_DIR = VERI_DIR;
process.env.SKORLIG_ADMIN_TOKEN = process.env.SKORLIG_ADMIN_TOKEN || "test-admin-token";

const express = require("express");
const PROV_FILE = path.join(VERI_DIR, "providers.json");
const JETON = process.env.SKORLIG_ADMIN_TOKEN;

let srv = null, port = 0;

before(async () => {
  const app = express();
  app.use("/api/provider", require(path.join(KOK, "routes", "provider.cjs")));
  await new Promise((r) => { srv = app.listen(0, r); });
  port = srv.address().port;
});

after(() => {
  srv?.close();
  try { fs.rmSync(VERI_DIR, { recursive: true, force: true }); } catch { /* geçici */ }
});

const BASLIK = { "x-admin-token": JETON, "content-type": "application/json" };
const mark = (ad) =>
  fetch(`http://127.0.0.1:${port}/api/provider/mark?name=${ad}&ok=1`,
        { method: "POST", headers: BASLIK, body: "{}" });

function modeliOku() {
  return JSON.parse(fs.readFileSync(PROV_FILE, "utf8"));
}

describe("providers.json kota kilidi", () => {
  test("kurulum sınandı: uç GERÇEKTEN sayacı artırıyor", async () => {
    /**
     * ⚠️ Bu olmadan eşzamanlılık iddiası boş: uç hiç yazmıyorsa 40 istek
     * sonunda 1 görmek de "beklenen" olurdu.
     */
    fs.rmSync(PROV_FILE, { force: true });
    const r = await mark("TSDB");
    assert.equal(r.status, 200, "uc 200 donmedi — yetki/rota yanlis, test bir sey olcmuyor");
    assert.equal(modeliOku().quotas.TSDB.used, 1, "tek istek sayaci artirmadi");
  });

  test("40 EŞZAMANLI artışın HİÇBİRİ kaybolmuyor", async () => {
    fs.rmSync(PROV_FILE, { force: true });
    const N = 40;
    const yanitlar = await Promise.all(Array.from({ length: N }, () => mark("TSDB")));
    assert.equal(yanitlar.filter((r) => r.status === 200).length, N, "bazi istekler hata dondu");

    const m = modeliOku();
    assert.equal(m.quotas.TSDB.used, N,
      `kota sayaci ${m.quotas.TSDB.used}/${N} — ${N - m.quotas.TSDB.used} artis KAYIP (kilit yok)`);
    assert.equal(m.providers.TSDB.ok, N,
      `basari sayaci ${m.providers.TSDB.ok}/${N} — ayni yaris`);
  });

  test("FARKLI uçlar aynı dosyanın FARKLI alanlarını ezmiyor", async () => {
    /**
     * ⚠️ Yalnızca `mark`ı kilitlemek yetmez: `team-primary` ve `warn` de aynı
     * dosyanın tamamını yeniden yazıyor. Biri kilitsiz kalırsa ötekinin
     * yazdığını sessizce geri alır.
     */
    fs.rmSync(PROV_FILE, { force: true });
    const isler = [
      ...Array.from({ length: 15 }, () => mark("FDO")),
      ...Array.from({ length: 10 }, (_, i) =>
        fetch(`http://127.0.0.1:${port}/api/provider/team-primary`,
              { method: "POST", headers: BASLIK, body: JSON.stringify({ team: `TAKIM${i}`, provider: "FDO" }) })),
      ...Array.from({ length: 5 }, () =>
        fetch(`http://127.0.0.1:${port}/api/provider/warn`,
              { method: "POST", headers: BASLIK, body: JSON.stringify({ name: "FDO", warn: 80 }) })),
    ];
    const yanitlar = await Promise.all(isler);
    assert.equal(yanitlar.filter((r) => r.status === 200).length, 30, "bazi istekler hata dondu");

    const m = modeliOku();
    assert.equal(m.quotas.FDO.used, 15, `FDO used ${m.quotas.FDO.used}/15`);
    assert.equal(Object.keys(m.teamPref || {}).length, 10,
      `teamPref girdisi ${Object.keys(m.teamPref || {}).length}/10 — yazmalar birbirini eziyor`);
  });

  test("NÖBETÇİ: providers.json'a yazan HER modül kilit alıyor", () => {
    /**
     * ⚠️ ASIL KIRILGANLIK VE BU KUSURUN KÖKÜ. Koruma dosya dosya
     * uygulandığı için biri atlandığında hata vermiyor, yalnızca sayaç
     * eksik kalıyor. Sınıf taraması: providers.json'a YAZAN her modül
     * `withFileLock` kullanmalı.
     */
    const suclu = [];
    for (const d of ["routes", "services", "lib"]) {
      const dizin = path.join(KOK, d);
      for (const ad of fs.readdirSync(dizin)) {
        if (!ad.endsWith(".cjs")) continue;
        const src = fs.readFileSync(path.join(dizin, ad), "utf8");
        if (!/"providers\.json"/.test(src)) continue;
        // yalnızca YAZANLAR
        if (!/write(Json|JsonAtomic)\s*\(\s*(PROV_FILE|FILE_PATH|STORE_PATH)/.test(src)) continue;
        if (!/withFileLock\s*\(\s*(PROV_FILE|FILE_PATH|STORE_PATH)/.test(src)) suclu.push(`${d}/${ad}`);
      }
    }
    assert.deepEqual(suclu, [],
      "providers.json'a KILITSIZ yazan modul(ler): " + suclu.join(", "));
  });

  test("TERS RİSK: kilit KENDİ İÇİNDEN alınmıyor (kilitlenme olmaz)", async () => {
    /**
     * ⚠️ `withFileLock` YENİDEN GİRİLEBİLİR DEĞİL: kilidin içinden kilit alan
     * çağrı sonsuza kadar bekler ve istek ASILIR — hata bile vermez, ki bu
     * kayıp sayaçtan daha kötüdür. Sarılan gövdeler yalnızca load/save
     * çağırmalı. Zaman aşımlı gerçek istekle sınanıyor.
     */
    const c = new AbortController();
    const zaman = setTimeout(() => c.abort(), 5000);
    const r = await fetch(`http://127.0.0.1:${port}/api/provider/mark?name=AF&ok=1`,
                          { method: "POST", headers: BASLIK, body: "{}", signal: c.signal });
    clearTimeout(zaman);
    assert.equal(r.status, 200, "istek asildi — ic ice kilit olabilir");
  });
});
