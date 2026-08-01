"use strict";

/**
 * "TAM KUPON" ROZETİ YALNIZCA HAK EDENE.
 *
 * ⚠️ BULUNAN: `lib/kupon-store.cjs siralama` rozeti şöyle sayıyordu:
 *     tamKupon: { $sum: { $cond: [{ $eq: ["$dogru", "$toplam"] }, 1, 0] } }
 * İade edilen kupon, katılım kaydına tam olarak `dogru: 0, toplam: 0` yazıyor
 * (bkz. lib/kupon-settle.cjs `iadeEt` — yetersiz sonuçta puanlama YOK, iade
 * var). Sıfır sıfıra eşit olduğu için PUANLANMAMIŞ kupon "tam kupon"
 * sayılıyordu. Alanları hiç olmayan eski kayıtlarda da aynı: `$eq` iki eksik
 * alanı eşit sayar.
 *
 * ÖLÇÜLDÜ (7 katılım, yalnızca 1'i gerçekten 8/8):
 *     önce : 5 rozet
 *     sonra: 1 rozet
 * En çarpıcısı: hiç puanlanmamış oyuncu ("veli") tabloda 3 rozetle,
 * yani gerçek kazanandan ÜÇ KAT fazlasıyla görünüyordu.
 *
 * ⚠️ PARA ETKİSİ YOK, ABARTMIYORUM: rozet yalnızca gösterim
 * (mobile/app/(tabs)/stats.tsx satır 929 — "N tam kupon 🎯"). Sıralama puana
 * göre, rozete göre değil. Ama tabloya bakan oyuncu için görünen şey yanlış
 * ve iade — yani sistemin ÖZÜR mekanizması — övgüye dönüşüyordu.
 */

const os = require("os");
const path = require("path");

process.env.SKORLIG_DATA_DIR = path.join(os.tmpdir(), "skorlig-kupon-tam-rozeti-test");

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");

const Store = require("../lib/kupon-store.cjs");

let mongod = null, client = null, db = null;

const kayit = (u, k, o) => ({
  kuponId: k, userId: u, tur: "ulke", ulke: "Turkiye", haftaKey: "2026-W31",
  sonuclandiMi: true, sonuclandiAt: new Date().toISOString(), ...o,
});

before(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const { MongoClient } = require("mongodb");
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  db = client.db("test");

  await db.collection(Store.COLL_KATILIM).insertMany([
    kayit("ali", "k1", { dogru: 8, toplam: 8, puan: 40, odulLc: 30 }),   // GERÇEK tam kupon
    kayit("ali", "k2", { dogru: 5, toplam: 8, puan: 10, odulLc: 0 }),
    /* İade edilen kupon — `iadeEt` TAM OLARAK bu alanları yazıyor. */
    kayit("ali", "k3", { dogru: 0, toplam: 0, puan: 0, ceza: 0, bonus: 0, odulLc: 0, iadeLc: 25 }),
    kayit("veli", "k3", { dogru: 0, toplam: 0, puan: 0, ceza: 0, bonus: 0, odulLc: 0, iadeLc: 25 }),
    kayit("veli", "k4", { dogru: 0, toplam: 0, puan: 0, ceza: 0, bonus: 0, odulLc: 0, iadeLc: 25 }),
    kayit("veli", "k5", { puan: 3, odulLc: 0 }),                          // eski kayıt: alanlar YOK
    kayit("can", "k1", { dogru: 0, toplam: 8, puan: -4, odulLc: 0 }),     // hiç tutturamamış
  ].map((x) => ({ ...x, userIdLower: x.userId.toLowerCase() })));
});

after(async () => {
  if (client) await client.close();
  if (mongod) await mongod.stop();
});

const satirlar = async () => {
  const s = await Store.siralama({ tur: "ulke", ulke: "Turkiye", limit: 50 }, db);
  return Object.fromEntries(s.map((r) => [r._id, r]));
};

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("sıralama üç oyuncuyu da görüyor", async () => {
    const s = await satirlar();
    assert.deepEqual(Object.keys(s).sort(), ["ali", "can", "veli"]);
    assert.equal(s.ali.kuponSayisi, 3, "katilimlar sayilmiyor — test bir sey olcmuyor");
  });

  test("iade kaydının biçimi settle koduyla AYNI", () => {
    /**
     * ⚠️ Test kendi uydurduğu bir biçimi sınarsa, gerçek iade biçimi
     * değiştiğinde yeşil kalır ve hata geri gelir. `iadeEt` gerçekten
     * `dogru: 0, toplam: 0` yazıyor mu, kaynaktan doğrula.
     */
    const src = fs.readFileSync(path.join(__dirname, "..", "lib", "kupon-settle.cjs"), "utf8");
    assert.ok(
      /dogru:\s*0,\s*toplam:\s*0/.test(src),
      "iadeEt artik dogru:0/toplam:0 yazmiyor — bu testin dayandigi bicim degismis"
    );
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("tam kupon rozeti", () => {
  test("gerçekten hepsini tutturan 1 rozet alıyor", async () => {
    const s = await satirlar();
    assert.equal(s.ali.tamKupon, 1, "8/8 yapan oyuncunun rozeti yanlis sayildi");
  });

  test("İADE EDİLEN kupon rozet KAZANDIRMIYOR", async () => {
    const s = await satirlar();
    assert.equal(
      s.veli.tamKupon, 0,
      "puanlanmamis (iade edilmis) kupon 'tam kupon' sayiliyor — 0 == 0 tuzagi"
    );
  });

  test("hiç tutturamayan rozet almıyor", async () => {
    const s = await satirlar();
    assert.equal(s.can.tamKupon, 0);
  });

  test("tablodaki toplam rozet, hak edilen sayıya eşit", async () => {
    const s = await satirlar();
    const toplam = Object.values(s).reduce((a, r) => a + r.tamKupon, 0);
    assert.equal(toplam, 1, `rozet enflasyonu: ${toplam} rozet dagitildi, hak edilen 1`);
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: rozet koşulu puanlanmış olmayı ŞART koşuyor", () => {
  /**
   * Çıplak `$eq: ["$dogru", "$toplam"]` geri gelirse sıfır-sıfır tuzağı da
   * geri gelir. Koşulda `toplam > 0` kontrolü bulunmalı.
   */
  const src = fs.readFileSync(path.join(__dirname, "..", "lib", "kupon-store.cjs"), "utf8")
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");

  assert.ok(/tamKupon/.test(src), "tamKupon alani kaybolmus — test bir sey olcmuyor");
  assert.ok(
    /\$gt:\s*\[\{\s*\$ifNull:\s*\["\$toplam"/.test(src),
    "rozet kosulunda 'toplam > 0' korumasi yok"
  );
});
