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
const MOBIL = require("./_mobil-dizin.cjs").MOBIL;
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
    /* ⚠️ MUHAFIZ HER ZAMAN ARA KATMAN DEGIL. Ilk surum yalnizca router.METHOD
     * SATIRINA bakiyordu; `/api/rt/settle2` muhafizini govdenin icinde
     * tutuyor (`if (!isInternalCaller(req))`, iki satir asagida) ve bu yuzden
     * admin sayilmiyordu — para dagitan uc denetimin tamamen disinda kalmisti.
     * Artik her rota BLOGU (router.METHOD'dan bir sonrakine kadar) taraniyor. */
    const blokBasi = [];
    for (let i = 0; i < satirlar.length; i++) {
      if (/router\.(get|post|put|patch|delete)\(\s*"([^"]*)"/.test(satirlar[i])) blokBasi.push(i);
    }

    for (let b = 0; b < blokBasi.length; b++) {
      const bas = blokBasi[b];
      const son = b + 1 < blokBasi.length ? blokBasi[b + 1] : satirlar.length;
      const satir = satirlar[bas];
      const govde = satirlar.slice(bas, son).join("\n");

      const m = /router\.(get|post|put|patch|delete)\(\s*"([^"]*)"/.exec(satir);
      if (!m) continue;
      const yol = m[2];
      /* Muhafiz UC bicimde karsimiza cikiyor; ucu de sayilmali:
       *   1) ara katman   -> router.post("/x", requireAdmin, ...)
       *   2) govdede kontrol -> if (!isInternalCaller(req)) ...   (settle2)
       *   3) govdede YEREL fonksiyon -> if (!requireAdminToken(req, res)) return;
       *      (admin-users.cjs kendi kopyasini tanimlayip boyle cagiriyor)
       *
       * ⚠️ 3. BICIMDE OLUMSUZ-ERKEN-DONUS SEKLI ARANIR, salt ad gecisi DEGIL.
       * `/api/pred/list` muhafizi KOSULLU: userId yoksa admin jetonu, varsa
       * verifyToken + kendi kaydi. Bunu `return requireAdminToken(req, res, cb)`
       * sureklilik bicimiyle yaziyor. Salt ada bakan ilk deneme o rotayi
       * "admin" sanip istemcileri (predict sekmesi, mystatus) yanlis suclu
       * ilan etti — oysa ikisi de userId gonderip dogru dalda calisiyor. */
      const adminMi = routerAdmin ||
        /requireAdmin|requireAdminToken|_adminAuth/.test(satir) ||
        /\bisInternalCaller\s*\(|\bisAdminRequest\s*\(/.test(govde) ||
        /if\s*\(\s*!\s*(requireAdminToken|requireAdmin)\s*\(\s*req\b/.test(govde);
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
    const iceAktarilmis =
      /import\s*\{[^}]*\bwithAdminHeaders\b[^}]*\}\s*from\s*["'][^"']*adminToken["']/.test(icerik);

    /* ⚠️ MUAFIYET DOSYA DEGIL CAGRI SEVIYESINDE. Ilk surum "dosya
     * withAdminHeaders ice aktariyor mu" diye bakiyordu; boylece bir dosyadaki
     * TEK dogru cagri, ayni dosyadaki hatali cagrilari da akliyordu.
     * live.tsx tam boyle kacmisti: FT kaydetme cagrisina baslik eklenmis,
     * 15 satir asagidaki settle2 cagrisina eklenmemisti.
     *
     * ⚠️ AMA SALT YAKINLIK DA YANLIS. Bu depoda baskin desen, dosyanin
     * basinda basligi ekleyen bir SARMALAYICI tanimlamak (admin-add,
     * admin-live, admin/index, admin-runtime hep boyle); orada cagri yeri
     * basliktan yuzlerce satir uzakta ve yakinlik olcutu hepsini yanlislikla
     * suclu ilan ediyordu. Dogru soru "baslik yakinda mi" degil, CAGRI HANGI
     * FONKSIYONDAN GECIYOR. */
    const guvenliSarmalayici = new Set();
    const bildirim =
      /(?:async\s+function\s+([A-Za-z0-9_$]+)\s*\(|(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\()/g;
    for (const d of icerik.matchAll(bildirim)) {
      const ad = d[1] || d[2];
      if (!ad) continue;
      // Bildirimden sonraki kisa govde penceresinde baslik ekleniyor mu?
      const govde = icerik.slice(d.index, d.index + 500);
      if (/withAdminHeaders\s*\(/.test(govde)) guvenliSarmalayici.add(ad);
    }

    const PENCERE = 10;
    const yardimciBaslik = [];   // withAdminHeaders(...) — ice aktarim ister
    const elleBaslik = [];       // "x-admin-token": ... — ice aktarim ISTEMEZ
    satirlar.forEach((s, i) => {
      if (/withAdminHeaders\s*\(/.test(s)) yardimciBaslik.push(i);
      /* Elle kurulan baslik da gecerli: me.tsx yasak listesini ham `fetch` ile
       * cagirip `"x-admin-token": tok` yaziyor. Jeton ayni kaynaktan
       * (getAdminToken) geldigi icin yetki acisindan dogru. Bu bicim
       * withAdminHeaders'i ice aktarmadigindan ayri tutulur. */
      if (/["']x-admin-token["']\s*:/.test(s)) elleBaslik.push(i);
    });
    const yakin = (liste, i) => liste.some((b) => Math.abs(b - i) <= PENCERE);

    // Cagri ya guvenli sarmalayicidan gecer, ya da basligi satir icinde verir
    // (stats.tsx'te oldugu gibi birkac satir once degiskene atanmis olabilir).
    const kapsanan = (cagiran, i) =>
      (iceAktarilmis &&
        ((cagiran && guvenliSarmalayici.has(cagiran)) || yakin(yardimciBaslik, i))) ||
      yakin(elleBaslik, i);

    for (let idx = 0; idx < satirlar.length; idx++) {
      const satir = satirlar[idx];
      const kirpik = satir.trim();
      if (kirpik.startsWith("*") || kirpik.startsWith("//") || kirpik.startsWith("/*")) continue;

      /* ⚠️ YOL DIZENIN BASINDA OLMAYABILIR. Ilk surum tirnaktan HEMEN sonra
       * gelen /api/ yolunu ariyordu; me.tsx yasak listesini
       * `fetch(\`${base}/api/admin/banned\`)` diye cagiriyor ve o bicimde yol
       * `${base}` onekinin ardinda kaliyor — cagri denetime hic girmiyordu.
       * Ham `fetch` kullanan her yer bu sekilde gorunmezdi. */
      for (const m of satir.matchAll(/(\/api\/[A-Za-z0-9_\-/.${}[\]]+)/g)) {
        const yol = m[1]
          .replace(/(?<!\/)\$\{[^}]*\}.*$/, "")
          .replace(/\$\{[^}]*\}/g, ":p")
          .split("?")[0]
          .replace(/\/+$/, "");
        if (yol.split("/").length < 3) continue;

        /* Yolu tasiyan cagrinin adi: `apiFetch("/api/...` -> "apiFetch".
         * ⚠️ CAGRI COK SATIRLI OLABILIR: admin-add.tsx'te `apiFetch(` bir
         * satirda, yol bir alt satirda. Yalnizca ayni satira bakmak o cagriyi
         * "sarmalayicisiz" sanip yanlis suclu ilan ediyordu. */
        let cagiran = null;
        const oncesi = satir.slice(0, m.index);
        // Yol artik tirnagin ARDINDAN eslesiyor; acilis tirnagi/backtick ve
        // olasi `${base}` oneki cagiran adiyla yol arasinda kalabiliyor.
        const KUYRUK = /([A-Za-z0-9_$]+)\s*\(\s*["'`]?\s*(?:\$\{[^}]*\})?\s*$/;
        const cg = KUYRUK.exec(oncesi);
        if (cg) cagiran = cg[1];
        else if (/^[\s"'`]*$/.test(oncesi)) {
          for (let g = idx - 1; g >= 0 && g >= idx - 2; g--) {
            const onceki = KUYRUK.exec(satirlar[g].replace(/\s+$/, ""));
            if (onceki) { cagiran = onceki[1]; break; }
            if (satirlar[g].trim()) break;
          }
        }

        if (adminYollarSet.has(yol) && !kapsanan(cagiran, idx)) {
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
