"use strict";

/**
 * ANA EKRANIN HIZLI-OYUN BÖLÜMÜ, SAĞLAYICI YOKKEN DE DOLU.
 *
 * ⚠️ BULUNAN: `routes/daily-picks.cjs` maçları YALNIZCA AF sağlayıcısından
 * çekiyordu ve `AF_KEY` tanımsızsa `fetchLeagueFixtures` sessizce `[]`
 * dönüyordu:
 *
 *     if (!AF_KEY) return [];
 *
 * `.env.example`'da `AF_KEY=` boş. Sonuç: `/singles` ve `/quad`
 * `ok: true, count: 0` döner — istemci HATA BİLE GÖREMEZ, çünkü yanıt
 * başarılı. `mobile/components/QuickPlaySection.tsx` de sessizce boş kalır.
 *
 * ÖLÇÜLDÜ (bellek-içi Mongo, AF_KEY yok):
 *     önce : depoda 12 oynanabilir maç · /singles 0 · /quad 0
 *     sonra: depoda 12 oynanabilir maç · /singles 5 · /quad 4
 *
 * ⚠️ DEPO ZATEN ÇALIŞAN KAYNAK: fikstürleri Mackolik/FDO besliyor ve
 * uygulamanın geri kalanı oradan okuyor. Bu dosya onu hiç kullanmıyordu —
 * yani veri vardı, ekran boştu.
 */

const os = require("os");
const nodePath = require("path");
const fs = require("fs");

const TMP = nodePath.join(os.tmpdir(), "skorlig-hizli-oyun-test");
process.env.SKORLIG_DATA_DIR = TMP;
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
// ⚠️ Sağlayıcıyı BİLEREK kapatıyoruz — ölçülen durum bu.
delete process.env.AF_KEY;

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

const MAC_SAYISI = 12;
let mongod = null, client = null, db = null, server = null, taban = "";

before(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const { MongoClient } = require("mongodb");
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  db = client.db("test");

  const simdi = Date.now();
  const evler = ["Galatasaray", "Besiktas", "Fenerbahce", "Trabzonspor", "Kasimpasa", "Alanyaspor"];
  const deplar = ["Rizespor", "Konyaspor", "Antalyaspor", "Sivasspor", "Gaziantep", "Hatayspor"];
  await db.collection("fixtures").insertMany(
    Array.from({ length: MAC_SAYISI }, (_, i) => ({
      fixtureId: `hofx-${i}`,
      home: evler[i % 6], away: deplar[i % 6],
      league: "Super Lig", country: "Turkey",
      kickoffISO: new Date(simdi + (i + 2) * 3600_000).toISOString(),
      status: "NS",
    }))
  );
  // Geçmiş ve oynanmış maçlar: seçime GİRMEMELİ.
  await db.collection("fixtures").insertMany([
    { fixtureId: "gecmis-1", home: "A", away: "B", country: "Turkey",
      kickoffISO: new Date(simdi - 5 * 3600_000).toISOString(), status: "NS" },
    { fixtureId: "bitmis-1", home: "C", away: "D", country: "Turkey",
      kickoffISO: new Date(simdi + 3 * 3600_000).toISOString(), status: "FT" },
  ]);

  const express = require("express");
  const app = express();
  app.locals.db = db;
  app.use(express.json());
  app.use("/api/daily-picks", require("../routes/daily-picks.cjs"));
  await new Promise((r) => { server = app.listen(0, r); });
  taban = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) server.close();
  if (client) await client.close();
  if (mongod) await mongod.stop();
});

const al = (yol) => fetch(`${taban}${yol}`).then((r) => r.json());

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("AF sağlayıcısı gerçekten kapalı", () => {
    // Açık olsaydı test geri düşüşü değil sağlayıcıyı ölçerdi.
    assert.ok(!process.env.AF_KEY, "AF_KEY tanimli — test geri dususu olcmuyor");
  });

  test("depoda oynanabilir maç var", async () => {
    const n = await db.collection("fixtures").countDocuments({ status: "NS" });
    assert.ok(n >= MAC_SAYISI, `depoda yeterli mac yok (${n})`);
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("hızlı oyun bölümü", () => {
  test("/singles sağlayıcı yokken de maç döndürüyor", async () => {
    const r = await al("/api/daily-picks/singles?country=Turkey");
    assert.equal(r.ok, true);
    assert.ok(
      r.count > 0,
      "saglayici yokken /singles bos donuyor — ana ekranin hizli-oyun bolumu sessizce bos kalir"
    );
    assert.equal(r.picks.length, r.count, "count ile liste uyusmuyor");
  });

  test("/quad sağlayıcı yokken de dört maç döndürüyor", async () => {
    const r = await al("/api/daily-picks/quad?country=Turkey");
    assert.equal(r.ok, true);
    assert.equal(r.count, 4, `dortlu ${r.count} mac dondurdu`);
  });

  test("BAŞLAMIŞ ve BİTMİŞ maçlar seçime girmiyor", async () => {
    /**
     * ⚠️ FİLTRE DOĞRUDAN SINANIYOR, UÇ ÜZERİNDEN DEĞİL. Uç üzerinden bakmak
     * yetmiyordu: bitmiş bir maç listeye girse bile çekicilik sıralamasında
     * sona düşüp `limit` kesmesinde eleniyor — yani filtre bozulsa da test
     * yeşil kalıyordu. Negatif kontrol bunu yakaladı.
     */
    const { _depodanMaclar } = require("../routes/daily-picks.cjs");
    const hepsi = await _depodanMaclar("Turkey", db, 50);
    const idler = hepsi.map((p) => p.fixtureId);

    assert.ok(idler.length > 0, "geri dusus hic mac dondurmedi — test bir sey olcmuyor");
    assert.ok(!idler.includes("gecmis-1"), "baslama saati gecmis mac secilmis");
    assert.ok(!idler.includes("bitmis-1"), "bitmis mac secilmis");
  });

  test("dönen maçlar ödeme zinciriyle uyumlu ödül taşıyor", async () => {
    /**
     * Geri düşüş yolu da `sonucOdulu` kullanmalı — yoksa bir önceki turda
     * düzeltilen "ekranda yazan ile ödenen ayrı" hatası bu yoldan geri gelir.
     */
    const { macOdulu } = require("../lib/ekonomi.cjs");
    const TAVAN = macOdulu(Number.MAX_SAFE_INTEGER);
    const r = await al("/api/daily-picks/singles?country=Turkey");
    assert.ok(r.picks.length > 0, "liste bos — test bir sey olcmuyor");
    for (const p of r.picks) {
      for (const k of ["home", "draw", "away"]) {
        assert.ok(p.rewards && typeof p.rewards[k] === "number", `${p.fixtureId} odul tasimiyor`);
        assert.ok(
          p.rewards[k] <= TAVAN,
          `${p.fixtureId} ${k} odulu ${p.rewards[k]} > tavan ${TAVAN} — geri dusus eski formule donmus`
        );
      }
    }
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: sağlayıcı tek kaynak değil", () => {
  const src = fs.readFileSync(nodePath.join(__dirname, "..", "routes", "daily-picks.cjs"), "utf8")
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");

  assert.ok(/depodanMaclar\s*\(/.test(src), "fikstur deposundan geri dusus yok");
  // İki uç da geri düşüşü çağırmalı; biri unutulursa o ekran boş kalır.
  const cagrilar = (src.match(/await depodanMaclar\(/g) || []).length;
  assert.ok(cagrilar >= 2, `geri dusus yalnizca ${cagrilar} yerde cagriliyor — /singles ve /quad ikisi de kullanmali`);
  assert.ok(/FixturesStore/.test(src), "depo hic okunmuyor");
});
