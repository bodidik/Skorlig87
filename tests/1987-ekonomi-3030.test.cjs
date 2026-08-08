"use strict";

/**
 * 1987 EKONOMİSİ 30+30: BONUS KENDİ OYUNUNDA ERİR, BAŞKA OYUN NORMALDEN DÜŞER.
 *
 * ⚠️ BULUNAN (2026-08-08 uçtan uca tarama): `spendLc`nin `kanal:"1987"`
 * mekanizması cüzdanda YAZILIYDI ama hiçbir rota onu çağırmıyordu — üstelik
 * pred.cjs VE weekly-picks 1987 üyesini tamamen bedava geçiriyordu. Sonuç:
 * üye her şeyi bedava oynuyor, bonus1987 (30 + aylık 30) cüzdanda görünen
 * ama hiçbir oyunun düşüremediği ÖLÜ BAKİYE olarak duruyordu. Kullanıcının
 * tasarımı ("bonus sadece kendi oyunlarında; başka oyuna girerse diğer LC
 * düşsün") hiç uygulanmamıştı.
 *
 * ⚠️ İLK DÜZELTME UCA ULAŞMADI — nota değer: weekly-picks'te WalletCredit
 * imzasıyla (7 argüman) çağırdım; oysa dosyada YEREL bir spendLc sarmalayıcı
 * var (3 argüman) ve kanal seçeneğini SESSİZCE YUTUYORDU. Fonksiyon yerine
 * ucu döven bu test olmasaydı "düzeltildi" sanılacaktı.
 */

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const os = require("os");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "skorlig-3030-"));
process.env.SKORLIG_DATA_DIR = TMP;
process.env.SKORLIG_BG = "0";
process.env.SKORLIG_LANSMAN_BITIS = "2099-01-01T00:00:00Z";
process.env.SKORLIG_LANSMAN_BEDELI = "1";
fs.mkdirSync(path.join(TMP, "live"), { recursive: true });

const FX_HAFTALIK_1 = "E3030-W1";
const FX_HAFTALIK_2 = "E3030-W2";
const FX_NORMAL     = "E3030-N1";
const UYE   = "e3030-uye";     // 1987 üyesi: bonus 30 + bakiye 30
const DUZ   = "e3030-duz";     // üye değil: yalnız bakiye 30
const BONUS_BASLANGIC = 30;
const BAKIYE_BASLANGIC = 30;

let mongod, client, db, server, taban;

const cuzdan = async (uid) =>
  db.collection("lc_wallet_users").findOne({ userIdLower: uid });

const gonder = (uid, yol, govde) =>
  fetch(`${taban}${yol}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-test-uid": uid },
    body: JSON.stringify(govde),
  }).then(async (r) => ({ status: r.status, j: await r.json().catch(() => ({})) }));

before(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const { MongoClient } = require("mongodb");
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = "e3030";
  client = await MongoClient.connect(mongod.getUri());
  db = client.db("e3030");

  const FixturesStore = require("../lib/fixtures-store.cjs");
  const { creditLc } = require("../lib/wallet-credit.cjs");
  const UsersStore = require("../lib/users-store.cjs");

  const yakin = (saat) => new Date(Date.now() + saat * 3600_000).toISOString();
  await FixturesStore.saveAll([
    { fixtureId: FX_HAFTALIK_1, home: "A", away: "B", kickoffISO: yakin(2), status: "NS", country: "Turkey" },
    { fixtureId: FX_HAFTALIK_2, home: "C", away: "D", kickoffISO: yakin(3), status: "NS", country: "Turkey" },
    { fixtureId: FX_NORMAL,     home: "E", away: "F", kickoffISO: yakin(4), status: "NS", country: "Turkey" },
  ], db);

  for (const u of [UYE, DUZ]) await creditLc(db, u, BAKIYE_BASLANGIC, "initial_default");
  await UsersStore.updateUser(
    UYE, { is1987: true, since1987: new Date().toISOString(), active: true },
    { mainTeam: null, lc: 0, lcLastDaily: null }, db
  );
  await db.collection("lc_wallet_users").updateOne(
    { userIdLower: UYE }, { $set: { bonus1987: BONUS_BASLANGIC } }
  );

  const vt = require.resolve("../middleware/verifyToken.cjs");
  require.cache[vt] = {
    id: vt, filename: vt, loaded: true,
    exports: {
      verifyToken: (req, _res, next) => { req.uid = req.headers["x-test-uid"]; next(); },
      optionalToken: (req, _res, next) => { req.uid = req.headers["x-test-uid"] || null; next(); },
      isBanned: async () => false,
    },
  };

  const express = require("express");
  const app = express();
  app.use(express.json());
  app.locals.db = db;
  app.use("/api", require("../routes/pred.cjs"));
  app.use("/api/weekly-picks", require("../routes/weekly-picks.cjs"));
  server = app.listen(0);
  if (!server.listening) await new Promise((r) => server.once("listening", r));
  taban = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) server.close();
  if (client) await client.close();
  try {
    const { close } = require("../lib/mongo.cjs");
    if (typeof close === "function") await close();
  } catch {}
  if (mongod) await mongod.stop();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

describe("1987 ekonomisi 30+30", () => {
  test("üye HAFTALIK oyunda önce bonus1987'den öder, bakiye el değmez", async () => {
    const { status, j } = await gonder(UYE, "/api/weekly-picks/predict",
      { fixtureId: FX_HAFTALIK_1, outcome: "H" });
    assert.equal(status, 200, `gonderim reddedildi: ${JSON.stringify(j)}`);
    assert.ok(j.lcCharged > 0, "ucret kesilmedi — uye hala bedava oynuyor (olu bonus geri geldi)");

    const c = await cuzdan(UYE);
    assert.equal(Number(c.bonus1987), BONUS_BASLANGIC - j.lcCharged,
      `bonus1987 ${c.bonus1987} — bedel bonustan dusmedi (kanal uca ulasmiyor)`);
    assert.equal(Number(c.balance), BAKIYE_BASLANGIC,
      `balance ${c.balance} — bedel yanlis cepten (normal bakiyeden) dustu`);

    const kayit = await db.collection("lc_wallet_ledger").findOne(
      { userIdLower: UYE, kind: "spend" });
    assert.equal(kayit?.meta?.kaynak, "bonus1987", "defter kaynagi bonus1987 degil");
  });

  test("üye NORMAL maçta normal bakiyeden öder, bonus el değmez", async () => {
    const once = await cuzdan(UYE);
    const { status, j } = await gonder(UYE, "/api/pred/submit",
      { fixtureId: FX_NORMAL, outcome: "H" });
    assert.equal(status, 200, `gonderim reddedildi: ${JSON.stringify(j)}`);

    const sonra = await cuzdan(UYE);
    const bakiyeDusen = Number(once.balance) - Number(sonra.balance);
    assert.ok(bakiyeDusen > 0,
      "normal macta uyeden ucret kesilmedi — 'baska oyunda diger LC dussun' kurali uygulanmiyor");
    assert.equal(Number(sonra.bonus1987), Number(once.bonus1987),
      "normal mac BONUSTAN dustu — bonus yalnizca 1987 oyunlarinda gecerli olmali");
  });

  test("bonus tükenince haftalık oyun normal bakiyeye düşer", async () => {
    await db.collection("lc_wallet_users").updateOne(
      { userIdLower: UYE }, { $set: { bonus1987: 0 } });
    const once = await cuzdan(UYE);

    const { status, j } = await gonder(UYE, "/api/weekly-picks/predict",
      { fixtureId: FX_HAFTALIK_2, outcome: "D" });
    assert.equal(status, 200, `gonderim reddedildi: ${JSON.stringify(j)}`);

    const sonra = await cuzdan(UYE);
    assert.equal(Number(sonra.bonus1987), 0, "bonus eksiye dustu");
    assert.ok(Number(once.balance) - Number(sonra.balance) > 0,
      "bonus bitince bakiyeden dusulmedi — uye bedava oynadi");
  });

  test("üye olmayan haftalık oyunda normal bakiyeden öder", async () => {
    const { status, j } = await gonder(DUZ, "/api/weekly-picks/predict",
      { fixtureId: FX_HAFTALIK_1, outcome: "A" });
    assert.equal(status, 200, `gonderim reddedildi: ${JSON.stringify(j)}`);

    const c = await cuzdan(DUZ);
    assert.equal(Number(c.balance), BAKIYE_BASLANGIC - j.lcCharged,
      "uye olmayanin bakiyesi dusmedi");
  });

  test("NÖBETÇİ: pred.cjs 1987'yi bedava geçirmiyor, weekly kanal geçiriyor", () => {
    const oku = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8")
      .split(/\r?\n/)
      .filter((l) => { const t = l.trim(); return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*"); })
      .join("\n");

    const pred = oku("routes/pred.cjs");
    assert.ok(!/\(isPrem\s*\|\|\s*is1987\)\s*\?\s*0/.test(pred),
      "pred.cjs 1987 uyesini yine bedava geciriyor — 30+30 tasarimi geri alindi");

    const weekly = oku("routes/weekly-picks.cjs");
    assert.ok(/kanal:\s*"1987"/.test(weekly),
      'weekly-picks bonus kanalini kullanmiyor — bonus1987 yine olu bakiye');
  });
});
