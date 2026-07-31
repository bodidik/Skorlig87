"use strict";

/**
 * MİNİ TURNUVA MAÇ BİLGİSİ SUNUCUDAN GELİR.
 *
 * ⚠️ BULUNAN: `/api/mini/create` maç alanlarını istek gövdesinden olduğu gibi
 * saklıyordu. Bunlardan `kickoffISO` GÖRÜNTÜ DEĞİL, KARAR verisi:
 *
 *     bitmeyeHazirMi → bayatMi({ fixtureId, kickoffISO })
 *     başlama saatinin üstünden BEKLEME_SAAT geçmişse maç "bayat" → YOK SAYILIR
 *
 * Yani kurucu her maça GEÇMİŞ bir saat yazarak turnuvayı istediği an
 * bitirilebilir hâle getiriyordu: kendi lehine sonuçlanan ilk maçtan sonra
 * `/board` çağırıp kalan maçları eleyip MINI_WIN_LC'yi alıyordu.
 *
 * ⚠️ SUNUCU YEDEĞİ VARDI AMA YETMİYORDU. `lib/bayat-mac.cjs` saat OKUNAMAZSA
 * depoya bakıyor — o dosyanın kendi notu bu alanın istemciden geldiğini zaten
 * yazıyor. Eksik olan: geçerli ama YALAN bir tarih yedeği hiç çalıştırmıyordu.
 * Doğru yerde durup yanlış soruyu soran bir savunma.
 */

const os = require("os");
const nodePath = require("path");
const fs = require("fs");

const TMP = nodePath.join(os.tmpdir(), "skorlig-mini-mac-test");
process.env.SKORLIG_DATA_DIR = TMP;
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const KULLANICI = "kurucu-1";
const GERCEK_SAAT = new Date(Date.now() + 8 * 3600_000).toISOString();  // 8 saat sonra
const YALAN_SAAT  = new Date(Date.now() - 90 * 3600_000).toISOString(); // 90 saat önce

const MACLAR = ["mfx-1", "mfx-2", "mfx-3"];

let mongod = null, client = null, db = null, server = null, taban = "";

before(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const { MongoClient } = require("mongodb");
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  db = client.db("test");

  await db.collection("fixtures").insertMany(
    MACLAR.map((fid, i) => ({
      fixtureId: fid,
      home: `EvTakim${i}`,
      away: `DepTakim${i}`,
      league: "Test Ligi",
      kickoffISO: GERCEK_SAAT,
      status: "NS",
    }))
  );

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
  app.use("/api/mini", require("../routes/mini.cjs"));
  await new Promise((r) => { server = app.listen(0, r); });
  taban = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) server.close();
  if (client) await client.close();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  /* ⚠️ İKİ DEPO BİRDEN. `SocialStore` mini turnuvayı Mongo'ya VE dosya
   * aynasına yazıyor; yalnızca Mongo'yu silmek yetmedi ve ikinci testten
   * itibaren `TOO_MANY_OPEN_MINI` kotasına takıldım — testler birbirinin
   * artığını görüyordu. */
  await db.collection("mini_tournaments").deleteMany({}).catch(() => {});
  fs.writeFileSync(
    nodePath.join(TMP, "mini-tournaments.json"),
    JSON.stringify({ items: [] })
  );
});

const kur = (fixtures, ad = "Turnuva") =>
  fetch(`${taban}/api/mini/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: ad, fixtures }),
  }).then((r) => r.json());

/** Gövdede YALAN saat ve YALAN takımlarla maç listesi. */
const yalanListe = () =>
  MACLAR.map((fid) => ({
    fixtureId: fid,
    home: "Uydurma Ev",
    away: "Uydurma Dep",
    kickoffISO: YALAN_SAAT,
    league: "Uydurma Lig",
  }));

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

test("turnuva gerçekten kuruluyor (test ölü değil)", async () => {
  const r = await kur(yalanListe());
  assert.equal(r.ok, true, `turnuva kurulamadi: ${JSON.stringify(r)}`);
  assert.ok(r.tournament?.id, "turnuva kimligi yok");
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("maç alanları", () => {
  test("gövdedeki kickoffISO YOK SAYILIR", async () => {
    const r = await kur(yalanListe());
    const kayit = await db.collection("mini_tournaments").findOne({ id: r.tournament.id });
    assert.ok(kayit, "turnuva Mongo'ya yazilmamis");

    for (const f of kayit.fixtures) {
      assert.equal(
        f.kickoffISO, GERCEK_SAAT,
        "govdedeki saat saklanmis — turnuva istenen an bitirilebilir hale gelir"
      );
    }
  });

  test("gövdedeki takım/lig adları da YOK SAYILIR", async () => {
    const r = await kur(yalanListe());
    const kayit = await db.collection("mini_tournaments").findOne({ id: r.tournament.id });
    for (const f of kayit.fixtures) {
      assert.ok(/^EvTakim\d$/.test(f.home), `uydurma ev sahibi saklanmis: ${f.home}`);
      assert.ok(/^DepTakim\d$/.test(f.away), `uydurma deplasman saklanmis: ${f.away}`);
      assert.equal(f.league, "Test Ligi");
    }
  });

  test("var olmayan fikstür ile turnuva kurulamaz", async () => {
    // Eskiden tamamen uydurma kimliklerle turnuva kurulabiliyordu.
    const r = await kur([
      { fixtureId: "yok-1", kickoffISO: YALAN_SAAT },
      { fixtureId: "yok-2", kickoffISO: YALAN_SAAT },
      { fixtureId: "yok-3", kickoffISO: YALAN_SAAT },
    ]);
    assert.equal(r.ok, false);
    assert.equal(r.error, "FIXTURE_NOT_FOUND");
    assert.deepEqual(r.fixtures, ["yok-1", "yok-2", "yok-3"]);
  });
});

/* ── Bayatlık kararı ─────────────────────────────────────────────────────── */

describe("bayatlık kararı", () => {
  test("gerçek saatle maçlar bayat DEĞİL (turnuva erken bitmez)", async () => {
    const { bayatMi } = require("../lib/bayat-mac.cjs");
    const d = await bayatMi({ fixtureId: MACLAR[0], kickoffISO: GERCEK_SAAT, db });
    assert.equal(d.bayat, false, `mac bayat sayildi (${d.sebep}) — turnuva hemen kapanirdi`);
  });

  test("YALAN saat verilse BİLE sunucu saati kazanır", async () => {
    /**
     * ⚠️ ASIL DEĞİŞMEZ. `bayatMi` artık önce fikstür deposuna bakıyor;
     * çağıranın verdiği saat yalnızca depoda karşılık yoksa kullanılıyor.
     *
     * Önceki hâli sunucuya YALNIZCA saat okunamazsa bakıyordu — geçerli ama
     * yalan bir tarih o yedeği hiç çalıştırmıyordu. Bu, sadece mini turnuvayı
     * değil DÜELLOYU da etkiliyordu: bayat sayılan düello geçersiz olup iki
     * tarafın bahsini iade ediyor.
     */
    const { bayatMi } = require("../lib/bayat-mac.cjs");
    const d = await bayatMi({ fixtureId: MACLAR[0], kickoffISO: YALAN_SAAT, db });
    assert.equal(
      d.bayat, false,
      `yalan saat hala bayatlik uretiyor (${d.sebep}) — sunucu degeri kazanmiyor`
    );
  });

  test("depoda karşılığı YOKSA çağıranın saati kullanılır (para kilitlenmesin)", async () => {
    /**
     * Kapalı tarafa fazla kaçmak da hata olurdu: depoda olmayan eski bir maç
     * hiç bayatlamazsa o kayda bağlı para SONSUZA KADAR kilitli kalır — bu
     * dosyanın önlemek için yazıldığı durumun ta kendisi.
     */
    const { bayatMi } = require("../lib/bayat-mac.cjs");
    const d = await bayatMi({ fixtureId: "depoda-yok-1", kickoffISO: YALAN_SAAT, db });
    assert.equal(d.bayat, true, `depoda olmayan mac icin cagiranin saati yok sayildi (${d.sebep})`);
  });

  test("kayıtta yalan saat KALSA bile karar sunucudan okunur", async () => {
    /**
     * ⚠️ Bu düzeltmeden ÖNCE kurulmuş turnuvalar hâlâ istemcinin saatini
     * taşıyor. Karar yolu da sunucuya bağlandı; aşağıda eski biçimde bir
     * kayıt elle yazılıp bunun gerçekten geçerli olduğu doğrulanıyor.
     */
    const r = await kur(yalanListe());

    /* ⚠️ KAYIT İKİ DEPODA BİRDEN BOZULMALI.
     *
     * İlk sürüm yalnızca Mongo'yu güncelliyordu ve test BOŞ YERE YEŞİLDİ:
     * negatif kontrol (sunucu aramasını kapatmak) testi kırmadı. İz koyunca
     * görüldü ki `/board` `loadAll()`u db ARGÜMANSIZ çağırıyor; üretimde
     * `getDbSafe` paylaşılan bağlantıya düşüyor ama testteki bellek-içi
     * Mongo'yu tanımıyor, yani okuma dosya aynasından yapılıyordu.
     * Hangi depo okunursa okunsun yalan değeri görsün diye ikisi de bozuluyor. */
    await db.collection("mini_tournaments").updateOne(
      { id: r.tournament.id },
      { $set: { "fixtures.$[].kickoffISO": YALAN_SAAT } }
    );
    const ayna = nodePath.join(TMP, "mini-tournaments.json");
    const icerik = JSON.parse(fs.readFileSync(ayna, "utf8"));
    for (const t of icerik.items || []) {
      if (t.id !== r.tournament.id) continue;
      for (const f of t.fixtures || []) f.kickoffISO = YALAN_SAAT;
    }
    fs.writeFileSync(ayna, JSON.stringify(icerik));

    const bozukMongo = await db.collection("mini_tournaments").findOne({ id: r.tournament.id });
    assert.equal(bozukMongo.fixtures[0].kickoffISO, YALAN_SAAT, "Mongo kurulumu tutmadi");
    const bozukAyna = JSON.parse(fs.readFileSync(ayna, "utf8")).items
      .find((t) => t.id === r.tournament.id);
    assert.equal(bozukAyna.fixtures[0].kickoffISO, YALAN_SAAT, "ayna kurulumu tutmadi");

    const board = await fetch(`${taban}/api/mini/board?id=${r.tournament.id}`).then((x) => x.json());
    assert.equal(board.ok, true);
    assert.ok(
      !board.tournament?.finishedAt,
      "yalan saat tasiyan eski kayit turnuvayi ERKEN bitirdi — karar hala kayittan okunuyor"
    );
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: create gövdeden maç alanı okumuyor", () => {
  const ham = fs.readFileSync(nodePath.join(__dirname, "..", "routes", "mini.cjs"), "utf8");
  const src = ham
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");

  const bas = src.indexOf('router.post("/create"');
  assert.ok(bas > 0, "create rotasi bulunamadi");
  const kalan = src.slice(bas + 10);
  const sonraki = kalan.search(/\r?\n(router\.|async function|function|module\.exports)/);
  const govde = sonraki > 0 ? src.slice(bas, bas + 10 + sonraki) : src.slice(bas);

  assert.ok(/FixturesStore\.getOne\s*\(/.test(govde), "fikstur deposundan okunmuyor");
  for (const alan of ["kickoffISO", "home", "away", "league"]) {
    assert.ok(
      !new RegExp(`f\\?\\.${alan}`).test(govde),
      `\`${alan}\` hala istek govdesinden okunuyor`
    );
  }
});
