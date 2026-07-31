"use strict";

/**
 * SAHİPLİK DENETİMİ TESTLERİ.
 *
 * ⚠️ ASIL DEĞER NÖBETÇİDE. Cüzdan uçlarında YAZMALARIN hepsinde `verifyToken`
 * vardı, OKUMALARIN hiçbirinde yoktu — yani `?userId=` gönderen herkes
 * başkasının bakiyesini, harcama toplamını ve TÜM işlem geçmişini okuyabiliyordu.
 * Kimlikler sıralama tablolarında zaten görünür.
 *
 * Aynı biçim "benim/bana ait" adlı uçlarda da vardı: ad "benim" diyor ama
 * kimlik sorgudan geliyordu (`/pool/:id/my`, `/duels/my`, `/mini/mine`, ...).
 *
 * Birim testler mantığı kilitler; nöbetçi ise korumanın YENİ bir uçta
 * unutulmasını yakalar — asıl tekrar eden hata buydu.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const { kendiKaydiMi, adminMi } = require("../lib/kimlik-kontrol.cjs");

const istek = (uid, basliklar = {}) => ({ uid, headers: basliklar });

/* ── Birim ──────────────────────────────────────────────────────────────── */

test("kimliksiz istek 401", () => {
  const s = kendiKaydiMi(istek(""), "ali");
  assert.deepStrictEqual(s, { ok: false, kod: 401, hata: "AUTH_REQUIRED" });
});

test("kendi kaydı geçer", () => {
  assert.deepStrictEqual(kendiKaydiMi(istek("ali"), "ali"), { ok: true, uid: "ali" });
});

test("büyük/küçük harf farkı engel değil", () => {
  assert.strictEqual(kendiKaydiMi(istek("Ali"), "ALI").ok, true);
});

test("başkasının kaydı 403", () => {
  const s = kendiKaydiMi(istek("ali"), "veli");
  assert.deepStrictEqual(s, { ok: false, kod: 403, hata: "FORBIDDEN_OTHER_USER" });
});

test("userId gönderilmezse kendi kaydı kastedilir", () => {
  assert.deepStrictEqual(kendiKaydiMi(istek("ali"), undefined), { ok: true, uid: "ali" });
  assert.deepStrictEqual(kendiKaydiMi(istek("ali"), ""), { ok: true, uid: "ali" });
});

test("nesne enjeksiyonu kimlik yerine geçmez", () => {
  // Express `?userId[$ne]=1` sorgusunu NESNEYE çevirir. String'e zorlanmasa
  // Mongo süzgecine operatör olarak girebilirdi.
  const s = kendiKaydiMi(istek("ali"), { $ne: null });
  assert.strictEqual(s.ok, false);
  assert.strictEqual(s.hata, "FORBIDDEN_OTHER_USER");
});

test("admin jetonu yapılandırılmamışsa admin YOK (fail-closed)", () => {
  const eski = process.env.SKORLIG_ADMIN_TOKEN;
  const eskiA = process.env.ADMIN_TOKEN;
  const eskiE = process.env.EXPO_PUBLIC_ADMIN_TOKEN;
  delete process.env.SKORLIG_ADMIN_TOKEN;
  delete process.env.ADMIN_TOKEN;
  delete process.env.EXPO_PUBLIC_ADMIN_TOKEN;
  try {
    assert.strictEqual(adminMi({ headers: { "x-admin-token": "her-ne-ise" } }), false);
    assert.strictEqual(kendiKaydiMi(
      { uid: "ali", headers: { "x-admin-token": "her-ne-ise" } }, "veli").ok, false);
  } finally {
    if (eski !== undefined) process.env.SKORLIG_ADMIN_TOKEN = eski;
    if (eskiA !== undefined) process.env.ADMIN_TOKEN = eskiA;
    if (eskiE !== undefined) process.env.EXPO_PUBLIC_ADMIN_TOKEN = eskiE;
  }
});

test("doğru admin jetonu başkasını okuyabilir", () => {
  const eski = process.env.SKORLIG_ADMIN_TOKEN;
  process.env.SKORLIG_ADMIN_TOKEN = "test-jeton-degeri";
  try {
    const s = kendiKaydiMi(
      { uid: "ali", headers: { "x-admin-token": "test-jeton-degeri" } }, "veli");
    assert.deepStrictEqual(s, { ok: true, uid: "veli" });
  } finally {
    if (eski === undefined) delete process.env.SKORLIG_ADMIN_TOKEN;
    else process.env.SKORLIG_ADMIN_TOKEN = eski;
  }
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

/**
 * Adı "kendine ait" olduğunu söyleyen uçlar kimliği SORGUDAN almamalı.
 *
 * Liste bilinçli olarak dar: `/leaderboard`, `/totals` gibi uçlar başkasının
 * verisini göstermek için VAR. Buradaki isimler ise sahiplik iddia ediyor —
 * o yüzden `verifyToken` + sahiplik denetimi şart.
 */
test("NÖBETÇİ: 'benim' anlamına gelen uçlar kimliği sorgudan almamalı", () => {
  const rotaDizin = path.join(__dirname, "..", "routes");
  const sahiplikAdi = /router\.get\(\s*"([^"]*\/(my|mine|me)|\/my|\/mine|\/me)"/;

  const kusurlu = [];
  for (const dosya of fs.readdirSync(rotaDizin)) {
    if (!dosya.endsWith(".cjs")) continue;
    const satirlar = fs.readFileSync(path.join(rotaDizin, dosya), "utf8").split("\n");
    satirlar.forEach((satir, i) => {
      const m = sahiplikAdi.exec(satir);
      if (!m) return;
      const govde = satirlar.slice(i, i + 25).join("\n");
      if (!govde.includes("req.query.userId")) return;      // kimliği zaten jetondan alıyor
      if (govde.includes("kimlikVeyaHata")) return;          // denetimden geçiyor
      kusurlu.push(`${dosya}:${i + 1} → ${m[1]}`);
    });
  }

  assert.deepStrictEqual(
    kusurlu,
    [],
    "Bu uçlar 'benim' diyor ama kimliği sorgudan alıyor — kimlikVeyaHata() kullan:\n" +
      kusurlu.join("\n")
  );
});

/** Cüzdan okumaları kimlik doğrulamasından geçmeli. */
test("NÖBETÇİ: cüzdan uçlarının hepsi verifyToken ister", () => {
  const dosya = path.join(__dirname, "..", "routes", "lc-wallet.cjs");
  const kusurlu = [];
  fs.readFileSync(dosya, "utf8").split("\n").forEach((satir, i) => {
    const m = /router\.(get|post)\(\s*"([^"]+)"/.exec(satir);
    if (!m) return;
    // /store fiyat listesi — kullanıcıya özel veri yok, herkese açık kalabilir.
    if (m[2] === "/lc-wallet/store") return;
    if (satir.includes("verifyToken")) return;
    kusurlu.push(`${m[1].toUpperCase()} ${m[2]} (satır ${i + 1})`);
  });
  assert.deepStrictEqual(kusurlu, [], "Kimlik doğrulaması eksik cüzdan ucu:\n" + kusurlu.join("\n"));
});
