"use strict";

/**
 * settle2 OTOMATİK SONUÇLANDIRMA, BAŞKA TURNUVANIN YAZMASINI EZMİYOR.
 *
 * ⚠️ BULUNAN: `routes/settle2.cjs tryAutoSettleTournaments` fonksiyonun
 * BAŞINDA tüm turnuva listesini okuyor (`loadTournaments`), döngü boyunca o
 * bellek içi snapshot'ı değiştiriyor ve EN SONDA `saveTournaments(all, db)`
 * ile TÜM KOLEKSİYONU o snapshot'la değiştiriyordu
 * (`lib/social-store.cjs saveTournaments` → `replaceAll`).
 *
 * Arada koleksiyona düşen her atomik yazma — BAŞKA bir turnuvaya katılım,
 * tahmin, yeni turnuva — snapshot'ta bulunmadığı için SİLİNİYORDU. Üstelik
 * SESSİZCE: `replaceAll` başarıyla tamamlanıyor, katılım ucu `ok:true`
 * dönüyor, giriş ücreti çoktan tahsil edilmiş oluyor. Kullanıcı parasını
 * verir, "katıldın" cevabını alır ve turnuvada görünmez.
 *
 * Pencere dar değil: döngü her turnuva için fikstür durum dosyalarını okuyor
 * ve kazananların cüzdanlarına tek tek yazıyor.
 *
 * ⚠️ AYNI SINIF `services/tournament.cjs`TE ÖLÇÜLMÜŞTÜ (settle → saveAll):
 * A turnuvası sonuçlanırken B'ye katılım geldi; `join` BAŞARILI döndü ama B'nin
 * katılımcı listesinde yoktu ve 10 LC gitmişti. settle2 CANLI yol — mührü
 * neredeyse hep o alıyor, elle çağrılan uç nadir.
 *
 * ⚠️ NEDEN YAKALANMADI: mevcut turnuva testleri (havuz-asimi, zaman-asimi)
 * KAYNAK TARAMASI yapıyor, davranış ölçmüyor; ötekiler her işlemi tek başına
 * çağırıyor. Snapshot yarışı yalnızca eşzamanlılıkta görünür.
 *
 * ⚠️ İKİ MÜHÜR YERİ VAR, DÜZELTME İKİSİNİ DE İLGİLENDİRİYOR:
 * `claimTournamentSettle` koşulsuz `status:"settled"` yazıyor; zaman aşımı
 * yolunun `"voided"` durumu eskiden döngü sonundaki toptan yazma ile
 * DÜZELTİLİYORDU. Toptan yazma öylece silinseydi iptal edilen turnuvalar
 * "settled" damgasıyla kalırdı — ücretleri iade edilmiş, ama sonuçlanmış
 * görünen turnuvalar. Bu yüzden aşağıda iptal yolu AYRICA sınanıyor.
 */

const os = require("os");
const nodePath = require("path");
const fs = require("fs");

const TMP = nodePath.join(os.tmpdir(), "skorlig-settle2-esdzaman-test");
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(nodePath.join(TMP, "live"), { recursive: true });
process.env.SKORLIG_DATA_DIR = TMP;

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

const GIRIS = 10;
const BASLANGIC = 100;
const GUN = 86400000;

let mongod = null, client = null, db = null, Settle2 = null, SocialStore = null;

before(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const { MongoClient } = require("mongodb");
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();

  /**
   * ⚠️ VERİTABANI ADI `lib/mongo.cjs` İLE AYNI OLMALI.
   *
   * `SocialStore` db parametresi verilmediğinde global bağlantıyı kullanıyor
   * (`getDbSafe(null)` → `lib/mongo.cjs getDb()` → `skorlig`). Kardeş testte
   * `client.db("test")` açılmış ve turnuvalar `skorlig`e yazılmıştı: "katılımcı
   * listesi boş" sonucu kusur sanılmıştı. Sıfır sonuç kanıt değildir —
   * aşağıdaki kurulum testi aynı db'ye baktığımızı ayrıca doğruluyor.
   */
  client = await MongoClient.connect(mongod.getUri());
  db = client.db("skorlig");

  // MONGODB_URI kurulduktan SONRA yüklenmeli: modüller DATA_DIR ve ayna
  // bayraklarını yükleme anında okuyor.
  Settle2 = require("../routes/settle2.cjs");
  SocialStore = require("../lib/social-store.cjs");
});

after(async () => {
  /**
   * ⚠️ GLOBAL BAĞLANTI DA KAPATILMALI — YOKSA SÜREÇ BİTMİYOR.
   *
   * `SocialStore` db parametresi verilmediğinde `lib/mongo.cjs getDb()` ile
   * KENDİ bağlantısını açıyor; yalnızca aşağıdaki `client`ı kapatmak yetmiyor.
   * Açık kalan havuz olay döngüsünü canlı tutuyor: test iddiaları geçtiği hâlde
   * koşucu kapanmıyor ve `npm test` asılı kalıyor.
   */
  try { await require("../lib/mongo.cjs").close(); } catch {}
  if (client) await client.close();
  if (mongod) await mongod.stop();
});

/* ── Yardımcılar ─────────────────────────────────────────────────────────── */

async function cuzdanKur(...kullanicilar) {
  for (const u of kullanicilar) {
    await db.collection("lc_wallet_users").updateOne(
      { userIdLower: u.toLowerCase() },
      { $set: { userId: u, userIdLower: u.toLowerCase(), balance: BASLANGIC, totalEarned: 0, totalSpent: 0 } },
      { upsert: true }
    );
  }
}

const bakiye = async (u) =>
  Number((await db.collection("lc_wallet_users").findOne({ userIdLower: u.toLowerCase() }))?.balance);

/** Fikstürü FT olarak işaretler — `getFixtureOutcome` bu dosyayı okuyor. */
function fiksturBitti(fid, home, away) {
  fs.writeFileSync(
    nodePath.join(TMP, "live", `${fid}.json`),
    JSON.stringify({ status: "FT", score: { home, away } })
  );
}

/** Turnuvayı DOĞRUDAN koleksiyona koyar: ölçülen şey settle2, create değil. */
async function turnuvaKur({ id, code, fixtureIds, katilimcilar, yasGun = 0 }) {
  const t = {
    id, code,
    name: code,
    creatorId: katilimcilar[0].userId,
    entryLC: GIRIS,
    fixtureIds,
    fixtures: [],
    participants: katilimcilar.map((k) => ({
      userId: k.userId,
      joinedAt: new Date(Date.now() - yasGun * GUN).toISOString(),
      predictions: k.predictions || {},
      totalScore: 0,
    })),
    pool: GIRIS * katilimcilar.length,
    status: "open",
    createdAt: new Date(Date.now() - yasGun * GUN).toISOString(),
    settledAt: null,
    payouts: [],
  };
  await db.collection("tournaments").insertOne({ ...t });
  await cuzdanKur(...katilimcilar.map((k) => k.userId));
  return t;
}

const tahmin = (o) => ({ outcome: o });

/**
 * Mühür alınırken ARAYA GİREN atomik yazmayı çalıştırır.
 *
 * ⚠️ NEDEN `Promise.all` DEĞİL: yarışın hangi anda düştüğü ölçümü belirliyor.
 * Araya giren yazma snapshot okunduktan SONRA, toptan yazma yapılmadan ÖNCE
 * düşmeli. Mühür tam bu aralıkta çağrılıyor, dolayısıyla burası pencerenin
 * kendisi — zamanlamaya bırakılırsa test bazen yeşil yanar ve hiçbir şey
 * söylemez.
 */
async function muhurAninda(isi, govde) {
  const orijinal = SocialStore.claimTournamentSettle;
  let calisti = false;
  SocialStore.claimTournamentSettle = async (...a) => {
    if (!calisti) { calisti = true; await isi(); }
    return orijinal.apply(SocialStore, a);
  };
  try {
    return await govde();
  } finally {
    SocialStore.claimTournamentSettle = orijinal;
  }
}

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("settle2 ve test AYNI veritabanına bakıyor", async () => {
    await turnuvaKur({
      id: "t_kurulum", code: "KURULM", fixtureIds: ["fx-k1", "fx-k2"],
      katilimcilar: [{ userId: "kurulum-k" }],
    });
    const kayit = await db.collection("tournaments").findOne({ id: "t_kurulum" });
    assert.ok(
      kayit,
      "turnuva testin baktigi veritabaninda YOK — asagidaki 'silindi' " +
      "iddialari anlamsiz olurdu"
    );
  });

  test("tryAutoSettleTournaments dışa açık", () => {
    assert.equal(
      typeof Settle2.tryAutoSettleTournaments, "function",
      "fonksiyon disa acilmamis — es zamanlilik ancak dogrudan cagirarak olculebiliyor"
    );
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("auto-settle BAŞKA turnuvanın yazmasını ezmiyor", () => {
  test("A sonuçlanırken B'ye gelen katılım korunuyor", async () => {
    fiksturBitti("fx-a1", 2, 0);
    fiksturBitti("fx-a2", 1, 1);

    await turnuvaKur({
      id: "t_A", code: "AAAAAA", fixtureIds: ["fx-a1", "fx-a2"],
      katilimcilar: [
        { userId: "a-kurucu", predictions: { "fx-a1": tahmin("H"), "fx-a2": tahmin("D") } },
        { userId: "a-uye", predictions: { "fx-a1": tahmin("A") } },
      ],
    });
    await turnuvaKur({
      id: "t_B", code: "BBBBBB", fixtureIds: ["fx-b1", "fx-b2"],
      katilimcilar: [{ userId: "b-kurucu" }],
    });

    // Araya giren katılım: tek belgeye atomik yazma — `joinTournamentAtomik`
    // ne yapıyorsa o (koşul filtrede, katılımcı $push, havuz $inc).
    const araGiren = async () => {
      await db.collection("lc_wallet_users").updateOne(
        { userIdLower: "b-katilan" },
        { $inc: { balance: -GIRIS, totalSpent: GIRIS } }
      );
      const r = await db.collection("tournaments").updateOne(
        { id: "t_B", status: "open", "participants.userId": { $ne: "b-katilan" } },
        {
          $push: { participants: { userId: "b-katilan", joinedAt: new Date().toISOString(), predictions: {}, totalScore: 0 } },
          $inc: { pool: GIRIS },
        }
      );
      assert.equal(r.modifiedCount, 1, "araya giren katilim yazilamadi — olcum kurulumu bozuk");
    };

    await cuzdanKur("b-katilan");
    await muhurAninda(araGiren, () =>
      Settle2.tryAutoSettleTournaments("fx-a1", "H", db)
    );

    const bKayit = await db.collection("tournaments").findOne({ id: "t_B" });
    const bListe = (bKayit?.participants || []).map((p) => String(p.userId).toLowerCase());
    const harcanan = BASLANGIC - (await bakiye("b-katilan"));

    assert.ok(
      bListe.includes("b-katilan"),
      `katilim BASARILI yazildi ama B'nin listesinde yok (${JSON.stringify(bListe)}) ` +
      `ve ${harcanan} LC alinmis — auto-settle'in toptan saveTournaments'i BASKA ` +
      `turnuvanin atomik yazmasini ezdi`
    );
    assert.equal(
      bKayit.pool, GIRIS * 2,
      `B havuzu ${bKayit.pool}, beklenen ${GIRIS * 2} — toplanan ucretlerle odul ` +
      `havuzu ayrisiyor`
    );
    assert.equal(
      bKayit.status, "open",
      `B durumu ${bKayit.status} — hic sonuclanmamis olmaliydi`
    );

    /* Düzeltme auto-settle'ı bozmamalı: A gerçekten mühürlenmiş ve ödeme
     * tablosu YAZILMIŞ olmalı. Toptan yazma kaldırılırken `payouts`un mühre
     * taşınması şarttı. */
    const aKayit = await db.collection("tournaments").findOne({ id: "t_A" });
    assert.equal(aKayit.status, "settled", `A durumu: ${aKayit.status}`);
    assert.ok(
      Array.isArray(aKayit.payouts) && aKayit.payouts.length > 0,
      `A'nin payouts alani yazilmamis: ${JSON.stringify(aKayit.payouts)} — ` +
      `toptan yazma kaldirilirken payouts muhre tasinmamis`
    );
    assert.equal(
      aKayit.payouts.reduce((s, p) => s + Number(p.lcWon || 0), 0) <= aKayit.pool, true,
      "odeme havuzu asiyor"
    );
  });

  test("araya giren YENİ turnuva silinmiyor", async () => {
    /* Aynı kusurun ikinci yüzü: snapshot'ta hiç bulunmayan bir belge,
     * `replaceAll` "fazlalık" saydığı için tamamen kaldırılıyordu. */
    fiksturBitti("fx-c1", 3, 1);
    fiksturBitti("fx-c2", 0, 0);

    await turnuvaKur({
      id: "t_C", code: "CCCCCC", fixtureIds: ["fx-c1", "fx-c2"],
      katilimcilar: [
        { userId: "c-kurucu", predictions: { "fx-c1": tahmin("H") } },
        { userId: "c-uye", predictions: { "fx-c2": tahmin("D") } },
      ],
    });

    await muhurAninda(
      async () => {
        await db.collection("tournaments").insertOne({
          id: "t_YENI", code: "YENIII", name: "Yeni", creatorId: "y-kurucu",
          entryLC: GIRIS, fixtureIds: ["fx-y1", "fx-y2"], fixtures: [],
          participants: [{ userId: "y-kurucu", joinedAt: new Date().toISOString(), predictions: {}, totalScore: 0 }],
          pool: GIRIS, status: "open", createdAt: new Date().toISOString(),
          settledAt: null, payouts: [],
        });
      },
      () => Settle2.tryAutoSettleTournaments("fx-c1", "H", db)
    );

    const yeni = await db.collection("tournaments").findOne({ id: "t_YENI" });
    assert.ok(
      yeni,
      "auto-settle sirasinda kurulan turnuva KAYBOLDU — kurucudan ucret alinmis, " +
      "turnuva yok"
    );
  });
});

describe("iptal (voided) yolu düzeltmeden sonra da doğru", () => {
  test("zaman aşımına uğrayan turnuva 'voided' kalıyor, 'settled' değil", async () => {
    /**
     * ⚠️ EN KOLAY YAPILACAK HATA BU. `claimTournamentSettle` koşulsuz
     * `status:"settled"` yazıyor; iptal hâlini eskiden döngü sonundaki toptan
     * `saveTournaments` düzeltiyordu. Toptan yazma yalnızca SİLİNSEYDİ, iptal
     * edilen turnuva "settled" damgasıyla kalırdı: ücretleri iade edilmiş ama
     * kayıtta sonuçlanmış görünen, ödemesi olmayan turnuva.
     */
    fiksturBitti("fx-z1", 1, 0);
    // fx-z2 için durum dosyası YOK → turnuva tamamlanamıyor.

    await turnuvaKur({
      id: "t_Z", code: "ZZZZZZ", fixtureIds: ["fx-z1", "fx-z2"],
      katilimcilar: [{ userId: "z-kurucu" }, { userId: "z-uye" }],
      yasGun: 10,
    });

    await Settle2.tryAutoSettleTournaments("fx-z1", "H", db);

    const kayit = await db.collection("tournaments").findOne({ id: "t_Z" });
    assert.equal(
      kayit.status, "voided",
      `durum "${kayit.status}" — muhur kosulsuz "settled" yaziyor ve iptal ` +
      `alanlari ayni islemde gecilmemis; ucreti iade edilmis turnuva ` +
      `sonuclanmis gorunuyor`
    );
    assert.equal(kayit.voidReason, "FIXTURE_TIMEOUT", `voidReason: ${kayit.voidReason}`);
    assert.deepEqual(kayit.payouts, [], `iptal edilen turnuvada payouts: ${JSON.stringify(kayit.payouts)}`);
    assert.ok(kayit.settledAt, "settledAt yazilmamis");

    /* İade gerçekten yapılmış olmalı — yoksa "voided" yalnızca bir etiket. */
    assert.equal(await bakiye("z-kurucu"), BASLANGIC + GIRIS, "z-kurucu iadesi eksik");
    assert.equal(await bakiye("z-uye"), BASLANGIC + GIRIS, "z-uye iadesi eksik");
  });
});

describe("katılımcı puanları kalıcı yazılıyor", () => {
  test("ödeme tablosuna girmeyen katılımcının puanı da kayda geçiyor", async () => {
    /**
     * ⚠️ `payouts` YETMEZ: 4 katılımcıda ödeme tablosu 3 kalem
     * (PAYOUT_TABLE[4]), n≥8'de 4 kalem. Geri kalan katılımcılar puanlarını
     * yalnızca `participants[].totalScore` üzerinden görüyor ve o alan
     * `GET /api/tournaments/:code` ile istemciye dönüyor. Toptan yazma
     * kaldırılırken bu alan için hedefli bir yazma konmasaydı, sonuçlanan
     * turnuvada 4. sıradaki oyuncunun puanı 0 kalırdı.
     */
    fiksturBitti("fx-p1", 2, 0);   // H → 10 × 2   = 20
    fiksturBitti("fx-p2", 1, 1);   // D → 10 × 3   = 30
    fiksturBitti("fx-p3", 0, 2);   // A → 10 × 2   = 20

    await turnuvaKur({
      id: "t_P", code: "PPPPPP", fixtureIds: ["fx-p1", "fx-p2", "fx-p3"],
      katilimcilar: [
        { userId: "p1", predictions: { "fx-p1": tahmin("H"), "fx-p2": tahmin("D"), "fx-p3": tahmin("A") } }, // 70
        { userId: "p2", predictions: { "fx-p1": tahmin("H"), "fx-p2": tahmin("D"), "fx-p3": tahmin("H") } }, // 50
        { userId: "p3", predictions: { "fx-p2": tahmin("D") } },                                             // 30
        { userId: "p4", predictions: { "fx-p1": tahmin("H") } },                                             // 20
      ],
    });

    await Settle2.tryAutoSettleTournaments("fx-p1", "H", db);

    const kayit = await db.collection("tournaments").findOne({ id: "t_P" });
    assert.equal(kayit.status, "settled", `durum: ${kayit.status}`);
    assert.equal(kayit.payouts.length, 3, `payouts ${kayit.payouts.length} kalem — tablo 3 bekliyordu`);

    const puan = Object.fromEntries(kayit.participants.map((p) => [p.userId, p.totalScore]));
    assert.deepEqual(
      puan, { p1: 70, p2: 50, p3: 30, p4: 20 },
      `katilimci puanlari kayda gecmemis: ${JSON.stringify(puan)} — odeme tablosuna ` +
      `girmeyen p4 puanini yalnizca bu alandan gorebiliyor`
    );

    /* Hedefli yazmanın YAN ETKİSİ olmamalı: tahminler ve katılım bilgisi
     * arrayFilters yazımından sonra da yerinde durmalı. */
    assert.equal(kayit.participants.length, 4, "katilimci sayisi degismis");
    assert.equal(
      kayit.participants.find((p) => p.userId === "p4").predictions["fx-p1"].outcome, "H",
      "puan yazimi tahmin verisini bozdu"
    );
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: auto-settle koleksiyon geneli yazma yapmıyor", () => {
  /**
   * Davranış testleri kusuru yakalar; bu nöbetçi NEDENİ söyler ve satır geri
   * gelirse anında gösterir. `SocialStore.saveTournaments` → `replaceAll`:
   * koleksiyonun tamamı verilen listeye eşitleniyor, yani çağıranın
   * snapshot'ında olmayan her belge SİLİNİYOR.
   */
  const src = fs.readFileSync(
    nodePath.join(__dirname, "..", "routes", "settle2.cjs"), "utf8"
  );
  const kod = src.split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");

  const bas = kod.indexOf("async function tryAutoSettleTournaments(");
  assert.ok(bas > 0, "tryAutoSettleTournaments bulunamadi");
  const kalan = kod.slice(bas + 10);
  const bit = kalan.search(/\n(async )?function /);
  const govde = bit >= 0 ? kalan.slice(0, bit) : kalan;

  assert.ok(
    !/saveTournaments\s*\(/.test(govde),
    "tryAutoSettleTournaments yine toptan saveTournaments cagiriyor — " +
    "replaceAll TUM koleksiyonu snapshot ile degistirir ve araya giren atomik " +
    "yazmalari (baska turnuvaya katilim, yeni turnuva) SILER; ucret alinmis " +
    "kullanici turnuvada gorunmez"
  );
  assert.ok(
    /claimTournamentSettle\(/.test(govde),
    "muhur cagrisi kayip — cift odeme riski"
  );
  assert.ok(
    /setTournamentScoresAtomik\(/.test(govde),
    "katilimci puanlari icin hedefli yazma kayip — odeme tablosuna girmeyen " +
    "oyuncularin puani 0 kalir"
  );
});

test("NÖBETÇİ: iptal alanları mührün KENDİ işleminde geçiliyor", () => {
  /**
   * `claimTournamentSettle` koşulsuz `status:"settled"` yazdığı için
   * `voided` durumunun ek alan olarak geçilmesi ŞART. Ayrı bir yazmaya
   * bölünürse aradaki pencerede turnuva "settled" görünür.
   */
  const src = fs.readFileSync(
    nodePath.join(__dirname, "..", "routes", "settle2.cjs"), "utf8"
  );
  const idx = src.indexOf("FIXTURE_TIMEOUT");
  assert.ok(idx > 0, "FIXTURE_TIMEOUT bulunamadi");
  const oncesi = src.slice(Math.max(0, idx - 600), idx);
  assert.ok(
    /claimTournamentSettle\([^)]*,[^)]*,[^)]*,\s*\{/.test(oncesi + src.slice(idx, idx + 300)),
    "iptal yolu muhre ek alan gecmiyor — turnuva 'settled' damgasiyla kalir"
  );
});

test("NÖBETÇİ: mühür ek alanları varsayılanlardan SONRA yayıyor", () => {
  /**
   * Sıra ters olsaydı `status:"settled"` varsayılanı `"voided"`i ezerdi ve
   * iptal yolu sessizce çalışmaz hâle gelirdi — testler dışında hiçbir yerde
   * görünmeyen bir gerileme.
   */
  const src = fs.readFileSync(
    nodePath.join(__dirname, "..", "lib", "social-store.cjs"), "utf8"
  );
  assert.ok(
    /\$set:\s*\{\s*status:\s*"settled",\s*settledAt:\s*damga,\s*\.\.\.\(ekAlanlar\s*\|\|\s*\{\}\)\s*\}/.test(src),
    "claimTournamentSettle ek alanlari varsayilanlardan SONRA yaymiyor"
  );
});
