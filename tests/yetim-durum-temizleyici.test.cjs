"use strict";

/**
 * YETİM CANLI DURUM DOSYASI TEMİZLİĞİ — ve onu güvenli kılan korumalar.
 *
 * ⚠️ NEDEN VAR: `data/live/<fixtureId>.json` dosyaları, fikstür deposu kaydı
 * silindikten sonra diskte kalıyordu. Depo TAM DEĞİŞTİRME semantiğinde
 * (`saveAll` listede olmayanı siler), yani eski maçlar düştükçe artık
 * birikiyor. Silen hiçbir şey yoktu; `bayat-temizleyici` yalnızca PARA
 * iadesiyle ilgileniyor.
 *
 * ÖLÇÜLDÜ (üretim, 2026-08-02): 1403 durum dosyasının **305'i yetim** (%22).
 * Doğrulandı: 305'inin HİÇBİRİNDE Mongo `fixtures` kaydı yok — okuma hatası
 * değil, gerçekten sahipsiz. 73'ü uzlaşmış (match_results kaydı var).
 * Yaş: <1gün 43 · 1-7gün 193 · 7-30gün 60 · 30gün+ 9.
 *
 * ⚠️ ASIL TEHLİKE SİLMEK DEĞİL, YANLIŞ ŞEYİ SİLMEK. "Fikstür listesinde
 * yoksa sil" kuralı, listeyi BİR AN boş okursak 1403 dosyanın TAMAMINI
 * siler — ve `loadAll` Mongo düşünce dosyaya, dosya da yoksa boş listeye
 * düşüyor, yani boş liste GERÇEKTEN olabilir bir sonuç. Aşağıdaki testlerin
 * çoğu tam olarak bunu kilitliyor. Üç koruma var ve üçü de ayrı ayrı
 * sınanıyor; biri yetmez.
 */

const test = require("node:test");
const describe = require("node:test").describe;
const assert = require("node:assert/strict");
const os = require("os");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");

/* ⚠️ DATA_DIR modül yüklenirken okunuyor — require'dan ÖNCE kurulmalı,
 * yoksa test GERÇEK data/live dizinini siler. */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "skorlig-yetim-"));
process.env.SKORLIG_DATA_DIR = TMP;
process.env.SKORLIG_BG = "0";
fs.mkdirSync(path.join(TMP, "live"), { recursive: true });

/* Fikstür deposunu denetim altına al. */
const storeYol = require.resolve(path.join(KOK, "lib", "fixtures-store.cjs"));
let _fixtures = [];
require.cache[storeYol] = { id: storeYol, filename: storeYol, loaded: true, exports: {
  loadAll: async () => _fixtures.slice(),
  saveAll: async () => ({}), getOne: async () => null, invalidateCache: () => {},
  COLL: "fixtures", FIXTURES_FILE: "",
}};

const Temizleyici = require("../services/yetim-durum-temizleyici.cjs");
const { tur, YETIM_GUN, TABAN_FIKSTUR, TUR_TAVANI } = Temizleyici;

const GUN = 86400000;
const yol = (fid) => path.join(TMP, "live", `${fid}.json`);
const yaz = (fid, gunOnce) =>
  fs.writeFileSync(yol(fid), JSON.stringify({
    fixtureId: fid, status: "FT", isLive: false, score: { home: 1, away: 0 },
    updatedAt: new Date(Date.now() - gunOnce * GUN).toISOString(),
  }));
const sifirla = () => {
  for (const d of fs.readdirSync(path.join(TMP, "live"))) fs.unlinkSync(path.join(TMP, "live", d));
};
/** Tabanı geçecek kadar sahte fikstür (koruma 1 devreye girmesin). */
const dolgu = (n = TABAN_FIKSTUR + 10) =>
  Array.from({ length: n }, (_, i) => ({ fixtureId: `DOLGU-${i}` }));

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("test GERÇEK data/ dizinine dokunmuyor", () => {
    assert.ok(TMP.includes("skorlig-yetim"));
    assert.notEqual(path.resolve(TMP), path.resolve(KOK, "data"));
  });

  test("ayarlar makul", () => {
    assert.ok(YETIM_GUN >= 1, `yas korumasi ${YETIM_GUN} gun — cok kisa`);
    assert.ok(TABAN_FIKSTUR > 0, "taban korumasi kapali");
    assert.ok(TUR_TAVANI > 0, "tur tavani kapali");
  });
});

/* ── Asıl iş ─────────────────────────────────────────────────────────────── */

describe("yetim dosya siliniyor", () => {
  test("sahipsiz ve YETERİNCE ESKİ dosya siliniyor", async () => {
    sifirla();
    _fixtures = dolgu();
    yaz("YETIM-1", YETIM_GUN + 3);
    const r = await tur();
    assert.equal(r.silinen, 1, `silinmedi: ${JSON.stringify(r)}`);
    assert.equal(fs.existsSync(yol("YETIM-1")), false);
  });

  test("SAHİPLİ dosyaya dokunulmuyor", async () => {
    sifirla();
    _fixtures = dolgu().concat([{ fixtureId: "SAHIPLI-1" }]);
    yaz("SAHIPLI-1", YETIM_GUN + 30);
    const r = await tur();
    assert.equal(r.silinen, 0, "fikstur kaydi OLAN dosya silindi");
    assert.equal(fs.existsSync(yol("SAHIPLI-1")), true);
  });

  test("kuru çalışma HİÇBİR ŞEY silmiyor", async () => {
    sifirla();
    _fixtures = dolgu();
    yaz("KURU-1", YETIM_GUN + 5);
    const r = await tur({ kuru: true });
    assert.equal(r.silinen, 1, "kuru sayim yapmiyor");
    assert.equal(fs.existsSync(yol("KURU-1")), true, "KURU calismada dosya SILINDI");
  });
});

/* ── Korumalar — bu bölüm testin asıl sebebi ─────────────────────────────── */

describe("KORUMA 1: taban altı fikstür listesi", () => {
  test("liste BOŞ ise hiçbir şey silinmiyor", async () => {
    /**
     * ⚠️ EN ÖNEMLİ TEST. `loadAll` Mongo düşünce dosyaya, dosya da yoksa boş
     * listeye düşüyor — yani boş liste gerçekten olabilir. Koruma olmasaydı
     * TÜM durum dosyaları yetim sayılıp silinirdi (üretimde 1403 dosya).
     */
    sifirla();
    _fixtures = [];
    yaz("KORUMA-1", YETIM_GUN + 50);
    const r = await tur();
    assert.equal(r.atlandi, "TABAN_ALTI", `temizlik calisti: ${JSON.stringify(r)}`);
    assert.equal(fs.existsSync(yol("KORUMA-1")), true, "bos liste ile dosya SILINDI");
  });

  test("liste taban ALTINDA ise hiçbir şey silinmiyor", async () => {
    sifirla();
    _fixtures = dolgu(TABAN_FIKSTUR - 1);   // kıl payı altında
    yaz("KORUMA-2", YETIM_GUN + 50);
    const r = await tur();
    assert.equal(r.atlandi, "TABAN_ALTI");
    assert.equal(fs.existsSync(yol("KORUMA-2")), true);
  });

  test("liste taban ÜSTÜNDE ise temizlik çalışıyor", async () => {
    /* Korumanın kendisi de yanlış tarafa kilitlenmemeli: taban geçilince
     * temizlik GERÇEKTEN çalışmalı, yoksa servis sessizce hiç iş yapmaz. */
    sifirla();
    _fixtures = dolgu(TABAN_FIKSTUR);
    yaz("KORUMA-3", YETIM_GUN + 50);
    const r = await tur();
    assert.notEqual(r.atlandi, "TABAN_ALTI", "taban gecildigi halde atlandi");
    assert.equal(r.silinen, 1);
  });
});

describe("KORUMA 2: yaş", () => {
  test("YENİ yetimleşen dosyaya dokunulmuyor", async () => {
    /* Geçici bir depo tutarsızlığı (kısmi senkron) fikstürü bir tur silip
     * sonra geri koyabilir; o pencerede dosyayı silmek CANLI maçın skorunu
     * kaybetmek olurdu. */
    sifirla();
    _fixtures = dolgu();
    yaz("GENC-1", 0);
    const r = await tur();
    assert.equal(r.silinen, 0, "yeni yetimlesen dosya silindi");
    assert.equal(r.genc, 1);
    assert.equal(fs.existsSync(yol("GENC-1")), true);
  });

  test("DAMGASIZ dosya genç sayılıyor (fail-closed)", async () => {
    /* Yaşını doğrulayamadığımız dosyayı silmek, yanlış yönde yanılmaktır. */
    sifirla();
    _fixtures = dolgu();
    fs.writeFileSync(yol("DAMGASIZ-1"), JSON.stringify({ fixtureId: "DAMGASIZ-1", status: "FT" }));
    const r = await tur();
    assert.equal(r.silinen, 0, "damgasiz dosya silindi — yasi bilinmiyordu");
    assert.equal(fs.existsSync(yol("DAMGASIZ-1")), true);
  });

  test("BOZUK JSON dosya da genç sayılıyor", async () => {
    sifirla();
    _fixtures = dolgu();
    fs.writeFileSync(yol("BOZUK-1"), "{bozuk");
    const r = await tur();
    assert.equal(r.silinen, 0, "okunamayan dosya silindi");
    assert.equal(fs.existsSync(yol("BOZUK-1")), true);
  });
});

describe("KORUMA 3: tur tavanı", () => {
  test("tek turda TAVAN'dan fazla silinmiyor", async () => {
    /* Beklenmedik bir kusurun yarıçapını sınırlar: bir turda her şey
     * silinmez, sonraki turlarda devam eder. */
    sifirla();
    _fixtures = dolgu();
    for (let i = 0; i < TUR_TAVANI + 5; i++) yaz(`TAVAN-${i}`, YETIM_GUN + 2);
    const r = await tur();
    assert.equal(r.silinen, TUR_TAVANI, `tur tavani asildi: ${r.silinen}`);
    const kalan = fs.readdirSync(path.join(TMP, "live")).length;
    assert.equal(kalan, 5, "tavan sonrasi kalanlar silinmis");
  });
});

/* ── Nöbetçi ─────────────────────────────────────────────────────────────── */

const yalin = (p) => fs.readFileSync(path.join(KOK, p), "utf8")
  .split("\n")
  .map((l) => {
    const t = l.trim();
    return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
  })
  .join("\n");

test("NÖBETÇİ: fikstürler TAZE okunuyor", () => {
  /**
   * ⚠️ `loadAll` önbellekli. Bayat bir liste, o sırada eklenen fikstürlerin
   * durum dosyalarını yetim gösterip SİLDİRİRDİ — üstelik geri dönüşü yok.
   * (Aynı sınıf hata bu oturumda oku-değiştir-yaz yolunda da yaşandı.)
   */
  const src = yalin("services/yetim-durum-temizleyici.cjs");
  assert.ok(/loadAll\(undefined, \{ taze: true \}\)/.test(src),
    "onbellekli okuma — bayat liste dosya SILDIREBILIR");
});

test("NÖBETÇİ: servis sunucuya bağlı ve kapatılabilir", () => {
  const srv = yalin("server.cjs");
  assert.ok(/yetim-durum-temizleyici\.cjs"\)\.start\(/.test(srv), "servis mount edilmemis");
  assert.ok(/SKORLIG_YETIM_TEMIZLE !== "0"/.test(srv), "kapatma anahtari yok");
});

test("NÖBETÇİ: üç korumanın üçü de kodda", () => {
  const src = yalin("services/yetim-durum-temizleyici.cjs");
  assert.ok(/TABAN_ALTI/.test(src), "taban korumasi yok");
  assert.ok(/yasSiniri/.test(src), "yas korumasi yok");
  assert.ok(/silinen >= TUR_TAVANI/.test(src), "tur tavani yok");
});
