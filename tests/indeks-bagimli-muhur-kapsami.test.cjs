"use strict";

/**
 * BENZERSİZ İNDEKSE DAYANAN HER MÜHÜR, İNDEKS SONUCUNU KONTROL ETMELİ.
 *
 * ⚠️ BU TURDA YENİ KUSUR BULUNMADI — ve bunu ölçerek söylüyorum. Önceki iki
 * turda "koruma kurulamazsa sessizce fail-OPEN" kalıbı ÜÇ depoda bulunmuştu
 * (`push-sent-store`, `davet-odul-store`, `kupon-store`). Kalan
 * `ensureIndexes` kullanan depoları taradım:
 *
 *     lib/streak-store.cjs     benzersiz 1 · 11000 kontrolü YOK  → `bulkWrite`
 *                              upsert kullanıyor, mühür değil
 *     lib/moderation-store.cjs benzersiz 2 · 11000 kontrolü YOK  → upsert
 *     lib/invite-store.cjs     benzersiz 1 · 11000 kontrolü YOK
 *     lib/match-results.cjs    benzersiz 1 · 11000 kontrolü YOK  → mühür
 *                              `claimAward` KOŞULLU updateOne ile alınıyor
 *     lib/pool-store.cjs       benzersiz 2 · 11000 kontrolü YOK  → koruma
 *                              `withFileLock` + tavan kontrolü
 *     lib/social-store.cjs     benzersiz 7 · 11000 kontrolü VAR (tek yer):
 *                              `createGroup` kod çakışmasında yeni kod
 *                              deniyor — PARA değil, ad çakışması
 *
 * Yani hiçbirinin PARA güvenliği `insertOne` + 11000 desenine dayanmıyor.
 * Değişiklik yapmadım.
 *
 * ⚠️ BU TEST KURALI KODDAN TÜRETİYOR, elle liste tutmuyor: bir depo 11000
 * yakalıyorsa, o deponun `ensureIndexes` sonucunu da kontrol etmesi gerekir —
 * çünkü indeks yoksa 11000 hiç gelmez ve `catch` bloğu ölü koda döner.
 * Yeni bir depo bu deseni kullanmaya başladığında test onu yakalar.
 */

const test = require("node:test");
const describe = require("node:test").describe;
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");

/** Yorumları boşaltır — bu oturumda yorum/kod karışması altı kez tuzak oldu. */
const kaynak = (tam) =>
  fs.readFileSync(tam, "utf8")
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");

function depolar() {
  const dizin = path.join(KOK, "lib");
  return fs.readdirSync(dizin)
    .filter((a) => a.endsWith(".cjs"))
    .map((a) => ({ ad: `lib/${a}`, src: kaynak(path.join(dizin, a)) }));
}

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("tarama gerçekten dosya buluyor", () => {
    const d = depolar();
    assert.ok(d.length > 20, `yalnizca ${d.length} lib dosyasi tarandi — tarama bozuk`);
    assert.ok(
      d.some((x) => x.ad === "lib/kupon-store.cjs"),
      "bilinen depo taramada yok"
    );
  });

  test("bilinen üç mühür 11000 desenini kullanıyor", () => {
    // Kural boşlukta çalışmasın: desenin gerçekten var olduğunu doğrula.
    for (const ad of ["lib/push-sent-store.cjs", "lib/davet-odul-store.cjs", "lib/kupon-store.cjs"]) {
      const src = kaynak(path.join(KOK, ad));
      assert.ok(/11000/.test(src), `${ad}: 11000 deseni yok — kural bir sey olcmuyor`);
    }
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("11000'e dayanan her depo indeks sonucunu okuyor", () => {
  /**
   * ⚠️ GEREKÇELİ MUAFİYETLER — elle "listeye eklendi" değil, her biri için
   * NEDEN yazılı. Bu ikisi 11000'i mühür olarak DEĞİL, "çakışma oldu, başka
   * yolu dene / zaten kaydedilmiş" olarak kullanıyor; fail-closed yapmak
   * karşılığında hizmeti durdururdu.
   *
   *   lib/social-store.cjs   → `createGroup` grup KODU çakışınca yeni kod
   *                            deniyor. İndeks yoksa en kötü hâl iki grubun
   *                            aynı kodu alması; para değil, ad çakışması.
   *                            Fail-closed olsaydı grup kurulamazdı.
   *   lib/skor-uyusmazlik.cjs → `kaydet` maç başına TEK uyuşmazlık kaydı
   *                            tutuyor. İndeks yoksa en kötü hâl aynı maç
   *                            için mükerrer UYARI kaydı; para etkisi yok.
   *                            Fail-closed olsaydı denetim izi kaybolurdu —
   *                            o kaydın var olma sebebinin tam tersi.
   */
  const MUAF = new Set(["lib/social-store.cjs", "lib/skor-uyusmazlik.cjs"]);

  test("kural koddan türetiliyor, elle liste yok", () => {
    const suclu = [];
    for (const { ad, src } of depolar()) {
      if (MUAF.has(ad)) continue;
      if (!/11000/.test(src)) continue;              // mühür deseni yok
      if (!/ensureIndexes/.test(src)) continue;       // indeks kurulumu yok
      /* İndeks sonucu okunuyor mu? İki kabul edilebilir biçim:
       *   if (!(await ensureIndexes(x))) ...
       *   const hazir = await ensureIndexes(x); if (!hazir) ... */
      const okuyor =
        /!\(await ensureIndexes\(/.test(src) ||
        /=\s*await ensureIndexes\([^)]*\);[\s\S]{0,200}if \(!/.test(src);
      if (!okuyor) suclu.push(ad);
    }
    assert.deepEqual(
      suclu, [],
      `11000'e dayaniyor ama indeks sonucunu kontrol etmiyor: ${suclu.join(", ")} — ` +
        "indeks yoksa 11000 hic gelmez ve muhur sessizce acilir"
    );
  });

  test("ensureIndexes başarı/başarısızlık bildiriyor", () => {
    for (const ad of ["lib/push-sent-store.cjs", "lib/davet-odul-store.cjs", "lib/kupon-store.cjs"]) {
      const src = kaynak(path.join(KOK, ad));
      assert.ok(/return true;/.test(src), `${ad}: basari bildirilmiyor`);
      assert.ok(/return false;/.test(src), `${ad}: hata bildirilmiyor`);
    }
  });
});

/* ── Kapsam notu: hangi depolar 11000'e dayanmıyor ───────────────────────── */

describe("11000'e dayanmayan depolar", () => {
  test("mühürleri koşullu updateOne ya da kilit ile alıyorlar", () => {
    /**
     * ⚠️ Bu test bir kusuru kapatmıyor, YAPTIĞIM TARAMAYI kilitliyor.
     * Bu depolar bugün 11000'e dayanmıyor; biri yarın `insertOne`+11000
     * desenine geçerse yukarıdaki kural onu zaten yakalar. Buradaki iddia
     * daha dar: bugünkü korumaları yerinde duruyor mu?
     */
    const mr = kaynak(path.join(KOK, "lib", "match-results.cjs"));
    assert.ok(/updateOne\(/.test(mr), "match-results kosullu yazma kullanmiyor");

    const ps = kaynak(path.join(KOK, "lib", "pool-store.cjs"));
    assert.ok(/withFileLock\(`pool-bet:/.test(ps), "havuz bahsi kilidi kalkmis");

    const ss = kaynak(path.join(KOK, "lib", "streak-store.cjs"));
    assert.ok(/bulkWrite\(/.test(ss), "streak upsert yerine insert kullanmaya baslamis");
  });
});
