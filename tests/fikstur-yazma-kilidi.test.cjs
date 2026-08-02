"use strict";

/**
 * HER FİKSTÜR YAZMASI KİLİT ALTINDA OLMALI.
 *
 * ⚠️ BU TURDA KUSUR BULUNAMADI — dört yazma noktasının dördü de kilitli.
 * Ama özellik LOAD-BEARING ve beşinci bir nokta kolayca atlar; kilitliyorum.
 *
 * NEDEN ÖNEMLİ — `services/fixture-sync.cjs` kendi notunda yazıyor:
 *   "hepsi TAM DEĞİŞTİRME yapan writeFixtures/saveAll ile bitiyor — listede
 *    olmayan belge SİLİNİYOR. Bayat liste okunup üzerine yazılırsa arada
 *    eklenen maçlar sessizce kaybolur."
 *
 * Yani her yazma bir OKU-DEĞİŞTİR-YAZ turu ve `saveAll` sonda
 * `deleteMany({ fixtureId: { $nin: ids } })` çalıştırıyor. İki tur iç içe
 * geçerse:
 *     A okur (L) → B okur (L) → A yazar (L+a) → B yazar (L+b)
 * ve `a` SESSİZCE SİLİNİR. Belirti hata değil, "maç kayboldu" olur.
 *
 * ⚠️ TAZE OKUMA YETMİYOR. Depo `taze: true` ile önbelleği atlıyor ama o
 * BAYATLIĞA karşı bir önlem; EŞZAMANLILIĞA karşı değil. Taze okuma pencereyi
 * daraltır, kapatmaz. Kapatan şey kilit.
 *
 * ⚠️ BİLİNEN SINIR — DÜZELTİLMEDİ, BİLEREK: `withFileLock` SÜREÇ İÇİDİR.
 * Birden fazla instance çalışırsa hiçbir şey yapmaz; kod tabanı bu dersi
 * push mührü için zaten öğrenmiş ve onu Mongo'ya taşımıştı. Render ücretsiz
 * katmanda tek instance olduğu için bugün etkisiz bir risk — ölçeklenince
 * fikstür yazması da Mongo tarafına taşınmalı.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");

/** `withFileLock(` çağrısının kapanış parantezine kadar olan aralığı bulur. */
function kilitAraliklari(src) {
  const araliklar = [];
  let i = 0;
  while ((i = src.indexOf("withFileLock(", i)) !== -1) {
    let derinlik = 0, j = src.indexOf("(", i);
    for (; j < src.length; j++) {
      if (src[j] === "(") derinlik++;
      else if (src[j] === ")") { derinlik--; if (derinlik === 0) break; }
    }
    araliklar.push([i, j]);
    i += 13;
  }
  return araliklar;
}

describe("fikstür yazma kilidi", () => {
  test("writeFixtures ÇAĞRILARININ hepsi kilit içinde", () => {
    const dizin = path.join(KOK, "services");
    const bulunan = [];
    const kilitsiz = [];

    for (const ad of fs.readdirSync(dizin)) {
      if (!ad.endsWith(".cjs")) continue;
      const src = fs.readFileSync(path.join(dizin, ad), "utf8");
      const araliklar = kilitAraliklari(src);

      let i = 0;
      while ((i = src.indexOf("writeFixtures(", i)) !== -1) {
        const onceki = src.slice(Math.max(0, i - 40), i);
        // tanım ve import satırlarını atla
        if (/function\s+$/.test(onceki) || /\{\s*[\w,\s]*$/.test(onceki) && /require\(/.test(src.slice(i, i + 200).split("\n")[0])) { i += 14; continue; }
        if (/(function|const|let|var)\s+writeFixtures/.test(src.slice(Math.max(0, i - 30), i + 14))) { i += 14; continue; }

        const satir = src.slice(0, i).split("\n").length;
        bulunan.push(`${ad}:${satir}`);
        if (!araliklar.some(([a, b]) => i > a && i < b)) kilitsiz.push(`${ad}:${satir}`);
        i += 14;
      }
    }

    assert.ok(bulunan.length >= 4,
      `yalnizca ${bulunan.length} yazma noktasi bulundu (${bulunan.join(", ")}) — tarama bozuk, test bir sey olcmuyor`);
    assert.deepEqual(kilitsiz, [],
      `KILITSIZ fikstur yazmasi — es zamanli iki tur birbirinin macini SILER:\n${kilitsiz.join("\n")}`);
  });

  test("saveAll GERÇEKTEN tam değiştirme yapıyor (kilidin gerekçesi)", () => {
    /* ⚠️ Bu iddia düşerse yukarıdaki testin GEREKÇESİ ortadan kalkar —
     * o zaman kilit belki gereksizdir ve gözden geçirilmeli. Tersi de doğru:
     * silme davranışı sürdükçe kilit zorunludur. */
    const src = fs.readFileSync(path.join(KOK, "lib", "fixtures-store.cjs"), "utf8");
    const govde = src.slice(src.indexOf("async function saveAll"));
    assert.ok(/deleteMany\(\s*\{\s*fixtureId:\s*\{\s*\$nin/.test(govde),
      "saveAll artik listede olmayani silmiyor — kilidin gerekcesi degismis olabilir, gozden gecir");
  });

  test("oku-değiştir-yaz TAZE okuyor (kilidin tamamlayıcısı)", () => {
    /* Taze okuma tek başına yetmez ama olmadan kilit de yetmez: bayat liste
     * kilit altında yazılırsa yine maç kaybolur. İkisi birlikte gerekli. */
    const src = fs.readFileSync(path.join(KOK, "services", "fixture-sync.cjs"), "utf8");
    assert.ok(/taze:\s*true/.test(src), "readFixtures taze okumuyor — bayat liste uzerine yazilir");
  });
});
