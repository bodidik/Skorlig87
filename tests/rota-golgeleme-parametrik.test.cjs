"use strict";

/**
 * PARAMETRİK ROTA, KARDEŞ ROTAYI GÖLGELEMEZ.
 *
 * series.cjs SİLİNDİ (üç bozukluğu vardı ve sıfır mobil çağıranı kalmıştı).
 * Bu dosya iki şeyi korur:
 *   1) weekly-picks/leaderboard ucunun çalıştığını (regresyon testi)
 *   2) /api köküne parametrik ilk segmentle rota bağlanmadığını (nöbetçi)
 */

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const nodePath = require("path");

let server = null, taban = "";

before(async () => {
  const express = require("express");
  const app = express();
  app.locals.db = null;
  app.use(express.json());

  app.use("/api/weekly-picks", require("../routes/weekly-picks.cjs"));

  await new Promise((r) => { server = app.listen(0, r); });
  taban = `http://127.0.0.1:${server.address().port}`;
});

after(() => { if (server) server.close(); });

const al = (yol) => fetch(`${taban}${yol}`).then(async (r) => ({
  durum: r.status,
  govde: await r.json().catch(() => null),
}));

/* ── weekly-picks regresyon ──────────────────────────────────────────────── */

describe("weekly-picks/leaderboard calisiyor", () => {
  test("yanit weekly-picks uygulamasindan geliyor", async () => {
    const { govde } = await al("/api/weekly-picks/leaderboard?limit=50");
    assert.ok(govde, "yanit govdesi yok");
    assert.ok(
      "items" in govde,
      `yanitta items yok: ${JSON.stringify(govde)}`
    );
  });

  test("mobilin okudugu alanlar mevcut (items / total1987)", async () => {
    const { govde } = await al("/api/weekly-picks/leaderboard?limit=50&userId=biri");
    assert.equal(govde.ok, true);
    assert.ok(Array.isArray(govde.items), `items dizi degil: ${JSON.stringify(govde)}`);
    assert.ok(
      "total1987" in govde || govde.count === 0,
      `total1987 yok ve count sifir degil: ${JSON.stringify(govde)}`
    );
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: /api köküne PARAMETRİK ilk segmentle rota bağlanmıyor", () => {
  const srv = fs.readFileSync(
    nodePath.join(__dirname, "..", "server.cjs"), "utf8"
  );

  const kokeBaglilar = [];
  for (const m of srv.matchAll(
    /app\.use\(\s*"\/api"\s*,\s*require\(\s*"\.\/routes\/([\w.-]+)"\s*\)/g
  )) {
    kokeBaglilar.push(m[1]);
  }
  assert.ok(
    kokeBaglilar.length > 0,
    "/api kokune bagli hic router bulunamadi — tarama bozuk (server.cjs bicimi degisti mi?)"
  );

  const suclu = [];
  for (const dosya of kokeBaglilar) {
    const yol = nodePath.join(__dirname, "..", "routes", dosya);
    if (!fs.existsSync(yol)) continue;
    const src = fs.readFileSync(yol, "utf8");
    const kod = src.split("\n")
      .map((l) => {
        const t = l.trim();
        return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
      })
      .join("\n");

    for (const m of kod.matchAll(
      /router\.(get|post|put|patch|delete)\(\s*"(\/[^"]*)"/g
    )) {
      const yolDeseni = m[2];
      const ilkSegment = yolDeseni.split("/")[1] || "";
      if (ilkSegment.startsWith(":")) {
        suclu.push(`${dosya}: ${m[1].toUpperCase()} ${yolDeseni}`);
      }
    }
  }

  assert.deepEqual(
    suclu, [],
    "/api kokune bagli router(lar) PARAMETRIK ilk segmentle rota tanimliyor.\n" +
    "Bu, /api altindaki her kardes rotayi mount sirasina gore sessizce\n" +
    "golgeler (weekly-picks/leaderboard tam olarak boyle olmustu).\n" +
    "Cozum: router'i kendi onekine bagla (ornegin /api/series).\n" +
    suclu.join("\n")
  );
});
