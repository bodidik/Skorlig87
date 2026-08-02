"use strict";

/**
 * OLAY DÖNGÜSÜ BLOKAJI — `findLiveMatch` 25 SANİYE CPU harcıyordu.
 *
 * ⚠️ BULGU (kullanıcı deneyimi turu, üretim verisi 2026-08-03): uygulamanın
 * "takılmasının" kökü buydu. Ping deseni ölçüldü — 45 saniyede saniyede bir
 * `/api/live2/countries` (statik, disksiz, hesapsız bir uç):
 *     ..XXXXXXXXXXXXXXXXXXXXOXX.....o..XOXX.......X
 *     X = 1.5 sn+ yanıt yok → 45 ölçümün 26'sı
 * Statik ülke listesi bile 20 saniye yanıt veremiyordu.
 *
 * ÖLÇÜLDÜ: `findLiveMatch` tam turu **25.232 ms SENKRON** (1907 fikstür ×
 * 512 canlı maç). `sync()` her 30 saniyede çalışıyor — yani olay döngüsü
 * her 30 saniyenin ~25'inde KİLİTLİ. Node tek iş parçacıklı; o sürede HİÇBİR
 * istek işlenemiyor.
 *
 * SEBEP İKİ KATLIYDI:
 *   1) `normalizeTeam` her çağrıda TEAM_MAP'in 67 varyantını yeniden
 *      `baseNormalize`'dan geçiriyordu (NFD + 8 regex, her seferinde).
 *   2) `findLiveMatch` her fikstür×maç çifti için bunu tekrar çağırıyordu:
 *      1907 × 512 × 2 ≈ 2 milyon çağrı.
 *
 * ÇÖZÜM: varyant indeksi bir kez kurulur, sonuçlar ada göre memolanır.
 * SONUÇ: 25.232 ms → **32 ms** (~790 kat).
 *
 * ⚠️ EN ÖNEMLİSİ: DAVRANIŞ DEĞİŞMEDİ, VE BU ÖLÇÜLDÜ. Eski sürüm git'ten
 * çıkarılıp yan yana çalıştırıldı (gerçek üretim verisi):
 *     normalizeTeam : 3360 benzersiz ad → 0 fark
 *     findLiveMatch : 1907 fikstür      → 0 eşleşme farkı
 * Bu şart, çünkü bu fonksiyonun geçmişinde PARA var: bir dönem `includes`
 * kullanılıyordu ve "ts"/"gs" kısaltmaları yüzünden 1411 takımın 30'u yanlış
 * eşleşiyordu → yanlış maçın skoru yazılıyor → yanlış settle, yanlış LC.
 * Hız için eşleştirme kuralına dokunmak, o hatayı geri getirme riski demek.
 */

const test = require("node:test");
const describe = require("node:test").describe;
const assert = require("node:assert/strict");

process.env.SKORLIG_BG = "0";
const Sync = require("../services/livescore-sync.cjs");
const { normalizeTeam, findLiveMatch, TEAM_MAP, _resetNormalizeCache } = Sync;

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("TEAM_MAP dolu ve sıfırlama açık", () => {
    assert.ok(Object.keys(TEAM_MAP).length > 10, "TEAM_MAP bos — test bir sey olcmuyor");
    assert.equal(typeof _resetNormalizeCache, "function", "onbellek sifirlama disa acilmamis");
  });
});

/* ── Davranış korunuyor ──────────────────────────────────────────────────── */

describe("normalizeTeam davranışı DEĞİŞMEDİ", () => {
  test("TEAM_MAP varyantları kanonik ada iniyor", () => {
    for (const [kanonik, varyantlar] of Object.entries(TEAM_MAP)) {
      for (const v of varyantlar) {
        assert.equal(normalizeTeam(v), kanonik,
          `varyant coztulemedi: ${JSON.stringify(v)} -> ${normalizeTeam(v)}, beklenen ${kanonik}`);
      }
    }
  });

  test("KISALTMA İÇEREN AD YANLIŞ EŞLEŞMİYOR", () => {
    /**
     * ⚠️ BU TESTİN ASIL İŞİ. Bir dönem `n.includes(v)` kullanılıyordu ve
     * TEAM_MAP'te "ts"/"gs"/"fb" gibi kısaltmalar olduğu için:
     *     "Botev Vra[ts]a", "Por[ts]mouth", "Ludogore[ts]" -> trabzonspor
     *     "Au[gs]burg", "Livin[gs]ton"                     -> galatasaray
     * Ölçülen etki: 1411 takımın 30'u yanlış eşleşiyordu → yanlış maçın
     * skoru bizim fikstüre yazılıyordu (yanlış settle, yanlış LC).
     * Önbellek eklerken bu kuralın kazara gevşemediğini kilitliyor.
     */
    for (const ad of ["Botev Vratsa", "Portsmouth", "Ludogorets", "Augsburg", "Livingston"]) {
      const n = normalizeTeam(ad);
      assert.ok(!Object.keys(TEAM_MAP).includes(n),
        `${ad} -> ${n} : kisaltma icerdigi icin yanlis kanonige eslesti`);
    }
  });

  test("yaş/kadın/rezerv işareti A takımıyla karışmıyor", () => {
    const a = normalizeTeam("Galatasaray");
    for (const ek of ["U19", "Women", "Kadinlar", "Reserves"]) {
      assert.notEqual(normalizeTeam(`Galatasaray ${ek}`), a,
        `${ek} isareti kayboldu — genclik/kadin maci A takimina yazilabilir`);
    }
  });

  test("boş/bozuk girdi eskisi gibi", () => {
    assert.equal(normalizeTeam(""), "");
    assert.equal(normalizeTeam(null), "");
    assert.equal(normalizeTeam(undefined), "");
  });
});

/* ── Önbellek doğru ──────────────────────────────────────────────────────── */

describe("önbellek sonucu DEĞİŞTİRMİYOR", () => {
  test("memolu ve memosuz sonuç aynı", () => {
    const ornekler = [
      "Galatasaray", "Fenerbahçe SK", "FC Beşiktaş", "Trabzonspor A.Ş.",
      "Real Madrid CF", "Manchester United", "Bayern München", "Şibenik",
      "Galatasaray U19", "Botev Vratsa", "", "  ", "NK Široki Brijeg",
    ];
    for (const ad of ornekler) {
      const memolu = normalizeTeam(ad);
      _resetNormalizeCache();
      const temiz = normalizeTeam(ad);
      assert.equal(memolu, temiz, `onbellek sonucu degistirdi: ${JSON.stringify(ad)}`);
    }
  });

  test("aynı ad tekrar çağrıldığında AYNI sonuç", () => {
    const a = normalizeTeam("Fenerbahçe");
    for (let i = 0; i < 5; i++) assert.equal(normalizeTeam("Fenerbahçe"), a);
  });
});

/* ── Hız ─────────────────────────────────────────────────────────────────── */

describe("blokaj geri gelmiyor", () => {
  test("2000 fikstür × 500 maç makul sürede", () => {
    /**
     * ⚠️ EŞİK GEVŞEK (2 sn) VE BU BİLİNÇLİ: test makineleri değişken, katı
     * bir sayı gürültülü kırılma üretir. Ölçülen gerçek değerler çok uzakta:
     * düzeltmeden ÖNCE 25.232 ms, SONRA 32 ms. 2 sn eşiği, kusur geri
     * gelirse (O(n×m×varyant)) kesin yakalar, normal koşuda hiç kırılmaz.
     */
    const takimlar = Array.from({ length: 400 }, (_, i) => `Takim ${i} FC`);
    const maclar = Array.from({ length: 500 }, (_, i) => ({
      homeTeam: takimlar[i % 400], awayTeam: takimlar[(i + 7) % 400],
      homeScore: 1, awayScore: 0, matchDate: null,
    }));
    const fiksturler = Array.from({ length: 2000 }, (_, i) => ({
      fixtureId: `F${i}`, home: takimlar[i % 400], away: takimlar[(i + 7) % 400],
      kickoffISO: null,
    }));

    _resetNormalizeCache();
    const t0 = Date.now();
    for (const f of fiksturler) findLiveMatch(f, maclar);
    const gecen = Date.now() - t0;

    assert.ok(gecen < 2000,
      `findLiveMatch tam tur ${gecen}ms — olay dongusu blokaji geri gelmis olabilir ` +
      `(duzeltmeden once 25232ms, sonra 32ms)`);
  });
});

/* ── Nöbetçi ─────────────────────────────────────────────────────────────── */

const fs = require("fs");
const path = require("path");
const kaynak = fs.readFileSync(path.join(__dirname, "..", "services", "livescore-sync.cjs"), "utf8")
  .split("\n")
  .map((l) => {
    const t = l.trim();
    return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
  })
  .join("\n");

test("NÖBETÇİ: TEAM_MAP taraması her çağrıda TEKRARLANMIYOR", () => {
  /* Eski hâl: `for (const [canonical, variants] of Object.entries(TEAM_MAP))`
   * doğrudan normalizeTeam gövdesindeydi ve her çağrıda 67 varyantı yeniden
   * normalize ediyordu. */
  const i = kaynak.indexOf("function normalizeTeam");
  const govde = kaynak.slice(i, kaynak.indexOf("\n}", i));
  assert.ok(!/Object\.entries\(TEAM_MAP\)/.test(govde),
    "TEAM_MAP her cagrida yeniden taraniyor — 25 saniyelik blokaj geri gelir");
  assert.ok(/variantIx\(\)/.test(govde), "onhesaplanmis varyant indeksi kullanilmiyor");
});

test("NÖBETÇİ: eşleştirme TAM EŞİTLİK, includes değil", () => {
  /**
   * Para güvenliği: `includes` bir dönem 1411 takımın 30'unu yanlış
   * eşleştirip yanlış settle üretmişti. Önbellek eklerken kural gevşerse
   * hız kazanılır ama para kaybedilir.
   */
  const i = kaynak.indexOf("function variantIx");
  const govde = kaynak.slice(i, kaynak.indexOf("\n}\n", i));
  assert.ok(!/\.includes\(/.test(govde), "varyant eslestirmesinde includes belirmis");
  assert.ok(/_variantIx\.set\(k, canonical\)/.test(govde), "tam esitlik indeksi kurulmuyor");
});
