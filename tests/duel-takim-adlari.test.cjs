"use strict";

/**
 * DÜELLO TAKIM ADLARI SUNUCUDAN GELİR.
 *
 * ⚠️ BULUNAN: `/api/duels/create` takım adlarını İSTEK GÖVDESİNDEN alıp
 * düelloya yazıyordu, ve sonuçlandırma tam o adlarla puanı hesaplıyor:
 *
 *     const odds = calcOdds(duel.home, duel.away);        // duels.cjs settle
 *     if (oc === "H") return odds.home;                   // düello puanı
 *
 * `calcOdds` yalnızca takım adlarına bakan bir derecelendirme tablosu
 * (services/odds-engine.cjs). Yani düelloyu KURAN, kendi düellosunun puan
 * ağırlıklarını yazabiliyordu: zayıf bir takımı "ev sahibi" diye etiketleyip
 * kendi tahmininin oranını yükseltmek mümkündü.
 *
 * ⚠️ İKİNCİ ETKİ — YANILTMA: adlar rakibe olduğu gibi gösteriliyor
 * (`duelMatchLabel`, düello listesi). Gerçek `fixtureId` başka bir maçken
 * ekranda "Galatasaray – Fenerbahçe" yazdırmak mümkündü.
 *
 * ⚠️ NEDEN DAVRANIŞ TESTİ: metin taraması "gövdeden okunuyor mu" sorusunu
 * cevaplar ama "sonuçta ne saklandı" sorusunu cevaplamaz. Burada uç gerçekten
 * çağrılıyor ve YAZILAN kayda bakılıyor.
 */

const os = require("os");
const nodePath = require("path");
const fs = require("fs");

const TMP = nodePath.join(os.tmpdir(), "skorlig-duel-takim-test");
process.env.SKORLIG_DATA_DIR = TMP;
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const GERCEK_EV = "Kasimpasa";
const GERCEK_DEP = "Alanyaspor";
const UYDURMA_EV = "Erokspor";
const UYDURMA_DEP = "Real Madrid";

const FID = "fx-takim-1";
const KULLANICI = "oyuncu-1";

let mongod = null, client = null, db = null, server = null, taban = "";

before(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const { MongoClient } = require("mongodb");
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  db = client.db("test");

  /* Fikstür GERÇEK takımlarla, başlamasına çok var (kilit kapısı geçsin).
   * ⚠️ Denge kapısı da bu adlarla çalışıyor: dengesiz bir eşleşme seçilirse
   * düello MATCH_TOO_LOPSIDED ile reddedilir ve test hiçbir şey ölçmez.
   * Bu yüzden birbirine yakın iki takım seçildi (aşağıda doğrulanıyor). */
  await db.collection("fixtures").insertOne({
    fixtureId: FID,
    home: GERCEK_EV,
    away: GERCEK_DEP,
    kickoffISO: new Date(Date.now() + 6 * 3600_000).toISOString(),
    status: "NS",
  });

  await db.collection("lc_wallet_users").insertOne({
    userId: KULLANICI, userIdLower: KULLANICI, balance: 500,
    totalEarned: 0, totalSpent: 0, createdAt: new Date().toISOString(),
  });

  /* ⚠️ KİMLİK ARA KATMANI DEĞİŞTİRİLİYOR — rotadan ÖNCE.
   *
   * `duels.cjs` `verifyToken`ı kendi içinde uca bağlıyor, yani dışarıdan bir
   * `app.use` ile atlanamaz: ilk denemede uç 401 AUTH_REQUIRED döndü ve test
   * hiçbir şey ölçmedi. Modül önbelleği rotadan önce değiştiriliyor.
   * (Bu testin konusu yetki değil, saklanan verinin KAYNAĞI.) */
  const vtYol = require.resolve("../middleware/verifyToken.cjs");
  require("../middleware/verifyToken.cjs");
  require.cache[vtYol].exports = {
    ...require.cache[vtYol].exports,
    verifyToken: (req, _res, next) => { req.uid = KULLANICI; next(); },
    optionalToken: (req, _res, next) => { req.uid = KULLANICI; next(); },
  };

  const express = require("express");
  const app = express();
  app.locals.db = db;
  app.use(express.json());
  app.use("/api", require("../routes/duels.cjs"));
  await new Promise((r) => { server = app.listen(0, r); });
  taban = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) server.close();
  if (client) await client.close();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  /* ⚠️ SİLME STORE'DAN GEÇMELİ.
   *
   * Ham `deleteMany` yalnızca Mongo'yu boşaltıyor; `data/duels.json` aynası
   * dokunulmadan kalıyordu. Bir sonraki API çağrısında `duelsMongoYetkili`
   * `estimatedDocumentCount() === 0` gördüğü için dosya aynasına düşüyor,
   * `tohumla()` de dosyadaki eski düelloları Mongo'ya GERİ yazıyordu:
   *
   *   [social-store] TOHUMLAMA: duels bos, dosyadan 3 kayit yaziliyor
   *
   * Sonuç: `acikDuelloSayisi` üç açık düello görüyor, `TOO_MANY_OPEN_DUELS`
   * dönüyor, "düello gerçekten kuruluyor" testi patlıyordu. Aynıyı çağırıp
   * dosyayı da temizliyoruz — `saveDuels([])` iki tarafı da sıfırlar. */
  const SocialStore = require("../lib/social-store.cjs");
  await SocialStore.saveDuels([], db);
  await db.collection("lc_wallet_users").updateOne(
    { userIdLower: KULLANICI }, { $set: { balance: 500 } }
  );
});

const kur = (govde) =>
  fetch(`${taban}/api/duels/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fixtureId: FID, stake: 10, ...govde }),
  }).then((r) => r.json());

/* ── Önce testin bir şey ölçtüğünden emin ol ─────────────────────────────── */

describe("kurulum sağlam", () => {
  test("seçilen maç düelloya UYGUN (denge kapısı reddetmiyor)", async () => {
    const { duelloyaUygunMu } = require("../lib/mac-denge.cjs");
    const d = await duelloyaUygunMu(FID, db);
    assert.equal(
      d.uygun, true,
      `secilen mac dengesiz (olasilik=${d.olasilik}) — duello hic kurulamaz, test olu olurdu`
    );
  });

  test("düello gerçekten kuruluyor", async () => {
    const r = await kur({});
    assert.equal(r.ok, true, `duello kurulamadi: ${JSON.stringify(r)}`);
    const kayit = await db.collection("duels").findOne({ id: r.duel.id });
    assert.ok(kayit, "duello Mongo'ya yazilmamis");
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("takım adları", () => {
  test("gövdedeki adlar YOK SAYILIR, fikstürdekiler saklanır", async () => {
    const r = await kur({ home: UYDURMA_EV, away: UYDURMA_DEP });
    assert.equal(r.ok, true);

    const kayit = await db.collection("duels").findOne({ id: r.duel.id });
    assert.equal(kayit.home, GERCEK_EV, "govdedeki ev sahibi saklanmis — puan agirligi kurana birakilmis");
    assert.equal(kayit.away, GERCEK_DEP, "govdedeki deplasman saklanmis");
  });

  test("gövde HİÇ ad göndermese de adlar dolu gelir", async () => {
    // Eski davranışta istemci ad göndermezse kayıt boş kalıyordu ve
    // sonuçlandırma tarafsız orana düşüyordu — artık sunucu dolduruyor.
    const r = await kur({});
    const kayit = await db.collection("duels").findOne({ id: r.duel.id });
    assert.equal(kayit.home, GERCEK_EV);
    assert.equal(kayit.away, GERCEK_DEP);
  });

  test("uydurma adlar ORANI değiştirebiliyordu (açığın büyüklüğü)", () => {
    /**
     * Bu test düzeltmeyi sınamıyor; açığın neden önemli olduğunu ÖLÇÜYOR.
     * Fark küçük olsaydı bulgu da küçük olurdu.
     */
    const { calcOdds } = require("../services/odds-engine.cjs");
    const gercek = calcOdds(GERCEK_EV, GERCEK_DEP);
    const uydurma = calcOdds(UYDURMA_EV, UYDURMA_DEP);
    const kat = uydurma.home / gercek.home;

    /* ÖLÇÜLDÜ: gerçek maçta ev sahibi oranı 2.57; "Erokspor – Real Madrid"
     * etiketiyle 120.97 (47 kat). Ters yönde "Real Madrid – Erokspor" ile
     * deplasman oranı 300.94 çıkıyor. Yani kurana bırakılan sayı, oyunun
     * doğal aralığının iki basamak üstüne çıkabiliyordu.
     *
     * Eşik 10x: bulgunun etkisi bundan küçülürse anlatım abartılı kalır. */
    assert.ok(
      kat >= 10,
      `uydurma adlarin ev sahibi orani yalnizca ${kat.toFixed(2)} kat degistiriyor — ` +
      "bulgunun etkisi olculdugunden kucuk, aciklama duzeltilmeli"
    );
    assert.ok(
      calcOdds(UYDURMA_DEP, UYDURMA_EV).away >= 100,
      "ters yonde de asiri oran uretilemiyor — olcum notu bayatlamis olabilir"
    );
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: create gövdeden takım adı okumuyor", () => {
  const ham = fs.readFileSync(nodePath.join(__dirname, "..", "routes", "duels.cjs"), "utf8");
  // Yorumları boşalt: bu dosyanın kendi düzeltme notu `home`/`away` geçiyor.
  const src = ham
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");

  const bas = src.indexOf('router.post("/duels/create"');
  assert.ok(bas > 0, "create rotasi bulunamadi");
  const kalan = src.slice(bas + 10);
  const sonraki = kalan.search(/\r?\n(router\.|async function|function|module\.exports)/);
  const govde = sonraki > 0 ? src.slice(bas, bas + 10 + sonraki) : src.slice(bas);

  assert.ok(/macTakimlari\s*\(/.test(govde), "takim adlari sunucudan cozulmuyor");
  assert.ok(
    !/req\.body[\s\S]{0,200}\bhome\b/.test(govde),
    "govdeden `home` okunuyor — puan agirligi yeniden kurana birakilmis"
  );
});
