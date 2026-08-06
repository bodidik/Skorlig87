"use strict";

/**
 * DÜELLO ENGEL KONTROLÜ VE SETTLE MÜHÜR FİLTRESİ.
 *
 * ⚠️ BULUNAN (2026-08-06):
 *
 * 1) `/duels/accept` engel kontrolü YAPMIYORDU. create ucunda engelliMi
 *    çağrılıyor (satır 681) ama accept ucunda yok. Engellenen kullanıcı
 *    açık bir düelloyu kabul edebiliyordu — create kapısını atlayarak.
 *
 * 2) `claimDuelSettle` Mongo filtresi `{ $ne: "settled" }` idi — "open",
 *    "cancelled", "voided" durumundaki düelloyu da eşleştiriyordu. Doğru
 *    filtre `"active"`: yalnızca kabul edilmiş, devam eden düello settle
 *    edilebilmeli.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");

/* ── Nöbetçi: accept ucunda engelliMi kontrolü var ──────────────────── */

test("nobetci: accept handler engelliMi kontrolu yapiyor", () => {
  const src = fs.readFileSync(path.join(KOK, "routes", "duels.cjs"), "utf8");

  const acceptBasla = src.indexOf('"/duels/accept"');
  assert.ok(acceptBasla > 0, "accept ucu bulunamadi");
  const sonrakiRoute = src.indexOf("router.", acceptBasla + 20);
  const acceptGovde = src.slice(acceptBasla, sonrakiRoute > 0 ? sonrakiRoute : undefined);

  assert.ok(
    /engelliMi\s*\(/.test(acceptGovde),
    "accept handler engel kontrolu YAPMIYOR — engellenen kullanici acik duelloyu kabul edebilir"
  );
});

/* ── Nöbetçi: create ucunda da engelliMi kontrolü duruyor ─────────── */

test("nobetci: create handler engelliMi kontrolu yapiyor", () => {
  const src = fs.readFileSync(path.join(KOK, "routes", "duels.cjs"), "utf8");

  const createBasla = src.indexOf('"/duels/create"');
  assert.ok(createBasla > 0, "create ucu bulunamadi");
  const sonraki = src.indexOf("router.", createBasla + 20);
  const createGovde = src.slice(createBasla, sonraki > 0 ? sonraki : undefined);

  assert.ok(
    /engelliMi\s*\(/.test(createGovde),
    "create handler engel kontrolu kaldirilmis"
  );
});

/* ── Nöbetçi: claimDuelSettle filtresi yalnız active durumunu kabul eder */

test("nobetci: claimDuelSettle Mongo filtresi yalniz active durumunu kabul eder", () => {
  const src = fs.readFileSync(path.join(KOK, "lib", "social-store.cjs"), "utf8");

  const fnBasla = src.indexOf("async function claimDuelSettle");
  assert.ok(fnBasla > 0, "claimDuelSettle bulunamadi");
  const fnSon = src.indexOf("\nasync function ", fnBasla + 10);
  const fnGovde = src.slice(fnBasla, fnSon > 0 ? fnSon : fnBasla + 1500);

  assert.ok(
    /status:\s*"active"/.test(fnGovde),
    'claimDuelSettle filtresi "active" degil — cancelled/voided duello settle edilebilir'
  );
  assert.ok(
    !/\$ne.*settled/.test(fnGovde),
    'claimDuelSettle hala $ne:"settled" kullaniyor — cok genis filtre'
  );
});

/* ── Nöbetçi: dosya fallback yolu da active kontrol ediyor ──────────── */

test("nobetci: claimDuelSettle dosya yolu active kontrol ediyor", () => {
  const src = fs.readFileSync(path.join(KOK, "lib", "social-store.cjs"), "utf8");

  const fnBasla = src.indexOf("async function claimDuelSettle");
  const fnSon = src.indexOf("\nasync function ", fnBasla + 10);
  const fnGovde = src.slice(fnBasla, fnSon > 0 ? fnSon : fnBasla + 1500);

  assert.ok(
    /status\s*!==\s*"active"/.test(fnGovde),
    "dosya yolu fallback active kontrolu eksik — cancelled duello settle edilebilir"
  );
});
