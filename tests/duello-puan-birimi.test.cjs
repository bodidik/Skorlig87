"use strict";

/**
 * DÜELLO PUANI TEK CETVELDE ÖLÇÜLÜR.
 *
 * ⚠️ BULUNAN: `settleDuelsForFixture` düşüşü OYUNCU BAŞINA yapıyordu. Sonuç
 * tahmini olan taraf ODDS cetvelinde puanlanıyordu (gerçek fikstür verisinde
 * medyan 3.81, tek maçta 104'e kadar), olmayan taraf ise `scoreFixture`
 * TOPLAMINDA (0–10; ilk gol, kırmızı kart, penaltı gibi YAN kalemler).
 * `winnerId` bu iki sayıyı doğrudan karşılaştırıyor — yani iki farklı birim.
 *
 * ÖLÇÜLDÜ (gerçek fonksiyon, Man City – Coventry, calcOdds H=1.41):
 *     önce : kuran=1.41  kabul=7  → KAZANAN: kabul eden
 *     sonra: kuran=1.41  kabul=0  → KAZANAN: kuran
 * Yani sonucu DOĞRU bilen oyuncu, sonuca hiç bahis girmemiş rakibine
 * kaybediyordu ve 5.7 LC yanlış kişiye geçiyordu.
 *
 * ⚠️ TETİKLEYİCİ GERÇEK: `/duels/accept` kabul edenden fikstüre tahmin girmiş
 * olmasını İSTEMİYOR. Yani "sonuç tahmini olmayan duelist" varsayımsal değil,
 * normal akış.
 *
 * ⚠️ SIKLIĞI ABARTMIYORUM: gerçek veride 36331 tahminin yalnızca 1'inde
 * `outcome` alanı yok, yani karışım nadir. Ama sonucu HİÇ tahmin etmemiş
 * duelist yaygın ve eski kodda o da scoresMap üzerinden puan alabiliyordu.
 *
 * KURAL: birim DÜELLO başına seçilir.
 *   • gerçek sonuç biliniyorsa  → ikisi de odds; sonuç tahmini olmayan 0 alır
 *   • gerçek sonuç bilinmiyorsa → ikisi de scoreFixture toplamı (bozulmuş yol)
 * Seçilen cetvel `puanBirimi` alanına yazılır; `creatorPoints` hangi ölçekte,
 * sonradan bakan bilebilsin (mobile/app/duel/[fixtureId].tsx bu alanı basıyor).
 */

const os = require("os");
const path = require("path");
const fs = require("fs");

const TMP = path.join(os.tmpdir(), "skorlig-duello-birim-test");
process.env.SKORLIG_DATA_DIR = TMP;
process.env.SKORLIG_BG = "0";

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const KOK = path.join(__dirname, "..");
const { settleDuelsForFixture } = require("../routes/duels.cjs");
const { calcOdds } = require("../services/odds-engine.cjs");

const FID = "MK-BIRIM-2026-08-01-X";
const HOME = "Manchester City FC";
const AWAY = "Coventry City FC";

let mongod = null, client = null, db = null;

before(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
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
  await db.collection("duels").deleteMany({});
  await db.collection("predictions").deleteMany({});
});

const simdi = () => new Date().toISOString();

async function kur({ kuranTahmin, kabulTahmin }) {
  await db.collection("duels").insertOne({
    id: "d1", fixtureId: FID, stake: 3, pot: 6, winAmount: 5.7,
    creatorId: "kuran", acceptorId: "kabul", status: "active",
    home: HOME, away: AWAY,
  });
  for (const [uid, t] of [["kuran", kuranTahmin], ["kabul", kabulTahmin]]) {
    if (t) await db.collection("predictions").insertOne({ fixtureId: FID, userId: uid, at: simdi(), ...t });
  }
}

const kapat = async (scoresMap, actual) =>
  (await settleDuelsForFixture(FID, scoresMap, db, actual)).items[0];

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("seçilen maç gerçekten dengesiz — iki cetvel çakışıyor", () => {
    /**
     * ⚠️ Ölçüm ancak odds SAYISI, tipik bir maç puanının ALTINDA kalırsa
     * anlamlı: eşit favorili bir maçta (odds ~2) çakışma görünmezdi ve test
     * hiçbir şey ölçmezdi.
     */
    const o = calcOdds(HOME, AWAY);
    assert.ok(o.home < 2, `ev sahibi odds ${o.home} — agir favori degil, senaryo cokmus`);
  });

  test("düello gerçekten sonuçlanıyor", async () => {
    await kur({ kuranTahmin: { outcome: "H" }, kabulTahmin: { outcome: "A" } });
    const d = await kapat({ kuran: 4, kabul: 2 }, "H");
    assert.ok(d, "duello sonuclanmadi — test bir sey olcmuyor");
    assert.equal(d.status, "settled");
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("birim karışmıyor", () => {
  test("sonucu DOĞRU bilen, tahmin girmemiş rakibe kaybetmiyor", async () => {
    /* Kabul eden `outcome` yazmamış ama yan kalemlerden 7 puan almış. */
    await kur({
      kuranTahmin: { outcome: "H" },
      kabulTahmin: { firstGoal: "H" },
    });
    const d = await kapat({ kuran: 4, kabul: 7 }, "H");

    assert.equal(
      d.winnerId, "kuran",
      `duelloyu ${d.winnerId} kazandi (kuran=${d.creatorPoints}, kabul=${d.acceptorPoints}) — ` +
        "sonuca bahis girmemis oyuncu, dogru bilene mac puaniyla ustun geldi"
    );
    assert.equal(d.acceptorPoints, 0, "sonuc tahmini olmayan tarafa yan kalemlerden puan yazilmis");
  });

  test("hiç tahmini olmayan duelist 0 alıyor", async () => {
    await kur({ kuranTahmin: { outcome: "H" }, kabulTahmin: null });
    const d = await kapat({ kuran: 4, kabul: 9 }, "H");
    assert.equal(d.acceptorPoints, 0);
    assert.equal(d.winnerId, "kuran");
  });

  test("iki taraf da doğru bilirse odds karşılaştırılıyor", async () => {
    const o = calcOdds(HOME, AWAY);
    await kur({ kuranTahmin: { outcome: "H" }, kabulTahmin: { outcome: "H" } });
    const d = await kapat({ kuran: 1, kabul: 8 }, "H");
    assert.equal(d.creatorPoints, Math.round(o.home * 100) / 100);
    assert.equal(d.acceptorPoints, Math.round(o.home * 100) / 100);
    assert.equal(d.winnerId, null, "ayni tahmin, ayni odds → berabere olmali");
  });

  test("kazanan puanı odds ölçeğinde — maç puanı sızmıyor", async () => {
    const o = calcOdds(HOME, AWAY);
    await kur({ kuranTahmin: { outcome: "A" }, kabulTahmin: { outcome: "H" } });
    const d = await kapat({ kuran: 10, kabul: 1 }, "H");
    assert.equal(d.creatorPoints, 0, "yanlis bilen 0 almali");
    assert.equal(d.acceptorPoints, Math.round(o.home * 100) / 100);
  });
});

describe("bozulmuş yol (gerçek sonuç bilinmiyor)", () => {
  test("outcome geçilmezse İKİ TARAF DA maç puanı cetvelinde", async () => {
    /**
     * Bu yol uyarı basıyor ve normalde çalışmaz (settle2 outcome'u skordan
     * hesaplar). Önemli olan: düştüğünde İKİSİ BİRDEN düşsün.
     */
    await kur({ kuranTahmin: { outcome: "H" }, kabulTahmin: null });
    const d = await kapat({ kuran: 3, kabul: 6 }, null);
    assert.equal(d.creatorPoints, 3, "kuran odds cetvelinde kalmis — birim karisti");
    assert.equal(d.acceptorPoints, 6);
    assert.equal(d.winnerId, "kabul");
    assert.equal(d.puanBirimi, "macPuani");
  });
});

describe("birim kayda yazılıyor", () => {
  test("odds yolu puanBirimi=odds işaretliyor", async () => {
    await kur({ kuranTahmin: { outcome: "H" }, kabulTahmin: { outcome: "A" } });
    const d = await kapat({ kuran: 4, kabul: 2 }, "H");
    assert.equal(
      d.puanBirimi, "odds",
      "puan hangi olcekte belirsiz kaliyor — ayni alan iki farkli sey demek olur"
    );
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: cetvel düello başına seçiliyor, oyuncu başına değil", () => {
  const src = fs.readFileSync(path.join(KOK, "routes", "duels.cjs"), "utf8")
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");

  assert.ok(/macPuaniCetveli\s*=\s*!actual/.test(src), "cetvel duello basina secilmiyor");
  assert.ok(/puanBirimi:/.test(src), "secilen birim kayda yazilmiyor");
  /* Eski hata tam olarak buydu: oyuncu puanı hesaplanırken `!oc` görünce
   * scoresMap'e düşülüyordu. O düşüş artık yalnızca cetvel seçiminde olmalı. */
  assert.ok(
    !/if\s*\(!oc\s*\|\|\s*!actual\)/.test(src),
    "oyuncu basina cetvel dususu geri gelmis"
  );
});
