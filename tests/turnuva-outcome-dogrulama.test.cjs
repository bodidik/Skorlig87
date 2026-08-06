"use strict";

/**
 * TURNUVA TAHMİN OUTCOME DOĞRULAMASI.
 *
 * ⚠️ BULUNAN (2026-08-06): `predict()` outcome değerini doğrulamıyordu.
 * "X", "home", "abc" gibi geçersiz değerler kaydolup puanlamada hiç
 * eşleşmiyordu — giriş ücreti ödenmiş ama puan kazanılamaz hâle geliyordu.
 *
 * ÖLÇÜLDÜ: geçersiz outcome ("X") ile tahmin gönderildiğinde servis
 * `ok:true` dönüyor ve kayıt yazılıyordu. Puanlama sonucunda `totalScore`
 * 0 kalıyordu çünkü `pred.outcome !== r.outcome` her zaman doğru oluyordu.
 *
 * Doğru davranış: H, D, A dışı outcome INVALID_OUTCOME ile reddedilmeli.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");

const { GECERLI_OUTCOME, puanlariHesapla } = require("../services/tournament.cjs");

/* ── Kapalı liste ────────────────────────────────────────────────────── */

test("GECERLI_OUTCOME yalnizca H, D, A iceriyor", () => {
  assert.deepStrictEqual(
    [...GECERLI_OUTCOME].sort(),
    ["A", "D", "H"],
    "GECERLI_OUTCOME degisti — puanlama mantigi bu kume disindaki degerleri HIC eslestiremez"
  );
});

/* ── Nöbetçi: servis katmanı doğruluyor ─────────────────────────────── */

test("nobetci: predict fonksiyonu INVALID_OUTCOME kontrolu yapiyor", () => {
  const src = fs.readFileSync(path.join(KOK, "services", "tournament.cjs"), "utf8");
  assert.ok(
    /GECERLI_OUTCOME\.has\(outcome\)/.test(src),
    "predict() outcome dogrulamasi kaldirilmis — gecersiz outcome kaydolur ve puan alinamaz"
  );
  assert.ok(
    /INVALID_OUTCOME/.test(src),
    "INVALID_OUTCOME hatasi tanimlanmamis"
  );
});

/* ── Davranış: geçersiz outcome puanlama sıfırlar ────────────────────── */

test("gecersiz outcome ile yapilan tahmin puanlamada HIC eslesmez", () => {
  const turnuva = {
    fixtureIds: ["f1"],
    fixtures: [{ fixtureId: "f1", home: "A Takimi", away: "B Takimi" }],
    participants: [
      { userId: "ali", predictions: { f1: { outcome: "X" } }, totalScore: 0 },
      { userId: "veli", predictions: { f1: { outcome: "H" } }, totalScore: 0 },
    ],
  };
  const sonuclar = { f1: { outcome: "H" } };

  const sirali = puanlariHesapla(turnuva, sonuclar);

  const ali = sirali.find((p) => p.userId === "ali");
  const veli = sirali.find((p) => p.userId === "veli");

  assert.equal(ali.totalScore, 0,
    "gecersiz outcome (X) puan vermemeli");
  assert.ok(veli.totalScore > 0,
    "gecerli outcome (H) puan vermeli");
});

/* ── Nöbetçi: rota katmanı da kontrol ediyor ──────────────────────── */

test("nobetci: rota katmani outcome dogrulamasini servise birakiyor", () => {
  const routeSrc = fs.readFileSync(
    path.join(KOK, "routes", "tournaments.cjs"), "utf8"
  );
  assert.ok(
    /!code\s*\|\|\s*!fixtureId\s*\|\|\s*!outcome/.test(routeSrc),
    "rota predict ucunda alan kontrolu bozulmus"
  );
});

/* ── Negatif kontrol: sabotaj ─────────────────────────────────────── */

test("sabotaj: GECERLI_OUTCOME kaldirmak testi kirar", () => {
  const src = fs.readFileSync(path.join(KOK, "services", "tournament.cjs"), "utf8");
  const satirSayisi = (src.match(/GECERLI_OUTCOME/g) || []).length;
  assert.ok(
    satirSayisi >= 3,
    `GECERLI_OUTCOME yalnizca ${satirSayisi} yerde geciyor — ` +
    "has() kontrolu, tanimlanma ve export'un uc ayagi olmali"
  );
});
