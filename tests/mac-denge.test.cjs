"use strict";

/**
 * MAÇ DENGESİ — tek taraflı maça düello kurulmamalı.
 *
 * Gerekçe: "Real Madrid – Erokspor" maçında sonuç zaten büyük ölçüde belli.
 * Sürprizi ödüllendirme işini tek maç tahmini yapıyor (düşük ihtimalli sonuç
 * daha çok LC getiriyor); aynı maça düello açmak yeni bir oyun kurmuyor,
 * yalnızca sisteme yük ekliyor.
 *
 * ⚠️ EŞİK ÖLÇÜLEREK SEÇİLDİ. Üretimdeki 639 fikstürde favori olasılığın
 * dağılımı: medyan 0.450, %90 0.621, %95 0.671, en yüksek 0.761. Eşik 0.65
 * fikstürlerin %8.1'ini kapatıyor. Aşağıdaki örnekler o ölçümü KİLİTLİYOR —
 * `odds-engine` reytingleri değişirse burada kırılır.
 */

const os = require("os");
const nodePath = require("path");
process.env.SKORLIG_DATA_DIR = nodePath.join(os.tmpdir(), "skorlig-denge-test");

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");

const MacDenge = require("../lib/mac-denge.cjs");
const { favoriOlasiligi, duelloyaUygunMu, ESIK } = MacDenge;

let mongod = null, client = null, db = null;

before(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const { MongoClient } = require("mongodb");
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  db = client.db("test");
});
after(async () => {
  if (client) await client.close();
  if (mongod) await mongod.stop();
});
beforeEach(async () => {
  await db.collection("fixtures").deleteMany({});
});

const fiksturEkle = (fixtureId, home, away) =>
  db.collection("fixtures").insertOne({ fixtureId, home, away, status: "NS" });

/* ── Ölçüt ───────────────────────────────────────────────────────────────── */

describe("favori olasılığı", () => {
  test("ölçülen örnekler beklenen tarafta kalır", () => {
    // Bu sayılar üretim fikstürlerinden ölçüldü; eşik onlara göre seçildi.
    const beklenen = [
      ["Real Madrid", "Erokspor", 0.771, false],
      ["Galatasaray", "Erokspor", 0.706, false],
      ["Erokspor", "Galatasaray", 0.621, true],
      ["Real Madrid", "Barcelona", 0.505, true],
      ["Galatasaray", "Fenerbahce", 0.450, true],
      ["Trabzonspor", "Besiktas", 0.360, true],
    ];
    for (const [h, a, p, uygunMu] of beklenen) {
      const olcum = favoriOlasiligi(h, a);
      assert.ok(
        Math.abs(olcum - p) < 0.01,
        `${h}-${a}: beklenen ~${p}, olculen ${olcum.toFixed(3)}`
      );
      assert.equal(olcum < ESIK, uygunMu, `${h}-${a} esigin yanlis tarafinda`);
    }
  });

  test("ev avantajı asimetrisi korunur", () => {
    // Zayıf takım KENDİ SAHASINDA gerçekten daha rekabetçi; ölçüt bunu
    // yansıtmalı. İki yönü aynı saymak futbolu yanlış modellemek olurdu.
    assert.ok(
      favoriOlasiligi("Erokspor", "Galatasaray") < favoriOlasiligi("Galatasaray", "Erokspor"),
      "ev avantasi asimetrisi kaybolmus"
    );
  });
});

/* ── Kapı ────────────────────────────────────────────────────────────────── */

describe("düello kapısı", () => {
  test("tek taraflı maç reddedilir", async () => {
    await fiksturEkle("fx-tek-tarafli", "Real Madrid", "Erokspor");
    const r = await duelloyaUygunMu("fx-tek-tarafli", db);
    assert.equal(r.uygun, false);
    assert.equal(r.sebep, "MATCH_TOO_LOPSIDED");
    assert.ok(r.olasilik >= ESIK);
  });

  test("dengeli maç kabul edilir", async () => {
    await fiksturEkle("fx-dengeli", "Galatasaray", "Fenerbahce");
    const r = await duelloyaUygunMu("fx-dengeli", db);
    assert.equal(r.uygun, true);
    assert.equal(r.sebep, "DENGELI");
  });

  test("takım adları SUNUCUDAN okunur, istemciden değil", async () => {
    // ⚠️ `POST /api/duels/create` gövdesinde de home/away var ama onlar
    // istemcinin yazdığı değerler. Kapıyı onlara dayasaydık, sahte ad
    // göndererek atlatmak bir satırlık iş olurdu.
    await fiksturEkle("fx-sahte", "Real Madrid", "Erokspor");
    // İstemci "Barcelona vs Real Madrid" iddia etse bile karar fikstürden:
    const r = await duelloyaUygunMu("fx-sahte", db);
    assert.equal(r.home, "Real Madrid");
    assert.equal(r.away, "Erokspor");
    assert.equal(r.uygun, false);
  });
});

/* ── Bilinmeyen veri ─────────────────────────────────────────────────────── */

describe("veri eksikse", () => {
  test("fikstür bulunamazsa düello AÇIK kalır (fail-open)", async () => {
    // ⚠️ Para yollarının tersine bilinçli fail-open: fikstür okunamayınca
    // düelloyu engellemek, veri gecikince oyunun tamamını durdururdu.
    // Buradaki hata bedeli "gereksiz düello açıldı", "para kayboldu" değil.
    await fiksturEkle("baska", "A", "B");
    const r = await duelloyaUygunMu("hic-boyle-fikstur-yok", db);
    assert.equal(r.uygun, true);
  });

  test("takım adı boşsa düello açık kalır", async () => {
    await db.collection("fixtures").insertOne({ fixtureId: "fx-bos", home: null, away: null });
    const r = await duelloyaUygunMu("fx-bos", db);
    assert.equal(r.uygun, true);
    assert.equal(r.sebep, "TAKIM_BILINMIYOR");
  });

  test("iki takım da reytingsizse dengeli sayılır — bilinen sınır", async () => {
    // Üretim fikstürlerinin %75'inden fazlasında iki takım da tabloda yok ve
    // ikisi de DEFAULT_RATING alıyor. Bu maçlar kapıdan geçer. Bu bir hata
    // değil, reyting tablosunun kapsam sınırı — testin işi onu GÖRÜNÜR tutmak.
    await fiksturEkle("fx-bilinmeyen", "Bilinmeyen A", "Bilinmeyen B");
    const r = await duelloyaUygunMu("fx-bilinmeyen", db);
    assert.equal(r.uygun, true);
    assert.ok(r.olasilik < ESIK);
  });
});

/* ── Sıra ────────────────────────────────────────────────────────────────── */

test("kapı, LC düşülmeden ÖNCE çalışır", () => {
  /**
   * Reddedilen düello para götürmemeli. Bu kaynak sırası kontrolü dar ama
   * doğrudan değişmezi kodluyor: `duelloyaUygunMu` çağrısı `deductLc`
   * çağrısından önce gelmeli.
   */
  const src = fs.readFileSync(nodePath.join(__dirname, "..", "routes", "duels.cjs"), "utf8");
  const kapi = src.indexOf("duelloyaUygunMu(fx, db)");
  const tahsilat = src.indexOf('deductLc(db, creatorId, s, "duel_create"');
  assert.ok(kapi > 0, "denge kapisi bulunamadi");
  assert.ok(tahsilat > 0, "tahsilat bulunamadi");
  assert.ok(kapi < tahsilat, "denge kapisi tahsilattan SONRA — reddedilen duello para goturur");
});
