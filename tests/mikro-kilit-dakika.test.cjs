"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");

describe("mikro-kilit dakika guvenilirlik", () => {
  test("predMinute istemciden (req.body.minute) alinmiyor", () => {
    const src = fs.readFileSync(path.join(KOK, "routes", "pred.cjs"), "utf8");
    const mikroBolge = src.slice(
      src.indexOf("predMinuteRaw"),
      src.indexOf("predMinuteRaw") + 200
    );
    assert.ok(
      !/req\.body\.minute/.test(mikroBolge),
      "predMinuteRaw hala req.body.minute kullaniyor — istemci dakika gondererek mikro-kilidi atlayabilir"
    );
  });

  test("predMinute sunucu kaynagindan (st.minute) aliniyor", () => {
    const src = fs.readFileSync(path.join(KOK, "routes", "pred.cjs"), "utf8");
    const idx = src.indexOf("predMinuteRaw");
    const blok = src.slice(idx, idx + 100);
    assert.ok(
      /st\?\.minute/.test(blok),
      "predMinuteRaw st?.minute kullanmiyor — sunucu kaynagi kayip"
    );
  });

  test("MICRO_LOCKED_RED hata kodu mevcut", () => {
    const src = fs.readFileSync(path.join(KOK, "routes", "pred.cjs"), "utf8");
    assert.ok(src.includes("MICRO_LOCKED_RED"),
      "MICRO_LOCKED_RED hata kodu bulunamadi");
  });

  test("NEGATIF KONTROL: req.body.minute geri eklenirse test kirilir", () => {
    const src = fs.readFileSync(path.join(KOK, "routes", "pred.cjs"), "utf8");
    const idx = src.indexOf("predMinuteRaw");
    const blok = src.slice(idx, idx + 200);
    const sahte = blok.replace("st?.minute", "req.body.minute");
    assert.ok(
      /req\.body\.minute/.test(sahte),
      "negatif kontrol basarisiz — degisiklik uygulanmadi"
    );
    assert.ok(
      !/req\.body\.minute/.test(blok),
      "gercek kodda req.body.minute olmamali"
    );
  });
});
