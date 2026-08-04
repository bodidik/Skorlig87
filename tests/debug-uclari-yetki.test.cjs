"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");

describe("debug uclari yetki nobetcisi", () => {
  test("fixtures.cjs debug uclari requireAdmin ile korunuyor", () => {
    const src = fs.readFileSync(path.join(KOK, "routes", "fixtures.cjs"), "utf8");
    for (const yol of ["/debug-af-key", "/debug-fdo-key"]) {
      const idx = src.indexOf(`"${yol}"`);
      assert.ok(idx > 0, `${yol} bulunamadi`);
      const oncesi = src.slice(Math.max(0, idx - 120), idx);
      const satir = src.slice(src.lastIndexOf("\n", idx), src.indexOf("\n", idx + 1));
      assert.ok(/requireAdmin/.test(satir),
        `fixtures.cjs ${yol} ucunda requireAdmin middleware eksik`);
    }
  });

  test("live2.cjs debug uclari requireAdmin ile korunuyor", () => {
    const src = fs.readFileSync(path.join(KOK, "routes", "live2.cjs"), "utf8");
    for (const yol of ["/debug-af-key", "/debug-fdo-key", "/debug-manual"]) {
      const idx = src.indexOf(`"${yol}"`);
      assert.ok(idx > 0, `${yol} bulunamadi`);
      const satir = src.slice(src.lastIndexOf("\n", idx), src.indexOf("\n", idx + 1));
      assert.ok(/requireAdmin/.test(satir),
        `live2.cjs ${yol} ucunda requireAdmin middleware eksik`);
    }
  });

  test("requireAdmin import edilmis", () => {
    for (const dosya of ["fixtures.cjs", "live2.cjs"]) {
      const src = fs.readFileSync(path.join(KOK, "routes", dosya), "utf8");
      assert.ok(/require\(.*requireAdmin/.test(src),
        `${dosya} requireAdmin import etmiyor`);
    }
  });

  test("NEGATIF KONTROL: requireAdmin kaldirilirsa test kirilir", () => {
    const src = fs.readFileSync(path.join(KOK, "routes", "live2.cjs"), "utf8");
    const idx = src.indexOf('"/debug-af-key"');
    const satir = src.slice(src.lastIndexOf("\n", idx), src.indexOf("\n", idx + 1));
    const sahte = satir.replace("requireAdmin", "");
    assert.ok(!/requireAdmin/.test(sahte),
      "negatif kontrol basarisiz — requireAdmin kaldirildi ama hala eslesiyor");
  });
});
