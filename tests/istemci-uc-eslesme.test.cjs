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
/**
 * ⚠️ WORKTREE'DE `../mobile` YOK — NÖBETÇİ SESSİZCE ATLIYORDU.
 *
 * Bu depo `.claude/worktrees/*` altında çalışıyor; oradan `KOK/../mobile`
 * `.claude/worktrees/mobile`e çıkıyor ve klasör bulunamayınca aşağıdaki
 * testlerin HEPSİ `t.skip` ile yeşil geçiyor. Yani worktree'de çalışan
 * herkes için bu dosya hiçbir şey denetlemiyordu — "atlandı" ile "geçti"
 * arasındaki farkı kimse okumaz.
 *
 * Bu, bu dosyanın başında anlatılan hatanın ta kendisi: yalan söyleyen bir
 * nöbetçi, olmayan nöbetçiden kötüdür. Override ile worktree'den de
 * çalıştırılabiliyor.
 */
const MOBIL = require("./_mobil-dizin.cjs").MOBIL;

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

/* ── Sunucunun ÜRETTİĞİ yanıt anahtarları ────────────────────────────────── */

/** İşaretler: şekil koddan güvenle okunamadı → o rota için iddia atlanır. */
const SPREAD = "*SPREAD*";   // `...bir sey` — bilinmeyen alanlar eklenmiş
const OPAK   = "*OPAK*";     // `.json(degisken)` — literal yok

/** `app.use` montajları (önek, rota dosyası). */
function montajlar() {
  const src = fs.readFileSync(path.join(KOK, "server.cjs"), "utf8");
  const out = [];
  for (const m of src.matchAll(
    /app\.use\(\s*"([^"]+)"\s*,\s*require\(\s*"\.\/routes\/([^"]+)"\s*\)/g
  )) out.push([m[1], m[2]]);
  const dv = new Map();
  for (const m of src.matchAll(
    /(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*require\(\s*"\.\/routes\/([^"]+)"\s*\)/g
  )) dv.set(m[1], m[2]);
  for (const m of src.matchAll(/app\.use\(\s*"([^"]+)"\s*,\s*([A-Za-z0-9_$]+)\s*\)/g)) {
    if (dv.has(m[2])) out.push([m[1], dv.get(m[2])]);
  }
  return out;
}

/**
 * Her rota için `res.json({...})` literallerindeki anahtarlar.
 *
 * ⚠️ İÇ İÇE ANAHTARLAR DA TOPLANIYOR (bilerek). Yalnızca üst seviyeyi almak
 * daha keskin olurdu ama bu nöbetçinin işi "bu ad yanıtta HİÇ geçmiyor"
 * demek; fazladan ad toplamak testi HOŞGÖRÜLÜ yapar, yanlış alarm üretmez.
 * Tersi — sıkı olup yanlış alarm üretmek — nöbetçiyi kapattırır.
 */
function sunucuAnahtarlari() {
  const harita = new Map();
  for (const [onek, dosya] of montajlar()) {
    const tam = path.join(KOK, "routes", dosya);
    if (!fs.existsSync(tam)) continue;
    const satirlar = fs.readFileSync(tam, "utf8").split("\n");
    let yol = null, govde = [];

    const bitir = () => {
      if (!yol) return;
      /* ⚠️ YORUMLAR ÖNCE SİLİNMELİ. Silmeden önce `packages:` ve
       * `outcomeMult:` gibi anahtarlar KAÇIRILIYORDU: bir önceki satır
       * `mode: STORE_MODE, // "mock"` ile bitince virgül tabanlı tarama
       * sonraki anahtara ulaşamıyor ve sahte bulgu üretiyordu. */
      const metin = govde.join("\n")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");

      const set = harita.get(yol) || new Set();
      if (/\.json\(\s*[A-Za-z_$]/.test(metin)) set.add(OPAK);

      for (const m of metin.matchAll(/\.json\(\s*\{/g)) {
        let i = m.index + m[0].length - 1, d = 0, j = i;
        for (; j < metin.length; j++) {
          if (metin[j] === "{") d++;
          else if (metin[j] === "}") { d--; if (d === 0) break; }
        }
        const govdeMetin = metin.slice(i + 1, j);
        for (const km of govdeMetin.matchAll(/(?:^|[,{])\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*:/g)) set.add(km[1]);
        /* `|$` ŞART: literalin İÇİ kesiliyor, son kısayol anahtarından sonra
         * kapanış `}` yok. Eksikken `{ ok, kendisi, profile }` içindeki
         * `profile` düşüyor ve altı sahte bulgu çıkıyordu. */
        for (const km of govdeMetin.matchAll(/(?:^|[,{])\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*(?=[,}]|$)/g)) set.add(km[1]);
        for (const km of govdeMetin.matchAll(/^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*[:,]/gm)) set.add(km[1]);
        if (/\.\.\./.test(govdeMetin)) set.add(SPREAD);
      }
      harita.set(yol, set);
    };

    for (const satir of satirlar) {
      const m = /^router\.(get|post|put|patch|delete)\(\s*"([^"]+)"/.exec(satir);
      if (m) {
        bitir();
        yol = (onek.replace(/\/+$/, "") + "/" + m[2].replace(/^\/+/, "")).replace(/\/{2,}/g, "/");
        govde = [];
      } else if (yol) govde.push(satir);
    }
    bitir();
  }
  return harita;
}

/* ── İstemcinin OKUDUĞU yanıt alanları ───────────────────────────────────── */

/**
 * `fetch` Response üyeleri — yanıt GÖVDESİNİN alanı DEĞİL.
 * `const r = await apiFetch("/api/x")` sonrası `r.json()` görülüyor; bunları
 * gövde alanı saymak tek başına ~70 sahte bulgu üretmişti.
 */
const RESPONSE_UYELERI = new Set([
  "json", "text", "status", "ok", "headers", "body", "blob", "arrayBuffer",
  "statusText", "url", "redirected", "type", "clone", "formData",
]);

const PENCERE = 25;

function istemciOkumalari() {
  const bulunan = [];
  for (const dosya of dosyalar(MOBIL)) {
    const satirlar = fs.readFileSync(dosya, "utf8").split("\n");
    satirlar.forEach((satir, i) => {
      const k0 = satir.trim();
      if (k0.startsWith("*") || k0.startsWith("//") || k0.startsWith("/*")) return;

      const cm = /(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=]+)?=\s*await\s+[^;]*?["`](\/api\/[A-Za-z0-9_\-/.${}[\]]+)/.exec(satir);
      if (!cm) return;

      const degisken = cm[1];
      const yol = cm[2]
        .replace(/(?<!\/)\$\{[^}]*\}.*$/, "")
        .replace(/\$\{[^}]*\}/g, ":p")
        .split("?")[0]
        .replace(/\/+$/, "");
      if (yol.split("/").length < 3) return;
      /* Kapanmamış `${...}`: karakter sınıfı `(` görünce duruyor, yani
       * `/api/friends/board/${encodeURIComponent` gibi YARIM yollar çıkıyor.
       * Yol güvenilir değilse anahtar iddiası da güvenilir değil. */
      if (/[${}]/.test(yol)) return;

      const re = new RegExp("\\b" + degisken + "\\??\\.([A-Za-z_$][A-Za-z0-9_$]*)", "g");
      const yenidenAta = new RegExp(
        "(?:const|let|var)\\s+" + degisken + "\\b|\\b" + degisken + "\\s*=[^=]"
      );

      for (let k = i; k < Math.min(satirlar.length, i + PENCERE); k++) {
        const s = satirlar[k].trim();
        if (s.startsWith("*") || s.startsWith("//") || s.startsWith("/*")) continue;
        /* ⚠️ PENCERE BİR SONRAKİ ÇAĞRIYA TAŞMAMALI. `j` aynı dosyada
         * defalarca yeniden bağlanıyor; taşma me.tsx'te tek başına onlarca
         * sahte bulgu üretti (bir çağrının alanları ötekine yazıldı). */
        if (k > i && (/["`]\/api\//.test(satirlar[k]) || yenidenAta.test(satirlar[k]))) break;
        for (const m of satirlar[k].matchAll(re)) {
          if (RESPONSE_UYELERI.has(m[1])) continue;
          bulunan.push({
            yol, anahtar: m[1],
            dosya: path.relative(MOBIL, dosya), satirNo: k + 1,
          });
        }
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
  /* "/api/skorlig/next" ve "/api/users/get" ÇIKARILDI — 2026-08-08.
   * predict.tsx artık /api/team/fixtures kullanıyor (sıradaki maç seçimi
   * istemcide); profildeki ölü yedek çağrı söküldü. İkisi de mobil depoda
   * c0d0e85 ile düzeltildi. */
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

/**
 * YANIT ŞEKLİ — yolun var olması YETMİYOR.
 *
 * ⚠️ İKİNCİ SINIF, BU OTURUMDA BEŞ KEZ: doğru yol, YANLIŞ ŞEKİL. İstemci ucun
 * hiç üretmediği bir alanı okuyor; `ok` true olduğu için hata yolu hiç
 * çalışmıyor ve ekran SESSİZCE boş ya da yanlış çiziyor:
 *
 *   /api/weekly-picks/leaderboard · /api/rt/competition-totals ·
 *   /api/rt/board2 · /api/stats/user · /api/pred/match-board
 *
 * Sonuncusu en kötüsü: yönetici bildirimi BAŞARI deyip satır sayısını hep 0
 * raporluyordu — boş ekran değil, YANLIŞ GÜVENCE.
 *
 * Yukarıdaki testler yalnızca YOLU karşılaştırıyor; beşi de o denetimden temiz
 * geçti. Bu test eksik olan yarıyı koyuyor.
 *
 * ⚠️ KAPSAM ~%70 — ABARTMIYORUM. Tarayıcı yalnızca tek satırda
 * `const j = await ...("/api/...")` biçiminde BAĞLANAN çağrıları izleyebiliyor
 * (164 çağrı satırının 115'i). `Promise.allSettled([...])` ile toplu yapılan
 * çağrılar KAPSAM DIŞI — nitekim `stats/user` hatası tam o biçimdeydi ve bu
 * nöbetçi onu YAKALAYAMAZDI. Ekran bazlı sözleşme testleri
 * (`stats-me-ekran-sozlesmesi`, `board2-veri-sozlesmesi`,
 * `match-board-yonetici-bildirimi`) bu yüzden GEREKLİ; bu test onların yerine
 * geçmez, yeni ekranlarda ucuz bir ilk savunma hattı kurar.
 */
test("istemci, ucun ÜRETMEDİĞİ bir yanıt alanını okuyamaz", (t) => {
  if (!fs.existsSync(MOBIL)) return t.skip("mobil depo yan klasorde yok");

  const sunucu = sunucuAnahtarlari();
  assert.ok(sunucu.size > 100, `sunucu anahtar taramasi bozuk (${sunucu.size})`);

  const okumalar = istemciOkumalari();
  assert.ok(okumalar.length > 50, `istemci alan taramasi bozuk (${okumalar.length})`);

  const eslesenRota = (cy) => {
    const cp = cy.split("/").filter(Boolean);
    for (const sy of sunucu.keys()) {
      const sp = sy.split("/").filter(Boolean);
      if (sp.length !== cp.length) continue;
      if (sp.every((s, i) => s.startsWith(":") || cp[i] === ":p" || s === cp[i])) return sy;
    }
    return null;
  };

  const sorunlu = new Set();
  for (const o of okumalar) {
    const sy = eslesenRota(o.yol);
    if (!sy) continue;                                       // yol: üstteki testin işi
    const set = sunucu.get(sy);
    if (!set || set.has(SPREAD) || set.has(OPAK)) continue;   // şekil okunamadı
    if (set.has(o.anahtar)) continue;
    sorunlu.add(`${o.yol}  .${o.anahtar}  <- ${o.dosya}:${o.satirNo}`);
  }

  assert.deepStrictEqual(
    [...sorunlu].sort(), [],
    "Bu istemci okumalarinin sunucu yanitinda KARSILIGI YOK. Yol dogru, sekil\n" +
      "yanlis: `ok` true doner, hata yolu hic calismaz, ekran sessizce bos ya da\n" +
      "YANLIS sayi gosterir:\n" + [...sorunlu].sort().join("\n")
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
