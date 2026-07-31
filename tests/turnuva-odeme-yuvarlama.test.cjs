"use strict";

/**
 * TURNUVA ÖDEMELERİ HAVUZU AŞMAZ.
 *
 * ⚠️ BULUNAN: her ödeme bağımsız `Math.round` ile yuvarlanıyor ve toplam
 * havuzla hiç karşılaştırılmıyordu.
 *
 * ÖLÇÜLDÜ (oyuncu 2-16 × giriş 5-100 LC = 1440 senaryo):
 *     %74.7 tam eşleşme
 *     %25.0 FAZLA ödeme (+1 LC)   ← yoktan LC, dörtte bir turnuvada
 *     %0.3  eksik ödeme (-1 LC)
 * Örnek: 3 oyuncu × 5 LC = 15 havuz → round(10.5)=11 + round(4.5)=5 = 16.
 *
 * ⚠️ DOĞRU KURAL KOD TABANINDA ZATEN VARDI: `routes/mini.cjs` içindeki
 * `kazananPayi` aşağı yuvarlıyor ve gerekçesini yazıyor — "Yukarı yuvarlamak
 * toplamı taşırırdı ... Enflasyon yönünde hata yapmamak, kuruş kuruşuna
 * dağıtmaktan önemli." Turnuva o kuralı almamıştı.
 *
 * ⚠️ AMA SADECE AŞAĞI YUVARLAMAK DA YETMİYOR — ölçtüm: fazla ödemeyi bitiriyor
 * ama 1440 senaryonun 1199'unda 3 LC'ye kadar YAKIYOR. Mini'de tek pay
 * hesaplandığı için kayıp önemsizdi; burada üç-dört kalem var. Çözüm EN BÜYÜK
 * KALAN yöntemi: toplam havuza tam eşitleniyor (1440/1440), hiç aşmıyor.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KAYNAK = path.join(__dirname, "..", "services", "tournament.cjs");

/**
 * ⚠️ MANTIK KOPYALANMIYOR, GERÇEK FONKSİYON ÇAĞRILIYOR.
 *
 * İlk sürümde dağıtım mantığının bir kopyasını teste yazmıştım ve negatif
 * kontrol yakaladı: kaynaktaki dağıtımı bozmak testi KIRMIYORDU — test kendi
 * kopyasını ölçüyordu. Mantık `_odemeDagit` olarak dışa açıldı, kopya silindi.
 */
const Turnuva = require("../services/tournament.cjs");
const dagit = (havuz, tab) => Turnuva._odemeDagit(havuz, tab);
const tablo = Turnuva._PAYOUT_TABLE;
const sekizArti = Turnuva._PAYOUT_8PLUS;

const tabloFor = (n) => (n >= 8 ? sekizArti : (tablo[n] || tablo[2]));

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

test("tablolar kaynaktan okunabildi", () => {
  assert.ok(Object.keys(tablo).length >= 5, `tablo okunamadi: ${JSON.stringify(tablo)}`);
  assert.ok(Array.isArray(sekizArti) && sekizArti.length >= 3, "8+ tablosu okunamadi");
});

test("her tablo satırı 1.00'e toplanıyor (ev payı yok)", () => {
  // Ev payı eklenirse bu test kırılır ve karar bilinçli verilir.
  for (const [n, tab] of Object.entries(tablo)) {
    const t = tab.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(t - 1) < 1e-9, `${n} oyuncu tablosu ${t} topluyor`);
  }
  assert.ok(Math.abs(sekizArti.reduce((a, b) => a + b, 0) - 1) < 1e-9);
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

test("hiçbir senaryoda ödemeler havuzu AŞMIYOR", () => {
  const asan = [];
  let bakilan = 0;
  for (let n = 2; n <= 16; n++) {
    for (let e = 5; e <= 100; e++) {
      bakilan++;
      const havuz = n * e;
      const toplam = dagit(havuz, tabloFor(n)).reduce((a, b) => a + b, 0);
      if (toplam > havuz) asan.push(`n=${n} giris=${e} havuz=${havuz} odeme=${toplam} (+${toplam - havuz})`);
    }
  }
  assert.ok(bakilan >= 1000, `cok az senaryo (${bakilan})`);
  assert.deepStrictEqual(
    asan.slice(0, 10),
    [],
    `${asan.length}/${bakilan} senaryoda odemeler havuzu asiyor — yoktan LC:\n` +
      asan.slice(0, 10).join("\n")
  );
});

test("ödemeler havuza TAM eşitleniyor (LC yakılmıyor)", () => {
  const eksik = [];
  for (let n = 2; n <= 16; n++) {
    for (let e = 5; e <= 100; e++) {
      const havuz = n * e;
      const toplam = dagit(havuz, tabloFor(n)).reduce((a, b) => a + b, 0);
      if (toplam !== havuz) eksik.push(`n=${n} giris=${e}: ${toplam} != ${havuz}`);
    }
  }
  assert.deepStrictEqual(
    eksik.slice(0, 10),
    [],
    `${eksik.length} senaryoda havuz tam dagitilmiyor:\n` + eksik.slice(0, 10).join("\n")
  );
});

test("bilinen örnek: 3 oyuncu × 5 LC → 11 + 4 = 15", () => {
  // Eski davranış 11 + 5 = 16 veriyordu (+1 LC yoktan).
  assert.deepStrictEqual(dagit(15, tabloFor(3)), [11, 4]);
});

test("aynı girdi hep aynı dağıtımı veriyor", () => {
  /**
   * ⚠️ BU TEST EŞİTLİK KURALINI DOĞRULAMAZ. Kaynakta kesirler eşit olduğunda
   * üst sıraya öncelik veren bir kural var (`a.i - b.i`); negatif kontrolde
   * onu kaldırdım ve test KIRILMADI — çünkü `Array.sort` modern V8'de zaten
   * kararlı, sıra değişmiyor.
   *
   * Yani kural gereksiz değil ama fazladan: sıralamanın kararlılığına
   * güvenmek yerine niyeti açıkça yazıyor. Testin gerçekten kilitlediği şey
   * daha zayıf — aynı girdi hep aynı çıktıyı veriyor.
   */
  for (let i = 0; i < 5; i++) {
    assert.deepStrictEqual(dagit(15, tabloFor(3)), [11, 4]);
    assert.deepStrictEqual(dagit(30, tabloFor(6)), dagit(30, tabloFor(6)));
  }
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: kaynak `Math.round(pool * pct)` kullanmıyor", () => {
  const ham = fs.readFileSync(KAYNAK, "utf8");
  const src = ham
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");

  assert.ok(
    !/Math\.round\(\s*t\.pool\s*\*/.test(src),
    "odeme yine `Math.round(t.pool * pct)` ile hesaplaniyor — havuzu asar"
  );
  assert.ok(/Math\.floor\(tam\)/.test(src), "en buyuk kalan yontemi yok");
  assert.ok(/kesir/.test(src), "kesirli kisim hesaplanmiyor");
});

test("NÖBETÇİ: ödeme havuzu aşarsa ödeme YAPILMIYOR", () => {
  /**
   * Yuvarlama bugün doğru, ama tablo ya da yöntem bir gün değişirse hata
   * sessiz enflasyon olarak değil gürültü olarak çıksın.
   */
  const src = fs.readFileSync(KAYNAK, "utf8");
  assert.ok(/PAYOUT_EXCEEDS_POOL/.test(src), "havuz asimi kontrolu yok");
  const kontrol = src.indexOf("odenecek > Number(t.pool");
  const odeme = src.indexOf("creditLc(conn, odeme.userId");
  assert.ok(kontrol > 0 && odeme > 0, "tarama kaliplari bulunamadi");
  assert.ok(kontrol < odeme, "havuz asimi kontrolu odemeden SONRA yapiliyor");
});
