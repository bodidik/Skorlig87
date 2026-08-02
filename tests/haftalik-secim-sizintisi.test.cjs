"use strict";

/**
 * BAŞKASININ AÇIK TAHMİNİ SIZMASIN — rekabet bütünlüğü.
 *
 * ⚠️ KUSUR: `GET /api/weekly-picks` `?userId=` parametresine güvenip O
 * KULLANICININ tahminlerini yanıta koyuyordu; hiçbir kimlik denetimi yoktu.
 *
 * DENETİMLİ OLARAK ÜRETİLDİ (kickoff'a 3 saat, maç `open: true`):
 *     KURBAN kendi sorgusu  → {"outcome":"H","firstGoal":"H",...}
 *     SALDIRGAN kimliğiyle  → AYNI cevap
 *     KİMLİKSİZ istek       → AYNI cevap
 * Kullanıcı kimlikleri sıralama tablosunda zaten görünür; yani herkes
 * rakibinin HENÜZ OYNANMAMIŞ maçtaki tahminini okuyup ona göre oynayabilirdi.
 *
 * ⚠️ LİSTE KAPATILMADI, YALNIZCA TAHMİN. Maç listesi misafire de açık
 * kalmalı; gizli olan KİMİN NE OYNADIĞI. Bu yüzden `verifyToken` değil
 * `optionalToken` kullanılıyor.
 *
 * ⚠️ İSTEMCİ DE DEĞİŞTİ: `Picks1987.tsx` ve `BigFourPicks.tsx` ham `fetch`
 * kullanıyordu, yani jeton göndermiyordu. Sunucu kilitlendikten sonra
 * kullanıcı KENDİ tahminini de göremezdi; ikisi `apiFetch`e geçirildi.
 *
 * `lib/kimlik-kontrol.cjs` aynı dersi anlatıyor ve on rotada kullanılıyor —
 * burada eksikti. Notu: "Yazmalar bir kez güvenceye alınmış, okumalara
 * dönülmemiş."
 */

const test = require("node:test");
const describe = require("node:test").describe;
const assert = require("node:assert/strict");
const os = require("os");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "skorlig-wpsizinti-"));
fs.mkdirSync(path.join(TMP, "live"), { recursive: true });
process.env.SKORLIG_DATA_DIR = TMP;
process.env.SKORLIG_BG = "0";

const vt = require.resolve(path.join(KOK, "middleware", "verifyToken.cjs"));
require.cache[vt] = { id: vt, filename: vt, loaded: true, exports: {
  verifyToken: (q, _r, n) => { q.uid = q.headers["x-user-id"]; n(); },
  optionalToken: (q, _r, n) => { q.uid = q.headers["x-user-id"] || null; n(); },
  getFirebaseAuth: () => null, kimlikModu: () => "test",
}};

describe("açık tahmin sızıntısı", () => {
  let mongod, cli, db, srv, port;

  test("kur", async () => {
    const { MongoMemoryServer } = require(path.join(KOK, "node_modules", "mongodb-memory-server"));
    const { MongoClient } = require(path.join(KOK, "node_modules", "mongodb"));
    const express = require(path.join(KOK, "node_modules", "express"));
    mongod = await MongoMemoryServer.create();
    cli = await MongoClient.connect(mongod.getUri());
    db = cli.db("t");

    /* Kickoff 3 saat sonra → maç AÇIK, yani tahmin hâlâ gizli olmalı. */
    await db.collection("fixtures").insertOne({
      fixtureId: "FX-GIZLI", home: "A", away: "B",
      kickoffISO: new Date(Date.now() + 3 * 3600 * 1000).toISOString(),
      status: "NS", country: "Türkiye", league: "L",
    });
    await db.collection("predictions").insertOne({
      fixtureId: "FX-GIZLI", userId: "KURBAN", userIdLower: "kurban",
      outcome: "H", firstGoal: "H", firstHalf: "H", redAny: true, penaltyAny: true,
      at: new Date().toISOString(), isBot: false,
    });

    const app = express();
    app.use((q, _r, n) => { q.app.locals.db = db; n(); });
    app.use("/api/weekly-picks", require(path.join(KOK, "routes", "weekly-picks.cjs")));
    srv = app.listen(0);
    port = srv.address().port;
  });

  const sor = (u, baslik) =>
    fetch(`http://127.0.0.1:${port}/api/weekly-picks${u ? `?userId=${u}` : ""}`, { headers: baslik || {} })
      .then((r) => r.json());
  const bul = (j) => (j.picks || []).find((p) => p.fixtureId === "FX-GIZLI");

  test("kurulum: maç AÇIK ve listede", async () => {
    const j = await sor("", {});
    const p = bul(j);
    assert.ok(p, "test maci listede yok — test bir sey olcmuyor");
    assert.equal(p.open, true, "mac kapali — sizinti testi anlamsiz olur");
  });

  test("SAHİBİ kendi tahminini GÖRÜYOR", async () => {
    const p = bul(await sor("KURBAN", { "x-user-id": "KURBAN" }));
    assert.equal(p?.pred?.outcome, "H", "kullanici kendi tahminini goremiyor — ekran bozulur");
  });

  test("userId parametresi OLMADAN da kendi tahmini gelir", async () => {
    /* Kimlik jetondan geliyor; sorgu parametresi zorunlu değil. */
    const p = bul(await sor("", { "x-user-id": "KURBAN" }));
    assert.equal(p?.pred?.outcome, "H");
  });

  test("BAŞKASI kimliğiyle sorunca tahmin GELMİYOR", async () => {
    const p = bul(await sor("KURBAN", { "x-user-id": "SALDIRGAN" }));
    assert.equal(p?.pred, null, "baskasinin acik tahmini sizdi — rekabet butunlugu");
  });

  test("KİMLİKSİZ istekte tahmin GELMİYOR", async () => {
    const p = bul(await sor("KURBAN", {}));
    assert.equal(p?.pred, null, "kimliksiz istek baskasinin tahminini okudu");
  });

  test("liste KAPATILMADI — misafir maçları görüyor", async () => {
    /* Aşırı kilitlemek de kusur olurdu: misafir maç listesini görebilmeli. */
    const j = await sor("", {});
    assert.equal(j.ok, true);
    assert.ok((j.picks || []).length > 0, "misafire liste hic donmuyor");
  });

  test("kapat", async () => {
    srv?.close(); await cli?.close(); await mongod?.stop();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });
});

/* ── Nöbetçi ─────────────────────────────────────────────────────────────── */

const yalin = (p) => fs.readFileSync(path.join(KOK, p), "utf8")
  .split("\n")
  .map((l) => {
    const t = l.trim();
    return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
  })
  .join("\n");

test("NÖBETÇİ: kimlik JETONDAN alınıyor, sorgudan değil", () => {
  const src = yalin("routes/weekly-picks.cjs");
  assert.ok(/router\.get\("\/", optionalToken,/.test(src),
    "liste ucunda kimlik ara katmani yok");
  assert.ok(/istenen\.toLowerCase\(\) === kimlik\.toLowerCase\(\)/.test(src),
    "istenen userId dogrulanmiyor");
});

test("NÖBETÇİ: istemci jeton gönderiyor (apiFetch)", (t) => {
  const MOB = path.join(KOK, "..", "mobile", "components");
  if (!fs.existsSync(MOB)) return t.skip("mobil depo yok");
  for (const dosya of ["Picks1987.tsx", "BigFourPicks.tsx"]) {
    const s = fs.readFileSync(path.join(MOB, dosya), "utf8");
    const i = s.indexOf("/api/weekly-picks");
    assert.ok(i > 0, `${dosya}: haftalik secim cagrisi bulunamadi`);
    const cevre = s.slice(Math.max(0, i - 300), i + 120);
    assert.ok(/apiFetch\(/.test(cevre),
      `${dosya}: ham fetch kullaniyor — jeton gitmez, kullanici KENDI tahminini goremez`);
  }
});
