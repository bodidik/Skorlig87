"use strict";
/**
 * KİMLİKSİZ ERİŞİLEBİLEN UÇ TARAMASI — ELLE ÇALIŞTIRILIR.
 *
 *     node scripts/acik-uc-taramasi.cjs
 *
 * ⚠️ NEDEN TEST DEĞİL: 215 ucu dövmek birkaç dakika sürüyor ve `npm test`i
 * kilitliyordu (iki denemede de zaman aşımı). Paralelleştirmek yetmedi —
 * bazı uçlar dış ağ çağrısı yapıyor. Süite ağır bir test göndermek yerine
 * araç olarak duruyor; yeni uç eklendiğinde elle çalıştır.
 *
 * ⚠️ ÖNEKLER server.cjs'TEN OKUNUYOR. İlk denememde uydurma önek kullandım
 * (pool'u /api altına mount ettim); havuzun `/:fixtureId` rotası `/diag`ı
 * yuttu ve `groups/diag` KORUMASIZ göründü — oysa doğru şekilde 401 dönüyor.
 * Önek uydurulursa sonuç uydurma olur.
 *
 * SON TARAMA (2026-08-02): 215 uç, 40 tanesi kimliksiz 200. Biri hariç hepsi
 * meşru (sıralama, fikstür, mağaza, ping). İstisna DÜZELTİLDİ:
 * GET /api/friends/list/:userId ve /board/:userId tüm sosyal grafiği
 * herkese açıyordu — bkz. tests/arkadas-listesi-sizintisi.test.cjs
 */
const fs = require("fs"), os = require("os"), path = require("path");
const KOK = path.join(__dirname, "..");
process.env.SKORLIG_ADMIN_TOKEN = process.env.SKORLIG_ADMIN_TOKEN || "tarama";
process.env.SKORLIG_BG = "0";
process.env.SKORLIG_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tarama-"));

(async () => {
  const express = require("express");
  const src = fs.readFileSync(path.join(KOK, "server.cjs"), "utf8");
  const mount = [...src.matchAll(/app\.use\("(\/api[a-zA-Z\/-]*)",\s*require\("\.\/routes\/([a-z0-9-]+)\.cjs"\)/g)]
    .map((m) => [m[1], m[2]]);
  if (mount.length < 20) { console.error("mount bicimi degismis, tarama bozuk"); process.exit(1); }

  const app = express();
  app.use(express.json());
  app.use((q, _r, n) => { q.app.locals.db = null; n(); });
  const yollar = [];
  for (const [pre, f] of mount) {
    const p = path.join(KOK, "routes", `${f}.cjs`);
    if (!fs.existsSync(p)) continue;
    try {
      const r = require(p); app.use(pre, r);
      const gez = (k, acc = []) => {
        for (const l of (k.stack || [])) {
          if (l.route) for (const m of Object.keys(l.route.methods)) acc.push([m.toUpperCase(), pre + l.route.path, f]);
          else if (l.handle && l.handle.stack) gez(l.handle, acc);
        } return acc;
      };
      yollar.push(...gez(r));
    } catch (e) { console.warn("yuklenemedi:", f, e.message.slice(0, 60)); }
  }
  const srv = app.listen(0); const port = srv.address().port;
  const at = async (m, y) => {
    try {
      const r = await fetch(`http://127.0.0.1:${port}${y.replace(/:[a-zA-Z]+/g, "x")}`,
        { method: m, headers: { "Content-Type": "application/json" },
          body: m === "GET" ? undefined : "{}", signal: AbortSignal.timeout(2500) });
      return r.status;
    } catch { return 0; }
  };

  // ⚠️ SONDA KONTROLU: bu olmadan "hepsi kapali" sonucu hicbir sey kanitlamaz.
  const k = await at("POST", "/api/pool/X/bet");
  console.log(`sonda kontrolu (POST /api/pool/X/bet, 401 olmali): ${k}`);
  if (k !== 401) { console.error("SONDA YANLIS YERI DOVUYOR — sonuclar gecersiz"); srv.close(); process.exit(1); }

  console.log(`taranan uc: ${yollar.length}\n=== KIMLIKSIZ 200 DONEN ===`);
  const acik = [];
  const sira = [...yollar];
  await Promise.all(Array.from({ length: 12 }, async () => {
    for (;;) {
      const is = sira.shift(); if (!is) return;
      if (await at(is[0], is[1]) === 200) acik.push(`${is[0]} ${is[1]}`.padEnd(44) + `[${is[2]}]`);
    }
  }));
  acik.sort(); console.log(acik.join("\n"));
  console.log(`\ntoplam acik: ${acik.length}`);
  srv.close(); process.exit(0);
})();
