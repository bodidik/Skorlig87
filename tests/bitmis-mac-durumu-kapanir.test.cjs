"use strict";

/**
 * BİTEN MAÇ FİKSTÜR DEPOSUNDA "LIVE" KALMAZ.
 *
 * ⚠️ BULUNAN: `mackolik-fixture-sync` bitmiş maçları tamamen eliyor — bu
 * BİLİNÇLİ, dosya başlığı da öyle diyor: "maç bitmiş (isFinished) — bunlar
 * zaten geçmiş, tahmin girilemez". Ama yan etkisi kapatılmamış: bir maç
 * canlıyken `LIVE` yazılıyor, bittiğinde artık hiç görülmediği için durumu
 * O HÂLDE KALIYOR.
 *
 * ÖLÇÜLDÜ (data/fixtures.json, 1458 kayıt): 431 maç `LIVE`, yalnızca 3'ü
 * `FT`. LIVE olanların 389'u başlama saatinden 3 saatten fazla geçmiş —
 * ortanca 16.6 saat, en fazla 64 saat. Önbellekte de 84 bitmiş maç var ve
 * hepsi eleniyordu.
 *
 * ⚠️ PARA ETKİSİ YOK — abartmıyorum. Önceki turda izini sürdüm: kilit zaten
 * NS dışını kapatıyor (oynanmış maça bahis girilemiyor), settle durumu
 * fikstürden değil canlı durum dosyasından okuyor, bağlı para 48 saatte iade
 * ediliyor. Bu bir DOĞRULUK düzeltmesi: fikstür deposu "bu maç bitti mi"
 * sorusuna güvenilir cevap verebilsin.
 *
 * ⚠️ SÜZGEÇ GEVŞETİLMEDİ. Bitmiş maçı normal akışa sokmak "bitmiş maç
 * yayınlama" kararını çiğner ve geçmiş maçları listeye eklerdi. Yalnızca
 * ZATEN VAR OLAN kayıt kapatılıyor.
 */

const os = require("os");
const nodePath = require("path");
const fs = require("fs");

const TMP = nodePath.join(os.tmpdir(), "skorlig-bitmis-durum-test");
process.env.SKORLIG_DATA_DIR = TMP;

const { test, describe, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const MK = require("../services/mackolik-fixture-sync.cjs");

const CACHE = nodePath.join(TMP, "livescore-cache.json");
const FIX = nodePath.join(TMP, "fixtures.json");

const gun = (offsetSaat) =>
  new Date(Date.now() + offsetSaat * 3600_000).toISOString().slice(0, 10);

/** Maçkolik cache satırı — biçim `"YYYY-MM-DD HH:MM"` (ISO DEĞİL). */
function satir({ home, away, tarih, saat = "20:00", bitti = false, canli = false }) {
  return {
    homeTeam: home, awayTeam: away,
    matchDate: `${tarih} ${saat}`,
    isFinished: bitti, isLive: canli,
  };
}

function cacheYaz(maclar) {
  fs.writeFileSync(CACHE, JSON.stringify({
    /* ⚠️ ÜLKE/LİG LİG NESNESİNDEN OKUNUYOR, MAÇTAN DEĞİL. readCache her maça
     * `country: lg.country, league: lg.name` yazıyor; maça koymak "ulke:(bos)"
     * elemesine takılıyor (ilk denememde tam olarak bu oldu). */
    leagues: { ekstraklasa: { country: "Polonya", name: "Ekstraklasa", matches: maclar } },
    updatedAt: new Date().toISOString(),
  }));
}

const fiksturler = () => {
  const raw = JSON.parse(fs.readFileSync(FIX, "utf8"));
  return raw.fixtures || raw.items || [];
};

beforeEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
});

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("kimlik şeması iki yolda da AYNI", () => {
    /**
     * ⚠️ Kapatma, kaydı fixtureId ile buluyor. Şemalar ayrışırsa kapatma
     * hiçbir kayda denk gelmez ve SESSİZCE hiçbir şey yapmaz — test yeşil,
     * hata yerinde kalır.
     */
    const m = { ...satir({ home: "Lech Poznan", away: "AGF", tarih: gun(26) }), country: "Polonya", league: "Ekstraklasa" };
    const normal = MK.normalize({ ...m, isFinished: false })?.fixtureId;
    const bitmis = MK._bitmisFixtureId({ ...m, isFinished: true });
    assert.ok(normal, "normal yol kimlik uretmedi — test kurulumu bozuk");
    assert.equal(bitmis, normal, "kimlik semalari ayrismis; kapatma hicbir kayda denk gelmez");
  });

  test("normal yol bitmiş maçı HÂLÂ eliyor (tasarım korundu)", () => {
    const m = { ...satir({ home: "Lech Poznan", away: "AGF", tarih: gun(26), bitti: true }), country: "Polonya", league: "Ekstraklasa" };
    assert.equal(MK.normalize(m), null, "bitmis mac normal akisa girmis — tasarim kararina aykiri");
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("durum kapanması", () => {
  test("canlıyken yazılan kayıt, maç bitince FT oluyor", async () => {
    /**
     * ⚠️ GERÇEKÇİ SIRA: bir maç canlıyken yazılır (kickoff ~şimdi), saatler
     * sonra biter. İlk denememde bitmiş maça GELECEK tarih vermiştim — öyle
     * bir maç yok ve `merge` gelecek tarihli kendi kaydını gelen listede
     * bulamayınca DÜŞÜRÜYOR, yani test yanlış şeyi ölçüyordu.
     */
    const t = gun(-5);                       // 5 saat önce başlamış
    fs.writeFileSync(FIX, JSON.stringify({
      fixtures: [{
        fixtureId: `MK-LECHPO-${t}-AGF`, home: "Lech Poznan", away: "AGF",
        kickoffISO: `${t}T20:00:00+03:00`, status: "LIVE", source: "MK",
        country: "Polonya", league: "Ekstraklasa",
      }],
    }));

    cacheYaz([satir({ home: "Lech Poznan", away: "AGF", tarih: t, bitti: true })]);
    const r = await MK.syncOnce();

    const son = fiksturler().find((f) => f.fixtureId === `MK-LECHPO-${t}-AGF`);
    assert.ok(son, "kayit kayboldu — kapatma kaydi silmemeli");
    assert.equal(
      son.status, "FT",
      "biten mac hala LIVE — depo 'bu mac bitti mi' sorusuna yanlis cevap verir"
    );
    assert.equal(r.kapatilan, 1, `kapatilan sayaci ${r.kapatilan}`);
  });

  test("bitmiş maç YENİ kayıt AÇMIYOR", async () => {
    // Depoda hiç olmayan bitmiş bir maç — eklenmemeli.
    cacheYaz([satir({ home: "Gornik Zabrze", away: "Fenerbahce", tarih: gun(-5), bitti: true })]);
    const r = await MK.syncOnce();
    const liste = fs.existsSync(FIX) ? fiksturler() : [];
    assert.ok(
      !liste.some((f) => String(f.fixtureId).includes("GORNIK")),
      "bitmis mac fikstur listesine EKLENMIS — 'bitmis mac yayinlama' karari cignendi"
    );
    assert.ok(!r.kapatilan, `var olmayan kayit icin kapatilan=${r.kapatilan}`);
  });

  test("başka kaynağın kaydına dokunulmuyor", async () => {
    const t = gun(-5);
    // FDO kaynaklı bir kayıt elle yerleştir.
    fs.writeFileSync(FIX, JSON.stringify({
      fixtures: [{
        fixtureId: "MK-LECHPO-" + t + "-AGF", home: "Lech Poznan", away: "AGF",
        kickoffISO: `${t}T20:00:00+03:00`, status: "LIVE", source: "FDO",
      }],
    }));
    cacheYaz([satir({ home: "Lech Poznan", away: "AGF", tarih: t, bitti: true })]);
    await MK.syncOnce();
    const f = fiksturler().find((x) => x.source === "FDO");
    assert.ok(f, "FDO kaydi kaybolmus");
    assert.equal(f.status, "LIVE", "baska kaynagin kaydi degistirilmis");
  });

  test("zaten FT olan kayıt tekrar sayılmıyor", async () => {
    const t = gun(-5);
    fs.writeFileSync(FIX, JSON.stringify({ fixtures: [{
      fixtureId: `MK-LECHPO-${t}-AGF`, home: "Lech Poznan", away: "AGF",
      kickoffISO: `${t}T20:00:00+03:00`, status: "LIVE", source: "MK",
    }] }));
    cacheYaz([satir({ home: "Lech Poznan", away: "AGF", tarih: t, bitti: true })]);
    const r1 = await MK.syncOnce();
    const r2 = await MK.syncOnce();
    assert.equal(r1.kapatilan, 1);
    assert.equal(r2.kapatilan, 0, "ayni kayit her turda yeniden kapatiliyor");
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: kapatma kimliği normal yolla aynı parçalardan üretiliyor", () => {
  const src = fs.readFileSync(nodePath.join(__dirname, "..", "services", "mackolik-fixture-sync.cjs"), "utf8")
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");
  // İki yerde de `MK-${slugPart(...)}-...-${slugPart(...)}` kalıbı olmalı.
  const adet = (src.match(/MK-\$\{slugPart\(/g) || []).length;
  assert.ok(adet >= 2, `kimlik uretimi ${adet} yerde — kapatma ayri bir sema kullaniyor olabilir`);
});
