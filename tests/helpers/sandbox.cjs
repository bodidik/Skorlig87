"use strict";

/**
 * Testler için izole veri kumbarası.
 *
 * settle2 puan ve LC dağıtır; testlerin gerçek kullanıcı verisine dokunması
 * kabul edilemez. SKORLIG_DATA_DIR ile geçici bir dizine yönlendirilir —
 * gerçek data/ klasörü hiç açılmaz.
 *
 * ÖNEMLİ: settle2 modülü DATA_DIR'i yüklenirken bir kez okur. Bu yüzden
 * env değişkeni require'dan ÖNCE ayarlanmalı; `loadSettle2()` bunu garanti
 * eder ve modülü taze yükler.
 */

const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const path = require("path");

function createSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skorlig-settle2-"));
  fs.mkdirSync(path.join(dir, "live"), { recursive: true });
  return dir;
}

function destroySandbox(dir) {
  if (dir && dir.includes("skorlig-settle2-")) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Test DOSYASI başına tek kumbara kurar ve modülü bir kez yükler.
 *
 * ⚠️ NEDEN TEST BAŞINA DEĞİL, DOSYA BAŞINA: `SKORLIG_DATA_DIR` süreç geneli
 * bir değişken ve settle2 onu yalnızca yüklenirken okur. Her testte env'i
 * değiştirip modülü yeniden yüklemek, testler herhangi bir biçimde
 * örtüşürse birinin yazımını diğerinin dizinine düşürür — gerçekten yaşandı,
 * bir koşuda beklenmedik fazladan ledger kaydı görüldü ve sonraki koşuda
 * kayboldu. Kararsız test, testsizlikten kötüdür.
 *
 * Bunun yerine: dosya başına TEK dizin, TEK modül örneği; testler benzersiz
 * fixture/kullanıcı kimlikleriyle birbirinden ayrışır.
 *
 * Süreç çıkarken dizin silinir (node --test her dosyayı ayrı süreçte koşar).
 */
function setupFile() {
  const dir = createSandbox();
  process.env.SKORLIG_DATA_DIR = dir;

  const p = require.resolve("../../routes/settle2.cjs");
  delete require.cache[p];
  const settle2 = require(p);

  process.on("exit", () => destroySandbox(dir));
  return { dir, settle2 };
}

async function writeJson(dir, name, data) {
  await fsp.writeFile(path.join(dir, name), JSON.stringify(data, null, 2), "utf8");
}

async function readJson(dir, name, fb = null) {
  try {
    return JSON.parse(await fsp.readFile(path.join(dir, name), "utf8"));
  } catch {
    return fb;
  }
}

/**
 * Bitmiş bir maç kurar: live state + tahminler.
 *
 * @param score  { h, a }            nihai skor
 * @param preds  [{userId, ...}]     tahminler
 * @param opts   { ht, firstGoal, redAny, redSide, penaltyAny, penaltySide, homeTeam, awayTeam }
 */
async function seedFixture(dir, fixtureId, score, preds, opts = {}) {
  // scoreFixture'ın okuduğu şema (routes/settle2.cjs):
  //   st.score / st.htScore  → { home, away }  (SAYI)
  //   st.home  / st.away     → TAKIM ADI (odds ve maç zorluğu için)
  //   st.redHome / st.redAway → boolean (redAny/redSide DEĞİL)
  const state = {
    fixtureId,
    status: "FT",
    score: { home: score.h, away: score.a },
    home: opts.homeTeam || "Takim A",
    away: opts.awayTeam || "Takim B",
    country: opts.country || "Türkiye",
    kickoffISO: new Date(Date.now() - 3 * 3600 * 1000).toISOString(),
  };
  if (opts.ht) state.htScore = { home: opts.ht.h, away: opts.ht.a };
  if (opts.firstGoal) state.firstGoal = opts.firstGoal;
  if (opts.redHome !== undefined) state.redHome = opts.redHome;
  if (opts.redAway !== undefined) state.redAway = opts.redAway;
  if (opts.penaltyAny !== undefined) state.penaltyAny = opts.penaltyAny;
  if (opts.penaltySide) state.penaltySide = opts.penaltySide;

  await writeJson(dir, path.join("live", `${fixtureId}.json`), state);

  const existing = (await readJson(dir, "preds.json", [])) || [];
  const list = Array.isArray(existing) ? existing : existing.items || [];
  for (const p of preds) list.push({ fixtureId, at: new Date().toISOString(), ...p });
  await writeJson(dir, "preds.json", list);

  // Boş iskeletler — modül yoklarını tolere eder ama testler deterministik olsun.
  if (!fs.existsSync(path.join(dir, "lc-wallet.json"))) {
    await writeJson(dir, "lc-wallet.json", { users: [], ledger: [], updatedAt: null });
  }
  if (!fs.existsSync(path.join(dir, "users.json"))) {
    await writeJson(dir, "users.json", { items: [] });
  }

  return state;
}

module.exports = {
  createSandbox,
  destroySandbox,
  setupFile,
  seedFixture,
  writeJson,
  readJson,
};
