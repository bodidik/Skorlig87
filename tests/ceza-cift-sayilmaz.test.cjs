"use strict";

/**
 * CEZA İKİ KEZ SAYILMAZ: `totalPoints` NET, `totalPenalty` yalnızca sayaç.
 *
 * ⚠️ BU TURDA KUSUR BULUNMADI. Şüphem somuttu: `lib/ranking.cjs` satır
 * şeklini `{ userId, total, played, penalties }` diye belgeliyor ama
 * `rankRows` `penalties` alanını HİÇ KULLANMIYOR. İki okuma mümkündü —
 * ya cezalar sıralamaya hiç yansımıyor (kusur), ya da `total` zaten net
 * (doğru davranış).
 *
 * ÖLÇTÜM, gerçek `scoreFixture` ile (2-0 biten maç, üç tahmin):
 *     doğru tahmin  → points  7.2   (outcome  7.2)
 *     yanlış tahmin → points -0.6   (outcome -0.6)
 *     yanlış + yan kalemleri de kaçıran → points -1.2, outcome -0.6
 * Yani ceza PUANIN İÇİNDE. `settle2` bunu `totalPoints` alanına `$inc`
 * ediyor; `totalPenalty` ise AYRI bir bilgi sayacı.
 *
 * ⚠️ SONUÇ: `rankRows`'un `penalties`'i yok sayması DOĞRU. Birinin "cezalar
 * sıralamaya yansımıyor" diye düzeltmesi cezayı İKİ KEZ uygulardı — bu test
 * tam olarak o iyi niyetli değişikliği yakalamak için var.
 *
 * ⚠️ VESTİJYAL ALAN: `detail.zeroPenalty` her zaman 0 yazılıyor (settle2
 * satır ~1100) ama sezon toplamındaki `ceza` hesabına dahil ediliyor.
 * Katkısı sıfır olduğu için zararsız; kaldırmadım, çünkü ölçülebilir bir
 * etkisi yok ve alan adı geçmiş kayıtlarda duruyor olabilir.
 */

const os = require("os");
const path = require("path");
const fs = require("fs");

const TMP = path.join(os.tmpdir(), "skorlig-ceza-cift-test");
process.env.SKORLIG_DATA_DIR = TMP;
process.env.SKORLIG_BG = "0";

const { test, describe, before } = require("node:test");
const assert = require("node:assert/strict");

const KOK = path.join(__dirname, "..");
const FID = "fx-ceza-1";

let sonuc = null;

before(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(path.join(TMP, "live"), { recursive: true });

  // settle2 skoru CANLI DURUM dosyasindan okuyor.
  fs.writeFileSync(path.join(TMP, "live", FID + ".json"), JSON.stringify({
    fixtureId: FID, status: "FT", score: { home: 2, away: 0 },
    firstGoal: "H", redHome: false, redAway: false,
    penaltyAny: false, penaltySide: null, htScore: { home: 1, away: 0 },
  }));
  fs.writeFileSync(path.join(TMP, "preds.json"), JSON.stringify([
    { userId: "dogru", fixtureId: FID, outcome: "H", at: new Date().toISOString() },
    { userId: "yanlis", fixtureId: FID, outcome: "A", at: new Date().toISOString() },
    { userId: "cezali", fixtureId: FID, outcome: "A", redAny: true, redSide: "A",
      penaltyAny: true, penaltySide: "H", at: new Date().toISOString() },
  ]));

  const S = require("../routes/settle2.cjs");
  sonuc = await S.scoreFixture(FID, { updateTotals: false });
});

const satir = (uid) => (sonuc.leaderboard || sonuc.rows || []).find((r) => r.userId === uid);

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("üç tahmin de puanlandı", () => {
    assert.equal((sonuc.leaderboard || sonuc.rows || []).length, 3, "puanlama calismadi — test bir sey olcmuyor");
  });

  test("doğru tahmin POZİTİF puan alıyor", () => {
    assert.ok(satir("dogru").points > 0, "dogru tahmin puan almiyor — senaryo cokmus");
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("ceza puanın içinde", () => {
  test("yanlış tahminin puanı NEGATİF", () => {
    assert.ok(
      satir("yanlis").points < 0,
      "yanlis tahmin ceza almiyor — ceza puana islenmemis, sıralama cezayi hic gormez"
    );
  });

  test("daha çok kalem kaçıran daha ÇOK ceza alıyor", () => {
    assert.ok(
      satir("cezali").points < satir("yanlis").points,
      `cezali ${satir("cezali").points} >= yanlis ${satir("yanlis").points} — ek cezalar puana islenmemis`
    );
  });

  test("puan, yalnız sonuç kaleminden DAHA DÜŞÜK (ek cezalar dahil)", () => {
    const c = satir("cezali");
    assert.ok(
      c.points <= Number(c.detail?.outcome || 0),
      "ek ceza kalemleri puana eklenmemis"
    );
  });
});

describe("sıralama cezayı tekrar düşmüyor", () => {
  const { rankRows } = require("../lib/ranking.cjs");

  test("aynı NET puan, farklı penalties → AYNI rating", () => {
    /**
     * ⚠️ BU TESTİN ASIL İŞİ. `total` zaten net olduğu için `penalties`
     * sıralamayı etkilememeli. Biri "cezalar yansımıyor" diye `rankRows`'a
     * çıkarma eklerse ceza İKİ KEZ uygulanır ve bu test kırılır.
     */
    const [a, b] = rankRows([
      { userId: "cezasiz", total: 100, played: 20, penalties: 0 },
      { userId: "cezali", total: 100, played: 20, penalties: 40 },
    ]);
    assert.equal(
      a.rating, b.rating,
      "penalties sıralamayi degistirdi — ceza iki kez uygulaniyor (total zaten net)"
    );
  });

  test("net puanı düşük olan gerçekten geride", () => {
    // Cezanın etkisi `total` üzerinden gelmeli, ayrı alandan değil.
    const s = rankRows([
      { userId: "iyi", total: 200, played: 20, penalties: 0 },
      { userId: "kotu", total: 60, played: 20, penalties: 0 },
    ]);
    assert.equal(s[0].userId, "iyi");
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

const kaynak = (rel) =>
  fs.readFileSync(path.join(KOK, rel), "utf8")
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");

test("NÖBETÇİ: sezon toplamına yazılan puan HAM satır puanı", () => {
  /**
   * `totalPoints` net puanı taşımalı. Buraya bir çıkarma eklenirse ceza iki
   * kez uygulanmış olur.
   */
  const src = kaynak("routes/settle2.cjs");
  assert.ok(
    /totalPoints:\s*Number\(r\.points \|\| 0\)/.test(src),
    "sezon toplamina yazilan deger degismis — ceza cift sayilıyor olabilir"
  );
});

test("NÖBETÇİ: ceza kalemleri puana EKLENİYOR", () => {
  const src = kaynak("routes/settle2.cjs");
  assert.ok(/pts \+= redAnyPts \+ redSidePts \+ redSidePenalty;/.test(src), "kirmizi kart cezasi puana eklenmiyor");
  assert.ok(/pts \+= penaltyAnyPts \+ penaltySidePts \+ penaltySidePenalty;/.test(src), "penalti cezasi puana eklenmiyor");
});
