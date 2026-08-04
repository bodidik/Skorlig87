"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");

describe("hesap silme kapsami", () => {
  test("silme yolu bilinen tum kullanici koleksiyonlarini kapsiyor", () => {
    const src = fs.readFileSync(path.join(KOK, "routes", "users.cjs"), "utf8");
    const silmeBolge = src.slice(src.indexOf("delete-account"));

    const BEKLENEN = [
      "pool_bets", "season_totals", "streaks",
      "lc_wallet_users", "lc_wallet_ledger", "predictions",
      "duels", "tournaments", "mini_tournaments",
      "push_tokens", "kupon_katilim", "competition_totals",
      "match_results", "leaderboard", "users",
    ];

    const eksik = BEKLENEN.filter((k) => !silmeBolge.includes(k));
    assert.deepEqual(eksik, [],
      "silme yolunda eksik koleksiyon(lar): " + eksik.join(", "));
  });

  test("silme yolu friends verisini de temizliyor", () => {
    const src = fs.readFileSync(path.join(KOK, "routes", "users.cjs"), "utf8");
    const silmeBolge = src.slice(src.indexOf("delete-account"));
    assert.ok(/friends\.links/.test(silmeBolge),
      "silme yolunda friends.links temizligi yok");
    assert.ok(/friends\.requests/.test(silmeBolge),
      "silme yolunda friends.requests temizligi yok");
    assert.ok(/friends\.blocks/.test(silmeBolge),
      "silme yolunda friends.blocks temizligi yok");
  });

  test("silme yolu Firebase Auth'u da siliyor", () => {
    const src = fs.readFileSync(path.join(KOK, "routes", "users.cjs"), "utf8");
    const silmeBolge = src.slice(src.indexOf("delete-account"));
    assert.ok(/deleteUser|getAuth/.test(silmeBolge),
      "silme yolunda Firebase Auth silme yok");
  });

  test("silme yolu auth gerektiriyor", () => {
    const src = fs.readFileSync(path.join(KOK, "routes", "users.cjs"), "utf8");
    const routerIdx = src.indexOf('router.delete("/delete-account"');
    assert.ok(routerIdx > 0, "router.delete delete-account bulunamadi");
    const satir = src.slice(routerIdx, routerIdx + 80);
    assert.ok(/verifyToken/.test(satir),
      "delete-account ucunda verifyToken middleware yok");
  });
});
