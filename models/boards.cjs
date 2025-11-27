"use strict";

const { MongoClient } = require("mongodb");

let __cli = null, __db = null, __coll = null;

async function getColl(){
  if (__coll) return __coll;

  const uri = process.env.MONGODB_URI || "";
  const dbn = process.env.MONGODB_DB  || "skorlig";
  if (!uri) throw new Error("MONGODB_URI_MISSING");

  // Node 22+ TLS uyumlu, sade opsiyonlar
  __cli = new MongoClient(uri, { serverSelectionTimeoutMS: 3000 });
  await __cli.connect();
  __db = __cli.db(dbn);
  __coll = __db.collection("leaderboard_snapshots");
  return __coll;
}

/**
 * rows: [{ userId, points, detail?, ... }]
 */
async function saveBoardSnapshot(fixtureId, rows){
  try{
    if (!fixtureId || !Array.isArray(rows)) return false;

    // hafif sanitizasyon
    const items = rows.map(x => ({
      userId: String(x.userId || "anon"),
      points: Number(x.points || 0),
      detail: x.detail || {},
      at: x.at ? new Date(x.at) : new Date()
    }));

    const c = await getColl();
    const now = new Date();
    await c.updateOne(
      { fixtureId: String(fixtureId) },
      { $set: { fixtureId: String(fixtureId), items, updatedAt: now } },
      { upsert: true }
    );
    return true;
  }catch(e){
    // Atlas erişilemezse sessizce geç (dosyadan devam ederiz)
    return false;
  }
}

module.exports = { saveBoardSnapshot };
