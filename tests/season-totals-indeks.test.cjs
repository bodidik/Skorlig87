"use strict";

/**
 * SEASON_TOTALS SORGULARI İNDEKS KULLANIYOR.
 *
 * ⚠️ BULUNAN: `lib/season-totals.cjs` `season_totals` koleksiyonunda hiç
 * indeks kurmuyordu. `kullaniciToplami` `{ season, userIdLower }` ile TEK
 * kullanıcı arıyor, yani her çağrıda TÜM koleksiyon taranıyordu.
 *
 * ÖLÇÜLDÜ (bellek-içi Mongo, 20 000 kayıt, hedef en sondaki belge):
 *     indekssiz : 41.55 ms/sorgu · incelenen belge 20000
 *     indeksli  :  1.66 ms/sorgu · incelenen belge     1
 *     kazanç    : 25x
 *
 * Bu yol kullanıcı istatistik/profil ekranlarından çağrılıyor — her açılışta
 * ödeniyor ve maliyet kullanıcı sayısıyla doğrusal büyüyor.
 *
 * ⚠️ İNDEKS BENZERSİZ DEĞİL, BİLEREK: `belgeleriBirlestir` aynı kullanıcının
 * "sezonsuz" (migration öncesi) ve sezonlu belgesini birleştiriyor, yani aynı
 * `userIdLower` için birden çok belge OLMASI beklenen bir durum. Benzersiz
 * indeks kurulum anında patlar ve depoyu indekssiz bırakırdı.
 */

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const nodePath = require("path");

let mongod = null, client = null, db = null, SeasonTotals = null;

before(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const { MongoClient } = require("mongodb");
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  db = client.db("skorlig");
  SeasonTotals = require("../lib/season-totals.cjs");

  /* Tam taramanın görünür olması için yeterli hacim. */
  const docs = [];
  for (let i = 0; i < 3000; i++) {
    docs.push({
      userId: `k-${i}`, userIdLower: `k-${i}`, season: "2026-08",
      totalPoints: i % 100, totalPenalty: 0, matches: 5,
    });
  }
  await db.collection("season_totals").insertMany(docs);
});

after(async () => {
  if (client) await client.close();
  if (mongod) await mongod.stop();
});

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("veri GERÇEKTEN yazıldı", async () => {
    const n = await db.collection("season_totals").countDocuments();
    assert.ok(n >= 3000, `yalnizca ${n} kayit — olcum anlamsiz olur`);
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("sorgu indeks kullanıyor", () => {
  test("tek kullanıcı sorgusu TÜM koleksiyonu taramıyor", async () => {
    /* Modülün kendi yolu indeksi kurar. */
    const r = await SeasonTotals.kullaniciToplami(db, "k-2999", "2026-08");
    assert.ok(r, "kullanici bulunamadi — sorgu yolu degismis olabilir");

    const plan = await db.collection("season_totals")
      .find({ season: "2026-08", userIdLower: "k-2999" })
      .explain("executionStats");

    const incelenen = plan.executionStats.totalDocsExamined;
    const toplam = await db.collection("season_totals").countDocuments();

    assert.ok(
      incelenen < toplam / 10,
      `sorgu ${incelenen}/${toplam} belge inceledi — indeks kullanilMIYOR. ` +
      `Olculdu: 20 000 kayitta indekssiz 41.55 ms, indeksli 1.66 ms (25x).`
    );
  });

  test("indeks GERÇEKTEN kurulmuş", async () => {
    const idx = await db.collection("season_totals").indexes();
    const var_ = idx.some(
      (x) => x.key && x.key.userIdLower === 1 && x.key.season === 1
    );
    assert.ok(
      var_,
      `{userIdLower, season} indeksi yok: ${JSON.stringify(idx.map((x) => x.key))}`
    );
  });

  test("indeks BENZERSİZ DEĞİL (eski sezonsuz belgeler kırılmasın)", async () => {
    /**
     * ⚠️ Yanlış pozitif koruması: benzersiz indeks "daha güvenli" gibi
     * görünür ama `belgeleriBirlestir` aynı kullanıcının sezonsuz + sezonlu
     * belgesini birleştiriyor. Benzersiz indeks kurulum anında patlar ve
     * `catch` bloğu yüzünden koleksiyon İNDEKSSİZ kalırdı.
     */
    const idx = await db.collection("season_totals").indexes();
    const hedef = idx.find(
      (x) => x.key && x.key.userIdLower === 1 && x.key.season === 1
    );
    assert.ok(hedef, "indeks bulunamadi");
    assert.ok(
      !hedef.unique,
      "indeks BENZERSIZ kurulmus — ayni kullanicinin sezonsuz ve sezonlu " +
      "belgesi birlikte var olabiliyor, kurulum patlar ve indeks HIC kurulmaz"
    );
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: her Mongo sorgusu öncesi indeks garantisi var", () => {
  const src = fs.readFileSync(
    nodePath.join(__dirname, "..", "lib", "season-totals.cjs"), "utf8"
  );
  const kod = src.split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");

  const sorgular = [...kod.matchAll(/collection\(COLL\)|collection\("season_totals"\)/g)];
  assert.ok(sorgular.length > 0, "sorgu bulunamadi — tarama bozuk");

  /* Her sorgudan önceki 300 karakterde `ensureIndexes` çağrısı olmalı. */
  const korumasiz = [];
  for (const m of sorgular) {
    const oncesi = kod.slice(Math.max(0, m.index - 300), m.index);
    if (!/ensureIndexes\(/.test(oncesi)) {
      korumasiz.push(kod.slice(0, m.index).split("\n").length);
    }
  }

  assert.deepEqual(
    korumasiz, [],
    `su satirlardaki sorgular ensureIndexes cagirmadan calisiyor: ` +
    `${korumasiz.join(", ")} — ilk cagri indekssiz tam tarama yapar`
  );

  /* Söz önbelleklemesi korunmalı (bayrak değil). */
  assert.ok(
    /_indexPromise/.test(kod),
    "indeks garantisi soz onbeklemiyor — bayrak kullanilirsa eszamanli ikinci " +
    "cagri indeks HENUZ YOKKEN sorgu yapar (bkz. lib/pool-store.cjs notu)"
  );
});
