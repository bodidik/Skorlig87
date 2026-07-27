"use strict";

/**
 * settle2 — puanlama kuralları.
 *
 * Bu modül puan ve LC dağıtır; sessiz bir regresyon doğrudan kullanıcıların
 * bakiyesine yansır. Testler izole bir veri dizininde çalışır (SKORLIG_DATA_DIR),
 * gerçek data/ klasörüne dokunulmaz.
 *
 * Çalıştırma:  npm test
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const S = require("./helpers/sandbox.cjs");

// Dosya başına TEK kumbara ve TEK modül örneği (bkz. helpers/sandbox.cjs).
// Testler benzersiz fixtureId ile ayrışır.
const { dir, settle2 } = S.setupFile();

/** Tek maç kurup puanlar, kullanıcı→satır haritası döner. */
async function scoreOnce(fixtureId, score, preds, opts = {}) {
  await S.seedFixture(dir, fixtureId, score, preds, opts);
  const res = await settle2.scoreFixture(fixtureId, { updateTotals: true, db: null });
  const byUser = {};
  for (const r of res.leaderboard || []) byUser[r.userId] = r;
  return { res, byUser };
}

describe("settle2 — maç sonucu (1X2)", () => {
  test("doğru sonuç pozitif, yanlış sonuç negatif puan getirir", async () => {
    const { byUser } = await scoreOnce("SC-1", { h: 2, a: 1 }, [
      { userId: "dogru", outcome: "H" },
      { userId: "yanlis", outcome: "A" },
    ]);

    assert.ok(byUser.dogru.detail.outcome > 0, "doğru tahmin pozitif olmalı");
    assert.ok(byUser.yanlis.detail.outcome < 0, "yanlış tahmin negatif olmalı");
  });

  test("beraberlik doğru bilinirse ödüllendirilir", async () => {
    const { res, byUser } = await scoreOnce("SC-2", { h: 1, a: 1 }, [
      { userId: "u", outcome: "D" },
    ]);
    assert.equal(res.outcome, "D");
    assert.ok(byUser.u.detail.outcome > 0);
  });

  test("CEZA odds'a BÖLÜNÜR: favoriyi kaçırmak underdog'u kaçırmaktan pahalıdır", async () => {
    // Tasarım ilkesi (settle2 içinde belgeli): ceza odds ile çarpılsaydı riskli
    // seçim iki kez cezalandırılır ve cesur tahmin ölürdü. Bölme bunu tersine
    // çevirir. Bu testi kıran bir değişiklik oyun dengesini bozar.
    const { byUser } = await scoreOnce(
      "SC-3",
      { h: 0, a: 1 }, // deplasman kazandı: ev sahibi tahmini de beraberlik de yanlış
      [
        { userId: "favori", outcome: "H" }, // güçlü ev sahibi = düşük odds
        { userId: "underdog", outcome: "D" }, // beraberlik = yüksek odds
      ],
      { homeTeam: "Manchester City", awayTeam: "Luton Town" }
    );

    const favoriCeza = Math.abs(byUser.favori.detail.outcome);
    const underdogCeza = Math.abs(byUser.underdog.detail.outcome);

    assert.ok(byUser.favori.detail.outcome < 0 && byUser.underdog.detail.outcome < 0);
    assert.ok(
      favoriCeza > underdogCeza,
      `favori cezası (${favoriCeza}) underdog cezasından (${underdogCeza}) büyük olmalı`
    );
  });

  test("düşük olasılıklı doğru sonuç daha çok kazandırır", async () => {
    const { byUser } = await scoreOnce(
      "SC-4",
      { h: 0, a: 2 }, // zayıf takım deplasmanda kazandı
      [{ userId: "cesur", outcome: "A" }],
      { homeTeam: "Manchester City", awayTeam: "Luton Town" }
    );
    // Baz 3 puan; yüksek odds çarpanı bunu belirgin şekilde artırmalı.
    assert.ok(
      byUser.cesur.detail.outcome > 3,
      `beklenen >3, gelen ${byUser.cesur.detail.outcome}`
    );
    assert.ok(byUser.cesur.detail.outcomeMultiplier > 1);
  });
});

describe("settle2 — skor tahmini", () => {
  test("tam skor büyük bonus, yanlış skor sabit küçük ceza", async () => {
    const { byUser } = await scoreOnce("SC-5", { h: 2, a: 1 }, [
      { userId: "tam", outcome: "H", home: 2, away: 1 },
      { userId: "yanlis", outcome: "H", home: 3, away: 0 },
    ]);

    // Mutlak değer sabit DEĞİL: 12 baz puan kalabalık çarpanıyla ölçeklenir
    // (aşağıdaki "kalabalık" testine bak). Değişmez olan, tam skorun belirgin
    // bir ödül, yanlış skorun sabit -0.1 olmasıdır.
    assert.ok(byUser.tam.detail.exact > 5, `beklenen >5, gelen ${byUser.tam.detail.exact}`);
    assert.equal(byUser.yanlis.detail.exact, -0.1, "yanlış skor sabit -0.1");
    assert.ok(byUser.tam.detail.exact > byUser.yanlis.detail.exact);
  });

  test("KALABALIK KURALI: aynı skoru ne kadar çok kişi derse ödül o kadar düşer", async () => {
    // Oyunun temel vaadi ("az kişinin tuttuğunu bilirsen daha fazla puan").
    // Bu testi kıran bir değişiklik oyun dengesini sessizce bozar.
    const tek = await scoreOnce("SC-5a", { h: 2, a: 1 }, [
      { userId: "a", outcome: "H", home: 2, away: 1 },
    ]);
    const kalabalik = await scoreOnce("SC-5b", { h: 2, a: 1 }, [
      { userId: "a", outcome: "H", home: 2, away: 1 },
      { userId: "b", outcome: "H", home: 2, away: 1 },
      { userId: "c", outcome: "H", home: 2, away: 1 },
    ]);

    assert.ok(
      tek.byUser.a.detail.exact > kalabalik.byUser.a.detail.exact,
      `tek kişi (${tek.byUser.a.detail.exact}) kalabalıktan (${kalabalik.byUser.a.detail.exact}) fazla almalı`
    );
  });

  test("skor girilmezse exact kalemi hiç oluşmaz", async () => {
    const { byUser } = await scoreOnce("SC-6", { h: 2, a: 1 }, [
      { userId: "sadece_sonuc", outcome: "H" },
    ]);
    assert.equal(byUser.sadece_sonuc.detail.exact, undefined);
  });
});

describe("settle2 — yan kalemler", () => {
  test("ilk gol ve ilk yarı doğru bilinince puan ekler", async () => {
    const { byUser } = await scoreOnce(
      "SC-7",
      { h: 2, a: 1 },
      [{ userId: "u", outcome: "H", firstGoal: "H", firstHalf: "H" }],
      { firstGoal: "H", ht: { h: 1, a: 0 } }
    );
    assert.ok(byUser.u.detail.firstGoal > 0);
    assert.ok(byUser.u.detail.firstHalf > 0);
  });

  test("ilk gol ve ilk yarı yanlışsa ceza yazar", async () => {
    const { byUser } = await scoreOnce(
      "SC-8",
      { h: 2, a: 1 },
      [{ userId: "u", outcome: "H", firstGoal: "A", firstHalf: "A" }],
      { firstGoal: "H", ht: { h: 1, a: 0 } }
    );
    assert.ok(byUser.u.detail.firstGoal < 0);
    assert.ok(byUser.u.detail.firstHalf < 0);
  });

  test("kırmızı kart: var/yok bilgisi ve tarafı ayrı puanlanır", async () => {
    const { byUser } = await scoreOnce(
      "SC-9",
      { h: 1, a: 0 },
      [
        { userId: "tam_bilen", outcome: "H", redAny: true, redSide: "A" },
        { userId: "taraf_yanlis", outcome: "H", redAny: true, redSide: "H" },
        { userId: "yok_dedi", outcome: "H", redAny: false },
      ],
      { redAway: true }
    );

    assert.ok(byUser.tam_bilen.detail.redAny > 0 && byUser.tam_bilen.detail.redSide > 0);
    // Var demek doğru (puan alır) ama taraf yanlış (ayrı ceza)
    assert.ok(byUser.taraf_yanlis.detail.redAny > 0);
    assert.ok(byUser.taraf_yanlis.detail.redSidePenalty < 0);
    assert.ok(byUser.yok_dedi.detail.redAny < 0, "kırmızı varken 'yok' demek ceza");
  });

  test("penaltı: var/yok ve taraf ayrı puanlanır", async () => {
    const { byUser } = await scoreOnce(
      "SC-10",
      { h: 1, a: 0 },
      [
        { userId: "tam_bilen", outcome: "H", penaltyAny: true, penaltySide: "H" },
        { userId: "yok_dedi", outcome: "H", penaltyAny: false },
      ],
      { penaltyAny: true, penaltySide: "H" }
    );
    assert.ok(byUser.tam_bilen.detail.penaltyAny > 0 && byUser.tam_bilen.detail.penaltySide > 0);
    assert.ok(byUser.yok_dedi.detail.penaltyAny < 0);
  });
});

describe("settle2 — base (LC ödül tabanı)", () => {
  test("base yalnızca POZİTİF kalemlerden oluşur, cezalar düşülmez", async () => {
    // Kritik: base LC ödülünü belirler. Cezalar buraya karışırsa doğru
    // tahminler yüzünden hak edilen LC, başka kalemdeki ceza yüzünden erir.
    const { byUser } = await scoreOnce(
      "SC-11",
      { h: 2, a: 1 },
      [{ userId: "karisik", outcome: "H", home: 0, away: 5, firstGoal: "A" }],
      { firstGoal: "H" }
    );

    const d = byUser.karisik.detail;
    assert.ok(d.exact < 0, "skor yanlış (ceza)");
    assert.ok(d.firstGoal < 0, "ilk gol yanlış (ceza)");
    assert.equal(
      Math.round(d.base * 10) / 10,
      Math.round(Math.max(0, d.outcome) * 10) / 10,
      "base yalnızca pozitif outcome'dan gelmeli"
    );
    assert.ok(d.base >= 0, "base negatif olamaz");
  });

  test("hiçbir şey bilmeyen kullanıcının base'i 0'dır", async () => {
    const { byUser } = await scoreOnce("SC-12", { h: 2, a: 1 }, [
      { userId: "bos", outcome: "A", home: 0, away: 4 },
    ]);
    assert.equal(byUser.bos.detail.base, 0);
    assert.ok(byUser.bos.points < 0, "toplam puan negatif olmalı");
  });
});

describe("settle2 — mükerrer tahmin koruması", () => {
  test("aynı kullanıcının iki kaydı varsa yalnızca EN SON'u puanlanır", async () => {
    // Aksi halde kullanıcı tek settle'da iki kez puan alır.
    const eski = new Date(Date.now() - 3600_000).toISOString();
    const yeni = new Date().toISOString();

    const { res, byUser } = await scoreOnce("SC-13", { h: 2, a: 1 }, [
      { userId: "cift", outcome: "A", at: eski },
      { userId: "cift", outcome: "H", at: yeni },
    ]);

    assert.equal(res.leaderboard.length, 1, "tek satır olmalı");
    assert.ok(byUser.cift.detail.outcome > 0, "en son (doğru) tahmin geçerli olmalı");
  });
});
