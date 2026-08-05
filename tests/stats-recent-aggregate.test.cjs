"use strict";

/**
 * `recentMatches` BORU HATTI ÖNCE ELEYİP SONRA AÇIYOR.
 *
 * ⚠️ BULUNAN: `routes/stats.cjs` boru hattı `$unwind` ile BAŞLIYORDU, yani
 * tüm leaderboard belgelerinin TÜM satırlarını açıp sonra filtreliyordu.
 * Ara belge sayısı fikstür × satır kadar ve geçmiş maç sayısıyla büyüyor.
 *
 * ÖLÇÜLDÜ (bellek-içi Mongo, 1500 fikstür × 160 satır = 240 000 satır):
 *     $unwind önce : 861.4 ms/sorgu
 *     $match önce  : 235.5 ms/sorgu
 *     kazanç       : 3.7x
 *
 * Bu yol kullanıcı istatistik ekranından çağrılıyor — 861 ms kullanıcının
 * doğrudan hissettiği bir bekleme.
 *
 * ⚠️ SONUÇ DEĞİŞMEMELİ: ilk `$match` yalnızca kaba elek; kesin karşılaştırmayı
 * ikinci `$match` yapıyor. Bu testin asıl işi hızı değil, SONUCUN AYNI
 * kaldığını tutmak — özellikle harf düzeni farklı kimliklerde.
 */

const os = require("os");
const nodePath = require("path");
const fs = require("fs");

const TMP = nodePath.join(os.tmpdir(), "skorlig-recent-agg-test");
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
process.env.SKORLIG_DATA_DIR = TMP;

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

let mongod = null, client = null, db = null, server = null, taban = "";

const KAYITLI = "KarisikHarfli";   // leaderboard satırında BÖYLE duruyor
const BASKASI = "baska-kullanici";

before(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const { MongoClient } = require("mongodb");
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  db = client.db("skorlig");

  /* Üç fikstür: ikisinde aranan kullanıcı var, birinde yok. */
  await db.collection("leaderboard").insertMany([
    {
      fixtureId: "fx-1", updatedAt: new Date("2026-08-01T10:00:00Z"),
      items: [
        { fixtureId: "fx-1", userId: KAYITLI, points: 12, detail: { outcome: 3 } },
        { fixtureId: "fx-1", userId: BASKASI, points: 5, detail: null },
      ],
    },
    {
      fixtureId: "fx-2", updatedAt: new Date("2026-08-02T10:00:00Z"),
      items: [
        { fixtureId: "fx-2", userId: BASKASI, points: 7, detail: null },
      ],
    },
    {
      fixtureId: "fx-3", updatedAt: new Date("2026-08-03T10:00:00Z"),
      items: [
        { fixtureId: "fx-3", userId: KAYITLI.toUpperCase(), points: 9, detail: null },
      ],
    },
  ]);

  const express = require("express");
  const app = express();
  app.locals.db = db;
  app.use("/api/stats", require("../routes/stats.cjs"));
  await new Promise((r) => { server = app.listen(0, r); });
  taban = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) server.close();
  if (client) await client.close();
  if (mongod) await mongod.stop();
});

const al = (uid) =>
  fetch(`${taban}/api/stats/user?userId=${encodeURIComponent(uid)}`).then((r) => r.json());

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("uç yanıt veriyor", async () => {
    const j = await al(KAYITLI);
    assert.equal(j.ok, true, `uc basarisiz: ${JSON.stringify(j).slice(0, 200)}`);
  });
});

/* ── Asıl değişmez: eleme sonucu bozmuyor ───────────────────────────────── */

describe("önce eleme sonucu değiştirmiyor", () => {
  test("kullanıcının TÜM satırları geliyor (harf düzeni farklı olsa da)", async () => {
    /**
     * ⚠️ ASIL RİSK BURADA: ilk `$match` kaba bir elek ve harf duyarsız
     * olmalı. Duyarlı olsaydı `KARISIKHARFLI` yazılmış fikstür elenir ve
     * kullanıcı o maçı geçmişinde HİÇ göremezdi — üstelik sessizce.
     */
    const j = await al(KAYITLI);
    const fidler = (j.recentMatches || []).map((m) => m.fixtureId).sort();
    assert.deepEqual(
      fidler, ["fx-1", "fx-3"],
      `beklenen fx-1 ve fx-3, gelen ${JSON.stringify(fidler)} — kaba elek ` +
      `harf duyarli calisiyorsa buyuk harfle yazilmis satir kayboluyor`
    );
  });

  test("BAŞKASININ satırı sızmıyor", async () => {
    const j = await al(KAYITLI);
    const puanlar = (j.recentMatches || []).map((m) => m.points).sort((a, b) => a - b);
    assert.deepEqual(
      puanlar, [9, 12],
      `yabanci satir sizmis: ${JSON.stringify(puanlar)} — ikinci $match kesin ` +
      `karsilastirmayi yapmiyor olabilir`
    );
  });

  test("hiç satırı olmayan kullanıcıda BOŞ dönüyor", async () => {
    const j = await al("hic-oynamamis");
    assert.deepEqual(
      j.recentMatches || [], [],
      `bos olmasi gerekirken ${JSON.stringify(j.recentMatches)} dondu`
    );
  });

  test("regex özel karakterli kimlik boru hattını bozmuyor", async () => {
    /**
     * ⚠️ Kullanıcı kimliği doğrudan regex desenine giriyor. Kaçış olmasaydı
     * `a.b` deseni `axb` ile de eşleşir, `a+b` ise geçersiz desen üretebilirdi.
     */
    await db.collection("leaderboard").insertOne({
      fixtureId: "fx-ozel", updatedAt: new Date("2026-08-04T10:00:00Z"),
      items: [{ fixtureId: "fx-ozel", userId: "a.b+c", points: 3, detail: null }],
    });

    const dogru = await al("a.b+c");
    assert.equal(
      (dogru.recentMatches || []).length, 1,
      `ozel karakterli kimlik bulunamadi: ${JSON.stringify(dogru.recentMatches)}`
    );

    /* Kaçış çalışıyorsa `axbxc` bu satırla EŞLEŞMEMELİ. */
    const yanlis = await al("axbxc");
    assert.deepEqual(
      yanlis.recentMatches || [], [],
      `regex kacisi yok: "axbxc" sorgusu "a.b+c" satirini getirdi`
    );
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: boru hattı $unwind ile BAŞLAMIYOR", () => {
  const src = fs.readFileSync(
    nodePath.join(__dirname, "..", "routes", "stats.cjs"), "utf8"
  );
  const kod = src.split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");

  const i = kod.indexOf("aggregate([");
  assert.ok(i >= 0, "aggregate bulunamadi — tarama bozuk");
  const bas = kod.slice(i, i + 300);

  const unwindIdx = bas.indexOf("$unwind");
  const matchIdx = bas.indexOf("$match");
  assert.ok(unwindIdx >= 0, "$unwind bulunamadi");
  assert.ok(
    matchIdx >= 0 && matchIdx < unwindIdx,
    "$unwind ilk asamada — tum belgelerin TUM satirlari aciliyor. Olculdu: " +
    "240 000 satirda 861 ms vs 235 ms (3.7x). Once belge duzeyinde ele."
  );

  assert.ok(
    /replace\(\/\[\.\*\+\?/.test(kod) || /\\\\\$&/.test(kod),
    "regex kacisi yok — kullanici kimligi dogrudan desene giriyor"
  );
});
