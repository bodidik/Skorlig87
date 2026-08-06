"use strict";

/**
 * API KOTA SAYACI EŞZAMANLI KULLANIMDA KAYBOLMAZ.
 *
 * ⚠️ BULUNAN: `data/providers.json` sağlayıcı KOTA SAYAÇLARINI tutuyor ve ALTI
 * modül tarafından yazılıyor — lib/providers, services/af-sync, routes/live2,
 * routes/fixtures, routes/live1987, routes/provider. Hepsi "oku → değiştir →
 * TÜMÜNÜ yaz" yapıyordu; ne kilit vardı ne atomik yazma. Oysa `withFileLock`
 * ve `writeJsonAtomic` bu depoda ZATEN vardı ve sekiz başka depo kullanıyordu
 * — bu oturumun tekrar eden kalıbı: aynı savunma tek yerde eksik.
 *
 * ÖLÇÜLDÜ (üç ayrı yarış):
 *   A) 40 eşzamanlı markUsage → dosyada  used: 1   →  39 artış KAYIP
 *      düzeltmeden sonra                 used: 40  →   0 kayıp
 *   B) yazma sürerken okuma: 662 okumanın 81'i (%12) YARIM JSON
 *      düzeltmeden sonra: 14900 okumanın 10'u (%0.07)
 *   C) 30 eşzamanlı writeJsonAtomic → 21'i HATA (geçici ad çarpışması)
 *      düzeltmeden sonra                  0 hata
 *
 * ⚠️ (B) NEDEN KRİTİK: her okuyucu `JSON.parse` hatasını yutup varsayılana
 * düşüyor, yani `used` SIFIR görünüyor. Sayaç, tam korumasız kaldığı anda
 * "kota bitmedi" diyor — ücretsiz AF planı (100 istek/gün) aşıldıktan sonra da
 * istek atılır.
 *
 * ⚠️ (C) paylaşılan yardımcının KENDİSİNDEYDİ: `${file}.tmp-${pid}-${now}`
 * aynı milisaniyede iki kez üretilebiliyordu. Sekiz depo bu yüzden zaten
 * sayaç ekliyordu; fileLock.cjs eklememişti.
 *
 * ⚠️ (B)'deki kalan 10 okuma Windows'a özgü: açık tanıtıcı varken rename
 * EPERM veriyor, ısrarlı durumda ESKİ davranışa (doğrudan yazma) düşülüyor.
 * Üretim Linux, orada düşüş hiç olmuyor. Abartmıyorum: en kötü hâl eski
 * davranış, daha kötüsü değil.
 *
 * ⚠️ KİLİT SÜREÇ İÇİ. Render tek süreç çalıştırıyor; çok süreçli bir
 * dağıtımda kota Mongo'ya taşınmalı.
 */

const os = require("os");
const path = require("path");
const fs = require("fs");

/**
 * ⚠️ DİZİN SÜREÇ BAŞINA AYRI + SİLME YENİDEN DENEMELİ.
 *
 * Eskiden sabit bir `%TEMP%` adı kullanılıyor ve her testten önce
 * `rmSync` + `mkdirSync` ile siliniyordu. ÖLÇÜLDÜ: süit yükü olmadan bile
 * 6 koşunun 2'si Windows dosya sistemi hatasıyla kırıldı — kota sayımıyla
 * ilgili HİÇBİR iddia patlamadı, hep şunlar:
 *
 *     ENOTEMPTY: directory not empty, rmdir  ...\skorlig-kota-yarisi-test
 *     ENOENT: rename ...providers.json.tmp-15120-...-155 -> providers.json
 *
 * Windows'ta özyinelemeli silme HEMEN bitmeyebilir: açık bir tanıtıcı varsa
 * dizin "silinmeyi bekliyor" durumunda kalır. O aralıkta `rmdir` dizini boş
 * görmez, hemen ardından oluşturulan geçici dosya da `rename`e yetişmeden
 * kaybolabilir. Node'un kendi belgeleri Windows'ta `fs.rm` için `maxRetries`
 * öneriyor; sebep tam olarak bu.
 *
 * ⚠️ İKİ AYRI ÖNLEM, İKİ AYRI İŞ: `maxRetries` süreç İÇİNDEKİ silme yarışını
 * yumuşatıyor; pid'li ad ise önceki/paralel koşulardan artan dizinin bu koşuya
 * karışmasını engelliyor. Sonda `after` ile temizleniyor ki pid'li dizinler
 * `%TEMP%`te birikmesin.
 */
const TMP = path.join(os.tmpdir(), `skorlig-kota-yarisi-test-${process.pid}`);
process.env.SKORLIG_DATA_DIR = TMP;

const { test, describe, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");

const KOK = path.join(__dirname, "..");
const P = require("../lib/providers.cjs");
const { writeJsonAtomic } = require("../lib/fileLock.cjs");

const FILE = path.join(TMP, "providers.json");
const oku = () => JSON.parse(fs.readFileSync(FILE, "utf8"));

const dizniSil = () =>
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });

beforeEach(() => {
  dizniSil();
  fs.mkdirSync(TMP, { recursive: true });
});

after(dizniSil);

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("tek kullanım sayaca işleniyor", async () => {
    await P.ensureModel();
    await P.markUsage("AF", true, 5);
    assert.equal(oku().quotas.AF.used, 1, "tek artis bile yazilmiyor — test bir sey olcmuyor");
  });

  test("test GERÇEK data/ dizinine yazmıyor", () => {
    assert.ok(
      !P.STORE_PATH.startsWith(path.join(KOK, "data")),
      `test gercek veriye yaziyor: ${P.STORE_PATH}`
    );
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("eşzamanlı kota sayımı", () => {
  test("40 eşzamanlı kullanım → 40 artış (hiçbiri kaybolmuyor)", async () => {
    await P.ensureModel();
    const N = 40;
    await Promise.all(Array.from({ length: N }, () => P.markUsage("AF", true, 5)));
    const used = oku().quotas.AF.used;
    assert.equal(
      used, N,
      `${N} istek yapildi ama sayacta ${used} var — ${N - used} artis kayboldu (kilitsiz oku-degistir-yaz)`
    );
  });

  test("farklı sağlayıcılar birbirinin sayacını ezmiyor", async () => {
    await P.ensureModel();
    await Promise.all([
      ...Array.from({ length: 15 }, () => P.markUsage("AF", true)),
      ...Array.from({ length: 25 }, () => P.markUsage("FDO", true)),
      ...Array.from({ length: 10 }, () => P.markUsage("TSDB", false)),
    ]);
    const m = oku();
    assert.equal(m.quotas.AF.used, 15, "AF sayaci");
    assert.equal(m.quotas.FDO.used, 25, "FDO sayaci");
    assert.equal(m.quotas.TSDB.used, 10, "TSDB sayaci");
    assert.equal(m.providers.TSDB.fail, 10, "basarisiz sayaci");
  });

  test("takım tercihi yazımı kullanım sayımıyla yarışmıyor", async () => {
    await P.ensureModel();
    await Promise.all([
      ...Array.from({ length: 20 }, () => P.markUsage("AF", true)),
      ...Array.from({ length: 20 }, (_, i) => P.setPreferred(`takim${i}`, "FDO")),
    ]);
    const m = oku();
    assert.equal(m.quotas.AF.used, 20, "tercih yazimi kota artisini ezdi");
    assert.equal(Object.keys(m.teams).length, 20, "kota artisi tercih yazimini ezdi");
  });
});

describe("atomik yazma", () => {
  test("30 eşzamanlı atomik yazma hata vermiyor", async () => {
    /* Geçici ad `pid-Date.now()` iken aynı milisaniyede çakışıyordu: biri
     * rename ederken diğerinin dosyası kaybolup ENOENT atıyordu. */
    const hedef = path.join(TMP, "carpisma.json");
    const hatalar = [];
    await Promise.all(Array.from({ length: 30 }, (_, i) =>
      writeJsonAtomic(hedef, { i }).catch((e) => hatalar.push(e?.code || String(e)))));
    assert.equal(hatalar.length, 0, `gecici ad carpismasi: ${hatalar.slice(0, 3).join(", ")}`);
    assert.ok(JSON.parse(fs.readFileSync(hedef, "utf8")), "hedef dosya bozuk kaldi");
  });

  test("geçici dosya ortalıkta kalmıyor", async () => {
    const hedef = path.join(TMP, "temiz.json");
    await Promise.all(Array.from({ length: 10 }, (_, i) => writeJsonAtomic(hedef, { i })));
    const artik = fs.readdirSync(TMP).filter((f) => f.includes(".tmp-"));
    assert.equal(artik.length, 0, `geride kalan gecici dosya: ${artik.join(", ")}`);
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

test("NÖBETÇİ: providers deposu kilit ve atomik yazma kullanıyor", () => {
  const src = kaynak("lib/providers.cjs");
  assert.ok(/withFileLock\s*\(\s*STORE_PATH/.test(src), "kota yazimi kilitsiz");
  assert.ok(/writeJsonAtomic/.test(src), "atomik yazma kullanilmiyor");
  assert.ok(
    !/fsp\.writeFile\s*\(\s*STORE_PATH/.test(src),
    "hedef dosyaya dogrudan yaziliyor — yirtik okuma geri gelir"
  );
});

test("NÖBETÇİ: providers.json yazan HİÇBİR modül doğrudan writeFile yapmıyor", () => {
  /**
   * ⚠️ TEK MODÜLÜ DÜZELTMEK YETMİYOR: yırtık okumayı ÜRETEN taraf yazan
   * taraftır, okuyan değil. Altı modülden biri doğrudan yazarsa diğer beşinin
   * atomikliği okuyucuyu korumaz.
   */
  const YAZANLAR = [
    "lib/providers.cjs", "services/af-sync.cjs", "routes/live2.cjs",
    "routes/fixtures.cjs", "routes/live1987.cjs", "routes/provider.cjs",
  ];
  const suclu = [];
  for (const rel of YAZANLAR) {
    const src = kaynak(rel);
    // Yerel `writeJson` yardımcısı artık writeJsonAtomic'e devrediyor olmalı.
    if (/async function writeJson\([^)]*\)\s*\{[^}]*fsp\.writeFile\(/s.test(src)) suclu.push(rel);
  }
  assert.deepEqual(suclu, [], `dogrudan yazan modul(ler): ${suclu.join(", ")}`);
});

test("NÖBETÇİ: af-sync kota artışı kilitli", () => {
  const src = kaynak("services/af-sync.cjs");
  assert.ok(/withFileLock\s*\(\s*PROV_FILE/.test(src), "bumpAf kilitsiz — artislar birbirini ezer");
});

test("NÖBETÇİ: geçici ad benzersiz (sayaç içeriyor)", () => {
  const src = kaynak("lib/fileLock.cjs");
  assert.ok(
    /\.tmp-\$\{process\.pid\}-\$\{Date\.now\(\)\}-\$\{\+\+_tmpSayac\}/.test(src),
    "gecici ad yalnizca pid+zaman — ayni milisaniyede carpisir"
  );
});
