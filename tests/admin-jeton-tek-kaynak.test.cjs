"use strict";

/**
 * ADMIN JETONU TEK KAYNAKTAN ÇÖZÜLÜR — üç kopya vardı, ikisi ayrışmıştı.
 *
 * ⚠️ KUSUR: `middleware/requireAdmin.cjs beklenenToken()` ÜÇ env adı kabul
 * ediyor (`SKORLIG_ADMIN_TOKEN`, `ADMIN_TOKEN`, `EXPO_PUBLIC_ADMIN_TOKEN` —
 * son ikisi eski kurulumlar için). Ama `routes/admin-runtime.cjs` ve
 * `routes/pred.cjs` kendi kopyalarını taşıyor ve YALNIZCA ilkini okuyordu.
 *
 * ÖLÇÜLDÜ (yalnızca `ADMIN_TOKEN` tanımlı bir kurulum):
 *     ortak ara katmanı kullanan uçlar : ÇALIŞIYOR
 *     admin-runtime'ın koruduğu 21 uç  : 503 ADMIN_TOKEN_NOT_CONFIGURED
 *     pred.cjs'in 4 kullanımı          : 503
 * Yani admin paneli YARIM çalışıyor ve hata mesajı "jeton yapılandırılmamış"
 * diyerek yanlış yeri gösteriyor — operatör jetonu tanımladığından emin.
 *
 * ⚠️ BU SINIF ZATEN BİR KEZ YAZILMIŞTI: `lib/internal-caller.cjs` içindeki
 * not aynen diyor ki "Ayrı listeler, aynı jetonun bir uçta çalışıp ötekinde
 * 503 vermesi demek — kopyaların sessizce ayrışmasının bu oturumdaki en sık
 * görülen biçimi." Orada düzeltilmiş, geriye iki kopya kalmıştı.
 */

const test = require("node:test");
const describe = require("node:test").describe;
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");

/** Env'i geçici olarak kurup `beklenenToken`'ı temiz yükler. */
function jetonCoz(env) {
  const eski = { ...process.env };
  try {
    for (const k of ["SKORLIG_ADMIN_TOKEN", "ADMIN_TOKEN", "EXPO_PUBLIC_ADMIN_TOKEN"]) delete process.env[k];
    Object.assign(process.env, env);
    const yol = require.resolve(path.join(KOK, "middleware", "requireAdmin.cjs"));
    delete require.cache[yol];
    return require(yol).beklenenToken();
  } finally {
    for (const k of ["SKORLIG_ADMIN_TOKEN", "ADMIN_TOKEN", "EXPO_PUBLIC_ADMIN_TOKEN"]) {
      if (eski[k] === undefined) delete process.env[k];
      else process.env[k] = eski[k];
    }
    const yol = require.resolve(path.join(KOK, "middleware", "requireAdmin.cjs"));
    delete require.cache[yol];
    require(yol);
  }
}

/* ── Ortak çözücü ────────────────────────────────────────────────────────── */

describe("beklenenToken üç adı da kabul ediyor", () => {
  test("SKORLIG_ADMIN_TOKEN", () => {
    assert.equal(jetonCoz({ SKORLIG_ADMIN_TOKEN: "a" }), "a");
  });
  test("ADMIN_TOKEN (eski kurulum)", () => {
    assert.equal(jetonCoz({ ADMIN_TOKEN: "b" }), "b");
  });
  test("EXPO_PUBLIC_ADMIN_TOKEN (eski kurulum)", () => {
    assert.equal(jetonCoz({ EXPO_PUBLIC_ADMIN_TOKEN: "c" }), "c");
  });
  test("hiçbiri yoksa boş", () => {
    assert.equal(jetonCoz({}), "");
  });
  test("SKORLIG_ADMIN_TOKEN önceliklidir", () => {
    assert.equal(jetonCoz({ SKORLIG_ADMIN_TOKEN: "a", ADMIN_TOKEN: "b" }), "a");
  });
});

/* ── Nöbetçi: kopya geri gelmesin ────────────────────────────────────────── */

const yalin = (p) => fs.readFileSync(path.join(KOK, p), "utf8")
  /* ⚠️ SATIR SONLARI ÖNCE NORMALLEŞTIRİLİR — CRLF İKİ NÖBETÇİYİ SESSİZCE
   * KÖRELTMİŞTİ. Depoda .gitattributes yok ve core.autocrlf=true, yani Windows
   * checkout unda her satır CR+LF ile bitiyor. İçinde LF geçen bir kalıp — bir
   * fonksiyon gövdesini yeni satır + kapanış parantezi ile kesmek, ya da iki
   * satırlık bir dizgeyi indexOf ile aramak — o checkout ta HİÇBİR ZAMAN
   * eşleşmiyordu: kod doğru olduğu hâlde iddia düşüyor, ya da daha kötüsü gövde
   * çıkarımı -1 dönüp ölçüm YANLIŞ BÖLGEYE kayıyordu. */
  .replace(/\r\n?/g, "\n")
  .split("\n")
  .map((l) => {
    const t = l.trim();
    return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
  })
  .join("\n");

for (const dosya of ["routes/admin-runtime.cjs", "routes/pred.cjs"]) {
  test(`NÖBETÇİ: ${dosya} kendi jeton listesini YAZMIYOR`, () => {
    const src = yalin(dosya);
    assert.ok(
      !/process\.env\.SKORLIG_ADMIN_TOKEN/.test(src),
      `${dosya} env'i dogrudan okuyor — jeton adi listesi yeniden ayrisir ` +
      `(eski kurulumda 503 ADMIN_TOKEN_NOT_CONFIGURED)`
    );
    assert.ok(
      /beklenenToken/.test(src),
      `${dosya} ortak jeton cozucusunu kullanmiyor`
    );
  });
}

test("NÖBETÇİ: muhafız MANTIĞI değişmedi", () => {
  /* Yalnızca jetonun NEREDEN okunduğu birleştirildi; kabul kuralı (başlık ya
   * da sorgu parametresi) ve hata kodları aynı kalmalı. */
  for (const dosya of ["routes/admin-runtime.cjs", "routes/pred.cjs"]) {
    const src = yalin(dosya);
    assert.ok(/x-admin-token/.test(src), `${dosya}: baslik kontrolu kaybolmus`);
    assert.ok(/ADMIN_TOKEN_NOT_CONFIGURED/.test(src), `${dosya}: 503 kodu kaybolmus`);
    assert.ok(/ADMIN_TOKEN_REQUIRED/.test(src), `${dosya}: 401 kodu kaybolmus`);
  }
});
