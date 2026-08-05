"use strict";

/**
 * `GET /api/mini/board` KİŞİSEL ALANLARI — myRow, myRank, friendsInBoard.
 *
 * ⚠️ KİMLİK SORGUDAN DEĞİL JETONDAN GELİYOR. Bu testler ilk yazıldığında uç
 * `?userId=` okuyordu ve hiçbir kimlik kapısı yoktu; yani buradaki her çağrı
 * aynı zamanda "isteyen herkes başkasının arkadaş listesini okuyabiliyor"
 * demekti ve `kimlik-sinifi-nobeti` nöbetçisi o günden beri kırmızıydı.
 * Uç `optionalToken`a bağlandı ve sorgudaki `userId` yok sayılıyor
 * (gerekçe: routes/mini.cjs `/board` notu).
 *
 * İDDİALARIN KENDİSİ DEĞİŞMEDİ — puan, sıra ve arkadaş kesişimi hesabı aynı.
 * Değişen tek şey kimliğin NEREDEN geldiği. Sızıntının kapalı kaldığını
 * ayrıca `tests/mini-board-kimlik-kapisi.test.cjs` ölçüyor.
 *
 * ⚠️ JETON BAŞLIĞI ŞART, `x-user-id` TEK BAŞINA YETMEZ: `optionalToken`
 * `x-auth-token` yoksa kimliği okumadan anonim geçiyor. Yerel/dev ortamda
 * (Firebase yapılandırılmamış ve `NODE_ENV !== production`) jeton varken
 * kimlik `x-user-id`den alınıyor — bkz. middleware/verifyToken.cjs.
 */

const os = require("os");
const nodePath = require("path");
const fs = require("fs");

const TMP = nodePath.join(os.tmpdir(), "skorlig-mini-board-kisisel-test");
process.env.SKORLIG_DATA_DIR = TMP;
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
fs.mkdirSync(nodePath.join(TMP, "live"), { recursive: true });

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

/**
 * ⚠️ KİMLİK ARA KATMANI TAKLİT EDİLİYOR — GERÇEĞİ BU ORTAMDA JETONU REDDEDER.
 *
 * `getFirebaseAuth()` bu makinede firebase-admin'i GERÇEKTEN başlatıyor
 * (`kimlikModu() === "firebase"`), yani uydurma bir `x-auth-token`
 * `verifyIdToken` ile düşüyor ve `optionalToken` anonim geçiyor. Taklit
 * olmadan bütün kişisel alan iddiaları "kimlik yok" koluna düşer ve test
 * ölçmek istediği şeyi değil, ortamı ölçerdi. Kardeş testler
 * (mini-acik-turnuvalar, takim-siralamasi) aynı deseni kullanıyor.
 *
 * Taklit GERÇEĞE SADIK: `x-auth-token` YOKSA `req.uid = null`. Başlığı
 * koşulsuz kabul eden gevşek bir taklit, düzeltmenin tam sınamak istediği
 * "jeton olmadan kişisel veri yok" kuralını atlar.
 */
const nodePathMw = require("path");
const mwYol = require.resolve(nodePathMw.join(__dirname, "..", "middleware", "verifyToken.cjs"));
require.cache[mwYol] = { id: mwYol, filename: mwYol, loaded: true, exports: {
  verifyToken: (q, _r, n) => { q.uid = q.headers["x-user-id"]; n(); },
  optionalToken: (q, _r, n) => {
    q.uid = q.headers["x-auth-token"] ? (q.headers["x-user-id"] || null) : null;
    n();
  },
  getFirebaseAuth: () => null, kimlikModu: () => "test",
}};

const TURNUVA_ID = "mini-board-test-1";
const TURNUVA_CODE = "ABCD12";
const ALI = "oyuncu-ali";
const VELI = "oyuncu-veli";
const CAN = "oyuncu-can";
const DENIZ = "oyuncu-deniz";

let mongod = null, client = null, db = null, server = null, taban = "";

before(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const { MongoClient } = require("mongodb");
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  db = client.db("test");

  const turnuva = {
    id: TURNUVA_ID,
    code: TURNUVA_CODE,
    name: "Test Turnuvasi",
    ownerId: ALI,
    members: [ALI, VELI, CAN, DENIZ],
    fixtures: [
      { fixtureId: "f1", home: "GS", away: "FB", kickoffISO: "2026-08-01T18:00:00Z", league: "TSL" },
      { fixtureId: "f2", home: "BJK", away: "TS", kickoffISO: "2026-08-02T18:00:00Z", league: "TSL" },
    ],
    createdAt: "2026-07-30T10:00:00Z",
  };
  fs.writeFileSync(
    nodePath.join(TMP, "mini-tournaments.json"),
    JSON.stringify({ items: [turnuva] }),
    "utf8"
  );

  await db.collection("match_results").insertMany([
    {
      fixtureId: "f1",
      computedAt: "2026-08-01T20:00:00Z",
      finalScore: "2-1",
      rows: [
        { userId: ALI, points: 10 },
        { userId: VELI, points: 6 },
        { userId: CAN, points: 8 },
        { userId: DENIZ, points: 4 },
      ],
    },
    {
      fixtureId: "f2",
      computedAt: "2026-08-02T20:00:00Z",
      finalScore: "1-0",
      rows: [
        { userId: ALI, points: 5 },
        { userId: VELI, points: 9 },
        { userId: CAN, points: 3 },
        { userId: DENIZ, points: 7 },
      ],
    },
  ]);

  const pairKey = (a, b) => [a, b].map(x => x.trim().toLowerCase()).sort().join("::");
  await db.collection("friend_links").insertMany([
    { a: ALI, b: VELI, pair: pairKey(ALI, VELI), createdAt: "2026-07-25T10:00:00Z" },
    { a: ALI, b: CAN, pair: pairKey(ALI, CAN), createdAt: "2026-07-26T10:00:00Z" },
  ]);

  const express = require("express");
  const app = express();
  app.locals.db = db;
  app.use("/api/mini", require("../routes/mini.cjs"));
  await new Promise((r) => { server = app.listen(0, r); });
  taban = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) server.close();
  if (client) await client.close();
  if (mongod) await mongod.stop();
});

/**
 * @param {string} q  sorgu dizesi
 * @param {string} [kimlik]  verilirse jeton başlıklarıyla o kullanıcı olarak çağırır
 */
const al = (q, kimlik) =>
  fetch(`${taban}/api/mini/board?${q}`, {
    headers: kimlik ? { "x-auth-token": "yerel-gecis", "x-user-id": kimlik } : {},
  }).then((r) => r.json());

describe("mini board kisisel alanlar", () => {
  test("jetonla myRow, myRank, totalMembers doner", async () => {
    const r = await al(`id=${TURNUVA_ID}`, ALI);
    assert.equal(r.ok, true, `yanit basarisiz: ${JSON.stringify(r).slice(0, 300)}`);

    assert.ok(r.myRow, "myRow null — kisisel satir hesaplanmiyor");
    assert.equal(r.myRow.userId, ALI);
    assert.equal(r.myRow.points, 15);

    assert.equal(r.myRank, 1, `ali 15 puanla birinci olmali, gelen: ${r.myRank}`);
    assert.equal(r.totalMembers, 4, `4 uye var ama totalMembers: ${r.totalMembers}`);
  });

  test("myRank TAM siralama uzerinden hesaplaniyor", async () => {
    const r = await al(`id=${TURNUVA_ID}`, VELI);
    assert.equal(r.ok, true);
    assert.equal(r.myRank, 2, `veli 15 puanla ikinci olmali, gelen: ${r.myRank}`);

    const rc = await al(`id=${TURNUVA_ID}`, CAN);
    assert.equal(rc.myRank, 3, `can 11 puanla ucuncu olmali, gelen: ${rc.myRank}`);

    const rd = await al(`id=${TURNUVA_ID}`, DENIZ);
    assert.equal(rd.myRank, 4, `deniz 11 puanla dorduncu olmali, gelen: ${rd.myRank}`);
  });

  test("friendsInBoard arkadaslari doner", async () => {
    const r = await al(`id=${TURNUVA_ID}`, ALI);
    assert.equal(r.ok, true);

    assert.ok(Array.isArray(r.friendsInBoard), "friendsInBoard dizi degil");
    const ids = r.friendsInBoard.map((x) => x.userId).sort();
    assert.deepEqual(ids, [CAN, VELI].sort(),
      `ali nin arkadaslari veli ve can, gelen: ${JSON.stringify(ids)}`);
  });

  test("friendsInBoard arkadasin puanini tasiyor", async () => {
    const r = await al(`id=${TURNUVA_ID}`, ALI);
    const veli = r.friendsInBoard.find((x) => x.userId === VELI);
    assert.ok(veli, "veli friendsInBoard icinde yok");
    assert.equal(veli.points, 15, `veli nin puani 15 olmali, gelen: ${veli.points}`);
  });

  test("buyuk/kucuk harf farki myRow yi kacirmaz", async () => {
    /* Kimlik saglayicisi kimligi farkli yazimla dondurebilir; eslesme
     * harf duzenine duyarli olmamali. */
    const r = await al(`id=${TURNUVA_ID}`, ALI.toUpperCase());
    assert.equal(r.ok, true);
    assert.ok(r.myRow, "buyuk harfli kimlikle myRow bulunamadi");
    assert.equal(r.myRow.userId, ALI);
    assert.equal(r.myRank, 1);
  });

  test("turnuvada olmayan kullanici icin myRow null doner", async () => {
    const r = await al(`id=${TURNUVA_ID}`, "bilinmeyen-kullanici");
    assert.equal(r.ok, true);
    assert.equal(r.myRow, null, "turnuvada olmayan kullanici icin myRow null olmali");
    assert.equal(r.myRank, null);
    assert.equal(r.totalMembers, 4);
  });
});

describe("kimlik yoksa kisisel alanlar bos", () => {
  test("jetonsuz istekte myRow, myRank null; friendsInBoard bos dizi", async () => {
    const r = await al(`id=${TURNUVA_ID}`);
    assert.equal(r.ok, true, "pano herkese acik kalmali");
    assert.equal(r.myRow, null, "jetonsuz istekte myRow dolu gelmemeli");
    assert.equal(r.myRank, null, "jetonsuz istekte myRank dolu gelmemeli");
    assert.equal(r.totalMembers, 4);
    assert.ok(Array.isArray(r.friendsInBoard), "friendsInBoard dizi olmali");
    assert.equal(r.friendsInBoard.length, 0, "kimlik yokken friendsInBoard bos olmali");
  });

  test("sorgudaki userId kisisel alan ACMIYOR", async () => {
    /**
     * ⚠️ ASIL SIZINTI BUYDU: jeton yok, `?userId=` var. Eskiden bu istek
     * Ali'nin satirini, sirasini ve ARKADAS LISTESINI donduruyordu — kullanici
     * kimlikleri siralama tablolarinda zaten gorunur oldugu icin hedef secmek
     * kolaydi.
     */
    const r = await al(`id=${TURNUVA_ID}&userId=${ALI}`);
    assert.equal(r.ok, true);
    assert.equal(
      r.myRow, null,
      `sorgudaki userId kisisel satiri acti: ${JSON.stringify(r.myRow)}`
    );
    assert.equal(
      r.friendsInBoard.length, 0,
      `sorgudaki userId arkadas listesini acti: ${JSON.stringify(r.friendsInBoard)} — ` +
      `isteyen herkes baskasinin sosyal grafigini okuyabilir`
    );
  });
});
