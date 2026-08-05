"use strict";

/**
 * KORUMALI YÖNETİCİ UCUNA MOBİL TARAF BAŞLIK GÖNDERİYOR MU?
 *
 * ⚠️ BULUNAN: `POST /api/rt/admin-live-gs` sunucuda `requireAdmin` ile
 * korunuyor — doğru karar, çünkü o uç maçın skorunu ve "bitti" durumunu
 * yazıyor ve settle2 ödemeyi bu duruma bakarak yapıyor. Ama CANLI SEKMESİNDEKİ
 * yönetici paneli (`mobile/app/(tabs)/live.tsx`) o uca düz `apiJson` ile
 * gidiyordu. `mobile/lib/apiFetch.ts` yalnızca `x-auth-token` ve `x-user-id`
 * ekliyor, `x-admin-token` EKLEMİYOR.
 *
 * ÖLÇÜLDÜ (gerçek express rotası):
 *     baslıksız istek → 401 ADMIN_TOKEN_REQUIRED   (panelin yaptığı buydu)
 *     baslıklı istek  → 200                        (düzeltmeden sonraki hâli)
 *
 * ⚠️ SUNUCUDAKİ GEREKÇE NOTU YANILTICIYDI: "Yönetim ekranı zaten x-admin-token
 * gönderiyor (withAdminHeaders)". Bu `app/admin-live.tsx` için DOĞRU — o
 * ekranın kendi `apiFetch` sarmalayıcısı var. Canlı sekmesindeki panel için
 * DEĞİLDİ. İki ayrı ekran aynı ucu çağırıyor, biri korunmuş biri korunmamış:
 * bu oturumun tekrar eden kalıbı.
 *
 * ⚠️ SESSİZ DEĞİL, GÖRÜNÜR ARIZAYDI: panel `setAdmMsg(normalizeApiError(j1))`
 * ile hatayı gösteriyor. Yani veri bozulmuyordu, yönetici skoru
 * KAYDEDEMİYORDU. Abartmıyorum: bu bir veri kaybı değil, işlev kaybı.
 *
 * DÜZELTME mobil tarafta: başlık YALNIZCA o çağrıya ekleniyor. `apiJson`'a
 * genel olarak koymak, ekrandaki sıradan isteklere de yönetici jetonu
 * iliştirirdi.
 */

const os = require("os");
const path = require("path");
const fs = require("fs");

const TMP = path.join(os.tmpdir(), "skorlig-yonetici-baslik-test");
process.env.SKORLIG_DATA_DIR = TMP;
process.env.SKORLIG_BG = "0";

const KOK = path.join(__dirname, "..");
const vtYol = require.resolve(path.join(KOK, "middleware", "verifyToken.cjs"));
require.cache[vtYol] = {
  id: vtYol, filename: vtYol, loaded: true, exports: {
    verifyToken: (req, _res, next) => { req.uid = req.headers["x-user-id"]; next(); },
    optionalToken: (req, _res, next) => { req.uid = req.headers["x-user-id"] || null; next(); },
    getFirebaseAuth: () => null,
    kimlikModu: () => "test",
  },
};

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

const JETON = "test-yonetici-jetonu";
let srv = null, port = 0, eskiJeton;

before(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  eskiJeton = process.env.SKORLIG_ADMIN_TOKEN;
  process.env.SKORLIG_ADMIN_TOKEN = JETON;

  const app = express();
  app.use("/api/rt", require("../routes/rt.live-gs.cjs"));
  srv = app.listen(0);
  port = srv.address().port;
});

after(() => {
  if (srv) srv.close();
  if (eskiJeton === undefined) delete process.env.SKORLIG_ADMIN_TOKEN;
  else process.env.SKORLIG_ADMIN_TOKEN = eskiJeton;
});

const govde = {
  fixtureId: "MK-BASLIK-2026-08-01-X",
  status: "FT", homeGoals: 2, awayGoals: 1, minute: 90,
};

const gonder = (basliklar) =>
  fetch(`http://127.0.0.1:${port}/api/rt/admin-live-gs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...basliklar },
    body: JSON.stringify(govde),
  });

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("jeton yapılandırılmış — muhafız 503 vermiyor", async () => {
    const r = await gonder({ "x-admin-token": JETON });
    assert.notEqual(r.status, 503, "ADMIN_TOKEN yapilandirilmamis — test bir sey olcmuyor");
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("uç gerçekten korumalı", () => {
  test("başlıksız istek REDDEDİLİYOR", async () => {
    const r = await gonder({});
    assert.equal(r.status, 401, `basliksiz istek ${r.status} aldi — mac skorunu herkes yazabilir`);
  });

  test("yanlış jeton REDDEDİLİYOR", async () => {
    const r = await gonder({ "x-admin-token": "yanlis" });
    assert.equal(r.status, 401);
  });

  test("doğru başlıkla GEÇİYOR", async () => {
    const r = await gonder({ "x-admin-token": JETON });
    assert.equal(r.status, 200, "dogru jetonla da gecmiyor — muhafiz fazla kati");
  });
});

/* ── Nöbetçi: mobil çağıran başlığı gönderiyor mu ────────────────────────── */

/**
 * ⚠️ ÇAPRAZ DEPO DENETİMİ — ve sınırını dürüstçe yazıyorum. API deposu mobil
 * çekimine BAĞIMLI OLAMAZ; yan dizin yoksa test atlanır. Yine de değerli:
 * kusur tam olarak "sunucu kapıyı kapattı, çağıran anahtarı göndermiyor"
 * biçimindeydi ve iki tarafa ayrı ayrı bakan hiçbir test bunu göremezdi.
 */
test("NÖBETÇİ: mobil taraf korumalı uca yönetici başlığı gönderiyor", (t) => {
  const mobil = require("./_mobil-dizin.cjs").MOBIL;
  if (!fs.existsSync(mobil)) return t.skip("mobil deposu yok");

  const ARANAN = "/api/rt/admin-live-gs";
  const suclu = [];

  const gez = (dizin) => {
      /**
       * ⚠️ readdirSync + statSync YARIŞI — SÜİTİ ARADA BİR KIRIYORDU.
       *
       * Sunucu çalışırken `data/` altına atomik yazılıyor: önce `*.tmp`,
       * sonra rename. `readdirSync` dosyayı görüyor, `statSync`e gelene kadar
       * rename tamamlanıyor ve ENOENT atıyor:
       *     ENOENT: no such file or directory, stat 'data/results.json.tmp'
       *
       * ÖLÇÜLDÜ (2026-08-02): 8-10 tam koşuda 1 kırılma. Aynı kök bu sabah
       * `guvenli-yol-siniri` testinde de bulunmuştu; orada try/catch ile
       * TOLERE edilmişti ama sınıf taranmadığı için bu iki dosya kalmıştı.
       *
       * ⚠️ BU KEZ TOLERE ETMİYORUZ, YARIŞI KALDIRIYORUZ: `withFileTypes`
       * dizin bilgisini readdir'in KENDİ sonucundan veriyor, yani ikinci bir
       * sistem çağrısı ve arada kalan pencere yok.
       */
    for (const girdi of fs.readdirSync(dizin, { withFileTypes: true })) {
      const ad = girdi.name;
      if (ad === "node_modules" || ad.startsWith(".")) continue;
      const tam = path.join(dizin, ad);
      if (girdi.isDirectory()) { gez(tam); continue; }
      if (!/\.(ts|tsx)$/.test(ad)) continue;

      /**
       * ⚠️ YORUMLAR SİLİNİYOR ve PENCEREYE bakılıyor.
       *
       * İlk sürümüm "dosyanın herhangi bir yerinde `withAdminHeaders` geçiyor
       * mu" diye soruyordu. Negatif kontrolde düzeltmeyi geri aldım ve test
       * KIRILMADI: `import` satırı ve bu açıklamanın kendisi kelimeyi
       * içerdiği için eşleşme sürüyordu. Yani nöbetçi hiçbir şey ölçmüyordu —
       * bu oturumun altı kez tekrarlanan tuzağı (yorum/kod karışması).
       *
       * Şimdi: yorumlar boşaltılıyor ve başlık, ÇAĞRININ KENDİ çevresinde
       * aranıyor.
       */
      const src = fs.readFileSync(tam, "utf8")
        .split("\n")
        .map((l) => {
          const t = l.trim();
          return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
        })
        .join("\n");
      if (!src.includes(ARANAN)) continue;

      let i = -1;
      while ((i = src.indexOf(ARANAN, i + 1)) !== -1) {
        const pencere = src.slice(i, i + 600);
        // POST değilse (durum okuma) yönetici başlığı gerekmiyor.
        if (!/method:\s*"POST"/.test(pencere)) continue;
        if (/withAdminHeaders|x-admin-token/.test(pencere)) continue;
        // Dosyanın kendi `apiFetch` sarmalayıcısı başlığı ekliyor olabilir.
        if (/async function apiFetch[\s\S]{0,400}withAdminHeaders/.test(src)) continue;
        suclu.push(path.relative(mobil, tam));
        break;
      }
    }
  };
  gez(path.join(mobil, "app"));

  assert.deepEqual(
    suclu, [],
    `korumali uca yonetici basligi gondermeden istek atan ekran(lar): ${suclu.join(", ")}`
  );
});

test("NÖBETÇİ: uç hâlâ requireAdmin ile korumalı", () => {
  const src = fs.readFileSync(path.join(KOK, "routes", "rt.live-gs.cjs"), "utf8")
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");
  assert.ok(
    /router\.post\("\/admin-live-gs",\s*requireAdmin/.test(src),
    "skor yazan uctan muhafiz kalkmis — settle2 odemeyi bu duruma bakarak yapiyor"
  );
});
