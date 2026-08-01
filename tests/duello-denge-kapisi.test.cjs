"use strict";

/**
 * DÜELLO DENGE KAPISI TEK TARAFLI MAÇLARI ELEMELİ.
 *
 * ⚠️ BU TEST BİR ÖNCEKİ DÜZELTMENİN ETKİSİNİ KİLİTLİYOR. `getRating` tam
 * resmî adları tanımıyordu ("Arsenal FC", "Manchester United FC") ve o
 * takımlar DEFAULT_RATING alıyordu. İki takım da varsayılan olunca
 * `favoriOlasiligi` ~%50 çıkıyor ve maç "dengeli" görünüyordu — yani kapı
 * onları düelloya AÇIYORDU.
 *
 * ÖLÇÜLDÜ (data/fixtures.json, 1449 gerçek maç, eşik 0.65):
 *     eski derecelendirme ile reddedilen: 76 (%5.2)
 *     yeni derecelendirme ile reddedilen: 86 (%5.9)
 *     fark: +10 maç artık düelloya açılmıyor
 *
 * ⚠️ BÜYÜKLÜĞÜ ABARTMIYORUM: %0.7'lik bir kayma. Ama içindekiler somut —
 * "Arsenal FC – Coventry City FC" (favori %76) ve "Manchester City FC –
 * AFC Bournemouth" (%74) önceden düelloya açıktı.
 *
 * Kapının varlık sebebi `routes/duels.cjs` içinde yazılı: "Real Madrid –
 * Erokspor gibi maçlarda sonuç zaten büyük ölçüde belli ... aynı maça düello
 * açmak yeni bir oyun kurmuyor."
 */

const test = require("node:test");
const describe = require("node:test").describe;
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
const MD = require("../lib/mac-denge.cjs");

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("denge denetimi açık ve eşik makul", () => {
    // ACIK=false ise kapı hiç çalışmaz ve aşağıdaki testler boşlukta geçerdi.
    assert.equal(MD.ACIK, true, "denge denetimi kapali — test bir sey olcmuyor");
    assert.ok(MD.ESIK > 0.5 && MD.ESIK < 1, `esik beklenmedik: ${MD.ESIK}`);
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("tek taraflı maçlar", () => {
  /**
   * Tam resmî adlarla — gerçek fikstür verisinde bu biçimde geliyorlar.
   * Kısa adları kullanmak, düzeltilen hatayı hiç sınamamak olurdu.
   */
  const TEK_TARAFLI = [
    ["Arsenal FC", "Coventry City FC"],
    ["Manchester City FC", "AFC Bournemouth"],
    ["West Ham United FC", "Charlton Athletic FC"],
    ["RCD Espanyol de Barcelona", "Real Madrid CF"],
  ];

  for (const [h, a] of TEK_TARAFLI) {
    test(`"${h}" - "${a}" düelloya AÇILMIYOR`, () => {
      const p = MD.favoriOlasiligi(h, a);
      assert.ok(
        p >= MD.ESIK,
        `favori olasiligi %${(100 * p).toFixed(0)} < esik %${(100 * MD.ESIK).toFixed(0)} — ` +
          "tam resmi adlar taninmiyor olabilir (getRating varsayilana dusuyor)"
      );
    });
  }

  test("DENGELİ maçlar hâlâ açık (kapı fazla kapanmıyor)", () => {
    /**
     * Kapalı tarafa kaçmadığımızın kanıtı: kapı her şeyi elerse düello modu
     * fiilen ölür.
     */
    const DENGELI = [
      ["Kasimpasa", "Alanyaspor"],
      ["Galatasaray", "Fenerbahce"],
      ["Besiktas", "Trabzonspor"],
    ];
    for (const [h, a] of DENGELI) {
      const p = MD.favoriOlasiligi(h, a);
      assert.ok(p < MD.ESIK, `${h}-${a} reddedildi (favori %${(100 * p).toFixed(0)}) — kapi fazla kati`);
    }
  });
});

/* ── Gerçek veriyle oran ─────────────────────────────────────────────────── */

test("gerçek fikstürlerde red oranı makul aralıkta", (t) => {
  /**
   * ⚠️ TAM SAYI DONDURULMUYOR — veri değiştikçe oran da değişir. Ölçüm
   * anındaki değer %5.9 (86/1449). Aralık iki yönlü: çok düşerse kapı
   * çalışmıyor demektir (derecelendirme gerilemesi), çok yükselirse kapı
   * düello modunu boğuyor demektir.
   */
  const dosya = path.join(KOK, "data", "fixtures.json");
  if (!fs.existsSync(dosya)) return t.skip("fikstur verisi yok");
  const items = (JSON.parse(fs.readFileSync(dosya, "utf8")).fixtures || [])
    .filter((f) => f && f.home && f.away);
  if (items.length < 100) return t.skip("yeterli fikstur yok");

  const red = items.filter((f) => MD.favoriOlasiligi(f.home, f.away) >= MD.ESIK).length;
  const oran = red / items.length;

  assert.ok(
    oran >= 0.03,
    `red orani %${(100 * oran).toFixed(1)} — olcum aninda %5.9 idi; derecelendirme kapsami gerilemis olabilir`
  );
  assert.ok(
    oran <= 0.25,
    `red orani %${(100 * oran).toFixed(1)} — kapi cok fazla mac eliyor, duello modu bogulur`
  );
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: kapı fikstürü SUNUCUDAN okuyor", () => {
  /**
   * Takım adları istemciden gelseydi kurucu kendi maçını "dengeli"
   * gösterebilirdi. `duelloyaUygunMu` fikstür deposundan okumalı.
   */
  const src = fs.readFileSync(path.join(KOK, "lib", "mac-denge.cjs"), "utf8")
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");
  assert.ok(/FixturesStore\.getOne\s*\(/.test(src), "kapi fikstur deposunu okumuyor");
});
