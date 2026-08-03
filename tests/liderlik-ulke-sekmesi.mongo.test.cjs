"use strict";

/**
 * ÜLKE SEKMESİ MONGO'DAN OKUR — GERÇEK ROTA.
 *
 * ⚠️ BULUNAN KUSUR (2026-08-03, routes/leaderboard.cjs): `/countries` ucu
 * YALNIZCA totals.json'a bakıyordu, oysa AYNI DOSYADAKİ `/` ucu Mongo
 * öncelikli. `totals.json` git'te izlenmiyor (.gitignore `data/*`) ve Render'ın
 * diski geçici — her deploy'dan sonra ilk sonuçlanma yazana kadar dosya YOK.
 *
 * ÖLÇÜLDÜ (gerçek rota, veri dizini Render'daki gibi yalnızca git dosyalarıyla,
 * üretim Mongo'suna karşı):
 *     GET /api/leaderboard            → havuz 1758
 *     GET /api/leaderboard?country=…  → havuz  200
 *     GET /api/leaderboard/countries  → 0 ÜLKE      ← sekme bomboş
 * Düzeltmeden sonra aynı koşulda: 27 ülke · 1678 oyuncu, sekme = tablo.
 *
 * ⚠️ BEŞİNCİ TEKRAR: `lib/season-totals.cjs` tam bu yüzden yazılmış ve başlığı
 * "aynı hatanın dördüncü kez tekrarlanmaması için okuma buraya toplandı" diyor.
 * leaderboard/groups/friends taşınmış, AYNI DOSYADAKİ bu uç atlanmış.
 *
 * ⚠️ ÜRETİME DOKUNMAZ: bellek-içi Mongo + geçici veri dizini.
 */

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const KOK = path.join(__dirname, "..");

// ⚠️ VERİ DİZİNİ ROTA YÜKLENMEDEN ÖNCE AYARLANMALI: TOTALS_FILE modül
// düzeyinde hesaplanıyor, sonradan değiştirmek GERÇEK data/ dizinine bakardı.
const VERI_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "skorlig-ulke-"));
process.env.SKORLIG_DATA_DIR = VERI_DIR;

/**
 * ⚠️ RENDER'I DOĞRU TAKLİT ET — İLK YAZIMIM YANLIŞ SENARYOYDU.
 *
 * Dizini tamamen boş bırakmıştım; o zaman `bot-profiles.json` de yok sayılıyor,
 * BOT_PROFILE_MAP boşalıyor ve test "hiç ülke yok" diye çöküyordu. Ama o hâl
 * üretimde HİÇ oluşmaz: bu dosyalar .gitignore'da AÇIKÇA muaf tutulmuş
 * (`!data/bot-profiles.json` …), yani depoyla birlikte deploy edilir.
 *
 * Geçici disk yalnızca İZLENMEYEN dosyaları siler — `totals.json` bunlardan.
 * Ayrım tam olarak budur ve testin ölçtüğü şey de budur.
 */
for (const ad of ["bot-profiles.json", "bot-legacy-ids.json", "countries-teams.json"]) {
  const kaynak = path.join(__dirname, "..", "data", ad);
  if (fs.existsSync(kaynak)) fs.copyFileSync(kaynak, path.join(VERI_DIR, ad));
}

const express = require("express");
const { BOT_PROFILE_MAP } = require(path.join(KOK, "lib", "botIds.cjs"));
const { countryOfSegment } = require(path.join(KOK, "lib", "bot-countries.cjs"));
const Season = require(path.join(KOK, "lib", "season.cjs"));

let mongod = null, client = null, db = null, srv = null, port = 0;

/** Ülkesi çözülebilen ilk N botu döndürür (ülke → kimlikler). */
function botlariTopla(hedefUlkeSayisi) {
  const ulkeler = new Map();
  for (const [id, b] of BOT_PROFILE_MAP) {
    const c = countryOfSegment(b.segment);
    if (!c) continue;
    if (!ulkeler.has(c)) ulkeler.set(c, []);
    if (ulkeler.get(c).length < 3) ulkeler.get(c).push(id);
    if (ulkeler.size >= hedefUlkeSayisi && [...ulkeler.values()].every((v) => v.length >= 2)) break;
  }
  return ulkeler;
}

const ULKELER = botlariTopla(3);

before(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const { MongoClient } = require("mongodb");
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  db = client.db("test");

  const sezon = Season.seasonKey();
  const kayitlar = [];
  for (const [, idler] of ULKELER) {
    for (const id of idler) {
      kayitlar.push({
        season: sezon, userId: id, userIdLower: id.toLowerCase(),
        totalPoints: 10, totalPenalty: 0, matches: 3,
        lastAt: new Date().toISOString(),
      });
    }
  }
  await db.collection("season_totals").insertMany(kayitlar);

  const app = express();
  app.locals.db = db;
  app.use("/api/leaderboard", require(path.join(KOK, "routes", "leaderboard.cjs")));
  await new Promise((r) => { srv = app.listen(0, r); });
  port = srv.address().port;
});

after(async () => {
  srv?.close();
  await client?.close();
  await mongod?.stop();
  try { fs.rmSync(VERI_DIR, { recursive: true, force: true }); } catch { /* geçici dizin */ }
});

const g = async (u) => (await fetch(`http://127.0.0.1:${port}${u}`)).json();

describe("liderlik ülke sekmesi — Mongo öncelikli okuma", () => {
  test("kurulum sınandı: totals.json GERÇEKTEN YOK ve tohum ülke içeriyor", () => {
    /**
     * ⚠️ Bu olmadan iddia boş: dosya varsa eski kod da çalışırdı ve test
     * "Mongo'dan okuyor"u hiç kanıtlamazdı. Render'daki gerçek koşul bu.
     */
    assert.equal(fs.existsSync(path.join(VERI_DIR, "totals.json")), false,
      "test veri dizininde totals.json var — senaryo Render'i temsil etmiyor");
    assert.ok(fs.existsSync(path.join(VERI_DIR, "bot-profiles.json")),
      "bot-profiles.json kopyalanmamis — bu dosya git'te izleniyor, Render'da VARDIR");
    assert.ok(BOT_PROFILE_MAP.size > 0,
      "bot haritasi bos — senaryo yanlis, test bir sey olcmuyor");
    assert.ok(ULKELER.size >= 2,
      `tohumda yeterli ulke yok (${ULKELER.size}) — test bir sey olcmuyor`);
  });

  test("totals.json YOKKEN sekme DOLU gelir", async () => {
    const c = await g("/api/leaderboard/countries");
    assert.equal(c.ok, true);
    assert.ok(c.count >= ULKELER.size,
      `ulke sekmesi bos/eksik (${c.count}) — dosya yoksa Mongo'dan okunmuyor`);
    const toplam = c.items.reduce((a, b) => a + b.players, 0);
    assert.ok(toplam > 0, "sekmede hic oyuncu sayilmamis");
  });

  test("SEKME SAYISI = TABLO HAVUZU (aynı ekranda iki farklı sayı olmasın)", async () => {
    /**
     * ⚠️ ASIL KULLANICI ZARARI. Sekme "Türkiye 200" deyip tıklayınca başka
     * sayı çıkarsa kullanıcı hangisine inanacağını bilemez. İki uç aynı
     * kaynaktan okuduğu sürece bu eşitlik kendiliğinden korunur.
     */
    const c = await g("/api/leaderboard/countries");
    for (const satir of c.items) {
      const t = await g(
        `/api/leaderboard?scope=country&country=${encodeURIComponent(satir.country)}&limit=1`
      );
      assert.equal(t.scope.poolSize, satir.players,
        `${satir.country}: sekme ${satir.players}, tablo ${t.scope.poolSize}`);
    }
  });

  test("?humans=1 sekmede de geçerli (bot sayımı iki uçta aynı anlam)", async () => {
    /**
     * ⚠️ `/` botları çıkarabiliyorken sekme çıkaramazsa, insan kipine geçen
     * kullanıcı yine şişmiş sayılar görür. Tohumun TAMAMI bot olduğu için
     * insan kipi boş olmalı — bu da ayrımın gerçekten uygulandığını gösterir.
     */
    const ch = await g("/api/leaderboard/countries?humans=1");
    assert.equal(ch.humansOnly, true, "humansOnly yanitta bildirilmiyor");
    assert.equal(ch.count, 0,
      "tohumun tamami bot ama insan kipinde ulke sayiliyor — bot ayrimi uygulanmiyor");
  });

  test("NÖBETÇİ: uç totals.json'u DOĞRUDAN okumuyor", () => {
    /**
     * ⚠️ ASIL KIRILGANLIK. Biri "dosyadan okumak daha hızlı" diye eski hâle
     * dönerse kusur aynen geri gelir ve HATA VERMEZ — yalnızca Render'da
     * sekme boş kalır. Okuma tek yerden: lib/season-totals.cjs.
     */
    const src = fs.readFileSync(path.join(KOK, "routes", "leaderboard.cjs"), "utf8");
    const bas = src.indexOf('router.get("/countries"');
    assert.ok(bas > 0, "countries ucu bulunamadi");
    const govde = src.slice(bas);
    assert.ok(!/readJson\(\s*TOTALS_FILE/.test(govde),
      "countries ucu totals.json'u DOGRUDAN okuyor — Render'da dosya yok");
    assert.ok(/SeasonTotals\.loadTotals\(/.test(govde),
      "ortak okuyucu (lib/season-totals.cjs) kullanilmiyor");
  });

  test("TERS RİSK: Mongo da dosya da yoksa uç ÇÖKMEZ, boş döner", async () => {
    /* ⚠️ Boş liste ile 500 farklı şeyler: sekme boş kalabilir ama ekran
     * kırılmamalı. `db` yokken de yanıt vermeli. */
    const app2 = express();
    app2.locals.db = null;
    app2.use("/api/leaderboard", require(path.join(KOK, "routes", "leaderboard.cjs")));
    const s2 = app2.listen(0);
    const p2 = s2.address().port;
    const r = await (await fetch(`http://127.0.0.1:${p2}/api/leaderboard/countries`)).json();
    s2.close();
    assert.equal(r.ok, true, "db yokken uc hata donuyor");
    assert.ok(Array.isArray(r.items), "items dizi degil");
  });
});
