"use strict";

/**
 * BAYAT TEMİZLEYİCİ KAPANIŞTA YARIDA KESİLMİYOR.
 *
 * ⚠️ BULUNAN: `lib/kritik-is.cjs` tam bu durum için yazılmış — kendi başlığı
 * "sorun ARKA PLAN servislerinde: otomatik settle ve livescore-sync
 * zamanlayıcıyla çalışır, hiçbir isteğe bağlı değildir" diyor. Ama sayacı
 * YALNIZCA `routes/settle2.cjs` kullanıyordu.
 *
 * `services/bayat-temizleyici.cjs` de zamanlayıcıyla çalışıyor (6 saatte bir)
 * ve ÜÇ yerde LC iade ediyor: `duel_void_refund`, `pool_void_refund`,
 * `pred_void_refund`. Sayaca hiç girmiyordu.
 *
 * ÖLÇÜLDÜ (tur çalışırken sayaç örneklendi):
 *     önce : aktifKritikIs() = 0   → kapanış beklemeden çıkardı
 *     sonra: aktifKritikIs() = 1
 *
 * ⚠️ NEDEN ÖNEMLİ: bu servis "MÜHÜR ÖNCE, ÖDEME SONRA" sırasını kullanıyor
 * (kendi başlığı). SIGTERM ödeme sırasında düşerse düello/havuz iptali
 * MÜHÜRLÜ kalır ama iade yatmaz — mühür yüzünden tekrar da denenmez, para
 * kaybolur. Render ücretsiz katmanda SIGTERM her deploy'da ve boşta uyutmada
 * geliyor, yani çakışma kuramsal değil.
 *
 * ⚠️ BU BİR KİLİT DEĞİL: `kritikIs` eşzamanlılığı engellemez, yalnızca
 * "devam eden iş var" der. Eşzamanlılık koruması zaten mühürlerde.
 */

const os = require("os");
const path = require("path");
const fs = require("fs");

const TMP = path.join(os.tmpdir(), "skorlig-bayat-kritik-test");
process.env.SKORLIG_DATA_DIR = TMP;
process.env.SKORLIG_BG = "0";

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const KOK = path.join(__dirname, "..");
const Temizleyici = require("../services/bayat-temizleyici.cjs");
const { aktifKritikIs, aktifEtiketler } = require("../lib/kritik-is.cjs");

let mongod = null, client = null, db = null;
const SAAT = 3600_000;

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
  for (const c of ["duels", "pools", "pool_bets", "predictions", "fixtures", "lc_wallet_users"]) {
    await db.collection(c).deleteMany({});
  }
});

/** Sonucu hiç gelmemiş, 60 saat önce başlamış bir maçta kabul edilmiş düello. */
async function bayatDuelloKur() {
  const eski = new Date(Date.now() - 60 * SAAT).toISOString();
  await db.collection("fixtures").insertOne({
    fixtureId: "fx-bayat", home: "A", away: "B", status: "NS", kickoffISO: eski,
  });
  await db.collection("duels").insertOne({
    id: "d-bayat", fixtureId: "fx-bayat", status: "active", stake: 5,
    creatorId: "kuran", acceptorId: "kabul", kickoffISO: eski,
  });
}

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("sayaç boştayken sıfır", () => {
    assert.equal(aktifKritikIs(), 0, "baslangicta sayac sifir olmali");
  });

  test("temizleyici gerçekten para iade ediyor", async () => {
    await bayatDuelloKur();
    const r = await Temizleyici.tur(db);
    assert.equal(r.ok, true);
    assert.ok(
      r.duello.iptal >= 1,
      `hicbir duello iptal edilmedi (${JSON.stringify(r.duello)}) — test bir sey olcmuyor`
    );
    assert.ok(r.duello.iadeLc > 0, "iade edilen LC yok");
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("kritik iş sayacı", () => {
  test("tur SÜRERKEN sayaç sıfırdan büyük", async () => {
    await bayatDuelloKur();

    let enYuksek = 0;
    const etiketler = new Set();
    const orneklec = setInterval(() => {
      const n = aktifKritikIs();
      if (n > enYuksek) enYuksek = n;
      for (const e of aktifEtiketler()) etiketler.add(e);
    }, 1);

    await Temizleyici.tur(db);
    clearInterval(orneklec);

    assert.ok(
      enYuksek > 0,
      "tur boyunca sayac hep 0 kaldi — kapanis bu servisi BEKLEMEDEN cikar, " +
        "muhurlu ama odenmemis iade kalir"
    );
    assert.ok(
      [...etiketler].some((e) => e.includes("bayat")),
      `etiket bulunamadi: ${[...etiketler].join(", ") || "(yok)"}`
    );
  });

  test("tur bitince sayaç geri sıfırlanıyor", async () => {
    await bayatDuelloKur();
    await Temizleyici.tur(db);
    assert.equal(aktifKritikIs(), 0, "sayac dusmedi — kapanis sonsuza kadar bekler");
  });

  test("tur HATA verse bile sayaç düşüyor", async () => {
    /**
     * ⚠️ Sayaç düşmezse kapanış zaman aşımına kadar bekler ve her deploy
     * yavaşlar. `kritikIs` finally kullanıyor; burada uçtan uca doğrulanıyor.
     */
    const bozuk = { collection: () => { throw new Error("mongo yok"); } };
    await Temizleyici.tur(bozuk).catch(() => {});
    assert.equal(aktifKritikIs(), 0, "hata sonrasi sayac takili kaldi");
  });

  test("DB yokken de sayaç temiz kalıyor", async () => {
    const r = await Temizleyici.tur(null).catch(() => ({ ok: false }));
    assert.equal(aktifKritikIs(), 0);
    assert.ok(r);
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

const kaynak = (rel) =>
  fs.readFileSync(path.join(KOK, rel), "utf8")
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");

test("NÖBETÇİ: para dağıtan HER zamanlayıcı servisi sayaca dahil", () => {
  /**
   * ⚠️ ELLE LİSTE YAZMIYORUM. Bu oturumda elle tutulan listelerin gerçeklikten
   * ayrışması dört kez hata üretti. Kural koddan türetiliyor: `setInterval`
   * kullanan VE LC yazan her servis `kritikIs` çağırmalı.
   */
  const dizin = path.join(KOK, "services");
  const suclu = [];
  for (const ad of fs.readdirSync(dizin)) {
    if (!ad.endsWith(".cjs")) continue;
    const src = kaynak(path.join("services", ad));
    if (!/setInterval\s*\(/.test(src)) continue;
    if (!/creditLc\s*\(|spendLc\s*\(/.test(src)) continue;
    if (/kritikIs\s*\(/.test(src)) continue;
    suclu.push(ad);
  }
  assert.deepEqual(
    suclu, [],
    `zamanlayiciyla para dagitip kritik is sayacina girmeyen servis(ler): ${suclu.join(", ")}`
  );
});

test("NÖBETÇİ: kapanış iki sayacı da bekliyor", () => {
  const src = kaynak("server.cjs");
  assert.ok(
    /activeLockCount\(\)\s*>\s*0\s*\|\|\s*aktifKritikIs\(\)\s*>\s*0/.test(src),
    "kapanis yalnizca dosya kilitlerini bekliyor — mongo tabanli para isleri kesilir"
  );
});
