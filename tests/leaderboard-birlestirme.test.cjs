"use strict";

/**
 * leaderboard.json birlestirme testi.
 *
 * settle2 eskiden { items: rows } yaziyordu — sadece son settle edilen macin
 * satirlarini. Onceki maclarin verileri ve totals tamamen kayboluyordu.
 * Bu test A macini settle edip, sonra B macini settle edip, IKISININ de
 * satirlarinin ve dolu bir totals haritasinin dosyada kaldigini dogrular.
 */

const os = require("os");
const nodePath = require("path");
const fs = require("fs");

const TMP = nodePath.join(os.tmpdir(), "skorlig-lb-merge-test");
process.env.SKORLIG_DATA_DIR = TMP;
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const { test, describe, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const { mergeAndWriteLeaderboard } = require("../lib/leaderboard-merge.cjs");

async function readLb() {
  const txt = await fs.promises.readFile(nodePath.join(TMP, "leaderboard.json"), "utf8");
  return JSON.parse(txt);
}

const ALI  = "merge-ali";
const VELI = "merge-veli";
const CAN  = "merge-can";

const FIX_A = "fixtureA";
const FIX_B = "fixtureB";

const rowsA = [
  { fixtureId: FIX_A, userId: ALI,  points: 10, penalty: 0, country: "Turkiye" },
  { fixtureId: FIX_A, userId: VELI, points: 5,  penalty: 1, country: "Germany" },
];

const rowsB = [
  { fixtureId: FIX_B, userId: ALI, points: 8, penalty: 0, country: "Turkiye" },
  { fixtureId: FIX_B, userId: CAN, points: 3, penalty: 0, country: "Spain"   },
];

describe("leaderboard birlestirme", () => {
  beforeEach(() => {
    const lbFile = nodePath.join(TMP, "leaderboard.json");
    try { fs.unlinkSync(lbFile); } catch {}
  });

  test("iki ardisik settle sonrasi iki macin satirlari da kalir", async () => {
    await mergeAndWriteLeaderboard(FIX_A, rowsA);
    await mergeAndWriteLeaderboard(FIX_B, rowsB);

    const lb = await readLb();

    const fixARows = lb.items.filter(r => r.fixtureId === FIX_A);
    const fixBRows = lb.items.filter(r => r.fixtureId === FIX_B);

    assert.equal(fixARows.length, 2, "fixture A satirlari kaybolmus");
    assert.equal(fixBRows.length, 2, "fixture B satirlari kaybolmus");
    assert.equal(lb.items.length, 4, "toplam satir sayisi yanlis");
  });

  test("totals haritasi tum maclardan hesaplanir", async () => {
    await mergeAndWriteLeaderboard(FIX_A, rowsA);
    await mergeAndWriteLeaderboard(FIX_B, rowsB);

    const lb = await readLb();
    assert.ok(lb.totals, "totals haritasi yok");
    assert.ok(Object.keys(lb.totals).length > 0, "totals bos");

    const ali = lb.totals[ALI];
    assert.ok(ali, "Ali totals icinde yok");
    assert.equal(ali.total, 18, "Ali toplami yanlis (10+8=18 olmali)");
    assert.equal(ali.played, 2, "Ali oynanan mac sayisi yanlis");

    const veli = lb.totals[VELI];
    assert.ok(veli, "Veli totals icinde yok");
    assert.equal(veli.total, 5, "Veli toplami yanlis");
    assert.equal(veli.penalties, 1, "Veli ceza sayisi yanlis");

    const can = lb.totals[CAN];
    assert.ok(can, "Can totals icinde yok");
    assert.equal(can.total, 3, "Can toplami yanlis");
  });

  test("ayni macin tekrar settle edilmesi eski satirlari gunceller", async () => {
    await mergeAndWriteLeaderboard(FIX_A, rowsA);

    const yeniRowsA = [
      { fixtureId: FIX_A, userId: ALI, points: 15, penalty: 0, country: "Turkiye" },
    ];
    await mergeAndWriteLeaderboard(FIX_A, yeniRowsA);

    const lb = await readLb();
    const fixARows = lb.items.filter(r => r.fixtureId === FIX_A);
    assert.equal(fixARows.length, 1, "eski satirlar temizlenmemis");
    assert.equal(fixARows[0].points, 15, "guncellenmis puan yanlis");
  });

  test("updatedAt alani mevcut", async () => {
    await mergeAndWriteLeaderboard(FIX_A, rowsA);
    const lb = await readLb();
    assert.ok(lb.updatedAt, "updatedAt alani yok");
    assert.ok(!isNaN(Date.parse(lb.updatedAt)), "updatedAt gecerli bir tarih degil");
  });

  test("NEGATIF KONTROL: eski davranis (sadece son mac) kirik olurdu", async () => {
    await mergeAndWriteLeaderboard(FIX_A, rowsA);
    await mergeAndWriteLeaderboard(FIX_B, rowsB);

    const lb = await readLb();
    const fixARows = lb.items.filter(r => r.fixtureId === FIX_A);
    assert.notEqual(
      fixARows.length, 0,
      "REGRESYON: fixture A satirlari silindi — eski clobber davranisi geri donmus"
    );
    assert.notEqual(
      lb.totals, undefined,
      "REGRESYON: totals haritasi yok — eski clobber davranisi geri donmus"
    );
    assert.notEqual(
      Object.keys(lb.totals || {}).length, 0,
      "REGRESYON: totals bos — eski clobber davranisi geri donmus"
    );
  });
});
