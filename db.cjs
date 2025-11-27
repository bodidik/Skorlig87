"use strict";
const { MongoClient } = require("mongodb");

let __client = null, __db = null, __connecting = null;

async function getClient(){
  if (__client && __client.topology && __client.topology.isConnected()) return __client;
  if (__connecting) return __connecting;

  const uri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017";
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
  const db = c.db(process.env.MONGO_DB || "skorlig");
  __db = db;
  return db;
}

async function close(){
  try { await __client?.close(); } catch {}
  finally { __client = null; __db = null; __connecting = null; }
}

module.exports = { getDb, getClient, close };