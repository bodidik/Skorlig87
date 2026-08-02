"use strict";

/**
 * BOT DOLDURMA SIRASI — "en yakın 25" tıkanması.
 *
 * ⚠️ KUSUR (uçtan uca denetim, 2026-08-03): `pickFixtures` kickoff'a göre
 * sıralayıp ilk 25'i alıyordu ama DOLMUŞ maçları elemiyordu. Her 10
 * dakikalık turda AYNI en yakın 25 yeniden taranıyor ("hedef dolu" ile
 * geçiliyor), 26. sıradan sonrakiler kilide girene kadar HİÇ sıra
 * alamıyordu.
 *
 * ÖLÇÜLDÜ (üretim): 24 saatlik pencerede ~270 açık maç. Öğlen oynanan Çin
 * maçları 40'ar bot; Türk kullanıcının listesinin TEPESİNDEKİ akşam maçları
 * (Trabzonspor–Udinese, Ç.Rizespor, Galatasaray–Rennes) 0 tahmin. Botların
 * varlık sebebi "kullanıcı maçta yalnız kalmasın" — kusur tam tersini
 * üretmişti: en görünür maçlar bomboş.
 *
 * ÇÖZÜM: başarıyla doldurulan maç REFILL_MS (60 dk) boyunca aday listesine
 * girmiyor; 25'lik kota her turda SIRADAKI doldurulmamışlara geçiyor.
 * TTL süresiz değil: uç fazla botu her çağrıda geri çektiği için dolmuş
 * maçın saatte bir yeniden dengelenmesi gerekiyor.
 */

const test = require("node:test");
const describe = require("node:test").describe;
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");

const KOK = path.join(__dirname, "..");
process.env.SKORLIG_BG = "0";

/* Fikstür deposunu denetim altına al: 60 maç, 10'ar dakika arayla. */
const storeYol = require.resolve(path.join(KOK, "lib", "fixtures-store.cjs"));
const simdi = Date.now();
const MACLAR = Array.from({ length: 60 }, (_, i) => ({
  fixtureId: `M${String(i).padStart(2, "0")}`,
  kickoffISO: new Date(simdi + (30 + i * 10) * 60 * 1000).toISOString(),
}));
require.cache[storeYol] = { id: storeYol, filename: storeYol, loaded: true, exports: {
  loadAll: async () => MACLAR.slice(),
  saveAll: async () => ({}), getOne: async () => null, invalidateCache: () => {},
  COLL: "fixtures", FIXTURES_FILE: "",
}};

const Filler = require("../services/bot-filler.cjs");
const { pickFixtures, _sonDolum } = Filler;

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("aday seçimi çalışıyor ve 25 ile sınırlı", async () => {
    _sonDolum.clear();
    const a = await pickFixtures();
    assert.equal(a.length, 25, `aday ${a.length} — MAX_PER_TICK degismis olabilir`);
    assert.equal(a[0].fixtureId, "M00", "en yakin mac ilk sirada degil");
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("sıra dönüyor", () => {
  test("doldurulan maç sonraki turda YER AÇIYOR", async () => {
    /**
     * ⚠️ KUSURUN KENDİSİ: eskiden ikinci tur da AYNI ilk 25'i döndürüyordu
     * ve M25+ hiç sıra alamıyordu.
     */
    _sonDolum.clear();
    const tur1 = await pickFixtures();
    for (const f of tur1) _sonDolum.set(f.fixtureId, Date.now());   // tur bitti

    const tur2 = await pickFixtures();
    assert.equal(tur2.length, 25);
    assert.equal(tur2[0].fixtureId, "M25",
      `ikinci tur hala ayni maclari tariyor (${tur2[0].fixtureId}) — 26+ hic doldurulmaz`);

    for (const f of tur2) _sonDolum.set(f.fixtureId, Date.now());
    const tur3 = await pickFixtures();
    assert.equal(tur3[0].fixtureId, "M50", "ucuncu tur kaldigi yerden devam etmiyor");
    assert.equal(tur3.length, 10, "60 macin son 10'u kalmaliydi");
  });

  test("TTL dolunca maç yeniden aday oluyor (yeniden dengeleme)", async () => {
    /* Gerçek kullanıcılar geldikçe fazla botun geri çekilmesi bu yolla
     * oluyor — süresiz atlamak yoğunluğu taşlaştırırdı. */
    _sonDolum.clear();
    _sonDolum.set("M00", Date.now() - Filler.REFILL_MS - 1000);   // TTL geçmiş
    _sonDolum.set("M01", Date.now());                              // taze
    const a = await pickFixtures();
    const idler = a.map((f) => f.fixtureId);
    assert.ok(idler.includes("M00"), "TTL gecen mac yeniden aday olmadi");
    assert.ok(!idler.includes("M01"), "taze doldurulan mac hala listede");
  });

  test("hata alan maç işaretlenmiyor — sonraki turda yeniden denenir", () => {
    /* `fillOne` fırlatırsa `_sonDolum.set` çağrılmıyor (yalnızca başarılı
     * çağrıdan sonra). Kaynak düzeyinde kilitle: */
    const src = fs.readFileSync(path.join(KOK, "services", "bot-filler.cjs"), "utf8")
      .split("\n")
      .map((l) => {
        const t = l.trim();
        return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
      })
      .join("\n");
    const i = src.indexOf("const r = await fillOne");
    const govde = src.slice(i, src.indexOf("catch", i));
    assert.ok(/_sonDolum\.set/.test(govde), "basarili dolum isaretlenmiyor — sira donmez");
    const catchGovde = src.slice(src.indexOf("catch", i), src.indexOf("}", src.indexOf("catch", i) + 60));
    assert.ok(!/_sonDolum\.set/.test(catchGovde), "hatali mac da isaretleniyor — kalici atlanir");
  });
});
