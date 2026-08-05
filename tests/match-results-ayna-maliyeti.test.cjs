"use strict";

/**
 * MATCH-RESULTS AYNASI MONGO VARKEN YAZILMIYOR.
 *
 * ⚠️ BULUNAN: `lib/match-results.cjs` her snapshot yazımında TÜM kitabı
 * dosyaya yeniden serileştiriyordu (`writeJsonAtomic(FILE, book)`), Mongo
 * birincil olsa bile. Dosya bugün 23.6 MB.
 *
 * ÖLÇÜLDÜ (1537 kayıt, gerçek veri):
 *     tek snapshot yazımı : 507 ms (medyan)
 *     bunun 373 ms'i      : JSON.stringify — OLAY DÖNGÜSÜNÜ BLOKLAR
 *     maç günü ~50 settle : ~26 sn toplam blokaj, dosya kilidi tutarak
 *
 * ⚠️ MALİYET KARŞILIKSIZDI: Mongo varken bu dosya HİÇ OKUNMUYOR.
 * `getSnapshot` ve `listSnapshots`, `db` verildiğinde doğrudan koleksiyona
 * gidiyor; dosyaya yalnızca `db` YOKKEN düşüyorlar. Ayna yazma-only bir yandı.
 *
 * ⚠️ NEDEN GÜVENLİ: bu modülde tohumlama (koleksiyon boşsa dosyadan yükle)
 * YOK. `lib/social-store.cjs`te aynayı kapatmak eski dosyanın Mongo'ya geri
 * yazılmasına yol açardı — bu oturumda tam o yaşandı, silinen arkadaşlık
 * dirildi. Burada öyle bir yol yok, o yüzden ayna kapatılabilir.
 */

const os = require("os");
const nodePath = require("path");
const fs = require("fs");

const TMP = nodePath.join(os.tmpdir(), "skorlig-mr-ayna-test");
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
process.env.SKORLIG_DATA_DIR = TMP;

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const DOSYA = nodePath.join(TMP, "match-results.json");

/* ── Değişmez: varsayılan davranış ──────────────────────────────────────── */

describe("ayna varsayılanı", () => {
  test("MONGODB_URI varsa ayna KAPALI", () => {
    /* Modül seviyesinde okunduğu için ayrı süreçte sınıyoruz. */
    const { execFileSync } = require("child_process");
    const cikti = execFileSync(process.execPath, [
      "-e",
      `process.env.MONGODB_URI = "mongodb://ornek";
       delete process.env.SKORLIG_MATCHRESULTS_FILE_MIRROR;
       process.env.SKORLIG_DATA_DIR = ${JSON.stringify(TMP)};
       const m = require(${JSON.stringify(nodePath.join(__dirname, "..", "lib", "match-results.cjs"))});
       console.log(String(m._FILE_MIRROR));`,
    ], { encoding: "utf8" }).trim();

    assert.equal(
      cikti, "false",
      `Mongo varken ayna ACIK (${cikti}) — her snapshot 23.6 MB dosyayi ` +
      `yeniden yaziyor ve 373 ms olay dongusunu blokluyor, ustelik o dosya ` +
      `Mongo varken HIC OKUNMUYOR`
    );
  });

  test("MONGODB_URI YOKSA ayna AÇIK (dosya tek kaynak)", () => {
    /* ⚠️ Yanlış pozitif koruması: düzeltme "aynayı hep kapat" DEĞİL. Mongo
     * yokken dosya tek veri kaynağı; kapatmak sonuçları tamamen kaybettirirdi. */
    const { execFileSync } = require("child_process");
    const cikti = execFileSync(process.execPath, [
      "-e",
      `delete process.env.MONGODB_URI;
       delete process.env.SKORLIG_MATCHRESULTS_FILE_MIRROR;
       process.env.SKORLIG_DATA_DIR = ${JSON.stringify(TMP)};
       const m = require(${JSON.stringify(nodePath.join(__dirname, "..", "lib", "match-results.cjs"))});
       console.log(String(m._FILE_MIRROR));`,
    ], { encoding: "utf8" }).trim();

    assert.equal(
      cikti, "true",
      `Mongo yokken ayna KAPALI (${cikti}) — dosya tek kaynak, sonuclar kaybolur`
    );
  });

  test("env AÇIKÇA ayarlanmışsa ona uyuluyor", () => {
    const { execFileSync } = require("child_process");
    const cikti = execFileSync(process.execPath, [
      "-e",
      `process.env.MONGODB_URI = "mongodb://ornek";
       process.env.SKORLIG_MATCHRESULTS_FILE_MIRROR = "1";
       process.env.SKORLIG_DATA_DIR = ${JSON.stringify(TMP)};
       const m = require(${JSON.stringify(nodePath.join(__dirname, "..", "lib", "match-results.cjs"))});
       console.log(String(m._FILE_MIRROR));`,
    ], { encoding: "utf8" }).trim();

    assert.equal(
      cikti, "true",
      "acikca 1 yazilmasina ragmen ayna kapali — yedek isteyen kullanici " +
      "tercihini uygulayamaz"
    );
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: Mongo varken okuma yolu dosyaya düşmüyor", () => {
  /**
   * Aynayı kapatmak ancak okuma tarafı Mongo'ya gidiyorsa güvenli. Biri
   * `getSnapshot`i "önce dosya" yapacak olursa ayna kapalıyken veri
   * bulunamaz — bu nöbetçi o değişikliği yakalar.
   */
  const src = fs.readFileSync(
    nodePath.join(__dirname, "..", "lib", "match-results.cjs"), "utf8"
  );
  const kod = src.split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");

  const bas = kod.indexOf("async function getSnapshot");
  assert.ok(bas >= 0, "getSnapshot bulunamadi — tarama bozuk");
  const kalan = kod.slice(bas + 10);
  const bit = kalan.search(/\n(async )?function /);
  const govde = bit >= 0 ? kalan.slice(0, bit) : kalan;

  /* `if (db) { ... collection ... }` dosya okumasından ÖNCE gelmeli. */
  const dbIdx = govde.indexOf("if (db)");
  const dosyaIdx = govde.indexOf("readBook");
  assert.ok(dbIdx >= 0, "getSnapshot Mongo kolunu kaybetmis");
  assert.ok(
    dosyaIdx < 0 || dbIdx < dosyaIdx,
    "getSnapshot dosyayi Mongo'dan ONCE okuyor — ayna kapaliyken veri bulunamaz"
  );
});

test("NÖBETÇİ: tohumlama eklenmemiş (ayna kapatılabilir kalsın)", () => {
  /**
   * ⚠️ `lib/social-store.cjs` koleksiyon boşsa dosyadan tohumluyor. Buraya
   * öyle bir yol eklenirse, kapalı ayna yüzünden bayatlamış bir dosya
   * Mongo'ya geri yazılabilir — bu oturumda aynı sınıf bir kez silinen
   * arkadaşlığı diriltmişti.
   */
  const src = fs.readFileSync(
    nodePath.join(__dirname, "..", "lib", "match-results.cjs"), "utf8"
  );
  const kod = src.split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");

  assert.ok(
    !/estimatedDocumentCount|countDocuments/.test(kod),
    "koleksiyon bosluk kontrolu eklenmis — tohumlama yolu aciliyorsa ayna " +
    "varsayilani gozden gecirilmeli (bayat dosya Mongo'ya geri yazilabilir)"
  );
});
