"use strict";

/**
 * services/tournament.cjs settle, BAŞKA TURNUVANIN YAZMASINI EZMİYOR.
 *
 * ⚠️ KARDEŞ KUSURUN AYNISI, İKİNCİ ÖDEME YOLUNDA. `routes/settle2.cjs`
 * auto-settle düzeltildi (bkz. tests/turnuva-settle2-esdzamanlilik.test.cjs);
 * `settle` ise hâlâ şunu yapıyordu:
 *
 *     const data = await loadAll();          // TÜM turnuva listesi, snapshot
 *     ...                                     // puanlama, ödeme hesabı, mühür
 *     await saveAll(data);                    // TÜM KOLEKSİYONU snapshot'la DEĞİŞTİR
 *
 * `saveAll` → `SocialStore.saveTournaments` → `replaceAll`: koleksiyonun
 * tamamı verilen listeye eşitleniyor. Snapshot alındıktan sonra koleksiyona
 * düşen her belge — BAŞKA turnuvaya katılım, tahmin, yepyeni turnuva —
 * "fazlalık" sayılıp SİLİNİYORDU.
 *
 * SESSİZCE: `saveAll` hata vermiyor, ilgili uç `ok:true` dönüyor, giriş ücreti
 * çoktan tahsil edilmiş oluyor. Kullanıcı parasını verir, katıldın cevabını
 * alır ve turnuvada görünmez.
 *
 * ⚠️ İKİ ÖDEME YOLU AYNI MÜHRÜ PAYLAŞIYOR (`claimTournamentSettle`), yani bu
 * fonksiyonun snapshot'ı settle2'nin az önce yazdığı mührü de geri alabiliyordu:
 * "settled" damgalı turnuva yeniden "open" görünür, ödeme İKİNCİ KEZ yapılırdı.
 *
 * ⚠️ NEDEN YAKALANMADI: mevcut turnuva testleri (odeme-tek-kaynak,
 * odeme-yuvarlama, tek-katilimci) saf hesabı sınıyor ya da her işlemi TEK
 * BAŞINA çağırıyor. Snapshot yarışı yalnızca eşzamanlılıkta görünür.
 */

const os = require("os");
const nodePath = require("path");
const fs = require("fs");

const TMP = nodePath.join(os.tmpdir(), "skorlig-servis-settle-esdzaman-test");
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
process.env.SKORLIG_DATA_DIR = TMP;

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

const GIRIS = 10;
const BASLANGIC = 100;

let mongod = null, client = null, db = null, T = null, SocialStore = null;

before(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const { MongoClient } = require("mongodb");
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();

  /**
   * ⚠️ VERİTABANI ADI `lib/mongo.cjs` İLE AYNI OLMALI.
   *
   * `settle` içindeki `loadAll`/`saveAll` db parametresi ALMIYOR: global
   * bağlantıya gidiyorlar (`lib/mongo.cjs getDb()` → `skorlig`). `client.db("test")`
   * açılsaydı turnuvalar `skorlig`e yazılır, test boş koleksiyona bakar ve
   * "kayboldu" sonucunu kusur sanardı. Sıfır sonuç kanıt değildir — aşağıdaki
   * kurulum testi aynı db'ye baktığımızı ayrıca doğruluyor.
   */
  client = await MongoClient.connect(mongod.getUri());
  db = client.db("skorlig");

  T = require("../services/tournament.cjs");
  SocialStore = require("../lib/social-store.cjs");
});

after(async () => {
  /**
   * ⚠️ GLOBAL BAĞLANTI DA KAPATILMALI — YOKSA SÜREÇ BİTMİYOR.
   *
   * `loadAll`/`saveAll` kendi bağlantısını `lib/mongo.cjs getDb()` ile açıyor;
   * yalnızca aşağıdaki `client`ı kapatmak yetmiyor. Açık kalan havuz olay
   * döngüsünü canlı tutuyor: iddialar geçtiği hâlde koşucu kapanmıyor ve
   * `npm test` asılı kalıyor.
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

const tahmin = (o) => ({ outcome: o });

/** Turnuvayı DOĞRUDAN koleksiyona koyar: ölçülen şey `settle`, `create` değil. */
async function turnuvaKur({ id, code, fixtureIds, katilimcilar }) {
  const now = new Date().toISOString();
  await db.collection("tournaments").insertOne({
    id, code, name: code,
    creatorId: katilimcilar[0].userId,
    entryLC: GIRIS,
    fixtureIds,
    fixtures: [],
    participants: katilimcilar.map((k) => ({
      userId: k.userId, joinedAt: now, predictions: k.predictions || {}, totalScore: 0,
    })),
    pool: GIRIS * katilimcilar.length,
    status: "open",
    createdAt: now,
    settledAt: null,
    payouts: [],
  });
  await cuzdanKur(...katilimcilar.map((k) => k.userId));
}

/**
 * Mühür alınırken ARAYA GİREN atomik yazmayı çalıştırır.
 *
 * ⚠️ NEDEN `Promise.all` DEĞİL: araya giren yazma, snapshot okunduktan SONRA
 * ve toptan yazma yapılmadan ÖNCE düşmeli. Mühür tam bu aralıkta çağrılıyor,
 * dolayısıyla burası pencerenin kendisi. Zamanlamaya bırakılsa test bazen
 * yeşil yanar ve hiçbir şey söylemez.
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
  test("servis ve test AYNI veritabanına bakıyor", async () => {
    await turnuvaKur({
      id: "s_kurulum", code: "SKURUL", fixtureIds: ["fx-sk1", "fx-sk2"],
      katilimcilar: [{ userId: "sk-kurucu" }],
    });
    const kayit = await T.getByCode("SKURUL");
    assert.ok(
      kayit,
      "servis turnuvayi bulamadi — testin yazdigi db ile servisin okudugu db " +
      "ayri, asagidaki 'silindi' iddialari anlamsiz olurdu"
    );
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("settle BAŞKA turnuvanın yazmasını ezmiyor", () => {
  test("A sonuçlanırken B'ye gelen katılım korunuyor", async () => {
    await turnuvaKur({
      id: "s_A", code: "SAAAAA", fixtureIds: ["fx-sa1", "fx-sa2"],
      katilimcilar: [
        { userId: "sa-kurucu", predictions: { "fx-sa1": tahmin("H"), "fx-sa2": tahmin("D") } },
        { userId: "sa-uye", predictions: { "fx-sa1": tahmin("A") } },
      ],
    });
    await turnuvaKur({
      id: "s_B", code: "SBBBBB", fixtureIds: ["fx-sb1", "fx-sb2"],
      katilimcilar: [{ userId: "sb-kurucu" }],
    });
    await cuzdanKur("sb-katilan");

    // Araya giren katılım: tek belgeye atomik yazma — koşul filtrede,
    // katılımcı $push, havuz $inc.
    const araGiren = async () => {
      await db.collection("lc_wallet_users").updateOne(
        { userIdLower: "sb-katilan" },
        { $inc: { balance: -GIRIS, totalSpent: GIRIS } }
      );
      const r = await db.collection("tournaments").updateOne(
        { id: "s_B", status: "open", "participants.userId": { $ne: "sb-katilan" } },
        {
          $push: { participants: { userId: "sb-katilan", joinedAt: new Date().toISOString(), predictions: {}, totalScore: 0 } },
          $inc: { pool: GIRIS },
        }
      );
      assert.equal(r.modifiedCount, 1, "araya giren katilim yazilamadi — olcum kurulumu bozuk");
    };

    await muhurAninda(araGiren, () =>
      T.settle("SAAAAA", { "fx-sa1": { outcome: "H" }, "fx-sa2": { outcome: "D" } }, db)
    );

    const bKayit = await db.collection("tournaments").findOne({ id: "s_B" });
    const bListe = (bKayit?.participants || []).map((p) => String(p.userId).toLowerCase());
    const harcanan = BASLANGIC - (await bakiye("sb-katilan"));

    assert.ok(
      bListe.includes("sb-katilan"),
      `katilim BASARILI yazildi ama B'nin listesinde yok (${JSON.stringify(bListe)}) ` +
      `ve ${harcanan} LC alinmis — settle'in toptan saveAll'i BASKA turnuvanin ` +
      `atomik yazmasini ezdi`
    );
    assert.equal(
      bKayit.pool, GIRIS * 2,
      `B havuzu ${bKayit.pool}, beklenen ${GIRIS * 2} — toplanan ucretlerle odul ` +
      `havuzu ayrisiyor`
    );
    assert.equal(bKayit.status, "open", `B durumu ${bKayit.status} — hic sonuclanmamis olmaliydi`);

    /* Düzeltme settle'ı bozmamalı: A mühürlenmiş ve ödeme tablosu YAZILMIŞ
     * olmalı. `saveAll` kaldırılırken `payouts`un mühre taşınması şarttı. */
    const aKayit = await db.collection("tournaments").findOne({ id: "s_A" });
    assert.equal(aKayit.status, "settled", `A durumu: ${aKayit.status}`);
    assert.ok(
      Array.isArray(aKayit.payouts) && aKayit.payouts.length > 0,
      `A'nin payouts alani yazilmamis: ${JSON.stringify(aKayit.payouts)} — ` +
      `saveAll kaldirilirken payouts muhre tasinmamis`
    );
  });

  test("araya giren YENİ turnuva silinmiyor", async () => {
    /* Aynı kusurun ikinci yüzü: snapshot'ta hiç bulunmayan belge `replaceAll`
     * tarafından "fazlalık" sayılıp tamamen kaldırılıyordu. */
    await turnuvaKur({
      id: "s_C", code: "SCCCCC", fixtureIds: ["fx-sc1", "fx-sc2"],
      katilimcilar: [
        { userId: "sc-kurucu", predictions: { "fx-sc1": tahmin("H") } },
        { userId: "sc-uye", predictions: { "fx-sc2": tahmin("D") } },
      ],
    });

    await muhurAninda(
      async () => {
        await db.collection("tournaments").insertOne({
          id: "s_YENI", code: "SYENII", name: "Yeni", creatorId: "sy-kurucu",
          entryLC: GIRIS, fixtureIds: ["fx-sy1", "fx-sy2"], fixtures: [],
          participants: [{ userId: "sy-kurucu", joinedAt: new Date().toISOString(), predictions: {}, totalScore: 0 }],
          pool: GIRIS, status: "open", createdAt: new Date().toISOString(),
          settledAt: null, payouts: [],
        });
      },
      () => T.settle("SCCCCC", { "fx-sc1": { outcome: "H" }, "fx-sc2": { outcome: "D" } }, db)
    );

    const yeni = await db.collection("tournaments").findOne({ id: "s_YENI" });
    assert.ok(
      yeni,
      "settle sirasinda kurulan turnuva KAYBOLDU — kurucudan ucret alinmis, turnuva yok"
    );
  });

  test("settle2'nin az önce attığı mühür geri alınmıyor", async () => {
    /**
     * ⚠️ EN PAHALI HÂLİ: iki ödeme yolu AYNI mührü paylaşıyor. `settle`in
     * snapshot'ı, araya giren `claimTournamentSettle` yazmasını da geri
     * alabiliyordu — "settled" turnuva yeniden "open" görünür ve settle2 bir
     * sonraki taramada ödemeyi İKİNCİ KEZ yapardı.
     */
    await turnuvaKur({
      id: "s_D", code: "SDDDDD", fixtureIds: ["fx-sd1", "fx-sd2"],
      katilimcilar: [
        { userId: "sd-kurucu", predictions: { "fx-sd1": tahmin("H") } },
        { userId: "sd-uye", predictions: { "fx-sd2": tahmin("D") } },
      ],
    });
    await turnuvaKur({
      id: "s_E", code: "SEEEEE", fixtureIds: ["fx-se1", "fx-se2"],
      katilimcilar: [{ userId: "se-kurucu" }, { userId: "se-uye" }],
    });

    await muhurAninda(
      // E turnuvası, D sonuçlanırken BAŞKA bir çağrı tarafından mühürleniyor.
      () => SocialStore.claimTournamentSettle("s_E", new Date().toISOString(), db, {
        payouts: [{ rank: 1, userId: "se-kurucu", score: 0, lcWon: 20, pct: 100 }],
      }),
      () => T.settle("SDDDDD", { "fx-sd1": { outcome: "H" }, "fx-sd2": { outcome: "D" } }, db)
    );

    const eKayit = await db.collection("tournaments").findOne({ id: "s_E" });
    assert.equal(
      eKayit.status, "settled",
      `E durumu "${eKayit.status}" — settle'in snapshot'i BASKA bir cagrinin ` +
      `muhrunu geri aldi; turnuva yeniden "open" gorunur ve odeme IKINCI KEZ yapilir`
    );
    assert.ok(
      Array.isArray(eKayit.payouts) && eKayit.payouts.length === 1,
      `E'nin payouts alani silinmis: ${JSON.stringify(eKayit.payouts)}`
    );
  });
});

describe("katılımcı puanları kalıcı yazılıyor", () => {
  test("ödeme tablosuna girmeyen katılımcının puanı da kayda geçiyor", async () => {
    /**
     * ⚠️ `payouts` YETMEZ: 4 katılımcıda ödeme tablosu 3 kalem
     * (PAYOUT_TABLE[4]), n≥8'de 4 kalem. Geri kalanlar puanlarını yalnızca
     * `participants[].totalScore` üzerinden görüyor ve o alan
     * `getByCode`/`listByUser` ile istemciye dönüyor. `saveAll` kaldırılırken
     * hedefli bir yazma konmasaydı sonuçlanan turnuvada 4. sıradaki oyuncunun
     * puanı 0 kalırdı.
     *
     * Odds kaydı yok → varsayılan {H:2, D:3, A:2}, puan = 10 × odds.
     */
    await turnuvaKur({
      id: "s_P", code: "SPPPPP", fixtureIds: ["fx-sp1", "fx-sp2", "fx-sp3"],
      katilimcilar: [
        { userId: "sp1", predictions: { "fx-sp1": tahmin("H"), "fx-sp2": tahmin("D"), "fx-sp3": tahmin("A") } }, // 70
        { userId: "sp2", predictions: { "fx-sp1": tahmin("H"), "fx-sp2": tahmin("D"), "fx-sp3": tahmin("H") } }, // 50
        { userId: "sp3", predictions: { "fx-sp2": tahmin("D") } },                                                // 30
        { userId: "sp4", predictions: { "fx-sp1": tahmin("H") } },                                                // 20
      ],
    });

    await T.settle("SPPPPP", {
      "fx-sp1": { outcome: "H" }, "fx-sp2": { outcome: "D" }, "fx-sp3": { outcome: "A" },
    }, db);

    const kayit = await db.collection("tournaments").findOne({ id: "s_P" });
    assert.equal(kayit.status, "settled", `durum: ${kayit.status}`);
    assert.equal(kayit.payouts.length, 3, `payouts ${kayit.payouts.length} kalem — tablo 3 bekliyordu`);

    const puan = Object.fromEntries(kayit.participants.map((p) => [p.userId, p.totalScore]));
    assert.deepEqual(
      puan, { sp1: 70, sp2: 50, sp3: 30, sp4: 20 },
      `katilimci puanlari kayda gecmemis: ${JSON.stringify(puan)} — odeme tablosuna ` +
      `girmeyen sp4 puanini yalnizca bu alandan gorebiliyor`
    );

    /* Hedefli yazmanın YAN ETKİSİ olmamalı. */
    assert.equal(kayit.participants.length, 4, "katilimci sayisi degismis");
    assert.equal(
      kayit.participants.find((p) => p.userId === "sp4").predictions["fx-sp1"].outcome, "H",
      "puan yazimi tahmin verisini bozdu"
    );
  });
});

describe("düzeltme settle'ın kendi işini bozmuyor", () => {
  test("ödeme cüzdana gerçekten yazılıyor", async () => {
    /* ⚠️ "Snapshot yazımını kaldır" düzeltmesi kolayca fazla kesebilir. Ödeme
     * yolunun hâlâ çalıştığı ayrıca sınanıyor — yoksa turnuva mühürlenir,
     * kimse para almaz ve testler yeşil kalır. */
    await turnuvaKur({
      id: "s_O", code: "SOOOOO", fixtureIds: ["fx-so1", "fx-so2"],
      katilimcilar: [
        { userId: "so1", predictions: { "fx-so1": tahmin("H"), "fx-so2": tahmin("D") } },
        { userId: "so2", predictions: { "fx-so1": tahmin("A") } },
      ],
    });

    const t = await T.settle("SOOOOO", {
      "fx-so1": { outcome: "H" }, "fx-so2": { outcome: "D" },
    }, db);

    const toplamOdenen = t.payouts.reduce((a, p) => a + Number(p.lcWon || 0), 0);
    assert.ok(toplamOdenen > 0, "hic odeme hesaplanmamis");
    assert.ok(toplamOdenen <= GIRIS * 2, `odeme havuzu asiyor: ${toplamOdenen} > ${GIRIS * 2}`);

    const birinci = t.payouts[0];
    assert.equal(
      await bakiye(birinci.userId), BASLANGIC + birinci.lcWon,
      `${birinci.userId} cuzdanina odeme yazilmamis — muhur atildi ama para dagitilmadi`
    );
  });

  test("ikinci settle çağrısı ALREADY_SETTLED alıyor (çift ödeme yok)", async () => {
    await turnuvaKur({
      id: "s_R", code: "SRRRRR", fixtureIds: ["fx-sr1", "fx-sr2"],
      katilimcilar: [
        { userId: "sr1", predictions: { "fx-sr1": tahmin("H") } },
        { userId: "sr2", predictions: { "fx-sr2": tahmin("D") } },
      ],
    });

    await T.settle("SRRRRR", { "fx-sr1": { outcome: "H" }, "fx-sr2": { outcome: "D" } }, db);
    const sonrasi = { sr1: await bakiye("sr1"), sr2: await bakiye("sr2") };

    await assert.rejects(
      () => T.settle("SRRRRR", { "fx-sr1": { outcome: "H" }, "fx-sr2": { outcome: "D" } }, db),
      /ALREADY_SETTLED/,
      "ikinci settle cagrisi reddedilmedi — cift odeme"
    );
    assert.equal(await bakiye("sr1"), sonrasi.sr1, "sr1 ikinci kez odendi");
    assert.equal(await bakiye("sr2"), sonrasi.sr2, "sr2 ikinci kez odendi");
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: settle koleksiyon geneli yazma yapmıyor", () => {
  /**
   * Davranış testleri kusuru yakalar; bu nöbetçi NEDENİ söyler ve satır geri
   * gelirse anında gösterir. `saveAll` → `SocialStore.saveTournaments` →
   * `replaceAll`: koleksiyonun tamamı verilen listeye eşitleniyor, yani
   * çağıranın snapshot'ında olmayan her belge SİLİNİYOR.
   *
   * ⚠️ Mühür VARKEN `saveAll` da kalmışsa kusur geri gelir: mühür doğru yazar,
   * hemen ardından snapshot her şeyi geri alır. Tam bu olmuştu.
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

  const bas = kod.indexOf("async function settle(");
  assert.ok(bas > 0, "settle bulunamadi");
  const kalan = kod.slice(bas + 10);
  const bit = kalan.search(/\n(async )?function /);
  const govde = bit >= 0 ? kalan.slice(0, bit) : kalan;

  assert.ok(
    !/\bsaveAll\s*\(/.test(govde),
    "settle yine saveAll cagiriyor — replaceAll TUM koleksiyonu snapshot ile " +
    "degistirir; araya giren katilim, tahmin, yeni turnuva ve hatta settle2'nin " +
    "muhru SILINIR"
  );
  assert.ok(
    /claimTournamentSettle\([^)]*,[^)]*,[^)]*,\s*\{/.test(govde),
    "payouts muhre gecilmiyor — turnuva settled olur ama odeme tablosu yazilmaz"
  );
  assert.ok(
    /setTournamentScoresAtomik\(/.test(govde),
    "katilimci puanlari icin hedefli yazma kayip — odeme tablosuna girmeyen " +
    "oyuncularin puani 0 kalir"
  );
});
