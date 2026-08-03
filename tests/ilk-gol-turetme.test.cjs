"use strict";

/**
 * İLK GOL SKORDAN TÜRETİLİR — bahis yeniden kazanılabilir.
 *
 * ⚠️ ARKA PLAN (2026-08-03): `firstGoal`ü yalnızca af-sync (askıdaki kaynak)
 * yazıyordu; ölçüldü: 14518 tahminin TAMAMI ceza, 0 ödül. Seçeneği ekrandan
 * kaldırmak yerine veri yaşayan kaynaktan türetildi (lib/ilk-gol.cjs):
 *
 *   1) KESİN ÇIKARIM: tek taraf gol atmışsa ilk gol onundur (2-0 → H).
 *      Uzlaşmış maçların %39.5'i böyle; FT'den sonra bile çalışır.
 *   2) CANLI DAMGA: livescore-sync ~30 sn'de bir skoru görür; kural (1)
 *      herhangi bir turda tuttuğunda durum dosyasına damgalanır ve skor
 *      sonra 3-1 olsa da korunur.
 *
 * UÇTAN UCA DOĞRULANDI (gerçek scoreFixture, üretim maçları, yazma yok):
 *     4 tek-taraflı maç → 45 ÖDÜL, 35 ceza (önce: 0 ödül / hepsi ceza).
 *     2-2'ye düzeltilmiş maçta null kaldı — iki taraf da attıysa türetim
 *     TAHMİN ETMEZ, kalem puanlanmaz. Yanlış türetim hiç türetmemekten kötü.
 */

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const KOK = path.join(__dirname, "..");

// ⚠️ settle2 DATA_DIR'i modül yükünde okur — require'dan ÖNCE ayarla.
const VERI_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "skorlig-ilkgol-"));
process.env.SKORLIG_DATA_DIR = VERI_DIR;

const { ilkGolTuret } = require(path.join(KOK, "lib", "ilk-gol.cjs"));

function kodSatirlari(rel) {
  return fs.readFileSync(path.join(KOK, rel), "utf8")
    .split(/\r?\n/)
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");
}

describe("ilk gol türetme — saf kural", () => {
  test("tek taraf gol atmışsa KESİN: 2-0→H, 0-1→A", () => {
    assert.equal(ilkGolTuret(2, 0), "H");
    assert.equal(ilkGolTuret(1, 0), "H");
    assert.equal(ilkGolTuret(0, 1), "A");
    assert.equal(ilkGolTuret(0, 5), "A");
  });

  test("bilinemeyen durumlarda TAHMİN YOK: null", () => {
    /* ⚠️ Yanlış türetim hiç türetmemekten kötü: oyuncuya haksız ceza/ödül
     * yazar. 1-1'de kimin önce attığı skordan ÇIKARILAMAZ. */
    assert.equal(ilkGolTuret(0, 0), null, "golsuz macta ilk gol yok");
    assert.equal(ilkGolTuret(1, 1), null, "iki taraf da attiysa bilinemez");
    assert.equal(ilkGolTuret(3, 2), null);
    assert.equal(ilkGolTuret(NaN, 1), null, "bozuk veri tahmine donusmemeli");
    assert.equal(ilkGolTuret("x", 1), null);
  });
});

describe("ilk gol türetme — gerçek puanlama (scoreFixture)", () => {
  let scoreFixture = null;

  before(async () => {
    fs.mkdirSync(path.join(VERI_DIR, "live"), { recursive: true });

    const tahmin = (fid, uid, firstGoal, outcome = "H") => ({
      fixtureId: fid, userId: uid, outcome, firstGoal,
      at: "2026-07-29T18:00:00.000Z",
    });
    fs.writeFileSync(path.join(VERI_DIR, "preds.json"), JSON.stringify([
      // FGTEST-1: 2-0 biter → türetim H
      tahmin("FGTEST-1", "dogru1", "H"),
      tahmin("FGTEST-1", "yanlis1", "A"),
      // FGTEST-2: 2-1 biter ama canlı damga A (deplasman önce atmıştı)
      tahmin("FGTEST-2", "dogru2", "A"),
      tahmin("FGTEST-2", "yanlis2", "H"),
      // FGTEST-3: 1-1, damga yok → kalem hiç puanlanmamalı
      tahmin("FGTEST-3", "kimse3", "H"),
    ]));

    const durum = (fid, ek) => fs.writeFileSync(
      path.join(VERI_DIR, "live", `${fid}.json`),
      JSON.stringify({ fixtureId: fid, status: "FT", isLive: false, ...ek })
    );
    durum("FGTEST-1", { score: { home: 2, away: 0 } });
    // ⚠️ Damga türetimden ÖNCELİKLİ: skor 2-1'den H çıkarılamaz zaten, ama
    // damga 3-1 gibi "türetilebilir görünen" skorlarda da kazanmalı.
    durum("FGTEST-2", { score: { home: 2, away: 1 }, firstGoal: "A", firstGoalSource: "score-derived" });
    durum("FGTEST-3", { score: { home: 1, away: 1 } });

    ({ scoreFixture } = require(path.join(KOK, "routes", "settle2.cjs")));
  });

  after(() => {
    try { fs.rmSync(VERI_DIR, { recursive: true, force: true }); } catch { /* geçici */ }
  });

  const kalem = (r, uid) =>
    (r.leaderboard || []).find((x) => x.userId === uid)?.detail?.firstGoal;

  test("kurulum sınandı: puanlama GERÇEKTEN çalışıyor", async () => {
    /* ⚠️ Bu olmadan iddialar boş: tahminler hiç okunmuyorsa "ödül verildi"
     * de "kalem yok" da ölçülmez. updateTotals=false → hiçbir şeye yazılmaz. */
    const r = await scoreFixture("FGTEST-1", { updateTotals: false, db: null });
    assert.equal(r.leaderboard.length, 2, "tahminler okunamadi — senaryo bos");
  });

  test("tek taraflı skor: türetim ödül ve cezayı İKİ YÖNDE de veriyor", async () => {
    const r = await scoreFixture("FGTEST-1", { updateTotals: false, db: null });
    assert.equal(r.firstGoal, "H", "2-0 icin ilk gol H turetilmeli");
    assert.ok(kalem(r, "dogru1") > 0, "dogru tahmin ODUL almali — bahis kazanilabilir olmali");
    assert.ok(kalem(r, "yanlis1") < 0, "yanlis tahmin ceza almali (bahis gercek kalmali)");
  });

  test("canlı damga türetimden ÖNCELİKLİ (skor sonradan değişse de korunur)", async () => {
    const r = await scoreFixture("FGTEST-2", { updateTotals: false, db: null });
    assert.equal(r.firstGoal, "A", "damga varken skordan turetilmemeli");
    assert.ok(kalem(r, "dogru2") > 0, "damgaya gore dogru bilen odul almali");
  });

  test("iki taraf da attıysa ve damga yoksa kalem HİÇ puanlanmaz", async () => {
    /* ⚠️ ESKİ KUSURUN TAM NOKTASI: bilinmezlik ceza olarak puanlanıyordu.
     * Türetim eklerken bu kapı korunmalı — 1-1'de tahmin yürütmek, kusuru
     * "yanlış veriyle puanlama" olarak geri getirir. */
    const r = await scoreFixture("FGTEST-3", { updateTotals: false, db: null });
    assert.equal(r.firstGoal, null, "1-1'den ilk gol TURETILMEMELI");
    assert.equal(kalem(r, "kimse3"), undefined, "veri yokken kalem yazilmamali");
  });
});

describe("ilk gol türetme — bağlantı nöbetçileri", () => {
  test("settle2 son çare türetimi kullanıyor", () => {
    const s = kodSatirlari(path.join("routes", "settle2.cjs"));
    assert.ok(/st\.firstGoal \|\| ilkGolTuret\(h, a\)/.test(s),
      "settle2 FT skorundan turetmiyor — sunucu canli ani kacirirsa bahis yine olur");
  });

  test("livescore-sync canlı damgayı YALNIZCA boşken yazıyor", () => {
    /**
     * ⚠️ İKİ İNCELİK: (1) `!st.firstGoal` koşulu olmadan her tur yeniden
     * yazılır ve af-sync'in OLAYDAN yazdığı doğru değer skor türetimiyle
     * ezilebilir. (2) Damga `...prev` ile taşındığı için skor 3-1 olsa da
     * ilk gözlemdeki bilgi korunur — koşul kalkarsa o da bozulur.
     */
    const s = kodSatirlari(path.join("services", "livescore-sync.cjs"));
    assert.ok(/if \(!st\.firstGoal\)/.test(s), "boşken-yaz korumasi yok");
    assert.ok(/ilkGolTuret\(scores\.home, scores\.away\)/.test(s),
      "sync skordan turetmiyor — canli damga hic olusmaz");
    assert.ok(/firstGoalSource/.test(s), "turetilen deger kaynak isareti tasimali");
  });
});
