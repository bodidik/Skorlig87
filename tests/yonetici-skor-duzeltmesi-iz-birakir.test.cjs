"use strict";

/**
 * UZLAŞMIŞ MAÇIN SKORUNU YÖNETİCİ DEĞİŞTİRİRSE İZ KALIR.
 *
 * ⚠️ BULUNAN: `lib/skor-uyusmazlik.cjs` tam bu senaryo için yazılmış —
 * kendi başlığı "VAR kararı, kaynak düzeltmesi, YANLIŞ EŞLEŞEN MAÇIN
 * DÜZELTİLMESİ" diyor. Ama yalnızca OTOMATİK yola bağlanmıştı
 * (`services/livescore-sync.cjs`). Yöneticinin ELLE düzeltmesi
 * (`POST /api/admin/results/set`) — yani uzlaşma sonrası skor değişiminin
 * EN OLASI kaynağı — hiçbir iz bırakmıyordu. Aynı savunma bir yolda var,
 * ötekinde yok: bu oturumun baskın kusur biçimi.
 *
 * ÖLÇÜLDÜ (gerçek express rotası; uzlaşmış maç 1-0 → 2-2):
 *     önce : yanıt {ok:true}, score_mismatch kaydı 0, uyarı YOK
 *     sonra: yanıt {ok:true, uyari:"UZLASMA_SONRASI_SKOR_DEGISTI"}, kayıt 1
 *
 * ⚠️ NEDEN ÖNEMLİ: uzlaşma `claimAward` ile mühürlü, yani ikinci kez ödeme
 * YAPILMAZ. Skor sonradan düzeltilince puanlar ve LC eski skora göre dağıtılmış
 * hâlde kalır ve kendiliğinden düzelmez. Kayıt yoksa bunu fark eden hiçbir şey
 * olmuyordu.
 *
 * ⚠️ OTOMATİK DÜZELTME YAPILMIYOR — modülün kararı, ben de değiştirmedim:
 * dağıtılmış LC'yi geri almak bakiyeyi eksiye düşürebilir. Yapılan tek şey
 * durumu GÖRÜNÜR kılmak (kalıcı kayıt + yanıtta uyarı).
 */

const os = require("os");
const path = require("path");
const fs = require("fs");

const TMP = path.join(os.tmpdir(), "skorlig-skorset-iz-test");
process.env.SKORLIG_DATA_DIR = TMP;
process.env.SKORLIG_BG = "0";

const KOK = path.join(__dirname, "..");
const vtYol = require.resolve(path.join(KOK, "middleware", "verifyToken.cjs"));
require.cache[vtYol] = {
  id: vtYol, filename: vtYol, loaded: true, exports: {
    verifyToken: (req, _r, n) => { req.uid = req.headers["x-user-id"]; n(); },
    optionalToken: (req, _r, n) => { req.uid = req.headers["x-user-id"] || null; n(); },
    getFirebaseAuth: () => null, kimlikModu: () => "test",
  },
};

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

const MatchResults = require("../lib/match-results.cjs");
const SkorUyusmazlik = require("../lib/skor-uyusmazlik.cjs");

const JETON = "test-jeton";
let mongod = null, client = null, db = null, srv = null, port = 0, eskiJeton;

const FID = "MK-SKORSET-2026-08-01-X";

before(async () => {
  eskiJeton = process.env.SKORLIG_ADMIN_TOKEN;
  process.env.SKORLIG_ADMIN_TOKEN = JETON;

  const { MongoMemoryServer } = require("mongodb-memory-server");
  const { MongoClient } = require("mongodb");
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  db = client.db("test");

  const app = express();
  app.use((req, _r, n) => { req.app.locals.db = db; n(); });
  app.use("/api/admin", require("../routes/admin-runtime.cjs"));
  srv = app.listen(0);
  port = srv.address().port;
});

after(async () => {
  if (srv) srv.close();
  if (client) await client.close();
  if (mongod) await mongod.stop();
  if (eskiJeton === undefined) delete process.env.SKORLIG_ADMIN_TOKEN;
  else process.env.SKORLIG_ADMIN_TOKEN = eskiJeton;
});

beforeEach(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(path.join(TMP, "live"), { recursive: true });
  await db.collection(SkorUyusmazlik.COLL).deleteMany({});
  await db.collection(MatchResults.COLL).deleteMany({});

  // results/set kaydı fikstür deposunda bulamazsa 404 döner.
  fs.writeFileSync(path.join(TMP, "fixtures.json"), JSON.stringify({ fixtures: [{
    fixtureId: FID, home: "A Takimi", away: "B Takimi", status: "FT",
    kickoffISO: new Date(Date.now() - 3 * 3600_000).toISOString(),
    score: { home: 1, away: 0 },
  }] }));
});

/** Uzlaşma yapılmış gibi anlık görüntü + ödül mührü yazar. */
async function uzlastir(skor = { home: 1, away: 0 }) {
  await MatchResults.upsertSnapshot(FID, () => ({
    fixtureId: FID, finalScore: skor, meta: {}, rows: [],
  }), db);
  await MatchResults.claimAward(FID, new Date().toISOString(), db);
}

const skorYaz = (home, away) =>
  fetch(`http://127.0.0.1:${port}/api/admin/results/set`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-token": JETON },
    body: JSON.stringify({ fixtureId: FID, home, away, updatedBy: "yonetici" }),
  }).then(async (r) => ({ status: r.status, govde: await r.json() }));

const kayitSayisi = () => db.collection(SkorUyusmazlik.COLL).countDocuments();

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("uç çalışıyor ve sonucu yazıyor", async () => {
    const r = await skorYaz(3, 1);
    assert.equal(r.status, 200, `uc ${r.status} dondu: ${JSON.stringify(r.govde).slice(0, 120)}`);
    assert.equal(r.govde.saved.home, 3);
  });

  test("mühür gerçekten basılıyor", async () => {
    await uzlastir();
    const snap = await MatchResults.getSnapshot(FID, db);
    assert.ok(snap?.awardedAt, "odul muhru yok — test bir sey olcmuyor");
    assert.equal(snap.finalScore.home, 1);
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("uzlaşma sonrası düzeltme", () => {
  test("skor değişirse KALICI kayıt bırakılıyor", async () => {
    await uzlastir({ home: 1, away: 0 });
    assert.equal(await kayitSayisi(), 0);

    const r = await skorYaz(2, 2);
    assert.equal(r.status, 200);
    assert.equal(
      await kayitSayisi(), 1,
      "uzlasmis mac duzeltildi ama iz birakilmadi — puanlar/LC eski skora gore kalir ve kimse bilmez"
    );

    const kayit = await db.collection(SkorUyusmazlik.COLL).findOne({ fixtureId: FID });
    assert.equal(kayit.muhurluSkor.home, 1, "muhurlu skor yanlis kaydedilmis");
    assert.equal(kayit.guncelSkor.away, 2, "yeni skor yanlis kaydedilmis");
  });

  test("yönetici yanıtta UYARI görüyor", async () => {
    /* Kalıcı kayıt operatör sonradan bakarsa işe yarar; uyarı ise o anda
     * ekranda. İkisi ayrı iş yapıyor. */
    await uzlastir({ home: 1, away: 0 });
    const r = await skorYaz(2, 2);
    assert.equal(
      r.govde.uyari, "UZLASMA_SONRASI_SKOR_DEGISTI",
      "yanitta uyari yok — yonetici macin coktan odendigini bilmiyor"
    );
  });

  test("AYNI skor tekrar yazılırsa uyuşmazlık YOK", async () => {
    // Yanlış alarm operatörü kayda güvenmemeye iter.
    await uzlastir({ home: 1, away: 0 });
    const r = await skorYaz(1, 0);
    assert.equal(await kayitSayisi(), 0, "ayni skor uyusmazlik sayilmis");
    assert.equal(r.govde.uyari, null);
  });

  test("HENÜZ UZLAŞMAMIŞ maçta uyuşmazlık YOK", async () => {
    /* Mühür yoksa uzlaşma olmamış demektir; skor girmek normal akıştır ve
     * hiçbir para yanlış dağıtılmamıştır. */
    await MatchResults.upsertSnapshot(FID, () => ({
      fixtureId: FID, finalScore: { home: 1, away: 0 }, meta: {}, rows: [],
    }), db);
    const r = await skorYaz(4, 0);
    assert.equal(await kayitSayisi(), 0, "uzlasmamis macta yanlis alarm uretildi");
    assert.equal(r.govde.uyari, null);
  });

  test("aynı maç iki kez düzeltilse de tek kayıt (gürültü yok)", async () => {
    await uzlastir({ home: 1, away: 0 });
    await skorYaz(2, 2);
    await skorYaz(3, 3);
    assert.equal(await kayitSayisi(), 1, "her duzeltmede yeni kayit — gurultu, benzersiz indeks calismiyor");
  });

  test("kayıt tutulamasa bile sonuç YAZILIYOR", async () => {
    /**
     * ⚠️ İz bırakma, asıl işi (sonucu kaydetmek) engellememeli. Mongo'yu
     * zehirleyip uç hâlâ 200 dönüyor mu diye bakıyorum.
     */
    await uzlastir({ home: 1, away: 0 });
    const gercek = SkorUyusmazlik.kaydet;
    SkorUyusmazlik.kaydet = async () => { throw new Error("mongo yok"); };
    try {
      const r = await skorYaz(5, 5);
      assert.equal(r.status, 200, "iz tutulamayinca sonuc yazimi da dustu");
      assert.equal(r.govde.saved.home, 5);
    } finally {
      SkorUyusmazlik.kaydet = gercek;
    }
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

const kaynak = (rel) =>
  fs.readFileSync(path.join(KOK, rel), "utf8")
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");

test("NÖBETÇİ: uyuşmazlık denetimi HER İKİ yolda da bağlı", () => {
  /**
   * Otomatik yol (livescore-sync) ile elle yol (admin-runtime) aynı denetimi
   * kullanmalı. Kusur tam olarak birinin bağlı olup ötekinin olmamasıydı.
   */
  for (const rel of ["services/livescore-sync.cjs", "routes/admin-runtime.cjs"]) {
    const src = kaynak(rel);
    assert.ok(
      /SkorUyusmazlik\.farkliMi\s*\(/.test(src) && /SkorUyusmazlik\.kaydet\s*\(/.test(src),
      `${rel}: uyusmazlik denetimi bagli degil`
    );
  }
});

test("NÖBETÇİ: denetim ÖDÜL MÜHRÜNE bakıyor, yalnızca skora değil", () => {
  /**
   * Mühür kontrolü olmazsa henüz ödenmemiş maçta da alarm üretilir; yanlış
   * alarm operatörü tüm kayda güvenmemeye iter.
   */
  const src = kaynak("routes/admin-runtime.cjs");
  assert.ok(/snap\?\.awardedAt\s*&&\s*SkorUyusmazlik\.farkliMi/.test(src), "muhur kontrolu yok");
});
