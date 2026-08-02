"use strict";

/**
 * İSTEMCİ ↔ SUNUCU UÇ EŞLEŞMESİ.
 *
 * ⚠️ BU HATA DÖRT KEZ YAŞANDI VE AYLARCA FARK EDİLMEDİ. `mobile/lib/apiFetch.ts`
 * başındaki not aynen şunu sayıyor:
 *   • kings     → /api/users          (404) → "Takımım" sekmesi küresel listeyi
 *                                             takım sanıp gösterdi
 *   • board2    → /api/stats/board2   (404) → ekran hep boş
 *   • live/fav  → /api/stats/fav      (404) → favori takım hiç kaydedilmedi
 *   • stats/fav → /api/rt/fav-team    (404) → aynısı, farklı yanlış yol
 *
 * Dördü de aynı desenle saklandı: `catch {}` ya da `if (!j.ok) return` — hata
 * yutuluyor, ekran boş kalıyor, hiçbir yerde iz olmuyor. O turda LOGLAMA
 * eklendi ama çağrıların kendisi düzeltilmedi; bu test eksik olan denetimi
 * koyuyor.
 *
 * ⚠️ NE YAPAR: istemcideki her `/api/...` yolunu sunucudaki gerçek rotalarla
 * karşılaştırır (montaj önekleri + yol parametreleri dahil). Bilinen ölü
 * çağrılar DONDURULMUŞ bir listede; YENİ bir eşleşmeyen çağrı eklenirse test
 * kırılır.
 *
 * ⚠️ İKİ DEPO: mobil ayrı bir depo. Yan klasörde yoksa test sessizce atlanır —
 * yanlış alarm üretmek, nöbetçiyi işe yaramaz hâle getirir.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
const MOBIL = path.join(KOK, "..", "mobile");

/* ── Sunucu rotaları ─────────────────────────────────────────────────────── */

function sunucuYollari() {
  const src = fs.readFileSync(path.join(KOK, "server.cjs"), "utf8");
  const montaj = [];

  for (const m of src.matchAll(
    /app\.use\(\s*"([^"]+)"\s*,\s*require\(\s*"\.\/routes\/([^"]+)"\s*\)/g
  )) montaj.push([m[1], m[2]]);

  // Değişkenle monte edilenler (bu biçim bir kez gözden kaçmıştı).
  const degisken = new Map();
  for (const m of src.matchAll(
    /(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*require\(\s*"\.\/routes\/([^"]+)"\s*\)/g
  )) degisken.set(m[1], m[2]);
  for (const m of src.matchAll(/app\.use\(\s*"([^"]+)"\s*,\s*([A-Za-z0-9_$]+)\s*\)/g)) {
    if (degisken.has(m[2])) montaj.push([m[1], degisken.get(m[2])]);
  }

  const yollar = new Set();
  for (const [onek, dosya] of montaj) {
    const tam = path.join(KOK, "routes", dosya);
    if (!fs.existsSync(tam)) continue;
    for (const satir of fs.readFileSync(tam, "utf8").split("\n")) {
      const m = /^router\.(get|post|put|patch|delete)\(\s*"([^"]+)"/.exec(satir);
      if (!m) continue;
      yollar.add(
        (onek.replace(/\/+$/, "") + "/" + m[2].replace(/^\/+/, "")).replace(/\/{2,}/g, "/")
      );
    }
  }
  return yollar;
}

/* ── İstemci çağrıları ───────────────────────────────────────────────────── */

function* dosyalar(dizin) {
  for (const ad of fs.readdirSync(dizin, { withFileTypes: true })) {
    if (ad.name === "node_modules" || ad.name.startsWith(".")) continue;
    const tam = path.join(dizin, ad.name);
    if (ad.isDirectory()) yield* dosyalar(tam);
    else if (/\.(ts|tsx)$/.test(ad.name)) yield tam;
  }
}

function istemciCagrilari() {
  const bulunan = new Map();
  for (const dosya of dosyalar(MOBIL)) {
    const satirlar = fs.readFileSync(dosya, "utf8").split("\n");
    satirlar.forEach((satir) => {
      // Yorum satırlarını atla: apiFetch.ts'in başlığı örnek yollar içeriyor
      // ve onlar gerçek çağrı değil (ilk sürümde yanlış alarm ürettiler).
      const kirpik = satir.trim();
      if (kirpik.startsWith("*") || kirpik.startsWith("//") || kirpik.startsWith("/*")) return;

      for (const m of satir.matchAll(/["`](\/api\/[A-Za-z0-9_\-/.${}[\]]+)/g)) {
        const yol = m[1]
          /* ⚠️ EĞİK ÇİZGİ İLE BAŞLAMAYAN `${...}` YOL PARÇASI DEĞİL, SORGUDUR.
           * `/api/weekly-picks${qs}` içindeki değişken `?userId=...` taşıyor;
           * onu `:p` yapmak yolu `/api/weekly-picks:p` gösteriyor ve sunucuda
           * karşılığı yokmuş gibi YANLIŞ ALARM üretiyordu. Yol parametresi
           * (`/api/users/${id}`) her zaman `/` ile ayrılır — ayrım bu.
           * Tarayıcı `?` sonrasını zaten atıyor; sorun `?`nin değişkenin
           * İÇİNDE kalmasıydı. */
          .replace(/(?<!\/)\$\{[^}]*\}.*$/, "")
          .replace(/\$\{[^}]*\}/g, ":p")
          .split("?")[0]
          .replace(/\/+$/, "");
        if (yol.split("/").length < 3) continue;          // "/api" gibi parça
        if (!bulunan.has(yol)) bulunan.set(yol, new Set());
        bulunan.get(yol).add(path.relative(MOBIL, dosya));
      }
    });
  }
  return bulunan;
}

/** İstemci yolu, sunucudaki bir rotaya (parametreler dahil) uyuyor mu? */
function eslesir(cy, sunucu) {
  const cp = cy.split("/").filter(Boolean);
  for (const sy of sunucu) {
    const sp = sy.split("/").filter(Boolean);
    if (sp.length !== cp.length) continue;
    if (sp.every((s, i) => s.startsWith(":") || cp[i] === ":p" || s === cp[i])) return true;
  }
  return false;
}

/**
 * BİLİNEN ölü çağrılar — hepsi doğrulandı, sunucuda karşılığı YOK.
 *
 * Liste dondurulmuştur: YENİ bir eşleşmeyen çağrı eklenirse test kırılır.
 * Buradakiler ayrı bir iş olarak temizlenmeli; her biri sessizce 404 dönüyor
 * ve ilgili ekran boş/işlevsiz kalıyor.
 */
/* NOT: `apiFetch.ts` basligindaki dort tarihsel hata (kings/board2/live-fav/
 * stats-fav) BU LISTEDE YOK cunku onlar ZATEN DUZELTILMIS — yalnizca o yorum
 * metninde geciyorlar. Ilk taramada yorumlari atlamadigim icin hepsini "hala
 * bozuk" sanmistim; tarayici yorum satirlarini atlayinca gercek tablo cikti.
 * Bu, nobetci yazarken yorum/kod ayrimini yapmamanin bedeli. */
const BILINEN_OLU = new Set([
  /* "/api/mini/public" CIKARILDI — 2026-08-03te yazildi (routes/mini.cjs).
   * Duzeltilen ucu olu listede birakmak, listenin yalan soylemesi demek;
   * bayatlama nobetcisi bunu team-ranks ornekinde zaten yakalamisti. */
  "/api/rt/team-totals",       // stats/team.tsx
  /* "/api/stats/team-ranks" ÇIKARILDI — 2026-08-01'de yazıldı
   * (routes/stats.cjs). Bu satırın burada kalması, bayatlama nöbetçisinin
   * yakaladığı tam durumdu: düzeltilen uç ölü listede kalırsa liste
   * "bilinen eksikler" olmaktan çıkıp yalan söylemeye başlar. */
  "/api/rt/admin-fixture",     // live.tsx
  "/api/auth1987gs/status",    // mystatus.tsx (uçlar: verify/diag/members)
  "/api/skorlig/next",         // predict.tsx (skorlig.cjs /api'ye monte)
  "/api/users/get",            // profile/[userId].tsx — yalnızca yedek yol
  /* "/api/leaderboard:p" ÇIKARILDI — 2026-08-03. Zaten "tarayıcı eseri"
   * diye işaretlenmiş bir YANLIŞ POZİTİFTİ: `/api/leaderboard${qs}` gibi
   * bir çağrıda değişken SORGU taşıyor, yol parçası değil. Tarayıcının
   * normalleştirmesi düzeltilince (eğik çizgiyle başlamayan `${...}`
   * sorgudur) bu giriş kendiliğinden gereksizleşti ve bayatlama nöbetçisi
   * onu yakaladı. */
]);

/* ── Testler ─────────────────────────────────────────────────────────────── */

test("istemci deposu bulunamazsa test atlanır (yanlış alarm üretme)", () => {
  // Bilerek boş: aşağıdaki testler MOBIL yoksa kendiliğinden atlıyor.
  assert.ok(true);
});

test("YENİ ölü uç çağrısı eklenemez", (t) => {
  if (!fs.existsSync(MOBIL)) return t.skip("mobil depo yan klasorde yok");

  const sunucu = sunucuYollari();
  assert.ok(sunucu.size > 100, `sunucu rota taramasi bozuk (${sunucu.size})`);

  const cagrilar = istemciCagrilari();
  assert.ok(cagrilar.size > 30, `istemci tarama bozuk (${cagrilar.size})`);

  const yeni = [];
  for (const [yol, dosyalar_] of cagrilar) {
    if (eslesir(yol, sunucu)) continue;
    if (BILINEN_OLU.has(yol)) continue;
    yeni.push(`${yol}  <- ${[...dosyalar_].join(", ")}`);
  }

  assert.deepStrictEqual(
    yeni,
    [],
    "Bu istemci cagrilarinin sunucuda karsiligi YOK (404 doner ve hata\n" +
      "genellikle catch icinde yutulur — ekran sessizce bos kalir):\n" +
      yeni.join("\n")
  );
});

test("bilinen ölü liste bayat değil — düzeltilenler listede kalmasın", (t) => {
  if (!fs.existsSync(MOBIL)) return t.skip("mobil depo yan klasorde yok");

  const sunucu = sunucuYollari();
  const cagrilar = istemciCagrilari();

  const gereksiz = [...BILINEN_OLU].filter(
    (y) => !cagrilar.has(y) || eslesir(y, sunucu)
  );
  assert.deepStrictEqual(
    gereksiz,
    [],
    "Bu yollar artik olu degil (ya duzeltildi ya kaldirildi), listeden cikar:\n" +
      gereksiz.join("\n")
  );
});
