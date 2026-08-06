"use strict";

/**
 * TAKIM TAKMA ADLARI — ARAMA İNDEKSİNE GİRER, SEÇİCİYE GİRMEZ.
 *
 * ⚠️ NEDEN VAR (2026-08-06): ESPN fikstür kaynağı bağlanırken ölçüldü —
 * 2026-27 Süper Lig kadrosunun 18 takımından 8'i `kanonikTakim` ile
 * çözülemiyordu:
 *
 *   - 6'sı katalogda HİÇ YOKTU (Göztepe, Gençlerbirliği, Kocaelispor,
 *     Amedspor, Erzurumspor, Çorum FK — yeni yükselenler)
 *   - 2'si ÖNEK yüzünden eşleşmiyordu: `cekirdek("Istanbul Basaksehir")`
 *     "istanbul basaksehir" veriyor, katalogdaki "Başakşehir" ise
 *     "basaksehir" — tam eşleşme de çekirdek eşleşmesi de tutmuyor.
 *
 * `kanonikTakim` null dönünce fikstür sağlayıcının HAM adıyla yazılır:
 * ekranda aksansız ad ("Besiktas") ve aynı maçın iki kaynaktan iki farklı
 * adla girmesi (İKİZ fikstür) demek.
 *
 * ⚠️ ASIL DEĞİŞMEZ: takma ad `teams` dizisine EKLENMEZ. O dizi onboarding
 * seçicisini de besliyor (bkz. `takimlar`); varyantı oraya koymak aynı kulübü
 * listede iki kez gösterir ve iki farklı ad seçen taraftarlar AYRI
 * sıralamalara düşer — bu modülün önlemek için yazıldığı kusurun kendisi.
 */

const test = require("node:test");
const { describe } = require("node:test");
const assert = require("node:assert/strict");

const K = require("../lib/takim-katalog.cjs");

/** ESPN'in `tur.1` ucunda dönen 2026-27 kadrosu (ölçülerek alındı). */
const ESPN_ADLARI = [
  "Alanyaspor", "Amed SFK", "Besiktas", "Caykur Rizespor", "Erzurum BB",
  "Eyupspor", "Fenerbahce", "Galatasaray", "Gaziantep FK", "Genclerbirligi",
  "Goztepe", "Istanbul Basaksehir", "Kasimpasa", "Kocaelispor", "Konyaspor",
  "Samsunspor", "Trabzonspor", "Çorum FK",
];

describe("takım katalogu — ESPN adları", () => {
  test("2026-27 Süper Lig kadrosunun TAMAMI kanonikleşiyor", () => {
    const cozulemeyen = ESPN_ADLARI.filter((ad) => !K.kanonikTakim(ad));
    assert.deepStrictEqual(
      cozulemeyen, [],
      "Bu adlar kanonikTakim ile cozulemiyor. Fikstur HAM saglayici adiyla\n" +
        "yazilir: ekranda aksansiz ad + ikiz fikstur riski:\n" + cozulemeyen.join("\n")
    );
  });

  test("takma adlar DOĞRU kanonik ada gidiyor", () => {
    /* ⚠️ Yalnizca "null donmuyor" yetmez — YANLIS takima gitmek daha kotu:
     * iki ayri kulubun taraftari tek siralamada birlesir. */
    const beklenen = {
      "Istanbul Basaksehir": "Başakşehir",
      "Caykur Rizespor": "Rizespor",
      "Amed SFK": "Amedspor",
      "Erzurum BB": "Erzurumspor",
    };
    for (const [varyant, kanonik] of Object.entries(beklenen)) {
      assert.equal(K.kanonikTakim(varyant), kanonik,
        `${varyant} -> ${K.kanonikTakim(varyant)} (beklenen ${kanonik})`);
    }
  });

  test("aksansız yazım kanonik Türkçe ada dönüyor", () => {
    // ESPN ASCII yaziyor; ekranda Turkce gorunmeli.
    assert.equal(K.kanonikTakim("Besiktas"), "Beşiktaş");
    assert.equal(K.kanonikTakim("Fenerbahce"), "Fenerbahçe");
    assert.equal(K.kanonikTakim("Goztepe"), "Göztepe");
    assert.equal(K.kanonikTakim("Genclerbirligi"), "Gençlerbirliği");
  });
});

describe("takma adlar seçiciyi kirletmiyor", () => {
  test("onboarding listesinde takma ad YOK", () => {
    const secici = K.takimlar("Türkiye").map((x) => x.team);
    const sizan = Object.keys({
      "Istanbul Basaksehir": 1, "Caykur Rizespor": 1,
      "Amed SFK": 1, "Erzurum BB": 1,
    }).filter((v) => secici.includes(v));

    assert.deepStrictEqual(
      sizan, [],
      "Takma ad onboarding seciciye sizmis. Ayni kulup listede iki kez\n" +
        "gorunur ve iki farkli ad secen taraftarlar AYRI siralamalara duser:\n" +
        sizan.join("\n")
    );
  });

  test("seçicide mükerrer takım yok", () => {
    const secici = K.takimlar("Türkiye").map((x) => x.team);
    const mukerrer = secici.filter((v, i, a) => a.indexOf(v) !== i);
    assert.deepStrictEqual(mukerrer, [], `mukerrer takim: ${mukerrer.join(", ")}`);
  });

  test("takma adın hedefi gerçekten katalogda", () => {
    /* Hayalet hedefe isaret eden takma ad SESSIZCE calismaz: `kanonikTakim`
     * null doner ve kimse fark etmez. Yukleyici bu yuzden hedefi dogruluyor;
     * burasi o kontrolun kaldirilmadigini kilitliyor. */
    for (const varyant of ["Istanbul Basaksehir", "Caykur Rizespor", "Amed SFK", "Erzurum BB"]) {
      const hedef = K.kanonikTakim(varyant);
      assert.ok(hedef, `${varyant} cozulemiyor`);
      const secici = K.takimlar("Türkiye").map((x) => x.team);
      assert.ok(secici.includes(hedef),
        `${varyant} -> ${hedef}, ama ${hedef} katalogda yok (hayalet hedef)`);
    }
  });
});

describe("mevcut davranış korunuyor", () => {
  test("bilinmeyen ad hâlâ null dönüyor", () => {
    // Bulanik eslesme YOK kurali (modul basligi) bozulmamali.
    assert.equal(K.kanonikTakim("Boyle Bir Takim Yok FK"), null);
    assert.equal(K.kanonikTakim(""), null);
    assert.equal(K.kanonikTakim(null), null);
  });

  test("takım ülkesi doğru dönüyor", () => {
    assert.equal(K.takimUlkesi("Besiktas"), "Türkiye");
    assert.equal(K.takimUlkesi("Istanbul Basaksehir"), "Türkiye");
  });
});
