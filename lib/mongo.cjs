"use strict";

const { MongoClient, ServerApiVersion } = require("mongodb");

const URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB || "skorlig";

let _client = null;
let _db = null;
let _connecting = null;

async function connectOnce() {
  if (_db) return _db;
  if (_connecting) return _connecting;

  if (!URI) {
    console.warn("[mongo] SKIP: MONGODB_URI not set");
    return null;
  }

  _connecting = new Promise(async (resolve) => {
    try {
      const client = new MongoClient(URI, {
        serverApi: {
          version: ServerApiVersion.v1,
          strict: false,
          deprecationErrors: false,
        },
        maxPoolSize: 50,
        minPoolSize: 0,
        waitQueueTimeoutMS: 10000,
        serverSelectionTimeoutMS: 8000,
        heartbeatFrequencyMS: 10000,
      });

      await client.connect();
      _client = client;
      _db = client.db(DB_NAME);

      console.log(`[mongo] Connected to MongoDB, db = ${DB_NAME}`);
      resolve(_db);
    } catch (err) {
      console.error("[mongo] INIT FAILED:", err.message);
      resolve(null);
    } finally {
      _connecting = null;
    }
  });

  return _connecting;
}

async function getDb() {
  return await connectOnce();
}

async function close() {
  try {
    if (_client) {
      await _client.close();
      console.log("[mongo] connection closed");
    }
  } catch (e) {}
  _client = null;
  _db = null;
}

module.exports = { getDb, close };
