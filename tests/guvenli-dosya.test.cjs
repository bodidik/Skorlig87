"use strict";

/**
 * GÜVENLİ DOSYA ADI TESTLERİ.
 *
 * İki iş yapar:
 *   1) Temizleyicinin davranışını kilitler (traversal kapalı, meşru adlar sağlam).
 *   2) NÖBETÇİ: kaynak ağacında temizlenmemiş `path.join(DIR, `${x}.json`)`
 *      kalmadığını doğrular.
 *
 * ⚠️ (2) OLMADAN (1) YETMEZ. Bu açık zaten bir kez fark edilip düzeltilmişti —
 * ama 18 çağrı yerinden yalnızca 4'ünde. Yani asıl risk "temizleyici yanlış"
 * değil, "temizleyici bir yerde UNUTULDU". Nöbetçi tam olarak onu yakalar.
 */

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");

const { guvenliAd, guvenliYol } = require("../lib/guvenli-dosya.cjs");

const KOK = path.resolve("/tmp/skorlig-test-live");

/* ── 1) Davranış ─────────────────────────────────────────────────────────── */

test("meşru fikstür kimlikleri bozulmadan geçer", () => {
  for (const ad of ["12345", "fx-2026-07-31", "mk-99", "af_881", "TR1.2026"]) {
    assert.strictEqual(guvenliAd(ad), ad, `${ad} bozuldu`);
  }
});

test("tire ve nokta korunur — tarih adları buna bağlı", () => {
  // Bu testin varlık sebebi: temizleyiciyi yazarken tireyi yanlışlıkla
  // karakter sınıfına koymak "fx-2026-07-31" gibi ÇALIŞAN adları bozardı ve
  // önbellek sessizce ıskalardı.
  assert.strictEqual(guvenliAd("fx-2026-07-31"), "fx-2026-07-31");
});

test("yol ayırıcıları dizin dışına çıkamaz", () => {
  for (const kotu of [
    "../../data/lc-wallet",
    "..\\..\\data\\lc-wallet",
    "/etc/passwd",
    "a/b/c",
  ]) {
    const p = guvenliYol(KOK, kotu, ".json");
    assert.ok(
      p.startsWith(KOK + path.sep),
      `${kotu} kökün dışına çıktı: ${p}`
    );
  }
});

test("salt nokta ve boş adlar gizli dosyaya dönüşmez", () => {
  for (const ad of ["", "   ", ".", "..", "..."]) {
    assert.strictEqual(guvenliAd(ad), "_", `${JSON.stringify(ad)} yanlış`);
  }
});

test("denetim karakterleri temizlenir", () => {
  assert.strictEqual(guvenliAd("x\u0000y"), "x_y");
  assert.strictEqual(guvenliAd("a\u001Fb"), "a_b");
});

test("çok uzun ad kırpılır", () => {
  assert.ok(guvenliAd("a".repeat(500)).length <= 180);
});

test("komşu dizin kökün içi sayılmaz", () => {
  // "/tmp/skorlig-test-live-gizli" yolu "/tmp/skorlig-test-live" ile BAŞLAR
  // ama onun altında değildir; sınır kontrolü path.sep eki olmadan kanardı.
  const komsu = KOK + "-gizli";
  assert.ok(!path.resolve(komsu).startsWith(KOK + path.sep));
});

/* ── 2) Nöbetçi ──────────────────────────────────────────────────────────── */

test("NÖBETÇİ: temizlenmemiş path.join(DIR, `${x}.json`) kalmamalı", () => {
  const kokDizin = path.join(__dirname, "..");
  const taranan = ["routes", "lib", "services", "models"];
  // ⚠️ KALIP ÖNCE `*DIR` İLE BİTEN DEĞİŞKENLERİ ARIYORDU ve `LIVE` gibi
  // adlandırılmış dört çağrı yerini KAÇIRDI. Nöbetçinin kendi kör noktası,
  // koruduğu açık kadar tehlikeli — artık HERHANGİ bir tanımlayıcı eşleşir.
  const kalip = /path\.join\(\s*[A-Za-z_][A-Za-z0-9_]*\s*,\s*`[^`]*\$\{/;

  const bulunanlar = [];
  for (const alt of taranan) {
    const d = path.join(kokDizin, alt);
    if (!fs.existsSync(d)) continue;
    for (const dosya of fs.readdirSync(d)) {
      if (!dosya.endsWith(".cjs") && !dosya.endsWith(".js")) continue;
      // Temizleyicinin kendi açıklama metni örnek olarak bu kalıbı içeriyor.
      if (dosya === "guvenli-dosya.cjs") continue;
      const tam = path.join(d, dosya);
      const satirlar = fs.readFileSync(tam, "utf8").split("\n");
      satirlar.forEach((s, i) => {
        if (kalip.test(s)) bulunanlar.push(`${alt}/${dosya}:${i + 1}`);
      });
    }
  }

  assert.deepStrictEqual(
    bulunanlar,
    [],
    "Şu satırlar dosya adını temizlemeden birleştiriyor — guvenliYol() kullan:\n" +
      bulunanlar.join("\n")
  );
});
