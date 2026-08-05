"use strict";

/**
 * TURNUVA YAZMALARI EŞZAMANLI ÇAĞRIDA BİRBİRİNİ EZMİYOR.
 *
 * ⚠️ BULUNAN: `services/tournament.cjs` içindeki üç yazma yolu da aynı deseni
 * kullanıyordu — `loadAll()` ile TÜM turnuva listesini oku, snapshot'ı
 * değiştir, `saveAll()` ile TÜM KOLEKSİYONU o snapshot'la DEĞİŞTİR
 * (`lib/social-store.cjs saveTournaments` → `replaceAll`).
 *
 * İki çağrı aynı anda gelirse ikisi de aynı snapshot'ı okur; sonra yazan
 * ötekinin işini SİLER. Üstelik SESSİZCE: `saveAll` hata vermediği için
 * `create`/`join` içindeki iade kolları ("create_save_failed",
 * "join_save_failed") hiç çalışmaz ve uç `ok:true` döner.
 *
 * ÖLÇÜLDÜ (bellek-içi Mongo, giriş 10 LC):
 *
 *   create  — 4 eşzamanlı çağrı → 3'ü BAŞARILI döndü, koleksiyonda 0 turnuva,
 *             3 kurucudan 30 LC alınmış, hiçbiri turnuvasına sahip değil
 *   join    — 4 eşzamanlı çağrı → 4'ü BAŞARILI döndü, kayıtta kurucu + 1
 *             katılımcı, 3 kişiden 30 LC alınmış, havuz 20 (olması gereken 50)
 *   predict — 3 eşzamanlı çağrı → 3'ü BAŞARILI döndü, kayıtta 1 tahmin
 *
 * Yani kullanıcı parasını verir, "katıldın" cevabını alır ve turnuvada
 * görünmez. Tahmin kaybında para doğrudan gitmez ama giriş ücreti ödenmiş
 * kişi puanlanamaz.
 *
 * ⚠️ NEDEN YAKALANMADI: mevcut turnuva testleri her işlemi TEK BAŞINA
 * çağırıyor. Tek çağrıda snapshot yarışı hiç oluşmaz; kusur yalnızca
 * eşzamanlılıkta görünür. Aynı sınıf `routes/duels.cjs`te bir kez düzeltilmiş
 * (atomik mühür deseni) ama turnuva o işten habersiz kalmış — dosyanın kendi
 * yorumu (satır 355) başka bir konuda aynı şeyi söylüyor: "ana oyunda bu kilit
 * iki kez sertleştirildi ama turnuva o işten habersizdi".
 */

const os = require("os");
const nodePath = require("path");
const fs = require("fs");

const TMP = nodePath.join(os.tmpdir(), "skorlig-turnuva-esdzaman-test");
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
process.env.SKORLIG_DATA_DIR = TMP;

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

const GIRIS = 10;
const BASLANGIC = 100;

let mongod = null, client = null, db = null, T = null;

before(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const { MongoClient } = require("mongodb");
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();

  /**
   * ⚠️ VERİTABANI ADI `lib/mongo.cjs` İLE AYNI OLMALI — ÖLÇERKEN BUNA TAKILDIM.
   *
   * `SocialStore` db parametresi verilmediğinde global bağlantıyı kullanıyor
   * (`getDbSafe(null)` → `lib/mongo.cjs getDb()` → `skorlig`). İlk ölçümümde
   * `client.db("test")` açmıştım: turnuvalar `skorlig`e, cüzdan `test`e
   * yazıldı ve "katılımcı listesi boş" sonucunu kusur sandım. Sıfır sonuç
   * kanıt değil — aşağıdaki kurulum testi bunu ayrıca doğruluyor.
   */
  client = await MongoClient.connect(mongod.getUri());
  db = client.db("skorlig");

  T = require("../services/tournament.cjs");
});

after(async () => {
  /**
   * ⚠️ GLOBAL BAĞLANTI DA KAPATILMALI — YOKSA SÜREÇ BİTMİYOR.
   *
   * `SocialStore` db parametresi verilmediğinde `lib/mongo.cjs getDb()` ile
   * KENDİ bağlantısını açıyor. Yalnızca aşağıdaki `client`ı kapatmak yetmiyor:
   * açık kalan havuz olay döngüsünü canlı tutuyor, test iddiaları geçtiği
   * hâlde koşucu kapanmıyor ve `npm test` asılı kalıyordu.
   *
   * Kardeş testler (stats-me, board2) bu tuzağa düşmüyor çünkü db'yi
   * `app.locals.db` ile enjekte ediyorlar; global bağlantı hiç açılmıyor.
   */
  try { await require("../lib/mongo.cjs").close(); } catch {}
  if (client) await client.close();
  if (mongod) await mongod.stop();
});

async function cuzdanKur(...kullanicilar) {
  for (const u of kullanicilar) {
    await db.collection("lc_wallet_users").updateOne(
      { userIdLower: u },
      { $set: { userId: u, userIdLower: u, balance: BASLANGIC, totalSpent: 0 } },
      { upsert: true }
    );
  }
}

const bakiye = async (u) =>
  Number((await db.collection("lc_wallet_users").findOne({ userIdLower: u }))?.balance);

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("servis ve test AYNI veritabanını kullanıyor", async () => {
    await cuzdanKur("kurulum-k");
    const t = await T.create({
      creatorId: "kurulum-k", name: "K", entryLC: GIRIS,
      fixtureIds: ["fx-k1", "fx-k2"], db,
    });
    const kayit = await db.collection("tournaments").findOne({ code: t.code });
    assert.ok(
      kayit,
      "olusturulan turnuva testin baktigi veritabaninda YOK — servis baska bir " +
      "db'ye yaziyor, asagidaki 'kayboldu' iddialari anlamsiz olurdu"
    );
  });

  test("ücret GERÇEKTEN tahsil ediliyor", async () => {
    /* Para kaybı iddiaları, ücretin alındığı varsayımına dayanıyor. */
    await cuzdanKur("kurulum-p");
    await T.create({
      creatorId: "kurulum-p", name: "P", entryLC: GIRIS,
      fixtureIds: ["fx-p1", "fx-p2"], db,
    });
    assert.equal(
      await bakiye("kurulum-p"), BASLANGIC - GIRIS,
      "create ucret almiyor — para kaybi olcumu bir sey olcmez"
    );
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("create eşzamanlı çağrıda kaybolmuyor", () => {
  test("4 kurucu aynı anda → 4 turnuva ve para kaybı yok", async () => {
    const KURUCULAR = ["c1", "c2", "c3", "c4"];
    await cuzdanKur(...KURUCULAR);

    const sonuc = await Promise.allSettled(
      KURUCULAR.map((u, i) => T.create({
        creatorId: u, name: `T${i}`, entryLC: GIRIS,
        fixtureIds: ["fx-1", "fx-2"], db,
      }))
    );
    const basarili = sonuc.filter((r) => r.status === "fulfilled").length;

    /* Parası alınıp turnuvası olmayan var mı? */
    const kayipsiz = [];
    for (const u of KURUCULAR) {
      const harcanan = BASLANGIC - (await bakiye(u));
      const turnuvasi = await db.collection("tournaments").findOne({ creatorId: u });
      if (harcanan > 0 && !turnuvasi) kayipsiz.push(`${u} (-${harcanan} LC)`);
    }

    assert.deepEqual(
      kayipsiz, [],
      `ucreti alinip turnuvasi olmayan kurucular: ${kayipsiz.join(", ")}. ` +
      `saveAll TUM koleksiyonu snapshot ile degistirdigi icin es zamanli ` +
      `create'ler birbirini siliyor ve iade kolu calismiyor (saveAll hata vermiyor).`
    );

    const kayitli = await db.collection("tournaments").countDocuments({
      creatorId: { $in: KURUCULAR },
    });
    assert.equal(
      kayitli, basarili,
      `${basarili} cagri basarili dondu ama ${kayitli} turnuva kayitli`
    );
  });
});

describe("join eşzamanlı çağrıda kaybolmuyor", () => {
  test("4 katılım aynı anda → hepsi listede, havuz tutuyor", async () => {
    const KURUCU = "j-kurucu";
    const KATILANLAR = ["j1", "j2", "j3", "j4"];
    await cuzdanKur(KURUCU, ...KATILANLAR);

    const t = await T.create({
      creatorId: KURUCU, name: "Join", entryLC: GIRIS,
      fixtureIds: ["fx-j1", "fx-j2"], db,
    });

    const sonuc = await Promise.allSettled(
      KATILANLAR.map((u) => T.join(t.code, u, db))
    );
    const basarili = sonuc.filter((r) => r.status === "fulfilled").length;

    const kayit = await db.collection("tournaments").findOne({ code: t.code });
    const listede = (kayit?.participants || []).map((p) => String(p.userId).toLowerCase());

    const parasiGiden = [];
    for (const u of KATILANLAR) {
      const harcanan = BASLANGIC - (await bakiye(u));
      if (harcanan > 0 && !listede.includes(u)) parasiGiden.push(`${u} (-${harcanan} LC)`);
    }

    assert.deepEqual(
      parasiGiden, [],
      `ucreti alinip katilimi silinen: ${parasiGiden.join(", ")} — kullanici ` +
      `"katildin" cevabi aldi ama turnuvada yok`
    );

    /* Havuz katılımcı sayısıyla uyumlu olmalı: kurucu + başarılı katılanlar. */
    assert.equal(
      kayit.pool, GIRIS * (1 + basarili),
      `havuz ${kayit.pool}, beklenen ${GIRIS * (1 + basarili)} — toplanan ` +
      `ucretlerle odul havuzu ayrisiyor`
    );
  });

  test("aynı kullanıcı iki kez katılamaz (çift tahsilat yok)", async () => {
    /* ⚠️ Atomik koşulun yanlış pozitif üretmediğini de sınıyoruz: düzeltme
     * "her çağrıyı kabul et" DEĞİL. İkinci katılım reddedilmeli ve para
     * alınmamalı/iade edilmeli. */
    const KURUCU = "d-kurucu", KATILAN = "d1";
    await cuzdanKur(KURUCU, KATILAN);

    const t = await T.create({
      creatorId: KURUCU, name: "Dup", entryLC: GIRIS,
      fixtureIds: ["fx-d1", "fx-d2"], db,
    });

    await T.join(t.code, KATILAN, db);
    const sonrasi = await bakiye(KATILAN);

    await T.join(t.code, KATILAN, db).catch(() => {});

    assert.equal(
      await bakiye(KATILAN), sonrasi,
      `ikinci katilim denemesi bakiyeyi degistirdi — cift tahsilat`
    );
    const kayit = await db.collection("tournaments").findOne({ code: t.code });
    const kac = (kayit.participants || [])
      .filter((p) => String(p.userId).toLowerCase() === KATILAN).length;
    assert.equal(kac, 1, `katilimci ${kac} kez listede`);
  });
});

describe("predict eşzamanlı çağrıda kaybolmuyor", () => {
  test("3 tahmin aynı anda → üçü de kayıtlı", async () => {
    const KISILER = ["t1", "t2", "t3"];
    await cuzdanKur(...KISILER);

    const t = await T.create({
      creatorId: KISILER[0], name: "Tahmin", entryLC: GIRIS,
      fixtureIds: ["fx-A", "fx-B"], db,
    });
    await T.join(t.code, KISILER[1], db);
    await T.join(t.code, KISILER[2], db);

    /* Maç kilidi geçilebilsin: fikstür kaydı yoksa "FIXTURE_NOT_FOUND" ile
     * kilitli sayılıyor (fail-closed, doğru davranış). */
    const gelecek = new Date(Date.now() + 3 * 3600 * 1000).toISOString();
    for (const fid of ["fx-A", "fx-B"]) {
      await db.collection("fixtures").updateOne(
        { fixtureId: fid },
        { $set: { fixtureId: fid, id: fid, home: "A", away: "B", kickoffISO: gelecek, status: "NS" } },
        { upsert: true }
      );
    }

    const sonuc = await Promise.allSettled([
      T.predict(t.code, KISILER[0], "fx-A", "H", db),
      T.predict(t.code, KISILER[1], "fx-A", "D", db),
      T.predict(t.code, KISILER[2], "fx-A", "A", db),
    ]);
    const basarili = sonuc.filter((r) => r.status === "fulfilled").length;

    const kayit = await db.collection("tournaments").findOne({ code: t.code });
    const tahminli = (kayit?.participants || [])
      .filter((p) => p.predictions && Object.keys(p.predictions).length > 0);

    assert.equal(
      tahminli.length, basarili,
      `${basarili} tahmin basarili dondu ama ${tahminli.length} tanesi kayitli ` +
      `— snapshot yazimi birbirini eziyor, giris ucreti odemis kisi puanlanamaz`
    );

    /* Her tahmin KENDİ sahibine yazılmış olmalı — arrayFilters hedefi
     * yanlış katılımcıya denk gelirse sayı tutar ama içerik karışır. */
    const sahibi = Object.fromEntries(
      tahminli.map((p) => [String(p.userId).toLowerCase(), p.predictions["fx-A"]?.outcome])
    );
    assert.equal(sahibi[KISILER[0]], "H", `t1 tahmini: ${sahibi[KISILER[0]]}`);
    assert.equal(sahibi[KISILER[1]], "D", `t2 tahmini: ${sahibi[KISILER[1]]}`);
    assert.equal(sahibi[KISILER[2]], "A", `t3 tahmini: ${sahibi[KISILER[2]]}`);
  });

  test("katılmayan kişi tahmin YAPAMAZ (yanlış pozitif üretilmiyor)", async () => {
    const KURUCU = "n-kurucu", YABANCI = "n-yabanci";
    await cuzdanKur(KURUCU, YABANCI);

    const t = await T.create({
      creatorId: KURUCU, name: "Nope", entryLC: GIRIS,
      fixtureIds: ["fx-N1", "fx-N2"], db,
    });
    const gelecek = new Date(Date.now() + 3 * 3600 * 1000).toISOString();
    await db.collection("fixtures").updateOne(
      { fixtureId: "fx-N1" },
      { $set: { fixtureId: "fx-N1", id: "fx-N1", home: "A", away: "B", kickoffISO: gelecek, status: "NS" } },
      { upsert: true }
    );

    await assert.rejects(
      () => T.predict(t.code, YABANCI, "fx-N1", "H", db),
      /NOT_JOINED/,
      "katilmayan kisi tahmin yapabildi"
    );
  });
});

describe("settle BAŞKA turnuvanın yazmasını ezmiyor", () => {
  test("A sonuçlanırken B'ye katılım korunuyor", async () => {
    /**
     * ⚠️ BU, İLK DÜZELTMENİN EKSİK KALAN YANIYDI.
     *
     * create/join/predict atomikleştirildikten sonra bile `settle` hâlâ
     * `saveAll(data)` çağırıyordu: fonksiyonun BAŞINDA alınmış snapshot TÜM
     * koleksiyonu değiştiriyor ve aradaki atomik yazmaları — BAŞKA
     * turnuvalara yapılanlar dahil — siliyordu.
     *
     * ÖLÇÜLDÜ: A sonuçlanırken B'ye katılım geldi; `join` BAŞARILI döndü ama
     * B'nin katılımcı listesinde yoktu, 10 LC gitmişti.
     *
     * Mühür (`claimTournamentSettle`) zaten `status`/`settledAt` yazıyordu;
     * tek eksik `payouts`tı ve o da artık aynı `updateOne` içinde.
     */
    await cuzdanKur("s-a-kurucu", "s-a-uye", "s-b-kurucu", "s-b-katilan");

    const A = await T.create({
      creatorId: "s-a-kurucu", name: "SA", entryLC: GIRIS,
      fixtureIds: ["fx-s1", "fx-s2"], db,
    });
    await T.join(A.code, "s-a-uye", db);

    const B = await T.create({
      creatorId: "s-b-kurucu", name: "SB", entryLC: GIRIS,
      fixtureIds: ["fx-s3", "fx-s4"], db,
    });

    const sonuc = await Promise.allSettled([
      T.settle(A.code, { "fx-s1": { outcome: "H" }, "fx-s2": { outcome: "D" } }, db),
      T.join(B.code, "s-b-katilan", db),
    ]);

    const bKayit = await db.collection("tournaments").findOne({ code: B.code });
    const bListe = (bKayit?.participants || []).map((p) => String(p.userId).toLowerCase());
    const harcanan = BASLANGIC - (await bakiye("s-b-katilan"));

    if (sonuc[1].status === "fulfilled") {
      assert.ok(
        bListe.includes("s-b-katilan"),
        `join BASARILI dondu ama B'nin katilimci listesinde yok ` +
        `(${JSON.stringify(bListe)}) ve ${harcanan} LC alinmis — settle'in ` +
        `saveAll'i baska turnuvanin atomik yazmasini ezdi`
      );
      assert.equal(
        bKayit.pool, GIRIS * 2,
        `B havuzu ${bKayit.pool}, beklenen ${GIRIS * 2}`
      );
    }

    /* Düzeltme settle'ı bozmamalı: A gerçekten sonuçlanmış ve payouts yazılmış
     * olmalı. `saveAll` kaldırılırken payouts'un mühre taşınması şarttı. */
    const aKayit = await db.collection("tournaments").findOne({ code: A.code });
    assert.equal(aKayit.status, "settled", `A durumu: ${aKayit.status}`);
    assert.ok(
      Array.isArray(aKayit.payouts) && aKayit.payouts.length > 0,
      `A'nin payouts alani yazilmamis: ${JSON.stringify(aKayit.payouts)} — ` +
      `saveAll kaldirilirken payouts muhre tasinmamis`
    );
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: üç yazma yolu da atomik depoyu kullanıyor", () => {
  /**
   * Kaynak taraması: `create`/`join`/`predict` gövdelerinde atomik çağrı
   * bulunmalı. Biri `saveAll` snapshot yazımına geri dönerse kusur sessizce
   * geri gelir — davranış testi yakalar ama bu nöbetçi NEDENİ söyler.
   */
  const src = fs.readFileSync(
    nodePath.join(__dirname, "..", "services", "tournament.cjs"), "utf8"
  );
  const kod = src.split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");

  const BEKLENEN = {
    create:  "insertTournamentAtomik",
    join:    "joinTournamentAtomik",
    predict: "setTournamentPredictionAtomik",
    /* settle kendi belgesini mühürle yazar; `saveAll`a geri dönerse BAŞKA
     * turnuvaların yazmalarını ezer (ölçüldü: 10 LC kayıp). */
    settle:  "claimTournamentSettle",
  };

  const eksik = [];
  for (const [fn, cagri] of Object.entries(BEKLENEN)) {
    const bas = kod.indexOf(`async function ${fn}(`);
    if (bas < 0) { eksik.push(`${fn} (fonksiyon bulunamadi)`); continue; }
    const kalan = kod.slice(bas + 10);
    const bit = kalan.search(/\n(async )?function /);
    const govde = bit >= 0 ? kalan.slice(0, bit) : kalan;
    if (!govde.includes(cagri)) eksik.push(`${fn} → ${cagri}`);

    /* ⚠️ Atomik çağrı VARKEN `saveAll` da kalmışsa kusur geri gelir: mühür
     * doğru yazar, hemen ardından snapshot her şeyi geri alır. Tam bu oldu —
     * ilk düzeltmede create/join/predict atomikti ama settle saveAll'a devam
     * ediyordu. NO_DB (Mongo yok) kolundaki saveAll meşru, onu saymıyoruz. */
    const noDbKolu = /reason === "NO_DB"/.test(govde);
    if (!noDbKolu && /\bsaveAll\s*\(/.test(govde)) {
      eksik.push(`${fn} → hala saveAll cagiriyor (snapshot yazimi)`);
    }
  }

  assert.deepEqual(
    eksik, [],
    `su yazma yollari atomik depoyu KULLANMIYOR: ${eksik.join(", ")}.\n` +
    `saveAll TUM koleksiyonu snapshot ile degistiriyor (replaceAll); es zamanli ` +
    `cagrilar birbirini siler ve ucret alinmis kullanici turnuvada gorunmez.`
  );
});

test("NÖBETÇİ: nokta içeren fixtureId tahmin yazmıyor", async () => {
  /**
   * ⚠️ Mongo alan adlarında nokta YOL AYIRACIDIR. `predictions.a.b` iç içe
   * belge kurar; tahmin yanlış yere yazılır ve okuma tarafı bulamaz. Sessizce
   * bozuk veri üretmektense reddetmek doğru.
   */
  const SocialStore = require("../lib/social-store.cjs");
  const r = await SocialStore.setTournamentPredictionAtomik(
    "ABC123", "biri", "fx.nokta.li", { outcome: "H" }, db
  );
  assert.equal(
    r.ok, false,
    "noktali fixtureId kabul edildi — Mongo ic ice belge kurar, tahmin kaybolur"
  );
  assert.equal(r.reason, "BAD_FIXTURE_ID", `beklenmeyen sebep: ${r.reason}`);
});
