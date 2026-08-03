"use strict";

/**
 * DÜELLO ARENASI LİG ETİKETİNİ ÜLKESİYLE GÖSTERİR.
 *
 * ⚠️ İKİ AYRI SORUN (2026-08-03):
 *
 * 1) Düello kaydı `country` HİÇ TAŞIMIYORDU, yani arena "3. LİG" yazıyor ve
 *    hangi ülkenin ligi olduğu belirsiz kalıyordu. Ölçüldü (1944 üretim
 *    fikstürü): 32 lig adı birden fazla ülkede geçiyor — "Premier Lig" 24,
 *    "1. Lig" 18 ülkede. Ülkesiz etiket ayırt edici değil.
 *
 * 2) `league` alanı İSTEMCİ GÖVDESİNDEN alınıyordu. `home`/`away`/`kickoffISO`
 *    bilerek sunucudan çözülüyor (para kararı) ama lig atlanmıştı — istemci
 *    ne yazarsa arenada o görünüyordu.
 *
 * ÖLÇÜLDÜ (gerçek rotalar, bellek-içi Mongo):
 *     istemci gövdesi  → league: "ISTEMCININ UYDURDUGU LIG"
 *     kayıtta          → league: "3. Lig", country: "Türkiye"
 *     arena yanıtı     → league: "3. Lig", country: "Türkiye"
 *     ekranın çizdiği  → "🇹🇷 Türkiye · 3. Lig"
 */

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const KOK = path.join(__dirname, "..");
const MOBIL = path.join(KOK, "..", "mobile");

const VERI_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "skorlig-duello-lig-"));
process.env.SKORLIG_DATA_DIR = VERI_DIR;

const vt = require.resolve(path.join(KOK, "middleware", "verifyToken.cjs"));
require.cache[vt] = {
  id: vt, filename: vt, loaded: true, exports: {
    verifyToken: (q, r, n) => {
      if (!q.headers["x-user-id"]) return r.status(401).json({ ok: false, error: "AUTH" });
      q.uid = q.headers["x-user-id"]; n();
    },
    optionalToken: (q, _r, n) => { q.uid = q.headers["x-user-id"] || null; n(); },
  },
};

const express = require("express");

let mongod = null, client = null, db = null, srv = null, port = 0;
const FID = "TEST-ARENA-LIG";
const UYDURMA = "ISTEMCININ UYDURDUGU LIG";

before(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const { MongoClient } = require("mongodb");
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  db = client.db("test");

  await db.collection("lc_wallet_users").insertOne({
    userId: "OYUNCU", userIdLower: "oyuncu", balance: 500,
    totalEarned: 500, totalSpent: 0,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  await db.collection("fixtures").insertOne({
    fixtureId: FID, home: "Galatasaray", away: "Fenerbahce",
    league: "3. Lig", country: "Türkiye",
    kickoffISO: new Date(Date.now() + 6 * 3600 * 1000).toISOString(), status: "NS",
  });

  const app = express();
  app.use(express.json());
  app.locals.db = db;
  app.use("/api", require(path.join(KOK, "routes", "duels.cjs")));
  await new Promise((r) => { srv = app.listen(0, r); });
  port = srv.address().port;
});

after(async () => {
  srv?.close();
  await client?.close();
  await mongod?.stop();
  try { fs.rmSync(VERI_DIR, { recursive: true, force: true }); } catch { /* geçici */ }
});

async function cagir(yol, opt = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${yol}`, {
    method: opt.method || "GET",
    headers: { "content-type": "application/json", ...(opt.uid ? { "x-user-id": opt.uid } : {}) },
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  });
  let j = null; try { j = await r.json(); } catch { /* gövdesiz */ }
  return { st: r.status, j };
}

let olusan = null;

describe("düello — lig etiketi ve ülke", () => {
  test("kurulum sınandı: düello GERÇEKTEN oluşuyor", async () => {
    /* ⚠️ Bu olmadan alan kontrolleri boş: uç hata dönerse "country yok"
     * derdik ve sebebi hiç anlamazdık. */
    const r = await cagir("/api/duels/create", {
      method: "POST", uid: "OYUNCU",
      body: { fixtureId: FID, stake: 5, creatorName: "Oyuncu", league: UYDURMA },
    });
    assert.equal(r.st, 200, `duello olusmadi: ${JSON.stringify(r.j)}`);
    olusan = r.j?.duel;
    assert.ok(olusan?.id, "duello kaydi donmedi");
  });

  test("ÜLKE kayda yazılıyor (etiketin ayırt ediciliği buradan geliyor)", () => {
    assert.equal(olusan.country, "Türkiye", "duello kaydinda country yok/yanlis");
  });

  test("LİG FİKSTÜRDEN çözülüyor, İSTEMCİ GÖVDESİNDEN değil", () => {
    /**
     * ⚠️ `home`/`away`/`kickoffISO` bilerek sunucudan çözülüyor ama `league`
     * atlanmıştı. İstemcinin yazdığı değer arenada görünüyordu — yanıltıcı
     * etiket, ve genel olarak "gövdeye güvenme" kuralının deliği.
     */
    assert.equal(olusan.league, "3. Lig", "lig fiksturden cozulmemis");
    assert.notEqual(olusan.league, UYDURMA, "istemcinin gonderdigi lig kabul edilmis");
  });

  test("ARENA YANITI ülkeyi taşıyor (ekran etiketi kurabilsin)", async () => {
    /* ⚠️ Kayıtta olması yetmez: ekran arena yanıtını okuyor. Bu oturumun
     * tekrar eden dersi — "fonksiyonu sınamak yetmez, ucu döv". */
    const r = await cagir("/api/duels/arena?userId=BASKASI", { uid: "BASKASI" });
    const m = (r.j?.matches || [])[0];
    assert.ok(m, "arena mac dondurmedi");
    assert.equal(m.league, "3. Lig");
    assert.equal(m.country, "Türkiye", "arena yanitinda country yok — ekran etiketi kuramaz");
  });

  test("NÖBETÇİ: arena ekranı ortak etiketi kullanıyor", () => {
    const p = path.join(MOBIL, "app", "(tabs)", "arena.tsx");
    if (!fs.existsSync(p)) return;                 // mobil depo yoksa atla
    const s = fs.readFileSync(p, "utf8");
    assert.ok(/ligEtiketi\(match\.league, match\.country\)/.test(s),
      "arena ligEtiketi kullanmiyor");
    /**
     * ⚠️ `toUpperCase` KALDIRILDI VE GERİ GELMEMELİ: bayrak + Türkçe ülke adı
     * büyük harfe çevrilince bozuluyor ("İ" tuzağı bu depoda ölçülmüş bir
     * kusur) ve etiket okunmaz hâle geliyor.
     */
    assert.ok(!/match\.league\.toUpperCase\(\)/.test(s),
      "lig adi buyuk harfe ceviriliyor — bayrak ve Turkce ad bozulur");
  });
});
