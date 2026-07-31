"use strict";

/**
 * Tahmin okuma — canlı maç ekranının kaynağı (routes/realtime.cjs).
 *
 * ⚠️ KOLEKSİYON ADI: `predictions`. Bu dosya uzun süre `preds` yazıyordu —
 * VAR OLMAYAN bir koleksiyon. Gerçek tahminleri `predictions`'a settle2,
 * pred.cjs, duels ve migration script'i yazıyor.
 *
 * Hata neden sessiz kaldı: yanlış koleksiyon HATA VERMEZ, boş dizi döner.
 * Boş dizi de "dosyaya düş" koluna giriyordu, o da yerelde doluydu. Yani
 * geliştirmede her şey çalışıyor görünüyordu. Production'da ise
 * SKORLIG_PREDS_FILE_MIRROR=0 ile preds.json da yazılmıyor → canlı ekran
 * havuzda yüzlerce tahmin varken "kimse tahmin vermemiş" gösteriyordu.
 *
 * DERS: yanlış koleksiyon adı, yanlış alan adı ve boş sonuç Mongo'da aynı
 * şeye benzer. Fallback'i olan bir okuma yolunda bu üçü ayırt edilemez —
 * bu yüzden koleksiyon adları tek yerde tutulmalı.
 *
 * NOT: `savePred` hiçbir yerden ÇAĞRILMIYOR (yazma yolu routes/pred.cjs).
 * Silinmedi ama yeni yazma yolu için buraya değil, oraya bakılmalı.
 */

const fs   = require("fs");
const { ensurePredIndexes } = require("../lib/preds-index.cjs");
const fsp  = fs.promises;
const path = require("path");
const { getDb } = require("../lib/db.cjs");

// ⚠️ SKORLIG_DATA_DIR: sabit yol testleri GERÇEK data/ dizinine yazdırır.
const DATA_DIR   = process.env.SKORLIG_DATA_DIR || path.join(__dirname, "..", "data");
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
    await ensurePredIndexes(db);   // ilk erisimde kendi kendini onarir
    await db.collection("predictions").insertOne(doc);
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
    await ensurePredIndexes(db);
    const arr = await db
      .collection("predictions")
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
    await ensurePredIndexes(db);
    const doc = await db
      .collection("predictions")
      .find({ fixtureId: fid, userIdLower: uid.toLowerCase() })
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
