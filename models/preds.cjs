"use strict";

const fs   = require("fs");
const fsp  = fs.promises;
const path = require("path");
const { getDb } = require("../lib/db.cjs");

const DATA_DIR   = path.join(__dirname, "..", "data");
const PREDS_FILE = path.join(DATA_DIR, "preds.json");

async function readJson(file, fb) {
  try {
    const txt = await fsp.readFile(file, "utf8");
    return JSON.parse(txt);
  } catch {
    return fb;
  }
}

async function writeJson(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(data, null, 2), "utf8");
}

/**
 * Tahmin kaydet: önce Mongo'ya, sonra JSON fallback'e yazar.
 */
async function savePred(pred) {
  const now = new Date();

  const doc = {
    fixtureId: String(pred.fixtureId),
    userId: String(pred.userId || "anon"),
    outcome: pred.outcome || null,
    home: Number(pred.home),
    away: Number(pred.away),
    firstGoal: pred.firstGoal || null,
    firstHalf: pred.firstHalf || null,
    redHome: !!pred.redHome,
    redAway: !!pred.redAway,
    at: now.toISOString(),
    source: pred.source || "user",
  };

  // 1) Mongo
  try {
    const db = await getDb();
    await db.collection("preds").insertOne(doc);
  } catch (e) {
    console.error("MONGO_SAVE_PRED_FAILED", e);
  }

  // 2) dosya fallback
  try {
    const raw  = await readJson(PREDS_FILE, []);
    const list = Array.isArray(raw)
      ? raw
      : (Array.isArray(raw?.items) ? raw.items : []);
    list.push(doc);
    await writeJson(PREDS_FILE, list);
  } catch (e) {
    console.error("FILE_SAVE_PRED_FAILED", e);
  }

  return doc;
}

/**
 * Belirli bir fixture için tahmin listesi
 */
async function getPredsForFixture(fixtureId) {
  const fid = String(fixtureId);

  // Önce Mongo
  try {
    const db = await getDb();
    const arr = await db
      .collection("preds")
      .find({ fixtureId: fid })
      .sort({ at: 1 })
      .toArray();
    if (arr && arr.length) return arr;
  } catch (e) {
    console.error("MONGO_GET_PREDS_FAILED", e);
  }

  // Fallback: JSON
  const raw  = await readJson(PREDS_FILE, []);
  const list = Array.isArray(raw)
    ? raw
    : (Array.isArray(raw?.items) ? raw.items : []);
  return list.filter((p) => String(p.fixtureId) === fid);
}

/**
 * Kullanıcının o maçtaki son tahmini
 */
async function getMyLatestPred(fixtureId, userId) {
  const fid = String(fixtureId);
  const uid = String(userId || "anon");

  try {
    const db = await getDb();
    const doc = await db
      .collection("preds")
      .find({ fixtureId: fid, userId: uid })
      .sort({ at: -1 })
      .limit(1)
      .next();
    if (doc) return doc;
  } catch (e) {
    console.error("MONGO_GET_MY_PRED_FAILED", e);
  }

  const list = await getPredsForFixture(fid);
  const mine = list.filter(
    (p) => String(p.userId || p.user || "anon") === uid
  );
  return mine.length ? mine[mine.length - 1] : null;
}

module.exports = {
  savePred,
  getPredsForFixture,
  getMyLatestPred,
};
