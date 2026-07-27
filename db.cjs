"use strict";
const { MongoClient } = require("mongodb");

let __client = null, __db = null, __connecting = null;

async function getClient(){
  if (__client && __client.topology && __client.topology.isConnected()) return __client;
  if (__connecting) return __connecting;

  // ⚠️ İki Mongo modülü var ve eskiden FARKLI env adları okuyorlardı:
  // lib/mongo.cjs (server + migration) MONGODB_URI, burası MONGO_URI.
  // Production'da biri set edilip diğeri unutulduğunda bu dosya sessizce
  // localhost'a bağlanıyor, script "indeksler hazır" deyip çıkıyordu —
  // indeksler asıl veritabanında oluşmamış oluyordu. Artık ikisi de kabul
  // edilir ve production'da URI yoksa sessizce localhost'a DÜŞÜLMEZ.
  const uri =
    process.env.MONGODB_URI ||
    process.env.MONGO_URI ||
    (process.env.NODE_ENV === "production" ? "" : "mongodb://127.0.0.1:27017");

  if (!uri) {
    throw new Error(
      "MONGODB_URI (veya MONGO_URI) tanimli degil — production'da localhost'a dusulmez."
    );
  }
  __connecting = (async()=>{
    const c = new MongoClient(uri, { maxPoolSize: 10, serverSelectionTimeoutMS: 8000 });
    await c.connect();
    try { await c.db("admin").command({ ping: 1 }); } catch {}
    __client = c;
    __connecting = null;
    return c;
  })();

  return __connecting;
}

async function getDb(){
  if (__db) return __db;
  const c  = await getClient();
  const db = c.db(process.env.MONGODB_DB || process.env.MONGO_DB || "skorlig");
  __db = db;
  return db;
}

async function close(){
  try { await __client?.close(); } catch {}
  finally { __client = null; __db = null; __connecting = null; }
}

module.exports = { getDb, getClient, close };