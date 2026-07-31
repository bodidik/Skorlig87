"use strict";

/**
 * HESAP SİLME — kullanıcı BAŞKALARININ kayıtlarının içinden de çıkarılmalı.
 *
 * ⚠️ BULUNAN BOŞLUK: silme yolu "kullanıcıya ait belgeleri sil" yapıyordu ama
 * kullanıcı başkalarının belgelerinin İÇİNDE de duruyordu:
 *
 *   mini_tournaments — yalnızca `ownerId` eşleşenler siliniyordu; kullanıcı
 *     BAŞKASININ turnuvasında üye/kazanan olarak kalıyordu.
 *
 *   match_results.rows — kullanıcının tahmini, puanı ve kırılımı her maçın
 *     anlık görüntüsünde gömülü kalıyordu. Üstelik `/api/rt/pred/history`
 *     bu satırları `?userId=` ile döndürüyor: hesap silindikten SONRA da
 *     kimliği bilen biri tüm tahmin geçmişini okuyabiliyordu.
 *
 * Aynı ayrım GRUPLARDA doğru yapılmıştı (sahibi olduğu grup silinir, üyesi
 * olduğu gruptan çıkarılır) — mini turnuvaya ve anlık görüntülere
 * uygulanmamıştı. Kod yorumu Play Store "kullanıcı verisini sil" şartını
 * açıkça gerekçe gösteriyor.
 */

const os = require("os");
const nodePath = require("path");
const fs = require("fs");
process.env.SKORLIG_DATA_DIR = nodePath.join(os.tmpdir(), "skorlig-silme-gomulu-test");
fs.mkdirSync(process.env.SKORLIG_DATA_DIR, { recursive: true });

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

let mongod = null, client = null, db = null;

before(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const { MongoClient } = require("mongodb");
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  db = client.db("test");
});
after(async () => {
  if (client) await client.close();
  if (mongod) await mongod.stop();
});
beforeEach(async () => {
  for (const c of ["mini_tournaments", "match_results"]) {
    await db.collection(c).deleteMany({});
  }
});

const UID = "SilinenKullanici";
const UIDL = UID.toLowerCase();

/**
 * Rotadaki gömülü temizliğin AYNISI. Rota bir Express işleyicisi içinde
 * olduğu için doğrudan çağrılamıyor; burada aynı işlemler yürütülüyor.
 * Aşağıdaki nöbetçi, rotanın bu listeden SAPMADIĞINI ayrıca denetliyor.
 */
async function gomuluTemizlikCalistir(uid, uidL) {
  const islemler = [
    ["mini_tournaments", { members: uid }, { $pull: { members: uid } }],
    ["mini_tournaments", { winners: uid }, { $pull: { winners: uid } }],
    ["match_results", { "rows.userIdLower": uidL }, { $pull: { rows: { userIdLower: uidL } } }],
  ];
  for (const [koleksiyon, filtre, guncelleme] of islemler) {
    await db.collection(koleksiyon).updateMany(filtre, guncelleme);
  }
}

describe("mini turnuva üyeliği", () => {
  test("başkasının turnuvasından çıkarılır", async () => {
    await db.collection("mini_tournaments").insertOne({
      id: "t1", ownerId: "BaskaKisi", members: ["BaskaKisi", UID, "Ucuncu"],
    });
    await gomuluTemizlikCalistir(UID, UIDL);

    const t = await db.collection("mini_tournaments").findOne({ id: "t1" });
    assert.deepEqual(t.members, ["BaskaKisi", "Ucuncu"], "silinen kullanici uye olarak kalmis");
  });

  test("kazananlar listesinden de çıkarılır", async () => {
    await db.collection("mini_tournaments").insertOne({
      id: "t2", ownerId: "BaskaKisi", members: ["BaskaKisi", UID],
      winners: [UID, "BaskaKisi"], finishedAt: "2026-07-01T00:00:00Z",
    });
    await gomuluTemizlikCalistir(UID, UIDL);

    const t = await db.collection("mini_tournaments").findOne({ id: "t2" });
    assert.deepEqual(t.winners, ["BaskaKisi"]);
  });

  test("winners alanı YOKSA patlamaz", async () => {
    // ⚠️ `$pull` dizi olmayan alanda hata verir. Bitmemiş turnuvalarda
    // `winners` hiç yok; tek bir $pull'da bu tüm temizliği düşürebilirdi.
    await db.collection("mini_tournaments").insertOne({
      id: "t3", ownerId: "BaskaKisi", members: [UID],
    });
    await gomuluTemizlikCalistir(UID, UIDL);
    const t = await db.collection("mini_tournaments").findOne({ id: "t3" });
    assert.deepEqual(t.members, []);
  });

  test("winners null OLSA BİLE patlamaz", async () => {
    await db.collection("mini_tournaments").insertOne({
      id: "t4", ownerId: "BaskaKisi", members: [UID], winners: null,
    });
    await gomuluTemizlikCalistir(UID, UIDL);
    const t = await db.collection("mini_tournaments").findOne({ id: "t4" });
    assert.deepEqual(t.members, [], "winners:null temizligi dusurmus");
  });

  test("başka kullanıcılara dokunulmaz", async () => {
    await db.collection("mini_tournaments").insertOne({
      id: "t5", ownerId: "BaskaKisi", members: ["Ali", "Veli"], winners: ["Ali"],
    });
    await gomuluTemizlikCalistir(UID, UIDL);
    const t = await db.collection("mini_tournaments").findOne({ id: "t5" });
    assert.deepEqual(t.members, ["Ali", "Veli"]);
    assert.deepEqual(t.winners, ["Ali"]);
  });
});

describe("maç sonucu anlık görüntüleri", () => {
  test("kullanıcının satırı çıkarılır, diğerleri kalır", async () => {
    await db.collection("match_results").insertOne({
      fixtureId: "m1",
      rows: [
        { userId: "Ali", userIdLower: "ali", points: 5 },
        { userId: UID, userIdLower: UIDL, points: 12, detail: { outcome: "H" } },
        { userId: "Veli", userIdLower: "veli", points: 3 },
      ],
    });
    await gomuluTemizlikCalistir(UID, UIDL);

    const s = await db.collection("match_results").findOne({ fixtureId: "m1" });
    assert.deepEqual(s.rows.map((r) => r.userIdLower), ["ali", "veli"]);
  });

  test("tahmin geçmişi sorgusu artık sonuç vermez", async () => {
    // `/api/rt/pred/history?userId=` tam olarak bu süzgeci kullanıyor.
    await db.collection("match_results").insertMany([
      { fixtureId: "m1", rows: [{ userId: UID, userIdLower: UIDL, points: 9 }] },
      { fixtureId: "m2", rows: [{ userId: UID, userIdLower: UIDL, points: 4 }] },
    ]);
    assert.equal(await db.collection("match_results").countDocuments({ "rows.userIdLower": UIDL }), 2);

    await gomuluTemizlikCalistir(UID, UIDL);

    assert.equal(
      await db.collection("match_results").countDocuments({ "rows.userIdLower": UIDL }),
      0,
      "hesap silindikten sonra tahmin gecmisi hala okunabiliyor"
    );
  });

  test("büyük/küçük harf farkı sızıntıya yol açmaz", async () => {
    // Satırlarda `userIdLower` var; süzgeç onu kullanmalı, `userId`yi değil.
    await db.collection("match_results").insertOne({
      fixtureId: "m3", rows: [{ userId: "SILINENKULLANICI", userIdLower: UIDL, points: 7 }],
    });
    await gomuluTemizlikCalistir(UID, UIDL);
    const s = await db.collection("match_results").findOne({ fixtureId: "m3" });
    assert.deepEqual(s.rows, []);
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: silme yolu gömülü temizliği yapıyor", () => {
  const kaynak = fs.readFileSync(
    nodePath.join(__dirname, "..", "routes", "users.cjs"), "utf8"
  );
  const beklenen = [
    ["mini_tournaments", "members"],
    ["mini_tournaments", "winners"],
    ["match_results", "rows.userIdLower"],
  ];
  const eksik = beklenen.filter(([kol, alan]) => {
    const re = new RegExp(`"${kol}"[^\\n]*${alan.replace(".", "\\.")}`);
    return !re.test(kaynak);
  });
  assert.deepStrictEqual(
    eksik.map((x) => x.join("/")),
    [],
    "Silme yolunda gomulu temizlik eksik — kullanici baskalarinin kayitlarinda kalir"
  );
});
