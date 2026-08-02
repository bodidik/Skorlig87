"use strict";

/**
 * HAFTALIK SEÇİMLER UCU HİÇ YANIT VERMİYORDU — indeks çakışması + N+1.
 *
 * ⚠️ BULGU (yetki denetimi turunda tesadüfen): `GET /api/weekly-picks`
 * 60 saniyede bile yanıt vermiyordu (ölçüldü: HTTP 000). İki kusur
 * zincirlenmişti.
 *
 * 1) İNDEKS ÇAKIŞMASI ÖNBELLEĞİ BOZUYORDU.
 *    `lib/preds-index.cjs` üç indeks kuruyor ve sözü önbelleğe alıyor; ama
 *    HATA olunca `_soz = null` yapıp yeniden denenmesini sağlıyor. Üretimdeki
 *    `fixtureId_1_userIdLower_1` indeksi `unique: true` kurulmuş, modül ise
 *    aynı adı `unique` OLMADAN istiyordu → Mongo her çağrıda
 *    "An existing index has the same name as the requested index" hatası
 *    veriyordu → önbellek HİÇ tutmuyordu.
 *    Ölçüldü: çağrı başına **263 ms**. Sunucu günlüğü de bu hatayla doluydu.
 *
 * 2) N+1 SORGU. `routes/weekly-picks.cjs` fikstür DÖNGÜSÜ içinde
 *    `getUserPred` çağırıyordu; her çağrı `ensurePredIndexes` + ayrı bir
 *    `findOne`. Ölçüldü: pencerede 240 maç → yalnız indeks denemesi ~63 sn,
 *    sorgular ~20 sn.
 *
 * SONUÇ (izole sunucu, gerçek veri): 60+ sn (yanıt yok) → **2.26 sn** ilk
 * istek, **0.12 sn** sonraki. 354 seçim dönüyor.
 *
 * ⚠️ İKİ DÜZELTME DE GEREKLİ: indeksi düzeltmek tek başına yetmez (240 ayrı
 * sorgu kalırdı), toplu sorgu tek başına yetmez (indeks hatası her istekte
 * 263 ms + günlük kirliliği demekti).
 */

const test = require("node:test");
const describe = require("node:test").describe;
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
process.env.SKORLIG_BG = "0";

const yalin = (p) => fs.readFileSync(path.join(KOK, p), "utf8")
  .split("\n")
  .map((l) => {
    const t = l.trim();
    return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
  })
  .join("\n");

/* ── 1) İndeks spec'i üretimdekiyle uyumlu ───────────────────────────────── */

describe("indeks çakışması", () => {
  const src = yalin("lib/preds-index.cjs");

  test("VAR OLAN indeks yeniden kurulmaya çalışılmıyor", () => {
    /**
     * ⚠️ İLK DÜZELTMEM YANLIŞTI, ONU DA YAZIYORUM. Önce `unique: true`
     * ekledim (üretimdeki indeks öyle kurulmuş diye). Bu, dört testi kırdı
     * ve `tests/indeks-kapsam.test.cjs` gerekçesini zaten yazmıştı:
     *     "İndeks kurulumu bir ONARIM yolu, veri doğrulama aracı değil;
     *      benzersizlik kararı geçiş betiğinde kalıyor."
     * Çalışma zamanında unique kurmak, veride kopya varsa HER AÇILIŞTA
     * patlardı — kod tabanının kendi belgesi beni yanlış düzeltmeden kurtardı.
     *
     * Doğru çözüm: anahtarı zaten karşılayan indeks VARSA dokunma. Böylece
     * hem çakışma hatası biter hem "benzersizliği runtime iddia etme" kuralı
     * korunur.
     */
    assert.ok(/await col\.indexes\(\)/.test(src),
      "mevcut indeksler okunmuyor — ayni ada farkli secenekle cakisir " +
      "ve onbellek her cagrida sifirlanir (263ms/cagri)");
    assert.ok(/if \(anahtarVar\(key\)\) continue;/.test(src),
      "var olan anahtar atlanmiyor");
    assert.ok(!/unique: true/.test(src),
      "runtime benzersizlik iddia ediyor — gecis betiginin isi (bkz. indeks-kapsam)");
  });

  test("hata durumunda önbellek sıfırlanıyor (yeniden deneme korunuyor)", () => {
    /* Bu davranış DOĞRU; kusur onun sürekli tetiklenmesiydi. Kaldırmak
     * geçici bir Mongo hatasında indeksleri kalıcı olarak kurmazdı. */
    assert.ok(/_soz = null;/.test(src), "hata sonrasi yeniden deneme kalkmis");
  });
});

/* ── 2) N+1 kaldırıldı ───────────────────────────────────────────────────── */

describe("weekly-picks toplu okuma", () => {
  const src = yalin("routes/weekly-picks.cjs");

  test("döngü İÇİNDE getUserPred çağrılmıyor", () => {
    const i = src.indexOf("const picks = [];");
    const j = src.indexOf("res.json", i);
    assert.ok(i > 0 && j > i, "cikti dongusu bulunamadi");
    const dongu = src.slice(i, j);
    assert.ok(!/await getUserPred\(/.test(dongu),
      "dongu icinde tekil pred sorgusu — 240 mac icin ~80 sn");
    assert.ok(!/await ensurePredIndexes\(/.test(dongu),
      "dongu icinde indeks kontrolu — cagri basina 263 ms");
  });

  test("tahminler TEK sorguda alınıyor", () => {
    assert.ok(/getUserPredsBatch\(/.test(src), "toplu okuma yok");
    const i = src.indexOf("async function getUserPredsBatch");
    const govde = src.slice(i, src.indexOf("\n}\n", i));
    assert.ok(/\$in: fixtureIds\.map\(String\)/.test(govde),
      "toplu sorgu $in kullanmiyor");
    assert.ok(/await ensurePredIndexes\(db\)/.test(govde),
      "indeks kontrolu toplu fonksiyonda tek kez yapilmiyor");
  });

  test("durum dosyaları PARALEL okunuyor", () => {
    assert.ok(/await Promise\.all\(pencere\.map\(/.test(src),
      "durum dosyalari sirayla okunuyor — 240 ardisik dosya erisimi");
  });

  test("dosya yedeği de TEK okuma", () => {
    /**
     * ⚠️ Eski `getUserPred` dosya yolunda her çağrıda 13 MB'lık `preds.json`
     * yeniden okunup taranıyordu. Mongo düşerse yavaşlık geri gelmemeli.
     */
    const i = src.indexOf("async function getUserPredsBatch");
    const govde = src.slice(i, src.indexOf("\n}\n", i));
    const okuma = (govde.match(/readJson\(PREDS_FILE/g) || []).length;
    assert.equal(okuma, 1, `dosya ${okuma} kez okunuyor — tek okuma yeterli`);
  });
});

/* ── 3) Toplu okuyucunun davranışı ───────────────────────────────────────── */

describe("getUserPredsBatch davranışı", () => {
  const WP = require("../routes/weekly-picks.cjs");
  const batch = WP._getUserPredsBatch;

  test("dışa açık", () => {
    assert.equal(typeof batch, "function",
      "toplu okuyucu disa acilmamis — davranisi sinanamaz");
  });

  test("boş girdide boş harita", async () => {
    assert.equal((await batch("", ["A"], null)).size, 0);
    assert.equal((await batch("u1", [], null)).size, 0);
  });

  test("Mongo hatası dosya yedeğine düşürüyor, çökmüyor", async () => {
    const patlak = { collection: () => ({
      find: () => { throw new Error("mongo down"); },
      createIndex: async () => {}, createIndexes: async () => {},
    }) };
    const h = await batch("u1", ["A"], patlak);
    assert.ok(h instanceof Map, "hata durumunda harita donmuyor");
  });
});
