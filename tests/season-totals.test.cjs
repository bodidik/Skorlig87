"use strict";

/**
 * Sezon toplamları — settle2'nin Mongo yazımı.
 *
 * NEDEN VAR (bulundu 2026-07-29): routes/leaderboard.cjs birincil kaynak olarak
 * `season_totals` koleksiyonunu sorguluyordu ama oraya HİÇBİR YERDEN
 * yazılmıyordu. settle2 sezon toplamlarını yalnızca totals.json'a yazıyordu.
 * Zincir: season_totals boş → leaderboard totals.json'a düşüyor → Render'da
 * disk kalıcı değil → HER DEPLOY'DA TÜM SEZON PUANLARI SIFIRLANIYOR.
 *
 * Hata sessizdi: boş koleksiyon Mongo'da hata vermez, boş dizi döner; o da
 * "dosyaya düş" koluna giriyordu ve dosya yerelde doluydu.
 *
 * Bu testler settle2'nin yazdığı ŞEKLİ leaderboard'un okuduğu şekle karşı
 * tutar — ikisi ayrı dosyada olduğu için sessizce ayrışabilirler.
 *
 * Çalıştırma:  npm test
 */

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

let mongod = null;
let client = null;
let db = null;

before(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const { MongoClient } = require("mongodb");
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  db = client.db("test");
  await db.collection("season_totals").createIndex({ userIdLower: 1 }, { unique: true });
});

after(async () => {
  if (client) await client.close();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  await db.collection("season_totals").deleteMany({});
});

/**
 * settle2'deki blokla AYNI yazım. Orada değişirse burada da değişmeli —
 * ayrışırsa liderlik tablosu sessizce yanlış okur.
 */
async function settleRows(rows) {
  const nowISO = new Date().toISOString();
  const ops = rows.map((r) => {
    const uid = String(r.userId);
    const ceza =
      Number(r.detail?.zeroPenalty || 0) +
      Number(r.detail?.redSidePenalty || 0) +
      Number(r.detail?.penaltySidePenalty || 0);
    return {
      updateOne: {
        filter: { userIdLower: uid.toLowerCase() },
        update: {
          $inc: {
            totalPoints: Number(r.points || 0),
            totalPenalty: ceza,
            matches: 1,
          },
          $set: { userId: uid, lastAt: nowISO, updatedAt: nowISO },
          $setOnInsert: { userIdLower: uid.toLowerCase(), createdAt: nowISO },
        },
        upsert: true,
      },
    };
  });
  if (ops.length) await db.collection("season_totals").bulkWrite(ops, { ordered: false });
}

const oku = (uid) => db.collection("season_totals").findOne({ userIdLower: uid.toLowerCase() });

describe("season_totals yazımı", () => {
  test("ilk maç kaydı yaratır", async () => {
    await settleRows([{ userId: "Ali", points: 7 }]);
    const d = await oku("Ali");
    assert.equal(d.totalPoints, 7);
    assert.equal(d.matches, 1);
    assert.equal(d.userId, "Ali", "gösterilecek özgün yazım korunmalı");
  });

  test("sonraki maçlar BİRİKİR, ezmez", async () => {
    // Asıl amaç bu: $set olsaydı her maç öncekini siler, sezon anlamsızlaşırdı.
    await settleRows([{ userId: "Ali", points: 7 }]);
    await settleRows([{ userId: "Ali", points: 5 }]);
    await settleRows([{ userId: "Ali", points: 0 }]);
    const d = await oku("Ali");
    assert.equal(d.totalPoints, 12);
    assert.equal(d.matches, 3, "0 puanlı maç da oynanmış sayılır");
  });

  test("cezalar üç kaynaktan toplanır", async () => {
    await settleRows([
      { userId: "Ali", points: 2, detail: { zeroPenalty: 1, redSidePenalty: 2, penaltySidePenalty: 3 } },
    ]);
    assert.equal((await oku("Ali")).totalPenalty, 6);
  });

  test("karışık harfli kimlik AYNI kayda yazar", async () => {
    // Firebase UID'leri karışık harfli; userIdLower olmadan aynı oyuncu için
    // iki kayıt oluşur, tabloda iki kez görünür ve puanı bölünür.
    await settleRows([{ userId: "Ali", points: 4 }]);
    await settleRows([{ userId: "ALI", points: 6 }]);
    assert.equal(await db.collection("season_totals").countDocuments(), 1);
    assert.equal((await oku("ali")).totalPoints, 10);
  });

  test("EŞZAMANLI settle'lar birbirinin puanını ezmez", async () => {
    // Dosya tarafı read-modify-write olduğu için kilit gerektiriyordu.
    // $inc göreli çalışır, kilitsiz doğrudur — asıl kazanç bu.
    await Promise.all(
      Array.from({ length: 20 }, () => settleRows([{ userId: "Ali", points: 3 }]))
    );
    const d = await oku("Ali");
    assert.equal(d.totalPoints, 60, "20 × 3 puanın hepsi işlenmeli");
    assert.equal(d.matches, 20);
  });

  test("tek maçta çok oyuncu tek bulkWrite ile yazılır", async () => {
    await settleRows([
      { userId: "a", points: 1 },
      { userId: "b", points: 2 },
      { userId: "c", points: 3 },
    ]);
    assert.equal(await db.collection("season_totals").countDocuments(), 3);
    assert.equal((await oku("c")).totalPoints, 3);
  });
});

describe("leaderboard okuma sözleşmesi", () => {
  test("yazılan alanlar leaderboard'un beklediği adlarla eşleşir", async () => {
    // routes/leaderboard.cjs şu eşlemeyi yapıyor:
    //   userId: d.userId || d.userIdLower, total: d.totalPoints,
    //   played: d.matches, penalties: d.totalPenalty
    // Alan adlarından biri kayarsa tablo sessizce sıfır gösterir.
    await settleRows([{ userId: "Ali", points: 9, detail: { zeroPenalty: 2 } }]);
    const d = await oku("Ali");
    const satir = {
      userId: d.userId || d.userIdLower,
      total: Number(d.totalPoints || 0),
      played: Number(d.matches || 0),
      penalties: Number(d.totalPenalty || 0),
    };
    assert.deepEqual(satir, { userId: "Ali", total: 9, played: 1, penalties: 2 });
  });

  test("updatedAt/lastAt dolu — leaderboard bunları updatedAt için okuyor", async () => {
    await settleRows([{ userId: "Ali", points: 1 }]);
    const d = await oku("Ali");
    assert.ok(d.updatedAt, "updatedAt yazılmalı");
    assert.ok(d.lastAt, "lastAt yazılmalı");
  });

  test("benzersiz indeks aynı oyuncuyu ikinci kez yaratmaya izin vermez", async () => {
    await db.collection("season_totals").insertOne({ userId: "Ali", userIdLower: "ali", totalPoints: 1 });
    await assert.rejects(
      () => db.collection("season_totals").insertOne({ userId: "ALI", userIdLower: "ali", totalPoints: 5 }),
      /duplicate key/i
    );
  });
});
