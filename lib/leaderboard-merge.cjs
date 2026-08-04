"use strict";

const path = require("path");
const { withFileLock, writeJsonAtomic } = require("./fileLock.cjs");

const DATA_DIR = process.env.SKORLIG_DATA_DIR || path.join(__dirname, "..", "data");
const LEADERBOARD_FILE = path.join(DATA_DIR, "leaderboard.json");

const fsp = require("fs").promises;

async function readJson(file, fb = null) {
  try {
    const txt = await fsp.readFile(file, "utf8");
    return JSON.parse(txt);
  } catch {
    return fb;
  }
}

function mergeLeaderboard(existingItems, fixtureId, newRows) {
  const fid = String(fixtureId);
  const oldFiltered = existingItems.filter(r => String(r.fixtureId) !== fid);
  const merged = oldFiltered.concat(newRows);

  const totals = {};
  for (const r of merged) {
    const uid = r.userId || "anon";
    if (!totals[uid]) {
      totals[uid] = { userId: uid, total: 0, played: 0, penalties: 0 };
    }
    totals[uid].total     += Number(r.points   || 0);
    totals[uid].played    += 1;
    totals[uid].penalties += Number(r.penalty  || 0);
  }

  return { items: merged, totals };
}

async function mergeAndWriteLeaderboard(fixtureId, rows) {
  return withFileLock(LEADERBOARD_FILE, async () => {
    const lb = await readJson(LEADERBOARD_FILE, { items: [], totals: {} });
    const items = Array.isArray(lb.items) ? lb.items : [];
    const { items: merged, totals } = mergeLeaderboard(items, fixtureId, rows);
    const out = { items: merged, totals, updatedAt: new Date().toISOString() };
    await writeJsonAtomic(LEADERBOARD_FILE, out);
    return out;
  });
}

module.exports = { mergeLeaderboard, mergeAndWriteLeaderboard, LEADERBOARD_FILE };
