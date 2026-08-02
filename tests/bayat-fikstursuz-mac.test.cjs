"use strict";

/**
 * FİKSTÜR KAYDI SİLİNMİŞ MAÇTA PARA KİLİTLİ KALMASIN.
 *
 * ⚠️ KUSUR: `services/bayat-temizleyici.cjs kickoffHaritasi` başlama saatini
 * YALNIZCA `fixtures` koleksiyonundan okuyordu. Fikstür deposu TAM
 * DEĞİŞTİRME semantiğinde çalışıyor (`FixturesStore.saveAll` listede olmayan
 * belgeleri siler) ve eski maçlar listeden düşüyor. Kayıt silinince saat
 * `null` dönüyor, `lib/bayat-mac.cjs` ise FAIL-CLOSED:
 *     "⚠️ FAIL-CLOSED: başlama saati okunamıyorsa maç BAYAT SAYILMAZ."
 * Yani iade HİÇ tetiklenmiyordu → sonucu gelmemiş maçta oyuncunun LC'si
 * KALICI olarak kilitli kalıyordu.
 *
 * ⚠️ FAIL-CLOSED'IN KENDİSİ DOĞRU, YANLIŞ OLAN VERİNİN EKSİKLİĞİ. Erken iade
 * edip sonra gerçek sonuç gelirse ikinci kez ödeme yapılırdı; o yüzden
 * `bayat-mac` haklı olarak saati olmayan maçı bayat saymıyor. Çözüm kuralı
 * gevşetmek değil, saati BAŞKA YERDEN bulmak.
 *
 * ÖLÇÜLDÜ (üretim, 2026-08-02):
 *   tahmin almış maç ................ 242
 *   fikstür kaydı olmayan ........... 168
 *   iade edilmemiş insan tahmini .... 6 maç, 3'ü fikstürsüz
 *   bunlardan uzlaşmamış ............ 0   ← ŞU AN kilitli para YOK
 * Yani kusur gerçek ama henüz kimseyi vurmamış. Fikstürler sürekli
 * düştüğü için mesele zaman meselesiydi.
 *
 * ⚠️ DÜELLOLAR ETKİLENMİYOR: `duels` belgesi kendi `kickoffISO`sunu taşıyor.
 * Açık olan tahmin ve havuz yollarıydı — ikisi de bu haritayı kullanıyor.
 */

const test = require("node:test");
const describe = require("node:test").describe;
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
const Temizleyici = require("../services/bayat-temizleyici.cjs");
const { _kickoffHaritasi: kickoffHaritasi, TAHMIN_PENCERE_SAAT } = Temizleyici;

const SAAT = 3600 * 1000;

/** Sahte Mongo: yalnızca bu testin ihtiyaç duyduğu üç koleksiyon. */
function sahteDb({ fixtures = [], results = [], predictions = [] } = {}) {
  const suz = (liste, filtre) => {
    const idler = filtre?.fixtureId?.$in;
    return idler ? liste.filter((d) => idler.includes(String(d.fixtureId))) : liste.slice();
  };
  return {
    collection: (ad) => ({
      find: (filtre) => ({
        toArray: async () => {
          if (ad === "fixtures") return suz(fixtures, filtre);
          if (ad === "match_results") return suz(results, filtre);
          return suz(predictions, filtre);
        },
      }),
      aggregate: (boru) => ({
        toArray: async () => {
          const idler = boru?.[0]?.$match?.fixtureId?.$in || [];
          const gruplar = new Map();
          for (const p of predictions) {
            const fid = String(p.fixtureId);
            if (!idler.includes(fid)) continue;
            const onceki = gruplar.get(fid);
            if (!onceki || String(p.at) > String(onceki)) gruplar.set(fid, p.at);
          }
          return [...gruplar].map(([_id, sonAt]) => ({ _id, sonAt }));
        },
      }),
    }),
  };
}

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("harita dışa açık, pencere pozitif", () => {
    assert.equal(typeof kickoffHaritasi, "function");
    assert.ok(TAHMIN_PENCERE_SAAT > 0);
  });
});

/* ── Zincir ──────────────────────────────────────────────────────────────── */

describe("kickoff kaynak zinciri", () => {
  test("1) fikstür kaydı varsa ONDAN alınır", async () => {
    const h = await kickoffHaritasi(sahteDb({
      fixtures: [{ fixtureId: "A", kickoffISO: "2026-07-01T18:00:00.000Z" }],
      results: [{ fixtureId: "A", meta: { kickoffISO: "2000-01-01T00:00:00.000Z" } }],
    }), ["A"]);
    assert.equal(h.get("A"), "2026-07-01T18:00:00.000Z", "yetkili kaynak ezildi");
  });

  test("2) fikstür YOKSA sonuç meta'sından alınır", async () => {
    /* Fikstür silinse de `match_results` kaydı kalıyor. */
    const h = await kickoffHaritasi(sahteDb({
      fixtures: [],
      results: [{ fixtureId: "B", meta: { kickoffISO: "2026-07-02T18:00:00.000Z" } }],
    }), ["B"]);
    assert.equal(h.get("B"), "2026-07-02T18:00:00.000Z");
  });

  test("3) hiçbiri yoksa SON TAHMİN + pencere üst sınırı", async () => {
    /**
     * ⚠️ ÜST SINIR OLMASI KRİTİK. Tahmin yalnızca başlamasına 96 saatten az
     * kalan maça girilebiliyor, yani kickoff ≤ son tahmin + 96sa. Üst sınır
     * kullanmak beklemeyi UZATIR, kısaltmaz — erken iade edip sonra gerçek
     * sonuç gelince ikinci kez ödeme riski YOK.
     */
    const sonAt = "2026-07-03T10:00:00.000Z";
    const h = await kickoffHaritasi(sahteDb({
      predictions: [
        { fixtureId: "C", at: "2026-07-01T10:00:00.000Z" },
        { fixtureId: "C", at: sonAt },                       // en geç olan
      ],
    }), ["C"]);
    const beklenen = new Date(Date.parse(sonAt) + TAHMIN_PENCERE_SAAT * SAAT).toISOString();
    assert.equal(h.get("C"), beklenen, "ust sinir son tahmine gore hesaplanmadi");
  });

  test("tahmin zamanı BOZUKSA saat üretilmiyor (fail-closed korunuyor)", async () => {
    /* Uydurma bir saat, erken iadeye yol açardı. Saat yoksa `bayatMi` zaten
     * maçı bayat saymıyor — doğru davranış budur. */
    const h = await kickoffHaritasi(sahteDb({
      predictions: [{ fixtureId: "D", at: "bozuk-tarih" }],
    }), ["D"]);
    assert.equal(h.get("D"), undefined, "bozuk zamandan saat uydurulmus");
  });

  test("hiç iz yoksa harita BOŞ döner", async () => {
    const h = await kickoffHaritasi(sahteDb({}), ["E"]);
    assert.equal(h.get("E"), undefined);
  });
});

/* ── Uçtan uca: kilitli para çözülüyor mu ────────────────────────────────── */

describe("fikstürsüz maç artık bayat sayılabiliyor", () => {
  const { bayatMi } = require("../lib/bayat-mac.cjs");

  test("ÖNCE: saat yoksa bayat DEĞİL (kusurun kendisi)", async () => {
    const r = await bayatMi({ fixtureId: "X", kickoffISO: null, db: null });
    assert.equal(r.bayat, false, "saatsiz mac bayat sayildi — erken iade riski");
  });

  test("SONRA: zincirden gelen saatle bayat sayılıyor", async () => {
    /* Son tahmin 10 gün önce → üst sınır 10gün-96sa önce → 48 saatlik
     * bekleme çoktan dolmuş. */
    const sonAt = new Date(Date.now() - 10 * 24 * SAAT).toISOString();
    const h = await kickoffHaritasi(sahteDb({ predictions: [{ fixtureId: "Y", at: sonAt }] }), ["Y"]);
    const r = await bayatMi({ fixtureId: "Y", kickoffISO: h.get("Y"), db: null });
    assert.equal(r.bayat, true, `zincirden saat geldigi halde bayat sayilmadi: ${JSON.stringify(r)}`);
  });

  test("YENİ tahmin hâlâ bayat DEĞİL — üst sınır erken iade ettirmiyor", async () => {
    const sonAt = new Date(Date.now() - 1 * SAAT).toISOString();
    const h = await kickoffHaritasi(sahteDb({ predictions: [{ fixtureId: "Z", at: sonAt }] }), ["Z"]);
    const r = await bayatMi({ fixtureId: "Z", kickoffISO: h.get("Z"), db: null });
    assert.equal(r.bayat, false, "daha oynanmamis mac icin iade tetiklendi");
  });
});

/* ── Nöbetçi ─────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: tahmin penceresi live2 ile AYNI", () => {
  /**
   * ⚠️ İKİ KOPYA VAR ve bu bilinçli (servisin route dosyasını require etmesi
   * döngüsel bağımlılık riski). Kopya kaçınılmazsa en azından ÖLÇÜLÜR:
   * `routes/live2.cjs` içindeki `PREDICT_OPEN_AHEAD_HOURS` değişirse ve
   * burası değişmezse üst sınır yanlış olur — pencere KISALIRSA erken iade
   * riski doğar.
   */
  const src = fs.readFileSync(path.join(KOK, "routes", "live2.cjs"), "utf8");
  const m = src.match(/PREDICT_OPEN_AHEAD_HOURS\s*=\s*(\d+)/);
  assert.ok(m, "live2'de PREDICT_OPEN_AHEAD_HOURS bulunamadi");
  assert.equal(
    Number(m[1]), TAHMIN_PENCERE_SAAT,
    `tahmin penceresi ayrismis: live2=${m[1]}, bayat-temizleyici=${TAHMIN_PENCERE_SAAT}`
  );
});

test("NÖBETÇİ: zincirin üç kademesi de kodda", () => {
  const src = fs.readFileSync(path.join(KOK, "services", "bayat-temizleyici.cjs"), "utf8")
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");
  assert.ok(/collection\(COLL_FIXTURES\)/.test(src), "1. kademe (fixtures) yok");
  assert.ok(/collection\("match_results"\)/.test(src), "2. kademe (sonuc meta) yok");
  assert.ok(/\$max: "\$at"/.test(src), "3. kademe (son tahmin ust siniri) yok");
});
