"use strict";

/**
 * HAM `fetch` ILE /api/ CAGRISI YASAK — paylasilan sarmalayici kullanilmali.
 *
 * NEDEN: `lib/apiFetch.ts` uc politikayi tek yerde topluyor — zaman asimi,
 * guvenli yontemlerde yeniden deneme (ag hatasinda API adresini tazeleyerek)
 * ve 2xx disi yanitlarin loglanmasi. Ham `fetch` bunlarin hicbirini almiyor.
 * Depo bu kopyalari bir kez teke indirdi ("Ayni kopya 29 dosyada vardi"), ama
 * geriye 11 dosyada 19 cagri kalmisti ve sessizce ayrisiyorlardi.
 *
 * ⚠️ SORUN KOZMETIK DEGILDI. Kalan kopyalardan ikisi kimligi
 * `Authorization: Bearer` ile gonderiyordu; sunucudaki `verifyToken` ise
 * YALNIZCA `x-auth-token` okuyor (api/middleware/verifyToken.cjs). Yani
 * BigFourPicks ve Picks1987 bilesenlerinin gonderdigi her haftalik tahmin
 * 401 aliyordu ve sonuc `catch {}` ile yutuluyordu: kullanici seciyor,
 * hicbir sey olmuyordu. Sarmalayiciya gecmek bunu da duzeltti.
 *
 * MUAF OLANLAR: yalnizca API TABANINI COZEN bootstrap dosyalari. Onlar
 * apiFetch'i kullanamaz — apiFetch tabani onlardan aliyor, dongu olurdu.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
const MOBIL = require("./_mobil-dizin.cjs").MOBIL;

/* Tabani kendisi cozen dosyalar; apiFetch'e bagimli olamazlar. */
const MUAF = new Set(["lib/apiBase.ts", "lib/runtimeConfig.ts", "lib/serverTime.ts", "lib/apiFetch.ts"]);

const TARANAN = ["app", "components", "lib", "hooks"];

function* dosyalar(dizin) {
  if (!fs.existsSync(dizin)) return;
  for (const ad of fs.readdirSync(dizin, { withFileTypes: true })) {
    if (ad.name === "node_modules" || ad.name.startsWith(".")) continue;
    const tam = path.join(dizin, ad.name);
    if (ad.isDirectory()) yield* dosyalar(tam);
    else if (/\.(ts|tsx)$/.test(ad.name)) yield tam;
  }
}

function hamFetchCagrilari() {
  const sorunlu = [];
  for (const kok of TARANAN) {
    for (const dosya of dosyalar(path.join(MOBIL, kok))) {
      const bagil = path.relative(MOBIL, dosya).split(path.sep).join("/");
      if (MUAF.has(bagil)) continue;

      const satirlar = fs.readFileSync(dosya, "utf8").split("\n");
      satirlar.forEach((satir, i) => {
        const k = satir.trim();
        if (k.startsWith("*") || k.startsWith("//") || k.startsWith("/*")) return;

        /* `apiFetch(` / `sharedApiFetch(` buyuk F tasidigi icin bu kalip
         * onlarla eslesmez; yalnizca cipla `fetch(` yakalanir. */
        if (!/\bfetch\s*\(/.test(satir)) return;
        if (!satir.includes("/api/")) return;

        sorunlu.push(`${bagil}:${i + 1}  ${k.slice(0, 90)}`);
      });
    }
  }
  return sorunlu.sort();
}

test("istemci /api/ cagrilarini ham fetch ile yapmamali", (t) => {
  if (!fs.existsSync(MOBIL)) return t.skip("mobil depo yan klasorde yok");

  const sorunlu = hamFetchCagrilari();
  assert.deepEqual(
    sorunlu,
    [],
    "Bu cagrilar paylasilan apiFetch/apiJson kullanmali " +
      "(zaman asimi + yeniden deneme + hata logu):\n" + sorunlu.join("\n")
  );
});

test("muaf liste bayat degil — var olmayan dosya listede kalmasin", (t) => {
  if (!fs.existsSync(MOBIL)) return t.skip("mobil depo yan klasorde yok");

  const yok = [...MUAF].filter((f) => !fs.existsSync(path.join(MOBIL, f)));
  assert.deepEqual(yok, [], "Muaf listesindeki bu dosyalar artik yok:\n" + yok.join("\n"));
});
