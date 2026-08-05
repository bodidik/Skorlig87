"use strict";

/**
 * BAĞIMLILIKLAR DÜZ ADLA İSTENİR, `node_modules` YOLU ELLE KURULMAZ.
 *
 * ⚠️ NEDEN VAR: 11 test dosyası bağımlılıklarını şöyle istiyordu —
 *
 *     const express = require(path.join(KOK, "node_modules", "express"));
 *
 * `KOK` deponun kökü (`__dirname/..`). Normal bir checkout'ta orada
 * `node_modules` vardır ve bu çalışır. GIT WORKTREE'de YOKTUR: `node_modules`
 * `.gitignore`'da olduğu için yalnızca ana checkout'ta bulunur, worktree
 * dizini onu içermez. Düz `require("express")` çalışırdı, çünkü Node modül
 * çözümlemesi dizinleri YUKARI DOĞRU tarar ve ana checkout'taki kopyayı bulur.
 *
 * ÖLÇÜLDÜ (2026-08-05, bir worktree'de): `npm test` 74 hata verdi.
 *     69'u bu 11 dosya — `MODULE_NOT_FOUND` ile `before`/`kur` düşüyor,
 *          ardından o dosyadaki her test ardışık olarak kırılıyor
 *      5'i gerçek
 * Aynı ağaç ana checkout'ta 5 hata veriyordu. Yani süitin %93'ü kurulum
 * gürültüsüydü.
 *
 * ⚠️ BEDELİ SADECE GÜRÜLTÜ DEĞİL: o gürültünün içinde GERÇEK bir kırık test
 * saklanıyordu. `kimlik-sinifi-nobeti` `GET /api/mini/board`un doğrulanmamış
 * kimlikle arkadaş listesi döndürdüğünü yakalamıştı ve günlerce kırmızı
 * kaldı — 74 hatanın arasında kimse ayırt edemedi. Kırık bir süit, çalışan
 * nöbetçileri de görünmez kılıyor.
 *
 * KURAL: `require`/`require.resolve` çağrısında `node_modules` geçmesin.
 * Depo İÇİ dosyalar için `path.join(KOK, "routes", ...)` meşru ve yaygın —
 * onlar worktree'de de var, kural yalnızca `node_modules`a bakıyor.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");

/**
 * `require(...)` ya da `require.resolve(...)` çağrısı içinde `node_modules`.
 *
 * Dizin gezme süzgeçleri (`if (ad.name === "node_modules") continue`) bu
 * kalıba UYMAZ — onlar meşru ve birkaç testte var.
 */
const ELLE_YOL = /require(?:\.resolve)?\([^)]*node_modules/;

/**
 * ⚠️ BU DOSYANIN KENDİSİ TARANMIYOR — tek muafiyet ve gerekçesi dar.
 *
 * Aşağıdaki "tarama gerçekten çalışıyor" testi kalıbı BİLİNEN bir örnek
 * üzerinde sınıyor ve o örnek doğal olarak kalıba uyuyor. Kendini taramak,
 * nöbetçinin kendi kanıtını ihlal saymasıydı. Burada gerçek bir `require`
 * yok; muafiyet dosya adına bağlı, desene değil.
 */
const KENDI = path.basename(__filename);

function taranacakDosyalar() {
  const out = [];
  for (const dir of ["tests", "scripts"]) {
    const d = path.join(KOK, dir);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      if (f === KENDI) continue;
      if (f.endsWith(".cjs") || f.endsWith(".js")) out.push(`${dir}/${f}`);
    }
  }
  return out;
}

/** Yorum satırları elenir: bu dosyanın kendi başlığı örneği içeriyor. */
function kodOku(rel) {
  return fs.readFileSync(path.join(KOK, rel), "utf8")
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");
}

test("hiçbir test node_modules yolunu elle kurmuyor", () => {
  const bulgular = [];

  for (const rel of taranacakDosyalar()) {
    const satirlar = kodOku(rel).split("\n");
    satirlar.forEach((satir, i) => {
      if (ELLE_YOL.test(satir)) bulgular.push(`${rel}:${i + 1}`);
    });
  }

  assert.deepEqual(
    bulgular, [],
    `su dosyalar bagimliligi node_modules yolunu elle kurarak istiyor:\n` +
    `  ${bulgular.join("\n  ")}\n` +
    `Git worktree'de depo kokunde node_modules YOKTUR (.gitignore'da) ve bu\n` +
    `cagrilar MODULE_NOT_FOUND ile duser; dosyadaki TUM testler ardisik kirilir.\n` +
    `Duz require("express") kullan — Node dizinleri yukari tarar ve ana\n` +
    `checkout'taki kopyayi bulur.`
  );
});

test("NÖBETÇİ tarama gerçekten çalışıyor", () => {
  /**
   * ⚠️ Boş sonuç kanıt değil. Kalıp bir gün kırılırsa (ör. `require` yazımı
   * değişirse) bu nöbetçi sessizce yeşil kalır ve desen geri gelir. Kalıbı
   * bilinen bir örnek üzerinde sınıyoruz.
   */
  assert.ok(
    ELLE_YOL.test('const express = require(path.join(KOK, "node_modules", "express"));'),
    "kalip bilinen elle-yol ornegini yakalamiyor — nobetci korelmis"
  );
  assert.ok(
    !ELLE_YOL.test('if (ad.name === "node_modules" || ad.name.startsWith(".")) continue;'),
    "kalip dizin gezme suzgecini yanlislikla yakaliyor — mesru kullanim"
  );
  assert.ok(
    !ELLE_YOL.test('app.use("/api/mini", require(path.join(KOK, "routes", "mini.cjs")));'),
    "kalip depo ici dosya cagrisini yakaliyor — onlar worktree'de de var"
  );
});
