"use strict";

/**
 * TAKIM DERECELENDİRMESİ TAM RESMÎ ADLARLA DA BULUNMALI.
 *
 * ⚠️ BULUNAN: `getRating` yalnızca BİREBİR ve büyük/küçük harf eşleşmesi
 * yapıyordu. Gerçek fikstür verisi tam resmî adlarla geliyor
 * ("Manchester United FC", "Grêmio FBPA", "SC Corinthians Paulista") ve
 * tablodaki kısa adlarla eşleşmiyordu — hepsi DEFAULT_RATING'e düşüyordu.
 *
 * ÖLÇÜLDÜ (data/fixtures.json, 1449 maç, 2514 tekil takım adı):
 *     önce : 321 takım kapsanıyor  (%12.8)
 *     sonra: 439 takım kapsanıyor  (%17.5)
 * Manchester United FC 65 → 82, Arsenal FC 65 → 89, Grêmio FBPA 65 → 74.
 * Yani uzun kuyruk sorunu değil; BÜYÜK kulüpler jenerik sayılıyordu.
 *
 * ⚠️ NEDEN ÖNEMLİ: `calcOdds` iki takımı da aynı güçte sayınca o maçın TÜM
 * sonuçları eşit oran alıyor. Bu üç şeyi birden bozuyor —
 *   • düello puanı            (routes/duels.cjs → calcOdds)
 *   • gösterilen ödül         (routes/daily-picks.cjs → oddsMultiplier)
 *   • düello denge kapısı     (lib/mac-denge.cjs favoriOlasiligi)
 * Sonuncusu en sinsisi: dengesiz bir maç "dengeli" görünüp düelloya açılıyor.
 *
 * ⚠️ NORMALLEŞTİRME `services/livescore-sync.cjs`'te ZATEN VARDI, oran
 * motorunda yoktu — bu oturumun tekrar eden kalıbı.
 *
 * ⚠️ KALAN %81 GERÇEKTEN TABLODA YOK (dünya çapında alt ligler); onlar için
 * varsayılan doğru davranış. Bu test kapsamı %100 yapmayı değil, GERİLEMEYİ
 * engellemeyi hedefliyor.
 */

const test = require("node:test");
const describe = require("node:test").describe;
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
const OE = require("../services/odds-engine.cjs");

/** Varsayılan derecelendirme — kaynaktan okunuyor, uydurulmuyor. */
const DEFAULT_RATING = (() => {
  const s = fs.readFileSync(path.join(KOK, "services", "odds-engine.cjs"), "utf8");
  const m = /DEFAULT_RATING\s*=\s*(\d+)/.exec(s);
  assert.ok(m, "DEFAULT_RATING okunamadi");
  return Number(m[1]);
})();

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("tablo ve varsayılan okunabiliyor", () => {
    assert.ok(Object.keys(OE.TEAM_RATINGS).length > 500, "tablo beklenenden kucuk");
    assert.ok(DEFAULT_RATING > 0);
  });

  test("bilinmeyen takım varsayılana düşüyor", () => {
    assert.equal(OE.getRating("Hic Olmayan Takim XYZ"), DEFAULT_RATING);
    assert.equal(OE.getRating(""), DEFAULT_RATING);
    assert.equal(OE.getRating(null), DEFAULT_RATING);
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("tam resmî adlar", () => {
  /** Gerçek fikstür verisinde geçen, kulüp eki taşıyan büyük kulüpler. */
  const ORNEKLER = [
    "Manchester United FC",
    "Arsenal FC",
    "Grêmio FBPA",
    "Fluminense FC",
    "Cruzeiro EC",
    "Norwich City FC",
  ];

  for (const ad of ORNEKLER) {
    test(`"${ad}" derecelendirme buluyor`, () => {
      assert.notEqual(
        OE.getRating(ad), DEFAULT_RATING,
        `${ad} varsayilana dusuyor — kulup eki normallestirilmiyor`
      );
    });
  }

  test("tablodaki her ad kendi değerini döndürüyor", () => {
    /**
     * Normalleştirme mevcut davranışı BOZMAMALI: tablodaki bir ad her zaman
     * kendi değerini vermeli, normalleştirilmiş bir komşununkini değil.
     *
     * ⚠️ DÜRÜST SINIR: bu test "birebir eşleşme ÖNCELİKLİ" iddiasını
     * kanıtlamıyor. Negatif kontrolde birebir satırını sildim ve test
     * kırılmadı — çünkü küçük-harf indeksi aynı değeri döndürüyor, yani o
     * satır fiilen gereksiz. Kilitlenen şey daha zayıf ama yine de değerli:
     * tablodaki adlar doğru değeri veriyor.
     */
    for (const [k, v] of Object.entries(OE.TEAM_RATINGS).slice(0, 50)) {
      assert.equal(OE.getRating(k), v, `${k} kendi degerini vermiyor`);
    }
  });
});

/* ── Belirsiz adlar ──────────────────────────────────────────────────────── */

describe("çarpışmalar tahmin edilmiyor", () => {
  /**
   * ⚠️ Normalleştirme iki FARKLI kulübü aynı ada indirebiliyor. Ölçüldü:
   * tablodaki 1006 girdinin normalleştirilmiş hâlinde 86 çarpışma var ama
   * yalnızca İKİSİ farklı derecelendirmeye sahip — "Barcelona"(95) ile
   * "Barcelona SC"(68, Ekvador), ve "Nacional"(64) ile "Club Nacional"(71).
   * Bunları tahmin etmek yanlış oran üretirdi.
   */
  const CIFTLER = [
    ["Barcelona", "Barcelona SC"],
    ["Nacional", "Club Nacional"],
  ];

  for (const [a, b] of CIFTLER) {
    test(`"${a}" ile "${b}" ayrı derecelendirme koruyor`, () => {
      const ra = OE.getRating(a), rb = OE.getRating(b);
      assert.equal(ra, OE.TEAM_RATINGS[a], `${a} birebir degerini kaybetmis`);
      assert.equal(rb, OE.TEAM_RATINGS[b], `${b} birebir degerini kaybetmis`);
      assert.notEqual(ra, rb, `${a} ve ${b} ayni degere cokmus`);
    });
  }

  test("belirsiz anahtara düşen bilinmeyen ad TAHMİN EDİLMİYOR", () => {
    /**
     * ⚠️ SONDA DİKKATLE SEÇİLDİ. İlk denemede "Barcelona Atletico FC"
     * kullanmıştım; o `"barcelona atletico"` diye normalleşiyor, yani belirsiz
     * anahtara hiç uğramıyordu ve negatif kontrol ATEŞLENMEDİ — test
     * belirsizlik korumasını değil, hiçbir şeyi ölçüyordu.
     *
     * "Barcelona CF" ve "Nacional FC" tam olarak belirsiz anahtarlara
     * (`barcelona`, `nacional`) normalleşiyor ve tabloda birebir yok. Doğru
     * davranış: 95/68 ya da 64/71 diye tahmin etmek yerine varsayılan.
     */
    for (const ad of ["Barcelona CF", "Nacional FC"]) {
      assert.equal(
        OE.getRating(ad), DEFAULT_RATING,
        `${ad} belirsiz anahtar uzerinden tahmin edildi — yanlis oran uretir`
      );
    }
  });
});

/* ── Gerçek veriyle kapsam ───────────────────────────────────────────────── */

test("gerçek fikstür verisinde kapsam gerilemedi", (t) => {
  /**
   * ⚠️ Eşik ÖLÇÜLEN değerin biraz altında (%15) — veri değiştikçe oran da
   * değişir, testin amacı tam sayıyı dondurmak değil GERİLEMEYİ yakalamak.
   * Ölçüm anındaki değerler: önce %12.8, sonra %17.5.
   */
  const dosya = path.join(KOK, "data", "fixtures.json");
  if (!fs.existsSync(dosya)) return t.skip("fikstur verisi yok");

  const raw = JSON.parse(fs.readFileSync(dosya, "utf8"));
  const items = raw.fixtures || raw.items || [];
  if (!items.length) return t.skip("fikstur listesi bos");

  const adlar = new Set();
  for (const x of items) {
    if (x?.home) adlar.add(String(x.home));
    if (x?.away) adlar.add(String(x.away));
  }
  assert.ok(adlar.size > 100, `cok az takim adi (${adlar.size}) — tarama bozuk`);

  const kapsanan = [...adlar].filter((a) => OE.getRating(a) !== DEFAULT_RATING).length;
  const oran = kapsanan / adlar.size;
  assert.ok(
    oran >= 0.15,
    `kapsam %${(100 * oran).toFixed(1)} — olcum aninda %17.5 idi, gerileme var`
  );
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: her çağrıda tablo taranmıyor (indeks kuruluyor)", () => {
  /**
   * Eski kod her `getRating` çağrısında 1006 girdiyi geziyordu ve `calcOdds`
   * maç başına üç kez çağrılıyor. İndeks bir kez kurulur.
   */
  const src = fs.readFileSync(path.join(KOK, "services", "odds-engine.cjs"), "utf8")
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");

  assert.ok(/_indeksler\s*\(/.test(src), "indeks kurulumu yok");
  assert.ok(
    !/for \(const \[k, v\] of Object\.entries\(TEAM_RATINGS\)\) \{\s*if \(k\.toLowerCase\(\) === lower\)/.test(src),
    "her cagrida dogrusal tarama geri gelmis"
  );
});
