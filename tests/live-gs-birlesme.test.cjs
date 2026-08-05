"use strict";

/**
 * syncLiveStateForFixture MEVCUT DURUMU KORUMALI.
 *
 * Tohum: data/live/<fid>.json dosyasinda firstGoal, ilkFtAt, skorSabitAt,
 * pollCount, lastPolledAt, source alanlari var. Admin POST bunlari
 * gondermiyor — eskiden tum dosyayi sifirdan yaziyordu ve bu alanlar
 * kayboluyordu.
 *
 * Sonuc: firstGoal yoklugu 14518 tahmini cezalandirdi; ilkFtAt/skorSabitAt
 * yoklugu settle2 nin hemen odeme yapmasina yol acti.
 */

const os = require("os");
const nodePath = require("path");
const fs = require("fs");

const TMP = nodePath.join(os.tmpdir(), "skorlig-live-gs-birlesme-test");
process.env.SKORLIG_DATA_DIR = TMP;
process.env.SKORLIG_ADMIN_TOKEN = "test-token-123";
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(nodePath.join(TMP, "live"), { recursive: true });

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

const FID = "birlesme-42";

const TOHUM = {
  fixtureId: FID,
  status: "LIVE",
  isLive: true,
  score: { home: 1, away: 0 },
  minute: 55,
  kickoffISO: new Date(Date.now() - 55 * 60_000).toISOString(),
  updatedAt: new Date().toISOString(),
  source: "livescore-sync",

  firstGoal: "home",
  firstGoalSource: "livescore-sync",
  ilkFtAt: "2026-08-01T18:45:00.000Z",
  skorSabitAt: "2026-08-01T18:47:00.000Z",
  pollCount: 12,
  lastPolledAt: "2026-08-01T18:44:00.000Z",
};

let server = null, taban = "";

before(async () => {
  fs.writeFileSync(
    nodePath.join(TMP, "live", `${FID}.json`),
    JSON.stringify(TOHUM)
  );

  const express = require("express");
  const app = express();
  app.locals.db = null;
  app.use(express.json());
  app.use("/api/rt", require("../routes/rt.live-gs.cjs"));
  await new Promise((r) => { server = app.listen(0, r); });
  taban = `http://127.0.0.1:${server.address().port}`;
});

after(() => { if (server) server.close(); });

function adminPost(body) {
  return fetch(`${taban}/api/rt/admin-live-gs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-admin-token": "test-token-123",
    },
    body: JSON.stringify(body),
  }).then((r) => r.json());
}

function okuDosya() {
  return JSON.parse(
    fs.readFileSync(nodePath.join(TMP, "live", `${FID}.json`), "utf8")
  );
}

describe("admin kaydi diger alt-sistemlerin alanlarini korur", () => {
  test("firstGoal, ilkFtAt, skorSabitAt, pollCount hayatta kalir", async () => {
    const j = await adminPost({
      fixtureId: FID,
      status: "LIVE",
      minute: 60,
      homeGoals: 2,
      awayGoals: 0,
    });
    assert.equal(j.ok, true, `admin POST basarisiz: ${JSON.stringify(j)}`);

    const st = okuDosya();
    assert.equal(st.firstGoal, "home", "firstGoal silindi");
    assert.equal(st.firstGoalSource, "livescore-sync", "firstGoalSource silindi");
    assert.equal(st.ilkFtAt, "2026-08-01T18:45:00.000Z", "ilkFtAt silindi");
    assert.equal(st.skorSabitAt, "2026-08-01T18:47:00.000Z", "skorSabitAt silindi");
    assert.equal(st.pollCount, 12, "pollCount silindi");
    assert.equal(st.lastPolledAt, "2026-08-01T18:44:00.000Z", "lastPolledAt silindi");
  });

  test("admin gercekten gonderdigi alanlari yazar", async () => {
    const st = okuDosya();
    assert.equal(st.score.home, 2, "skor guncellenmedi");
    assert.equal(st.score.away, 0, "skor guncellenmedi");
    assert.equal(st.minute, 60, "dakika guncellenmedi");
  });

  test("source alani korunur (admin merged.source ezerse prev kalir)", async () => {
    const st = okuDosya();
    assert.ok(st.source, "source alani tamamen silindi");
  });
});

describe("negatif kontrol: alan GERCEKTEN GUNCELLENEBILIR", () => {
  test("admin firstGoal gonderirse dosyaya yazilir", async () => {
    const j = await adminPost({
      fixtureId: FID,
      firstGoal: "away",
    });
    assert.equal(j.ok, true);

    const st = okuDosya();
    assert.equal(st.firstGoal, "away", "admin firstGoal guncelleyemedi");
  });
});
