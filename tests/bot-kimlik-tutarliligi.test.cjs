"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
const { BOT_PROFILE_MAP, BOT_ID_SET } = require(path.join(KOK, "lib", "botIds.cjs"));

describe("bot kimlik tutarliligi", () => {
  test("BOT_ID_SET aktif botlarin TAMAMINI kapsar", () => {
    for (const [id] of BOT_PROFILE_MAP) {
      assert.ok(BOT_ID_SET.has(id),
        `aktif bot ${id} BOT_ID_SET icinde yok — emekli/aktif ayrimi bozuk`);
    }
  });

  test("team.cjs bot tespitinde BOT_ID_SET kullaniyor (regex degil)", () => {
    const src = fs.readFileSync(path.join(KOK, "routes", "team.cjs"), "utf8");
    assert.ok(!/\/\^bot_\//.test(src),
      "team.cjs hala /^bot_/ regex kullaniyor — gercek bot ID'leriyle eslesmez");
    assert.ok(/BOT_ID_SET/.test(src),
      "team.cjs BOT_ID_SET kullanmiyor — bot tespiti calismaz");
  });

  test("leaderboard.cjs bot filtresinde BOT_ID_SET kullaniyor", () => {
    const src = fs.readFileSync(path.join(KOK, "routes", "leaderboard.cjs"), "utf8");
    assert.ok(!/BOT_PROFILE_MAP\.has/.test(src),
      "leaderboard.cjs BOT_PROFILE_MAP.has kullaniyor — emekli botlar insan olarak sayilir");
    assert.ok(/BOT_ID_SET\.has/.test(src),
      "leaderboard.cjs BOT_ID_SET.has kullanmiyor — bot filtresi eksik");
  });

  test("gercek bot ID'leri /^bot_/ kalibina UYMUYOR (regex kullanilamaz)", () => {
    let uymayanSayisi = 0;
    for (const [id] of BOT_PROFILE_MAP) {
      if (!/^bot_/i.test(id)) uymayanSayisi++;
    }
    assert.ok(uymayanSayisi > 0,
      "tum botlar bot_ ile basliyor — o zaman regex sorun degil, ama bu test yanlis");
    assert.ok(uymayanSayisi === BOT_PROFILE_MAP.size,
      `${BOT_PROFILE_MAP.size - uymayanSayisi} bot bot_ ile basliyor — karisik kural`);
  });
});
