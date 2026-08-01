"use strict";

/**
 * DUMAN TESTİ — hiçbir GET ucu 500 dönmemeli.
 *
 * ⚠️ BU TURDA KUSUR BULUNMADI: 134 uç tarandı, 5xx yok. Test bir düzeltmeyi
 * değil, TÜM API yüzeyini koruyor.
 *
 * ⚠️ NEDEN GEREKLİ: bu oturumda bir commit `routes/users.cjs` içinde
 * import edilmemiş bir yardımcıyı çağırdı ve `/api/users/groups/list`
 * ReferenceError ile 500 vermeye başladı. Lint çıktısı `tail -3` ile
 * kırpıldığı için "lint temiz" diye rapor edilmişti. Birim testleri de
 * görmedi, çünkü hiçbiri o ucu ÇAĞIRMIYORDU. Sunucuyu gerçekten ayağa
 * kaldırıp her ucu bir kez çağırmak, o sınıfın tek güvenilir ağı.
 *
 * ⚠️ BOŞ VERİTABANINA KARŞI ÇALIŞIR. Asıl sınanan şey "veri yokken ne oluyor":
 * eksik kayıt, boş koleksiyon, olmayan fikstür. 4xx beklenen ve kabul edilen
 * cevap; 5xx ise kod hatası.
 *
 * ⚠️ YAN ETKİLİ GET'LER DIŞARIDA. Bazı GET uçları yazma yapıyor — örneğin
 * `/api/mini/board` turnuvayı bitirip LC ödeyebiliyor. Onları çağırmak testi
 * para dağıtan bir işleme çevirirdi.
 */

const os = require("os");
const nodePath = require("path");
const fs = require("fs");
const cp = require("child_process");

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

const KOK = nodePath.join(__dirname, "..");
const TMP = nodePath.join(os.tmpdir(), "skorlig-duman-test");
const PORT = 4293;
const TABAN = `http://127.0.0.1:${PORT}`;

/** Yan etkisi olduğu bilinen ya da pahalı olan yollar — çağrılmaz. */
const YASAK = [
  { re: /\/mini\/board/,  neden: "turnuvayi bitirip LC odeyebilir" },
  { re: /probe|yokla/,    neden: "her kaynak icin tarayici acar" },
  { re: /\/admin\//,      neden: "yonetici yuzeyi ayri sinaniyor (uc-yetki testleri)" },
  { re: /scrape|kazi/,    neden: "dis siteye cikar" },
  {
    re: /\/settle/,
    neden: "sonuclandirma tetikler",
    /**
     * ⚠️ İLERİYE DÖNÜK KORUMA — bugün eşleşen bir GET yolu YOK (settle
     * yalnizca POST). Yine de duruyor, cunku bu kod tabaninda yan etkili GET
     * gercekten var (`/mini/board` turnuvayi bitirip LC oduyor). Bir gun GET
     * bir settle yolu eklenirse duman testi onu CAGIRMAMALI.
     *
     * Bayatlık denetiminden muaf; muafiyet gerekçesiz olmasin diye burada.
     */
    ileriyeDonuk: true,
  },
];

let mongod = null, srv = null;

before(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });

  const { MongoMemoryServer } = require("mongodb-memory-server");
  mongod = await MongoMemoryServer.create();

  srv = cp.spawn("node", ["server.cjs"], {
    cwd: KOK,
    env: {
      ...process.env,
      SKORLIG_DATA_DIR: TMP,
      MONGODB_URI: mongod.getUri(),
      MONGODB_DB: "duman",
      SKORLIG_BG: "0",        // arka plan servisleri kapali (gercek veriye dokunmasin)
      SKORLIG_PUSH: "0",
      PORT: String(PORT),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  srv.stdout.resume();
  srv.stderr.resume();

  for (let i = 0; i < 80; i++) {
    try {
      await fetch(`${TABAN}/api/health`, { signal: AbortSignal.timeout(1500) });
      return;
    } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  throw new Error("sunucu ayaga kalkmadi");
});

after(async () => {
  if (srv) {
    srv.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 1200));
    srv.kill("SIGKILL");
  }
  if (mongod) await mongod.stop();
});

/**
 * GET yollarını KODDAN türetir.
 *
 * ⚠️ ELLE LİSTE YAZILMIYOR: bu oturumda elle tutulan listelerin gerçeklikten
 * ayrışması dört kez hata üretti, ve elle yazılan yol listesi "kodun ne
 * yaptığını" değil "yazarın ne hatırladığını" sınar.
 */
function getYollari() {
  const srvSrc = fs.readFileSync(nodePath.join(KOK, "server.cjs"), "utf8");
  const montaj = [];
  for (const m of srvSrc.matchAll(
    /app\.use\(\s*"([^"]+)"\s*,\s*require\(\s*"\.\/routes\/([^"]+)"\s*\)/g
  )) montaj.push([m[1], m[2]]);

  const yollar = new Set();
  for (const [onek, dosya] of montaj) {
    const tam = nodePath.join(KOK, "routes", dosya);
    if (!fs.existsSync(tam)) continue;
    for (const satir of fs.readFileSync(tam, "utf8").split("\n")) {
      const m = /^router\.get\(\s*"([^"]+)"/.exec(satir);
      if (!m) continue;
      const ham = (onek.replace(/\/+$/, "") + "/" + m[1].replace(/^\/+/, "")).replace(/\/{2,}/g, "/");
      if (YASAK.some((y) => y.re.test(ham))) continue;
      yollar.add(
        ham
          .replace(/:fixtureId/g, "fx-yok-1")
          .replace(/:userId/g, "duman-kullanici")
          .replace(/:code/g, "ABC123")
          .replace(/:id/g, "yok-1")
          .replace(/:[A-Za-z0-9_]+/g, "x")
      );
    }
  }
  return [...yollar].sort();
}

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("sunucu ayakta ve sağlık ucu cevap veriyor", async () => {
    const r = await fetch(`${TABAN}/api/health`);
    const j = await r.json();
    assert.ok(typeof j.mountedCount === "number", `saglik yaniti beklenmedik: ${JSON.stringify(j).slice(0, 200)}`);
    assert.ok(j.mountedCount > 30, `cok az router monte edilmis (${j.mountedCount})`);
    assert.deepStrictEqual(j.skipped, [], `bazi routerlar yuklenemedi: ${JSON.stringify(j.skipped)}`);
  });

  test("taranacak uç listesi makul büyüklükte", () => {
    const y = getYollari();
    assert.ok(y.length >= 100, `yalnizca ${y.length} GET ucu bulundu — tarama bozulmus olabilir`);
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

test("hiçbir GET ucu 500 dönmüyor", async () => {
  const yollar = getYollari();
  const besyuz = [];
  const ulasilamayan = [];
  let ikiyuz = 0, dortyuz = 0;

  for (const yol of yollar) {
    const url = `${TABAN}${yol}${yol.includes("?") ? "&" : "?"}userId=duman-kullanici`;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (r.status >= 500) {
        const govde = (await r.text()).slice(0, 300);
        besyuz.push(`${r.status}  ${yol}\n    ${govde}`);
      } else if (r.status >= 400) dortyuz++;
      else ikiyuz++;
    } catch (e) {
      ulasilamayan.push(`${yol} — ${String(e.message || e).slice(0, 80)}`);
    }
  }

  // Sağlık denetimi: hepsi 4xx dönseydi test hiçbir kod yolunu çalıştırmamış olurdu.
  assert.ok(
    ikiyuz >= 30,
    `yalnizca ${ikiyuz} uc basarili dondu — kurulum bozuk, test kod yollarini calistirmiyor`
  );
  assert.deepStrictEqual(
    ulasilamayan, [],
    "Bu uclardan yanit alinamadi (zaman asimi/baglanti):\n" + ulasilamayan.join("\n")
  );
  assert.deepStrictEqual(
    besyuz, [],
    `${besyuz.length}/${yollar.length} uc 500 donuyor. Bos veritabaninda 500,\n` +
      "eksik veriye degil KOD HATASINA isaret eder:\n" + besyuz.join("\n")
  );
});

/* ── Bozuk parametreler ──────────────────────────────────────────────────── */

/**
 * Bir istemcinin gerçekten gönderebileceği anlamsız değerler, tek sorguda.
 *
 * ⚠️ TAM ÇARPIM DEĞİL, BİLİNÇLİ. Ölçüm sırasında 14 bozuk değeri 134 uçla
 * çaprazladım — 1876 çağrı, 0 adet 5xx. Ama o tarama ~4 dakika sürüyor ve her
 * `npm test` çalışmasına eklemek pahalı. Burada hepsi TEK sorguda birleştirildi:
 * aynı kod yolları (Number(), slice(), sınır kontrolleri) çalışıyor, maliyet
 * 134 çağrı.
 */
const BOZUK_SORGU = [
  "limit=abc",
  "userId=",
  "fixtureId=",
  "days=-1",
  "top=NaN",
  "season=abc",
  "code=",
  "page=-1",
  "country=%C3%BC%C3%BC%C3%BC",
].join("&");

test("bozuk sorgu parametreleri 500'e yol açmıyor", async () => {
  const yollar = getYollari();
  const besyuz = [];
  let cevaplanan = 0;

  for (const yol of yollar) {
    try {
      const r = await fetch(`${TABAN}${yol}?${BOZUK_SORGU}`, { signal: AbortSignal.timeout(15000) });
      cevaplanan++;
      if (r.status >= 500) {
        const govde = (await r.text()).slice(0, 300);
        besyuz.push(`${r.status}  ${yol}\n    ${govde}`);
      }
    } catch (e) {
      besyuz.push(`YANITSIZ  ${yol} — ${String(e.message || e).slice(0, 80)}`);
    }
  }

  assert.ok(
    cevaplanan >= yollar.length - 2,
    `${yollar.length} uctan yalnizca ${cevaplanan} cevap verdi — kurulum bozuk`
  );
  assert.deepStrictEqual(
    besyuz, [],
    "Bozuk parametre 500'e yol aciyor. `Number('abc')` NaN, bos dize, negatif\n" +
      "sinir gibi degerler istemciden gelebilir; 4xx dogru cevap, 5xx kod hatasi:\n" +
      besyuz.join("\n")
  );
});

/* ── Muafiyet listesi ────────────────────────────────────────────────────── */

test("yasak liste bayat değil — her desen hâlâ bir yolla eşleşiyor", () => {
  /**
   * Muafiyet gerekçeli olmalı ve karşılığı kalmayan desen listeden çıkmalı;
   * yoksa liste zamanla "her şeyi atlayan" bir filtreye dönüşür.
   */
  const srvSrc = fs.readFileSync(nodePath.join(KOK, "server.cjs"), "utf8");
  const tumYollar = [];
  for (const m of srvSrc.matchAll(
    /app\.use\(\s*"([^"]+)"\s*,\s*require\(\s*"\.\/routes\/([^"]+)"\s*\)/g
  )) {
    const tam = nodePath.join(KOK, "routes", m[2]);
    if (!fs.existsSync(tam)) continue;
    for (const satir of fs.readFileSync(tam, "utf8").split("\n")) {
      const g = /^router\.get\(\s*"([^"]+)"/.exec(satir);
      if (g) tumYollar.push((m[1] + "/" + g[1]).replace(/\/{2,}/g, "/"));
    }
  }

  const karsiliksiz = YASAK
    .filter((y) => !y.ileriyeDonuk)
    .filter((y) => !tumYollar.some((p) => y.re.test(p)))
    .map((y) => `${y.re} (${y.neden})`);
  assert.deepStrictEqual(
    karsiliksiz, [],
    "Bu yasak desenlerin karsiligi kalmamis, listeden cikarilmali:\n" + karsiliksiz.join("\n")
  );
});
