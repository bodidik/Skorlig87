"use strict";

/**
 * YAZMA UÇLARI KORUMASIZ KALMASIN.
 *
 * ⚠️ BU TEST BİR DENETİM ARACININ KÖR NOKTASINDAN DOĞDU. Yetki denetimini elle
 * yapan ilk kalıp şuydu:
 *
 *     router\.(post|...)\(\s*"([^"]*)"\s*,\s*([^)]*?)...
 *
 * `[^)]*?` parantez GÖRÜNCE duruyordu, yani `express.json()` gibi çağrı
 * biçiminde bir ara katman varsa satır hiç eşleşmiyordu. Sonuç: denetim
 * "temiz" dedi ve 10 korumasız yazma ucu gizli kaldı. Aralarında
 * `POST /api/rt/admin-live-gs` vardı — kimliksizken maçın skorunu ve "bitti"
 * durumunu yazabiliyordu, yani settle2'nin ödeme yaptığı veriyi. Aynı para
 * zinciri routes/admin-live.cjs'te zaten kapatılmıştı; ikinci dosya
 * kaçırılmıştı.
 *
 * Ders: denetim aracının kendisi de denetlenmeli. Bu test artık o işi yapıyor.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROTA_DIZIN = path.join(__dirname, "..", "routes");

const KORUMA = [
  "verifyToken", "requireAdminToken", "requireAdmin", "optionalToken",
  "isInternalCaller", "rateLimit", "_adminAuth", "ADMIN_TOKEN", "isAdmin",
];

/** Bilerek açık bırakılanlar — her biri gerekçeli. */
const MUAF = {
  "POST /poll": "istemci yoklama ucu; kendi MAX_POLL tavani var (hiz siniri atlama listesinde de boyle)",
  "POST /verify": "1987 davet kodu kullanimi — kullaniciya acik olmali, hiz siniri 5/dk",
  "POST /pred/submit": "verifyToken ile korumali (kalip yakalayamazsa buraya bakma)",
};

describe("yazma uçları yetki kapsamı", () => {
  test("her POST/PUT/PATCH/DELETE ya korumalı ya gerekçeyle muaf", () => {
    // ⚠️ Kalip parantezli ara katmanlari da GEÇEBILMELI: `[\s\S]{0,220}?`
    const rota = /router\.(post|put|patch|delete)\(\s*"([^"]*)"\s*,([\s\S]{0,220}?)(?:async\s*)?\(\s*(?:req|_req)\b/g;
    const acik = [];

    for (const ad of fs.readdirSync(ROTA_DIZIN)) {
      if (!ad.endsWith(".cjs")) continue;
      const src = fs.readFileSync(path.join(ROTA_DIZIN, ad), "utf8");
      // Router genelinde koruma varsa dosyanın tamamı kapsanır.
      if (/router\.use\(\s*(requireAdmin|requireAdminToken|verifyToken|_adminAuth)\b/.test(src)) continue;

      for (const m of src.matchAll(rota)) {
        const [, yontem, yol, ara] = m;
        if (KORUMA.some((k) => ara.includes(k))) continue;
        // Gövde içi muhafız (admin-users / config deseni)
        const govde = src.slice(m.index, m.index + 500);
        if (KORUMA.some((k) => govde.includes(k))) continue;
        const anahtar = `${yontem.toUpperCase()} ${yol}`;
        if (MUAF[anahtar]) continue;
        acik.push(`${ad}: ${anahtar}`);
      }
    }

    assert.deepEqual(
      acik, [],
      "Korumasiz yazma ucu var:\n  " + acik.join("\n  ") +
      "\nAra katman ekle (requireAdmin / verifyToken) ya da bu testteki MUAF'a gerekceyle yaz."
    );
  });

  test("maç durumu yazan uçların ikisi de korumalı (settle bu veriye ödeme yapıyor)", () => {
    const a = fs.readFileSync(path.join(ROTA_DIZIN, "admin-live.cjs"), "utf8");
    const b = fs.readFileSync(path.join(ROTA_DIZIN, "rt.live-gs.cjs"), "utf8");
    assert.ok(/router\.use\(requireAdmin\)/.test(a), "admin-live router korumasi kalkmis");
    assert.ok(/"\/admin-live-gs",\s*requireAdmin/.test(b), "admin-live-gs korumasi kalkmis");
  });
});
