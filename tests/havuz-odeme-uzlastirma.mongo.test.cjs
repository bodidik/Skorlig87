"use strict";

/**
 * MAÇ HAVUZU: ÖDENEN + YAKILAN === HAVUZ (yoktan LC yok, boşuna yakma yok).
 *
 * ⚠️ BULUNAN KUSUR (2026-08-03): `settlePool` kazanan başına bağımsız
 * `Math.round(bahis × çarpan)` yapıyor ve toplamı havuzla hiç
 * karşılaştırmıyordu. Kesinti de ayrı yuvarlanıyordu.
 *
 * ÖLÇÜLDÜ (gerçek `settlePool`, bellek-içi Mongo, 210 senaryo:
 * kazanan 2-20 × bahis 5-50 × kaybeden oranı 0.1-2):
 *     %49.0 havuzdan FAZLA dağıtım   ← yoktan LC
 *     %47.6 eksik (LC boşuna yakılıyor)
 *     %3.3  tam eşit
 *     en kötü: 20 kazanan × 5 LC + 100 kaybeden → havuz 200,
 *              ödenen 200 + yakılan 10 = 210   (+10 LC yoktan)
 * `.5` payları hep yukarı yuvarlandığı için sapma kazanan sayısıyla büyüyor.
 *
 * ⚠️ AYNI KUSUR TURNUVADA DA VARDI (%23.4 fazla ödeme) ve orada düzeltilmişti;
 * kural o dosyada kaldığı için havuz aynı hatayı taşımaya devam ediyordu.
 * Dağıtım artık tek kaynakta: lib/pay-dagitim.cjs (en büyük kalan yöntemi).
 *
 * SONRA: 210/210 senaryoda ödenen + yakılan === havuz.
 */

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const KOK = path.join(__dirname, "..");
process.env.SKORLIG_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "skorlig-havuz-"));

const Pool = require(path.join(KOK, "lib", "pool-store.cjs"));

let mongod = null, client = null, db = null;
let sayac = 0;

before(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const { MongoClient } = require("mongodb");
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  db = client.db("test");
});

after(async () => {
  await client?.close();
  await mongod?.stop();
  try { fs.rmSync(process.env.SKORLIG_DATA_DIR, { recursive: true, force: true }); } catch { /* geçici */ }
});

/** Bir havuz kurar ve GERÇEK settlePool ile uzlaştırır. */
async function kosu({ kazananlar, kaybedenToplam, sonuc = "H" }) {
  const fid = `HAVUZ-TEST-${++sayac}`;
  await db.collection("pool_bets").deleteMany({});
  await db.collection("pools").deleteMany({});
  await db.collection("lc_wallet_users").deleteMany({});

  const bets = kazananlar.map((tutar, i) => ({
    fixtureId: fid, userId: `K${i}`, userIdLower: `k${i}`, side: "H", amount: tutar,
  }));
  if (kaybedenToplam > 0) {
    bets.push({ fixtureId: fid, userId: "L1", userIdLower: "l1", side: "A", amount: kaybedenToplam });
  }
  await db.collection("pool_bets").insertMany(bets);
  await db.collection("lc_wallet_users").insertMany(
    bets.map((b) => ({ userId: b.userId, userIdLower: b.userIdLower, balance: 0, totalEarned: 0, totalSpent: 0 }))
  );

  const r = await Pool.settlePool(fid, sonuc, db);
  const havuz = bets.reduce((a, b) => a + b.amount, 0);
  const cuzdanlar = await db.collection("lc_wallet_users")
    .find({ userIdLower: { $regex: "^k" } }).toArray();
  return { r, havuz, kazananBakiyeleri: cuzdanlar.map((c) => Number(c.balance || 0)) };
}

describe("maç havuzu — ödeme uzlaştırması", () => {
  test("kurulum sınandı: uzlaştırma GERÇEKTEN para dağıtıyor", async () => {
    /* ⚠️ Bu olmadan "toplam tutuyor" iddiası boş: hiç ödeme yapılmasa
     * 0 + 0 = 0 da "tutar" görünürdü. */
    const { r, kazananBakiyeleri } = await kosu({ kazananlar: [10, 10], kaybedenToplam: 20 });
    assert.ok(r.ok, "uzlastirma basarisiz");
    assert.ok(Number(r.paid) > 0, "hic odeme yapilmamis — test bir sey olcmuyor");
    assert.ok(kazananBakiyeleri.every((b) => b > 0), "kazananlarin cuzdani artmamis");
  });

  test("ÖLÇÜLEN EN KÖTÜ VAKA: 20 kazanan × 5 LC + 100 kaybeden", async () => {
    /* Eski kod: ödenen 200 + yakılan 10 = 210, havuz 200 → +10 LC yoktan. */
    const { r, havuz } = await kosu({ kazananlar: Array(20).fill(5), kaybedenToplam: 100 });
    assert.equal(havuz, 200);
    assert.equal(Number(r.paid) + Number(r.burned), havuz,
      `odenen ${r.paid} + yakilan ${r.burned} != havuz ${havuz}`);
  });

  test("210 SENARYODA ödenen + yakılan === havuz", async () => {
    /**
     * ⚠️ ASIL PARA KURALI. Tek senaryo yeterli değil: sapma kazanan sayısına
     * ve bahis büyüklüğüne göre değişiyor (eski kodda %49 senaryoda fazla).
     */
    for (const n of [2, 3, 5, 7, 10, 15, 20]) {
      for (const bahis of [5, 7, 11, 13, 25, 50]) {
        for (const oran of [0.1, 0.3, 0.5, 1, 2]) {
          const kaybeden = Math.max(0, Math.round(n * bahis * oran));
          const { r, havuz } = await kosu({ kazananlar: Array(n).fill(bahis), kaybedenToplam: kaybeden });
          assert.equal(Number(r.paid) + Number(r.burned), havuz,
            `n=${n} bahis=${bahis} kaybeden=${kaybeden}: ${r.paid}+${r.burned} != ${havuz}`);
        }
      }
    }
  });

  test("YAKILAN kesintiyi AŞMIYOR (artan birim oyunculara gider)", async () => {
    /**
     * ⚠️ BU TESTİ NEGATİF KONTROL DOĞURDU — İLK HÂLİMDE BOŞLUK VARDI.
     *
     * `yakilan` artık `havuz - dağıtılan` olarak TÜRETİLİYOR. Bu, "ödenen +
     * yakılan === havuz" değişmezini her koşulda sağlıyor — ama artan birim
     * oyunculara dağıtılmazsa da sağlıyor: fark sessizce YAKILIYOR.
     * Sabotajı (artan dağıtımını kaldır) uyguladığımda diğer testler geçmeye
     * devam etti; değişmez korunuyordu ama oyuncunun parası yanıyordu.
     *
     * Doğru sınır: kesinti yalnızca CUT_PCT kadar olmalı (yuvarlamadan
     * en fazla 1 LC pay). Kaybeden yoksa hiç kesinti olmamalı.
     */
    const { cutPct } = await Pool.summary("YOK", db);   // modülün KENDİ oranı
    for (const n of [3, 7, 20]) {
      for (const bahis of [5, 7, 13]) {
        const kaybeden = n * bahis;
        const { r, havuz } = await kosu({ kazananlar: Array(n).fill(bahis), kaybedenToplam: kaybeden });
        const ustSinir = Math.ceil(havuz * cutPct);
        assert.ok(Number(r.burned) <= ustSinir,
          `n=${n} bahis=${bahis}: yakilan ${r.burned} > kesinti ust siniri ${ustSinir} — artan birim oyunculara gitmemis`);
      }
    }
  });

  test("ADALET: eşit bahis yapanlar en fazla 1 LC farkla ödenir", async () => {
    /**
     * ⚠️ TERS RİSK. En büyük kalan yöntemi artan birimi birine verir; kural
     * yanlış yazılırsa tüm artan tek kişiye gidip aynı bahsi yapan iki oyuncu
     * çok farklı ödeme alabilirdi.
     */
    for (const n of [3, 7, 20]) {
      const { kazananBakiyeleri } = await kosu({ kazananlar: Array(n).fill(7), kaybedenToplam: 13 });
      const fark = Math.max(...kazananBakiyeleri) - Math.min(...kazananBakiyeleri);
      assert.ok(fark <= 1, `${n} esit bahiste ${fark} LC fark olustu`);
    }
  });

  test("BÜYÜK bahis daha çok kazanır (orantı korunuyor)", async () => {
    /* Dağıtım tam sayıya oturtulurken orantının bozulmaması gerekir. */
    const { kazananBakiyeleri } = await kosu({ kazananlar: [5, 50], kaybedenToplam: 55 });
    assert.ok(kazananBakiyeleri[1] > kazananBakiyeleri[0],
      "buyuk bahis daha az kazandi — oranti bozuk");
  });

  test("KAYBEDEN YOKSA kesinti alınmaz (herkes bahsini geri alır)", async () => {
    /* ⚠️ Dosyanın kendi kuralı: kesinti YALNIZCA kaybeden taraf varken. */
    const { r, havuz, kazananBakiyeleri } = await kosu({ kazananlar: [10, 20, 30], kaybedenToplam: 0 });
    assert.equal(Number(r.burned), 0, "kaybeden yokken kesinti alinmis");
    assert.equal(Number(r.paid), havuz, "iade tam degil");
    assert.deepEqual(kazananBakiyeleri, [10, 20, 30], "herkes kendi bahsini geri almali");
  });

  test("NÖBETÇİ: dağıtım TEK KAYNAKTAN, kendi yuvarlaması yok", () => {
    /**
     * ⚠️ KUSURUN KÖKÜ: kural turnuvada düzeltilmiş ama havuzda kendi
     * yuvarlaması duruyordu. Biri geri koyarsa aynı sızıntı döner ve HATA
     * VERMEZ — yalnızca LC üretir.
     */
    const oku = (rel) => fs.readFileSync(path.join(KOK, rel), "utf8")
      .split(/\r?\n/).map((l) => {
        const t = l.trim();
        return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
      }).join("\n");

    const havuz = oku(path.join("lib", "pool-store.cjs"));
    assert.ok(/odemeDagit\(/.test(havuz), "havuz ortak dagitimi kullanmiyor");
    assert.ok(!/Math\.round\(Number\(b\.amount \|\| 0\) \* carpan\)/.test(havuz),
      "havuz kazanc basina kendi yuvarlamasina donmus");

    const turnuva = oku(path.join("services", "tournament.cjs"));
    assert.ok(/require\("\.\.\/lib\/pay-dagitim\.cjs"\)/.test(turnuva),
      "turnuva ortak dagitimi kullanmiyor — kural yine iki yerde");
  });
});
