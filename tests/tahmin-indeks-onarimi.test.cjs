"use strict";

/**
 * TAHMİN İNDEKSLERİ HER SICAK YOLDA KENDİNİ ONARIR.
 *
 * ⚠️ BULUNAN: `lib/preds-index.cjs` tam bu iş için yazılmış — kendi başlığı
 * "diğer BÜTÜN depolar ilk erişimde `ensureIndexes()` çağırıp kendini
 * onarıyor; EN ÇOK SORGULANAN koleksiyon bu davranışa sahip değildi" diyor.
 * Ama onarım YALNIZCA `models/preds.cjs`'ten çağrılıyordu. `predictions`
 * koleksiyonunu DOĞRUDAN sorgulayan altı modül daha var: routes/settle2,
 * routes/duels, routes/pred, routes/pool, routes/weekly-picks,
 * services/bayat-temizleyici.
 *
 * ÖLÇÜLDÜ (taze Mongo, `predictions` indekssiz):
 *     düello settle sonrası     → 0 indeks
 *     bayat temizleyici sonrası → 0 indeks
 *     models/preds sonrası      → 3 indeks
 *     (düzeltmeden sonra ilk ikisi de 3)
 *
 * ⚠️ BELİRTİ "HATA" DEĞİL, YAVAŞLIK — ve modülün kendi notu bunu söylüyor:
 * "kimse bakmaz". `predictions` kod tabanının en büyük koleksiyonu (yerel
 * ölçümde 36.331 kayıt) ve her settle `{fixtureId}` ile tarıyor. İndeks yoksa
 * her settle TÜM koleksiyonu geziyor.
 *
 * ⚠️ BENZERSİZLİK İDDİA EDİLMİYOR (modülün kararı, değiştirmedim): çalışma
 * zamanında unique kurmak, mevcut veride kopya varsa hata verirdi.
 */

const os = require("os");
const path = require("path");
const fs = require("fs");

const TMP = path.join(os.tmpdir(), "skorlig-tahmin-indeks-test");
process.env.SKORLIG_DATA_DIR = TMP;
process.env.SKORLIG_BG = "0";

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const KOK = path.join(__dirname, "..");
const PredsIndex = require("../lib/preds-index.cjs");

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

/**
 * ⚠️ SÖZ ÖNBELLEĞİ SIFIRLANMALI. `ensurePredIndexes` sözü bir kez çözünce
 * bir daha kurmuyor (üretimde doğru davranış). Koleksiyonu düşürüp önbelleği
 * sıfırlamazsak ikinci senaryo VAKUMDA geçer.
 */
function onbellegiSifirla() {
  if (typeof PredsIndex._sifirla === "function") return PredsIndex._sifirla();
  // Dışa açılmamışsa modülü yeniden yükle.
  delete require.cache[require.resolve("../lib/preds-index.cjs")];
  for (const rel of [
    "../routes/settle2.cjs", "../routes/duels.cjs", "../routes/pool.cjs",
    "../routes/weekly-picks.cjs", "../services/bayat-temizleyici.cjs",
  ]) {
    try { delete require.cache[require.resolve(rel)]; } catch {}
  }
  return null;
}

beforeEach(async () => {
  for (const c of ["predictions", "duels", "pools", "pool_bets", "fixtures", "lc_wallet_users"]) {
    await db.collection(c).deleteMany({});
  }
  try { await db.collection("predictions").dropIndexes(); } catch {}
  onbellegiSifirla();
  await db.collection("predictions").insertOne({
    fixtureId: "fx1", userId: "u1", userIdLower: "u1", outcome: "H", at: new Date().toISOString(),
  });
});

const indeksAdlari = async () =>
  (await db.collection("predictions").indexes()).map((i) => i.name).filter((n) => n !== "_id_");

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("başlangıçta indeks YOK (senaryo gerçekten kuruluyor)", async () => {
    assert.deepEqual(await indeksAdlari(), [], "indeksler zaten var — test bir sey olcmuyor");
  });

  test("doğrudan çağrı üç indeksi kuruyor", async () => {
    await require("../lib/preds-index.cjs").ensurePredIndexes(db);
    const ad = await indeksAdlari();
    assert.equal(ad.length, 3, `beklenen 3 indeks, gelen: ${ad.join(", ")}`);
    assert.ok(ad.includes("fixtureId_1"), "settle sorgusunun indeksi yok");
    assert.ok(ad.includes("userIdLower_1"), "kullanici gecmisi indeksi yok");
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("sıcak yollar kendini onarıyor", () => {
  test("düello sonuçlandırma indeksleri kuruyor", async () => {
    const { settleDuelsForFixture } = require("../routes/duels.cjs");
    await db.collection("duels").insertOne({
      id: "d1", fixtureId: "fx1", status: "active", stake: 1, pot: 2, winAmount: 1.9,
      creatorId: "u1", acceptorId: "u2", home: "A", away: "B",
    });
    await settleDuelsForFixture("fx1", { u1: 3, u2: 1 }, db, "H");
    assert.equal(
      (await indeksAdlari()).length, 3,
      "duello settle tahminleri DOGRUDAN sorguluyor ama indeks onarimi calismadi — " +
        "her settle tum koleksiyonu tarar"
    );
  });

  test("bayat temizleyici indeksleri kuruyor", async () => {
    const T = require("../services/bayat-temizleyici.cjs");
    await T.tur(db).catch(() => {});
    assert.equal((await indeksAdlari()).length, 3, "bayat temizleyici onarim yapmadi");
  });

  test("havuz tahmin dağılımı indeksleri kuruyor", async () => {
    const Pool = require("../routes/pool.cjs");
    const f = Pool._tahminDagilimi || null;
    if (!f) return; // dışa açılmamışsa bu yol ayrıca sınanmıyor
    await f("fx1", db);
    assert.equal((await indeksAdlari()).length, 3);
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: predictions'a DOĞRUDAN erişen her çalışma zamanı modülü onarımı çağırıyor", () => {
  /**
   * ⚠️ ELLE LİSTE YOK — kural koddan türetiliyor. `scripts/` ve `models/`
   * hariç: biri çevrimdışı bakım aracı, öteki onarımın kendi evi.
   */
  const suclu = [];
  const gez = (dizin) => {
    for (const ad of fs.readdirSync(dizin)) {
      if (["node_modules", "scripts", "tests", "models"].includes(ad) || ad.startsWith(".")) continue;
      const tam = path.join(dizin, ad);
      if (fs.statSync(tam).isDirectory()) { gez(tam); continue; }
      if (!ad.endsWith(".cjs")) continue;

      const src = fs.readFileSync(tam, "utf8")
        .split("\n")
        .map((l) => {
          const t = l.trim();
          return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
        })
        .join("\n");
      if (!/collection\(\s*"predictions"\s*\)/.test(src)) continue;
      if (/ensurePredIndexes/.test(src)) continue;
      suclu.push(path.relative(KOK, tam).replace(/\\/g, "/"));
    }
  };
  gez(KOK);

  assert.deepEqual(
    suclu, [],
    `predictions'i dogrudan sorgulayip indeks onarimini cagirmayan modul(ler): ${suclu.join(", ")}`
  );
});
