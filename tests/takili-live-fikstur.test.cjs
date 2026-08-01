"use strict";

/**
 * TAKILI KALMIŞ "LIVE" FİKSTÜR YENİ BAHSE AÇILMAZ.
 *
 * ⚠️ ÖLÇÜLEN DURUM (data/fixtures.json, 1458 kayıt): 431 maç `LIVE`
 * işaretli ama yalnızca 3'ü `FT`. LIVE olanların 389'u başlama saatinden
 * 3 saatten fazla geçmiş — ortanca 16.6 saat, %90'ı 40.6 saat, en fazla 64
 * saat. Yani fikstür deposundaki durum alanı `FT`'ye İLERLEMİYOR.
 *
 * ⚠️ İZİNİ SÜRDÜM, PARA KAYBI BULAMADIM — ve bunu abartmadan yazıyorum:
 *   • `fiksturKilidi` durumu yedek sinyal olarak okuyor; NS olmayan maç
 *     KİLİTLİ sayılıyor, yani oynanmış maça yeni bahis girilemiyor (ölçüldü).
 *   • settle2 durumu fikstürden değil canlı DURUM DOSYASINDAN okuyor, o
 *     yüzden sonuçlandırma bu alandan etkilenmiyor.
 *   • Bağlı para 48 saatte `lib/bayat-mac.cjs` ile iade ediliyor.
 *
 * Kalan risk gelecekte: fikstür deposundaki `status` alanı "bu maç bitti mi"
 * sorusuna GÜVENİLİR cevap vermiyor. Buna dayanan yeni bir kod sessizce hiç
 * çalışmaz. Bu test, en azından kilitleme yönünün korunmasını garantiliyor.
 *
 * ⚠️ VERİ DÜZELTİLMEDİ: 389 kaydı `FT`'ye çekmek üretim verisine dokunmak
 * olurdu (ve hangi maçın gerçekten bittiğini fikstür verisi söylemiyor).
 */

const os = require("os");
const nodePath = require("path");
const fs = require("fs");

const TMP = nodePath.join(os.tmpdir(), "skorlig-takili-live-test");
process.env.SKORLIG_DATA_DIR = TMP;
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { fiksturKilidi } = require("../lib/fikstur-kilit.cjs");
const { bayatMi } = require("../lib/bayat-mac.cjs");

const SAAT = 3600_000;
let mongod = null, client = null, db = null;

before(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const { MongoClient } = require("mongodb");
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  db = client.db("test");

  await db.collection("fixtures").insertMany([
    // Başlamış ama durumu FT'ye ilerlememiş — ölçülen gerçek durum.
    { fixtureId: "takili-1", home: "A", away: "B", status: "LIVE",
      kickoffISO: new Date(Date.now() - 20 * SAAT).toISOString() },
    // Çok eski takılı kayıt (ölçümdeki en uç: 64 saat).
    { fixtureId: "takili-2", home: "E", away: "F", status: "LIVE",
      kickoffISO: new Date(Date.now() - 64 * SAAT).toISOString() },
    // Normal, oynanmamış maç.
    { fixtureId: "normal-1", home: "C", away: "D", status: "NS",
      kickoffISO: new Date(Date.now() + 6 * SAAT).toISOString() },
  ]);
});

after(async () => {
  if (client) await client.close();
  if (mongod) await mongod.stop();
});

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("normal maç AÇIK — kilit her şeyi kapatmıyor", async () => {
    const k = await fiksturKilidi("normal-1", { db });
    assert.equal(k.locked, false, `oynanmamis mac kilitli (${k.reason}) — test bir sey olcmuyor`);
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("takılı LIVE fikstür", () => {
  for (const fid of ["takili-1", "takili-2"]) {
    test(`${fid} yeni bahse KAPALI`, async () => {
      const k = await fiksturKilidi(fid, { db });
      assert.equal(
        k.locked, true,
        "durumu FT'ye ilerlememis ama OYNANMIS bir maca bahis girilebiliyor"
      );
    });
  }

  test("bağlı para 48 saat sonra bayat sayılıyor (sonsuza kadar kilitlenmiyor)", async () => {
    // 20 saatlik olan henüz beklemede, 64 saatlik olan bayat olmali.
    const yeni = await bayatMi({ fixtureId: "takili-1", kickoffISO: null, db });
    assert.equal(yeni.bayat, false, `20 saatlik mac erken bayat sayildi (${yeni.sebep})`);

    const eski = await bayatMi({ fixtureId: "takili-2", kickoffISO: null, db });
    assert.equal(
      eski.bayat, true,
      `64 saatlik takili mac bayat sayilmiyor (${eski.sebep}) — para sonsuza kadar kilitli kalir`
    );
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: kilit NS DIŞINDAKİ her durumu kapalı sayıyor", () => {
  /**
   * Kilit "status === LIVE" gibi bir beyaz liste kullansaydı, ilerlemeyen
   * ya da beklenmedik bir durum (HT, PAUSED, boş) maçı AÇIK bırakırdı.
   * Kural ters yönde olmalı: NS değilse kapalı.
   */
  const src = fs.readFileSync(nodePath.join(__dirname, "..", "lib", "fikstur-kilit.cjs"), "utf8")
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");

  assert.ok(
    /status\s*&&\s*status\s*!==\s*"NS"|status\s*!==\s*"NS"/.test(src),
    "kilit NS disindaki durumlari kapali saymiyor"
  );
});
