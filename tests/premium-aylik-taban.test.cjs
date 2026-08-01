"use strict";

/**
 * PREMIUM AYLIK TABAN — EŞZAMANLI ÇAĞRIDA BİR KEZ VERİLİR.
 *
 * ⚠️ BU TURDA KUSUR BULUNMADI, ve bunu dürüstçe yazıyorum. Somut bir açık
 * arayarak geldim: `/lc-wallet/summary` Mongo dalındaki koşullu yazma (CAS)
 * yalnızca `lastRegenAt` alanına bakıyor. Aylık taban ise `lastMonthlyAt`
 * mührüyle korunuyor ve `applyRegen` bazı durumlarda `lastRegenAt`'i HİÇ
 * DEĞİŞTİRMİYOR (`ticks <= 0` ile erken dönüyor). Kâğıt üstünde: eşzamanlı iki
 * çağrı da filtreyi geçer ve taban İKİ KEZ eklenir.
 *
 * ÖLÇTÜM, ÜRETİLMEDİ:
 *     40 eşzamanlı summary çağrısı            → bakiye 60 (taban 60), fazla 0
 *     30 ms yapay DB gecikmesiyle (Atlas taklidi) → yine 60, fazla 0
 * Yerel bellek-içi Mongo ~0.1 ms cevap verdiği için gecikmeyi bilerek
 * büyüttüm; yarış penceresini kapatmak değil AÇMAK istiyordum. Yine de
 * ikinci bir tamamlama üretemedim.
 *
 * ⚠️ NEGATİF KONTROL BANA BİR ŞEY ÖĞRETTİ, ve testin iddiasını buna göre
 * KÜÇÜLTTÜM. `grantMonthlyIfDue` içindeki `lastMonthlyAt` mührünü sildim:
 * aşağıdaki eşzamanlılık testleri KIRILMADI. Sebebi öğretici — koruma
 * mühürde değil, TAMAMLAMA SEMANTİĞİNDE. İlk çağrı bakiyeyi tabana çektiği
 * an ikinci çağrının vereceği miktar sıfır oluyor. Yani "tabana tamamla"
 * kararı, yan etkisi olarak grant'i doğal olarak idempotent yapmış; mühür
 * ikinci katman.
 *
 * Bu yüzden bu dosya "mühür çalışıyor" demiyor. Şunları kilitliyor:
 *   • 40 eşzamanlı çağrıda bakiye tabanı AŞMIYOR
 *   • defterde tek kayıt var (bakiye artışı denetim izinden okunabiliyor)
 *   • tamamlama kuralı: zengine hiç, yarım bakiyeye fark kadar, ücretsize hiç
 * Hepsi para değişmezleri ve kırılırsa kusur SESSİZ olur — bakiye artar,
 * kimse hata görmez.
 *
 * ⚠️ KİMLİK KAPISI TEST İÇİN SABİTLENİYOR: `middleware/verifyToken.cjs` modül
 * önbelleği önceden dolduruluyor. Depoda gerçek bir
 * `firebase-service-account.json` var ve rota gerçek Firebase'e gidiyordu.
 * Rotanın PARA MANTIĞI değişmiyor — yalnızca kim olduğumuz sabitleniyor.
 */

const os = require("os");
const path = require("path");
const fs = require("fs");

const KOK = path.join(__dirname, "..");
const TMP = path.join(os.tmpdir(), "skorlig-premium-aylik-test");
process.env.SKORLIG_DATA_DIR = TMP;
process.env.SKORLIG_BG = "0";

const vtYol = require.resolve(path.join(KOK, "middleware", "verifyToken.cjs"));
require.cache[vtYol] = {
  id: vtYol, filename: vtYol, loaded: true, exports: {
    verifyToken: (req, _res, next) => { req.uid = req.headers["x-user-id"]; next(); },
    optionalToken: (req, _res, next) => { req.uid = req.headers["x-user-id"] || null; next(); },
    getFirebaseAuth: () => null,
    kimlikModu: () => "test",
  },
};

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const express = require("express");
const premium = require("../lib/premium.cjs");

const TABAN = premium.PERKS.monthlyFloor;
let mongod = null, client = null, db = null, srv = null, port = 0;

before(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });

  const { MongoMemoryServer } = require("mongodb-memory-server");
  const { MongoClient } = require("mongodb");
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  db = client.db("test");

  const app = express();
  app.use((req, _res, next) => { req.app.locals.db = db; next(); });
  app.use("/api/rt", require("../routes/lc-wallet.cjs"));
  srv = app.listen(0);
  port = srv.address().port;
});

after(async () => {
  if (srv) srv.close();
  if (client) await client.close();
  if (mongod) await mongod.stop();
});

async function kur(uid, { prem = true, bakiye = 0, aylikMuhru = null } = {}) {
  await db.collection("users").deleteMany({});
  await db.collection("lc_wallet_users").deleteMany({});
  await db.collection("lc_wallet_ledger").deleteMany({});

  await db.collection("users").insertOne({
    userId: uid, userIdLower: uid.toLowerCase(),
    premium: prem,
    premiumUntil: prem ? new Date(Date.now() + 30 * 86400_000).toISOString() : null,
  });
  await db.collection("lc_wallet_users").insertOne({
    userId: uid, userIdLower: uid.toLowerCase(), balance: bakiye, totalEarned: 0, totalSpent: 0,
    /* ⚠️ lastRegenAt ŞİMDİ: `applyRegen` `ticks <= 0` ile erken döner ve bu
     * alanı DEĞİŞTİRMEZ. CAS filtresi yalnızca buna baktığı için, yarışın
     * görünmesi isteniyorsa alan sabit kalmalı — senaryo bilerek en zayıf
     * hâlde kuruluyor. */
    lastRegenAt: new Date().toISOString(),
    lastMonthlyAt: aylikMuhru,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
}

const ozet = (uid) =>
  fetch(`http://127.0.0.1:${port}/api/rt/lc-wallet/summary?userId=${uid}`, {
    headers: { "x-user-id": uid },
  }).then((r) => r.json());

const cuzdan = (uid) => db.collection("lc_wallet_users").findOne({ userIdLower: uid.toLowerCase() });
const defter = (uid) =>
  db.collection("lc_wallet_ledger").find({ reason: "premium_monthly" }).toArray();

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("taban pozitif ve uç cevap veriyor", async () => {
    assert.ok(TABAN > 0, `monthlyFloor ${TABAN} — ayricalik kapali, test bir sey olcmuyor`);
    await kur("k1");
    const r = await ozet("k1");
    assert.equal(r.ok, true, `uc cevap vermedi: ${JSON.stringify(r).slice(0, 120)}`);
  });

  test("tek çağrıda taban gerçekten veriliyor", async () => {
    await kur("k2");
    await ozet("k2");
    assert.equal((await cuzdan("k2")).balance, TABAN, "aylik taban hic verilmiyor");
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("eşzamanlı summary", () => {
  test("40 eşzamanlı çağrı bakiyeyi tabanın ÜSTÜNE çıkarmıyor", async () => {
    /**
     * ⚠️ DÜRÜST SINIR: bu testi "mühür çalışıyor" diye okumayın. Negatif
     * kontrolde `lastMonthlyAt` mührünü sildim ve test KIRILMADI — çünkü
     * asıl koruma tamamlama semantiğinde (ilk çağrıdan sonra verilecek
     * miktar zaten sıfır). Burada kilitlenen şey daha zayıf ama yine de
     * para değişmezi: bakiye tabanı aşmıyor.
     */
    await kur("yaris");
    await Promise.all(Array.from({ length: 40 }, () => ozet("yaris")));
    const w = await cuzdan("yaris");
    assert.equal(
      w.balance, TABAN,
      `bakiye ${w.balance}, taban ${TABAN} — aylik tamamlama birden fazla kez uygulanmis`
    );
    assert.equal(w.totalEarned, TABAN, "totalEarned bakiyeyle tutarsiz");
  });

  test("defterde tek kayıt — denetim izi bakiyeyi açıklıyor", async () => {
    /**
     * ⚠️ Bu ayrı bir iddia: bakiye doğru olsa bile defter kaydı eksik ya da
     * fazla olabilir. Bu oturumda tam o kusur bulundu (otomatik birikim
     * bakiyeyi artırıp deftere hiç yazmıyordu) — değişmez şu: bakiye artışı
     * defterden okunabilmeli.
     */
    await kur("defterli");
    await Promise.all(Array.from({ length: 40 }, () => ozet("defterli")));
    const kayitlar = await defter("defterli");
    assert.equal(kayitlar.length, 1, `defterde ${kayitlar.length} premium_monthly kaydi var`);
    assert.equal(kayitlar[0].amount, TABAN);
  });
});

describe("tamamlama kuralı", () => {
  test("bakiyesi tabanın ÜSTÜNDE olana hiç verilmiyor", async () => {
    // Koşulsuz ekleme değil TAMAMLAMA — zengin oyuncuya para basılmaz.
    await kur("zengin", { bakiye: TABAN + 100 });
    await ozet("zengin");
    assert.equal((await cuzdan("zengin")).balance, TABAN + 100);
    assert.equal((await defter("zengin")).length, 0);
  });

  test("aradaki fark kadar tamamlanıyor", async () => {
    await kur("yarim", { bakiye: Math.floor(TABAN / 3) });
    await ozet("yarim");
    assert.equal((await cuzdan("yarim")).balance, TABAN);
  });

  test("premium OLMAYANA verilmiyor", async () => {
    await kur("ucretsiz", { prem: false });
    await ozet("ucretsiz");
    assert.equal((await cuzdan("ucretsiz")).balance, 0, "ucretsiz kullaniciya premium tabani verilmis");
  });

  test("bu ay mührü basılıysa tekrar verilmiyor", async () => {
    await kur("muhurlu", { aylikMuhru: premium.monthKey() });
    await ozet("muhurlu");
    assert.equal((await cuzdan("muhurlu")).balance, 0, "ayni ay ikinci kez tamamlama yapildi");
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: bakiye GÖRELİ yazılıyor, mutlak değil", () => {
  /**
   * Mutlak (`$set: balance`) yazım, araya giren bir HARCAMAyı geri getirir —
   * bu kusur daha önce bulundu ve düzeltildi. CAS filtresi yalnızca birikimi
   * koruyor, harcamayı değil; koruma `$inc` olmasında.
   */
  const src = fs.readFileSync(path.join(KOK, "routes", "lc-wallet.cjs"), "utf8")
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");

  assert.ok(/\$inc = \{ balance: eklenen/.test(src), "bakiye goreli yazilmiyor");
  assert.ok(
    !/\$set:\s*\{[^}]*balance:\s*user\.balance/s.test(src),
    "bakiye mutlak yaziliyor — araya giren harcama geri gelir"
  );
});

test("NÖBETÇİ: aylık tamamlama mühür ne olursa olsun basıyor", () => {
  /**
   * `lastMonthlyAt` 0 verilse de yazılmalı; yoksa gün içinde bakiye düştükçe
   * defalarca tamamlama yapılırdı.
   */
  const src = fs.readFileSync(path.join(KOK, "lib", "premium.cjs"), "utf8");
  const i = src.indexOf("walletUser.lastMonthlyAt = mk;");
  const j = src.indexOf("if (verilecek <= 0) return 0;");
  assert.ok(i > 0 && j > i, "muhur, sifir verilen dalda basilmiyor olabilir");
});
