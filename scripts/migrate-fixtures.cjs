"use strict";

/**
 * Tek seferlik migration: fixtures.json → MongoDB `fixtures` koleksiyonu.
 *
 * Kullanım:
 *   node api/scripts/migrate-fixtures.cjs          (yazar)
 *   node api/scripts/migrate-fixtures.cjs --dry    (yalnızca gösterir)
 *
 * NEDEN: `data/fixtures.json` Render'da her deploy'da siliniyor (kalıcı disk
 * yok). Maçlar dış senkronla yeniden dolana kadar uygulama boş görünüyor — ve
 * dolma hızı/kapsamı kontrol etmediğimiz kaynaklara bağlı. Ölçüldü (2026-07-29):
 * yeniden başlatmadan sonra üretim önbelleği 16 lig / 70 maçtı, yerelde aynı
 * anda 62 lig / 201 maç.
 *
 * ⚠️⚠️ ÜRETİM İÇİN BU SCRIPT GEREKMEZ — VE YERELDEN ÇALIŞTIRILMAMALI.
 * Üretim kendi kendine taşınır: dağıtımdan sonraki ilk senkron turunda
 * `readFixtures()` Mongo'yu boş bulur, ÜRETİMİN KENDİ dosyasına düşer, merge
 * eder ve `saveAll` ile Mongo'ya yazar (en geç 3 dk, Maçkolik senkronu).
 * Bunu yerel makineden production MONGODB_URI ile çalıştırmak, GELİŞTİRME
 * makinesindeki fixtures.json'ı (test/elle girilmiş kayıtlar dahil) üretime
 * yükler ve üretimin gerçek listesini SİLER — saveAll tam değiştirme yapar.
 * Yalnızca yerel geliştirmede ya da üretim sunucusunun kendi kabuğunda kullan.
 *
 * ⚠️ SEZON TOPLAMLARI MIGRATION'INDAN FARKLI: bu script tekrar çalıştırılabilir.
 * `saveAll` upsert yapar ve listede olmayanı siler; dosya neyse Mongo o olur.
 * Yani senkron çalıştıktan sonra tekrar çalıştırmak, Mongo'yu ESKİ dosyaya
 * geri döndürür. Bir kez, geçiş anında çalıştır.
 *
 * Doğrulama: GET /api/live/schedule  → maç sayısı migration öncesiyle aynı olmalı.
 */

const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { getDb } = require("../lib/mongo.cjs");
const FixturesStore = require("../lib/fixtures-store.cjs");

const DRY = process.argv.includes("--dry");

(async () => {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(FixturesStore.FIXTURES_FILE, "utf8"));
  } catch (e) {
    console.error(`fixtures.json okunamadi (${FixturesStore.FIXTURES_FILE}):`, e.message);
    process.exit(1);
  }

  const list = FixturesStore._unwrap(raw).filter((f) => f && f.fixtureId != null);
  if (!list.length) {
    console.log("fixtures.json bos — tasinacak kayit yok.");
    process.exit(0);
  }

  const db = await getDb();
  if (!db) {
    console.error("MongoDB baglantisi yok. api/.env icinde MONGODB_URI tanimli mi?");
    process.exit(1);
  }

  const mevcut = await db.collection(FixturesStore.COLL).countDocuments();
  const kaynaklar = {};
  for (const f of list) {
    const k = String(f.source || "?");
    kaynaklar[k] = (kaynaklar[k] || 0) + 1;
  }

  console.log(`fixtures.json : ${list.length} kayit`);
  console.log(`kaynak dagilimi: ${JSON.stringify(kaynaklar)}`);
  console.log(`mongo (once)  : ${mevcut} kayit`);

  if (DRY) {
    console.log("--dry: hicbir sey yazilmadi. Ornek ilk 3:");
    for (const f of list.slice(0, 3)) {
      console.log(`   ${f.fixtureId}  ${f.home} - ${f.away}  ${f.kickoffISO || "?"}  [${f.league || "?"}]`);
    }
    process.exit(0);
  }

  const r = await FixturesStore.saveAll(list, db);
  const sonra = await db.collection(FixturesStore.COLL).countDocuments();

  console.log(`yazildi       : mongo=${r.mongo} dosya=${r.file} silinen=${r.deleted}`);
  console.log(`mongo (sonra) : ${sonra} kayit`);
  console.log('dogrulama: GET /api/live/schedule -> mac sayisi degismemis olmali');
  process.exit(0);
})().catch((e) => {
  console.error("migration hatasi:", e);
  process.exit(1);
});
