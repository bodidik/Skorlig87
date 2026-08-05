"use strict";

/**
 * `?humans=1` FİLTRESİ KULLANICININ SIRASINI DA DÜZELTİYOR.
 *
 * ⚠️ BULUNAN: `routes/competition-totals.cjs` yanıtı bir `res.json`
 * sarmalayıcısıyla süzüyor — botları işaretleyip `?humans=1` ise listeden
 * çıkarıyor ve `count`u güncelliyordu. Ama `me.rank` FİLTRE ÖNCESİ
 * hesaplanmıştı (`pickMeAndCount` → `idx + 1`, tüm liste üzerinden) ve
 * sarmalayıcı ona hiç dokunmuyordu.
 *
 * Sonuç: kullanıcı listeyi botsuz, kendi sırasını botlar dahil görüyordu.
 *
 * ÖLÇÜLDÜ (20 bot + 1 insan, `?humans=1`):
 *     count = 1   ·   me.rank = 21
 * Yani "1 kişilik listede 21. sıradasın". Üretimde daha uç: dosyanın kendi
 * notu "1707 kaydın 1706'sı bot" diyor, yani insan listesi tek kişilikken
 * kullanıcıya 1707. sırada olduğu söyleniyordu.
 *
 * İstemci bunu gerçekten kullanıyor: `mobile/app/(tabs)/stats.tsx:312`
 * `humans=1` parametresini ekliyor.
 *
 * ⚠️ AYNI SINIF BU OTURUMDA ÜÇÜNCÜ KEZ: weekly-picks (tablo vs kendi sıram)
 * ve tr-league (ödül vs gösterim). Sıra hesabı, listeyi değiştiren her
 * filtrenin yeniden hesaplaması gereken bir türev.
 */

const os = require("os");
const nodePath = require("path");
const fs = require("fs");

const TMP = nodePath.join(os.tmpdir(), "skorlig-humans-sira-test");
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
process.env.SKORLIG_DATA_DIR = TMP;

/**
 * ⚠️ BOT KİMLİKLERİ TOHUMLANMALI. `lib/botIds.cjs` kimlikleri
 * `data/bot-profiles.json`dan yüklüyor; tohum olmadan `BOT_ID_SET` BOŞ kalır,
 * filtre hiçbir şey süzmez ve test "ayrışma yok" diye YANLIŞ geçer.
 * (Ölçüm sırasında tam bu oldu: "yeterli bot kimligi yok: 0".)
 */
const BOTLAR = Array.from({ length: 20 }, (_, i) => `bot-test-${i}`);
fs.writeFileSync(
  nodePath.join(TMP, "bot-profiles.json"),
  JSON.stringify(BOTLAR.map((id) => ({ id, name: id })))
);

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

const INSAN = "gercek-kullanici";

let mongod = null, client = null, db = null, server = null, taban = "";

before(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const { MongoClient } = require("mongodb");
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  db = client.db("skorlig");

  /* Gerçek dağılıma yakın: botlar yüksek puanlı, insan EN SONDA. */
  const docs = BOTLAR.map((b, i) => ({
    competitionId: "c1", userId: b, totalPoints: 1000 - i, matches: 10, totalPenalty: 0,
  }));
  docs.push({ competitionId: "c1", userId: INSAN, totalPoints: 5, matches: 3, totalPenalty: 0 });
  await db.collection("competition_totals").insertMany(docs);

  const express = require("express");
  const app = express();
  app.locals.db = db;
  app.use("/api/rt", require("../routes/competition-totals.cjs"));
  await new Promise((r) => { server = app.listen(0, r); });
  taban = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) server.close();
  if (client) await client.close();
  if (mongod) await mongod.stop();
});

const al = (uid, ek = "") =>
  fetch(`${taban}/api/rt/competition-totals?competitionId=c1&userId=${encodeURIComponent(uid)}${ek}`)
    .then((r) => r.json());

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("bot kimlikleri GERÇEKTEN yüklendi", () => {
    const { BOT_ID_SET } = require("../lib/botIds.cjs");
    assert.ok(
      BOT_ID_SET.size >= 5,
      `BOT_ID_SET ${BOT_ID_SET.size} kimlik tasiyor — tohum yuklenmemis, ` +
      `filtre hicbir sey suzmez ve test yanlis gecer`
    );
  });

  test("filtresiz listede botlar GÖRÜNÜYOR", async () => {
    const j = await al(INSAN);
    assert.equal(j.ok, true);
    assert.equal(
      j.count, BOTLAR.length + 1,
      `filtresiz count ${j.count} — tohum eksik, olcum anlamsiz olur`
    );
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("humans=1 sırayı da düzeltiyor", () => {
  test("me.rank filtrelenmiş listeye göre", async () => {
    const j = await al(INSAN, "&humans=1");
    assert.equal(j.count, 1, `insan sayisi ${j.count}`);
    assert.ok(j.me, "me yok");
    assert.ok(
      j.me.rank <= j.count,
      `liste ${j.count} kisilik ama me.rank ${j.me.rank} — sira filtre ONCESI ` +
      `hesaplanmis, kullanici "1 kisilik listede 21. siradayim" goruyor`
    );
    assert.equal(j.me.rank, 1, `tek insan 1. sirada olmali, ${j.me.rank} dondu`);
  });

  test("filtresiz çağrıda sıra DEĞİŞMİYOR (yanlış pozitif üretilmiyor)", async () => {
    /* Düzeltme "her zaman 1 döndür" değil: botlar listedeyken gerçek sıra
     * korunmalı. */
    const j = await al(INSAN);
    assert.equal(
      j.me.rank, BOTLAR.length + 1,
      `filtresiz sira ${j.me.rank}, beklenen ${BOTLAR.length + 1}`
    );
  });

  test("filtre sonrası listede olmayan kullanıcıya UYDURMA sıra verilmiyor", async () => {
    /* Bot kullanıcı `humans=1` ile listeden çıkar; ona sıra vermek yanlış
     * bilgi olur. `null` dürüst cevap. */
    const j = await al(BOTLAR[0], "&humans=1");
    if (j.me) {
      assert.equal(
        j.me.rank, null,
        `filtre disi kalan kullaniciya ${j.me.rank}. sira verilmis — ` +
        `listede olmayan birine sira uyduruluyor`
      );
    }
  });
});

describe("sorgu indeks kullanıyor", () => {
  test("competitionId sorgusu TÜM koleksiyonu taramıyor, sıralama bellekte değil", async () => {
    /**
     * ⚠️ İNDEKSSİZDİ. `find({ competitionId }).sort({ totalPoints: -1 })`
     * tüm koleksiyonu tarayıp sıralamayı BELLEKTE yapıyordu — yavaşlıktan
     * öte, Mongo'nun sıralama bellek sınırına takılırsa sorgu tamamen HATA
     * verir.
     *
     * ÖLÇÜLDÜ (30 000 kayıt / 20 yarışma):
     *     indekssiz : 56.50 ms · incelenen 30000 · bellekte sıralama VAR
     *     indeksli  : 22.85 ms · incelenen  1500 · bellekte sıralama YOK
     */
    await al(INSAN); // uç çağrılınca indeks kuruluyor

    const plan = await db.collection("competition_totals")
      .find({ competitionId: "c1" })
      .sort({ totalPoints: -1 })
      .explain("executionStats");

    assert.ok(
      !JSON.stringify(plan).includes('"SORT"'),
      "siralama BELLEKTE yapiliyor — bilesik indeks {competitionId:1, " +
      "totalPoints:-1} yok ya da sirasi ters. Buyuk yarismada sorgu bellek " +
      "sinirina takilip HATA verebilir."
    );
  });

  test("indeks GERÇEKTEN kurulmuş ve sırası doğru", async () => {
    await al(INSAN);
    const idx = await db.collection("competition_totals").indexes();
    const hedef = idx.find(
      (x) => x.key && x.key.competitionId === 1 && x.key.totalPoints === -1
    );
    assert.ok(
      hedef,
      `{competitionId:1, totalPoints:-1} indeksi yok: ` +
      `${JSON.stringify(idx.map((x) => x.key))} — sira onemli, ters olsaydi ` +
      `siralama yine bellekte kalirdi`
    );
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: filtre sarmalayıcısı me'ye dokunuyor", () => {
  const src = fs.readFileSync(
    nodePath.join(__dirname, "..", "routes", "competition-totals.cjs"), "utf8"
  );
  const kod = src.split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");

  const bas = kod.indexOf("res.json = (govde)");
  assert.ok(bas >= 0, "filtre sarmalayicisi bulunamadi — tarama bozuk");
  const govde = kod.slice(bas, bas + 1200);

  assert.ok(
    /\bme\b/.test(govde),
    "sarmalayici `me`ye hic dokunmuyor — listeyi suzup sirayi eski birakirsa " +
    "kullanici botlar dahil sirasini, listeyi botsuz gorur"
  );
  assert.ok(
    /findIndex/.test(govde),
    "sarmalayici sirayi YENIDEN hesaplamiyor — `me` sadece kopyalaniyorsa " +
    "filtre oncesi rank aynen gecer"
  );
});
