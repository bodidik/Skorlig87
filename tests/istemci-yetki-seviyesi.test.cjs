"use strict";

/**
 * ISTEMCI ↔ SUNUCU YETKI SEVIYESI ESLESMESI.
 *
 * Yol eslesmesi (istemci-uc-eslesme.test.cjs) yolun VAR oldugunu denetler;
 * bu test istenen YETKI SEVIYESINI denetler. Bir uc `requireAdminToken`
 * istiyorsa istemci `withAdminHeaders` gondermeli, aksi halde 401 doner
 * ve ekran sessizce bos kalir — tam da /api/auth1987gs/members icin olan.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
const MOBIL = path.join(KOK, "..", "mobile");
const ROTA_DIZIN = path.join(KOK, "routes");

function mountTabani() {
  const srv = fs.readFileSync(path.join(KOK, "server.cjs"), "utf8");
  const t = {};
  const re = /app\.use\(\s*"([^"]+)"\s*,\s*require\("\.\/routes\/([a-z0-9.\-]+)\.cjs"\)/g;
  for (const m of srv.matchAll(re)) if (!t[m[2]]) t[m[2]] = m[1];

  const degisken = new Map();
  for (const m of srv.matchAll(
    /(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*require\(\s*"\.\/routes\/([^"]+)"\s*\)/g
  )) degisken.set(m[1], m[2]);
  for (const m of srv.matchAll(/app\.use\(\s*"([^"]+)"\s*,\s*([A-Za-z0-9_$]+)\s*\)/g)) {
    if (degisken.has(m[2])) {
      const dosya = degisken.get(m[2]).replace(/\.cjs$/, "");
      if (!t[dosya]) t[dosya] = m[1];
    }
  }
  return t;
}

function adminYollar() {
  const taban = mountTabani();
  const yollar = new Set();

  for (const ad of fs.readdirSync(ROTA_DIZIN)) {
    if (!ad.endsWith(".cjs")) continue;
    const dosya = ad.slice(0, -4);
    const onek = taban[dosya];
    if (!onek) continue;

    const src = fs.readFileSync(path.join(ROTA_DIZIN, ad), "utf8");

    const routerAdmin = /router\.use\(\s*(requireAdmin|requireAdminToken|_adminAuth)\b/.test(src);

    const satirlar = src.split("\n");
    for (const satir of satirlar) {
      const m = /router\.(get|post|put|patch|delete)\(\s*"([^"]*)"/.exec(satir);
      if (!m) continue;
      const yol = m[2];
      const adminMi = routerAdmin ||
        /requireAdmin|requireAdminToken|_adminAuth|isInternalCaller/.test(satir);
      if (!adminMi) continue;

      const tam = (onek.replace(/\/+$/, "") + "/" + yol.replace(/^\//, "")).replace(/\/\//g, "/");
      yollar.add(tam);
    }
  }
  return yollar;
}

function* dosyalar(dizin) {
  for (const ad of fs.readdirSync(dizin, { withFileTypes: true })) {
    if (ad.name === "node_modules" || ad.name.startsWith(".")) continue;
    const tam = path.join(dizin, ad.name);
    if (ad.isDirectory()) yield* dosyalar(tam);
    else if (/\.(ts|tsx)$/.test(ad.name)) yield tam;
  }
}

function istemciAdminCagrilari(adminYollarSet) {
  const sorunlu = [];

  for (const dosya of dosyalar(MOBIL)) {
    const icerik = fs.readFileSync(dosya, "utf8");
    const satirlar = icerik.split("\n");
    /* ⚠️ ICE AKTARIM ARANIR, PUSKUL DEGIL. Ilk surum yalnizca dosyada
     * `withAdminHeaders` GECIYOR MU diye bakiyordu; negatif kontrolde import
     * satirini silip govdedeki cagriyi birakinca kod bozuluyor ama test
     * GECIYORDU. Ice aktarimi sart kosmak o boslugu kapatiyor. */
    const adminBaslikVar =
      /import\s*\{[^}]*\bwithAdminHeaders\b[^}]*\}\s*from\s*["'][^"']*adminToken["']/.test(icerik);

    for (const satir of satirlar) {
      const kirpik = satir.trim();
      if (kirpik.startsWith("*") || kirpik.startsWith("//") || kirpik.startsWith("/*")) continue;

      for (const m of satir.matchAll(/["`](\/api\/[A-Za-z0-9_\-/.${}[\]]+)/g)) {
        const yol = m[1]
          .replace(/(?<!\/)\$\{[^}]*\}.*$/, "")
          .replace(/\$\{[^}]*\}/g, ":p")
          .split("?")[0]
          .replace(/\/+$/, "");
        if (yol.split("/").length < 3) continue;

        if (adminYollarSet.has(yol) && !adminBaslikVar) {
          sorunlu.push(`${yol}  <- ${path.relative(MOBIL, dosya)} (withAdminHeaders yok)`);
        }
      }
    }
  }
  // Ayni dosyada ayni uca birden fazla cagri varsa tek satir yeter.
  return [...new Set(sorunlu)].sort();
}

/**
 * BILINEN uyumsuzluklar — dondurulmus liste; YENI bir uyumsuzluk eklenirse
 * test kirilir.
 *
 * ⚠️ Su an BOS ve oyle kalmali. Ilk surumde tek girdi vardi
 * (/api/admin/runtime-mode <- admin-runtime.tsx); o ekran duzeltildi ve girdi
 * listeden CIKARILDI. Duzeltilen bir girdiyi listede birakmak, listenin yalan
 * soylemesi demek — `istemci-uc-eslesme.test.cjs` bu dersi team-ranks
 * orneginde zaten kayit altina almis.
 */
const BILINEN_UYUMSUZ = new Set([]);

test("bilinen uyumsuz liste bayat degil — duzeltilenler listede kalmasin", (t) => {
  if (!fs.existsSync(MOBIL)) return t.skip("mobil depo yan klasorde yok");

  const sorunlu = new Set(istemciAdminCagrilari(adminYollar()));
  const gereksiz = [...BILINEN_UYUMSUZ].filter((s) => !sorunlu.has(s));

  assert.deepEqual(
    gereksiz,
    [],
    "Bu girdiler artik uyumsuz degil (duzeltildi), listeden cikar:\n" +
      gereksiz.join("\n")
  );
});

test("istemci admin-guarded uca x-admin-token gondermeli", (t) => {
  if (!fs.existsSync(MOBIL)) return t.skip("mobil depo yan klasorde yok");

  const admin = adminYollar();
  assert.ok(admin.size > 0, "admin yol taramasi bozuk");

  const sorunlu = istemciAdminCagrilari(admin);
  const yeni = sorunlu.filter((s) => !BILINEN_UYUMSUZ.has(s));

  assert.deepEqual(
    yeni,
    [],
    "Bu istemci cagrilari admin-guarded uca gidiyor ama withAdminHeaders\n" +
      "kullanmiyor — 401 ADMIN_TOKEN_REQUIRED ile bos ekran olusur:\n" +
      yeni.join("\n")
  );
});
