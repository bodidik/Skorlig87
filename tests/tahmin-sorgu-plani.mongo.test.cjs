"use strict";

/**
 * TAHMİN SORGULARI İNDEKS KULLANIYOR — PLANLA DOĞRULANIR.
 *
 * ⚠️ MEVCUT TESTİN BIRAKTIĞI BOŞLUK: `tests/indeks-kapsam.test.cjs` indekslerin
 * KURULDUĞUNU doğruluyor, ama sorguların onları KULLANDIĞINI doğrulamıyor.
 * Aradaki fark sessiz: biri sorgu şeklini `{fixtureId, isBot}` ya da
 * `{userId}` (karışık harf) yapsa indeksler yerinde durur, plan COLLSCAN'e
 * düşer ve hiçbir hata çıkmaz — yalnızca yavaşlar.
 *
 * ÖLÇÜLDÜ (üretim, 33.083 kayıtlık `predictions`): bugün sıcak sorguların
 * hepsi IXSCAN, tek COLLSCAN yok. Bu test o özelliği kilitliyor.
 *
 * ⚠️ SONDANIN KENDİSİ SINANIYOR: indekssiz bir alanla yapılan sorgunun
 * GERÇEKTEN COLLSCAN döndüğü ayrıca ölçülüyor. Aksi hâlde "hepsi IXSCAN"
 * sonucu, planı hiç okuyamamaktan da gelebilirdi — bu oturumun tekrar eden
 * dersi: sıfır sonuç kanıt değildir.
 */

const os = require("os");
const path = require("path");
const fs = require("fs");
process.env.SKORLIG_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "skorlig-plan-"));

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { ensurePredIndexes } = require(path.join(__dirname, "..", "lib", "preds-index.cjs"));

let mongod = null, client = null, db = null, col = null;
const MAC = 40;          // gerçek dünyada maç başına ~40 tahmin
const FID = "PLAN-FID-7";

before(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const { MongoClient } = require("mongodb");
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  db = client.db("test");
  col = db.collection("predictions");

  // COLLSCAN ile IXSCAN'in AYIRT EDİLEBİLECEĞİ kadar veri: 40 maç × 40 tahmin.
  const toplu = [];
  for (let m = 0; m < 40; m++) {
    const fid = m === 7 ? FID : `PLAN-FID-${m}`;
    for (let u = 0; u < MAC; u++) {
      toplu.push({
        fixtureId: fid,
        userId: `Oyuncu${u}`,
        userIdLower: `oyuncu${u}`,
        outcome: "H",
        isBot: u > 2,
        at: new Date(Date.UTC(2026, 6, 29, 12, u)).toISOString(),
      });
    }
  }
  await col.insertMany(toplu);

  // İndeksler UYGULAMANIN KENDİ yolundan kurulur — testin elle kurduğu bir
  // indeks, üretimde olmayan bir şeyi doğrulardı.
  await ensurePredIndexes(db);
});

after(async () => {
  await client?.close();
  await mongod?.stop();
  try { fs.rmSync(process.env.SKORLIG_DATA_DIR, { recursive: true, force: true }); } catch { /* geçici */ }
});

/** Sorgunun kazanan planındaki tarama aşaması. */
async function plan(sorgu) {
  const e = await col.find(sorgu).explain("executionStats");
  const st = e.executionStats.executionStages;
  const asama = st.stage === "FETCH" ? (st.inputStage?.stage || st.stage) : st.stage;
  return { asama, incelenen: e.executionStats.totalDocsExamined, donen: e.executionStats.nReturned };
}

const IXSCAN = (a) => a === "IXSCAN" || a === "EXPRESS_IXSCAN" || a === "IDHACK";

describe("tahmin sorgu planları", () => {
  test("kurulum sınandı: veri GERÇEKTEN var ve indeksler kurulmuş", async () => {
    assert.equal(await col.countDocuments(), 40 * MAC, "tohum eksik");
    const ix = await col.indexes();
    const anahtarlar = ix.map((i) => JSON.stringify(i.key));
    for (const k of [{ fixtureId: 1 }, { userIdLower: 1 }, { fixtureId: 1, userIdLower: 1 }]) {
      assert.ok(anahtarlar.includes(JSON.stringify(k)), `indeks yok: ${JSON.stringify(k)}`);
    }
  });

  test("SONDA SINANDI: indekssiz alan GERÇEKTEN COLLSCAN döner", async () => {
    /**
     * ⚠️ BU OLMADAN "hepsi IXSCAN" sonucu boş: plan okuyucusu bozuksa ya da
     * her sorgu tesadüfen indeksliyse test hiçbir şey ayırt etmezdi.
     * `outcome` bilerek indekssiz.
     */
    const p = await plan({ outcome: "H" });
    assert.equal(p.asama, "COLLSCAN", `indekssiz alan IXSCAN dondu (${p.asama}) — sonda ayirt etmiyor`);
    assert.equal(p.incelenen, 40 * MAC, "COLLSCAN tum koleksiyonu taramali");
  });

  test("settle2 / duels: {fixtureId} indeksli", async () => {
    /* Kaynak: routes/settle2.cjs loadFixturePreds, routes/duels.cjs
     * settleDuelsForFixture. Her maç uzlaşmasında çalışır. */
    const p = await plan({ fixtureId: FID });
    assert.ok(IXSCAN(p.asama), `COLLSCAN: ${p.asama}`);
    assert.equal(p.donen, MAC);
    assert.ok(p.incelenen <= MAC, `gereginden fazla belge incelendi: ${p.incelenen}`);
  });

  test("profil/geçmiş: {userIdLower} indeksli", async () => {
    const p = await plan({ userIdLower: "oyuncu3" });
    assert.ok(IXSCAN(p.asama), `COLLSCAN: ${p.asama}`);
    assert.ok(p.incelenen <= 40, `gereginden fazla belge incelendi: ${p.incelenen}`);
  });

  test("çift ödeme kapısı: {fixtureId, userIdLower} indeksli", async () => {
    /**
     * ⚠️ EN KRİTİĞİ: bu sorgu "daha önce tahmin var mı" sorusunu yanıtlıyor,
     * yani 3 LC'nin ikinci kez alınıp alınmayacağına karar veriyor
     * (routes/weekly-picks.cjs getUserPred). Yavaşlaması yarış penceresini
     * genişletir.
     */
    const p = await plan({ fixtureId: FID, userIdLower: "oyuncu3" });
    assert.ok(IXSCAN(p.asama), `COLLSCAN: ${p.asama}`);
    assert.equal(p.donen, 1);
    assert.ok(p.incelenen <= 2, `gereginden fazla belge incelendi: ${p.incelenen}`);
  });

  test("weekly-picks toplu okuma: {fixtureId:$in, userIdLower} indeksli", async () => {
    /* Bu uç bir kez N+1 yüzünden 60 saniyede yanıt veremiyordu; sorgu şekli
     * o düzeltmenin ürünü ve indeksten düşerse aynı yere geri döner. */
    const ids = ["PLAN-FID-1", "PLAN-FID-2", FID];
    const p = await plan({ fixtureId: { $in: ids }, userIdLower: "oyuncu5" });
    assert.ok(IXSCAN(p.asama), `COLLSCAN: ${p.asama}`);
    assert.equal(p.donen, 3);
  });

  test("push-scheduler: {fixtureId:$in} indeksli", async () => {
    const p = await plan({ fixtureId: { $in: ["PLAN-FID-1", FID] } });
    assert.ok(IXSCAN(p.asama), `COLLSCAN: ${p.asama}`);
    assert.equal(p.donen, 2 * MAC);
  });

  test("NÖBETÇİ: kod KARIŞIK HARFLİ userId ile sorgulamıyor", () => {
    /**
     * ⚠️ `userId` (karışık harf) indeksli DEĞİL ve olmamalı — kimlikler
     * Firebase UID'si, tam eşleşme zaten kaçırıyordu (bu depoda ölçülmüş
     * kusur). Biri `{userId: uid}` ile sorgularsa hem COLLSCAN olur hem
     * yanlış sonuç verir.
     */
    const kaynak = ["routes", "services", "lib"].flatMap((d) => {
      const dir = path.join(__dirname, "..", d);
      return fs.readdirSync(dir).filter((f) => f.endsWith(".cjs"))
        .map((f) => ({ ad: `${d}/${f}`, src: fs.readFileSync(path.join(dir, f), "utf8") }));
    });
    const suclu = [];
    for (const { ad, src } of kaynak) {
      if (!/collection\("predictions"\)/.test(src)) continue;
      // `userId:` ile filtreleyen bir find/findOne var mı (projeksiyon değil)
      if (/collection\("predictions"\)[\s\S]{0,200}?\.(find|findOne|countDocuments)\(\{[^}]*\buserId:\s*(?!.*Lower)/.test(src)) {
        suclu.push(ad);
      }
    }
    assert.deepEqual(suclu, [],
      "karisik harfli userId ile tahmin sorgulayan dosya(lar): " + suclu.join(", "));
  });
});
