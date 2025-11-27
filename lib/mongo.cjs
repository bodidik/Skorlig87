"use strict";
const { MongoClient, ServerApiVersion } = require("mongodb");

const URI = process.env.MONGODB_URI;
const DB  = process.env.MONGODB_DB || "skorlig";

if (!URI) { throw new Error("MONGODB_URI missing"); }

let _client = null;
let _db = null;

async function getDb() {
  if (_db) return _db;
  _client = new MongoClient(URI, {
    serverApi: { version: ServerApiVersion.v1, strict: false, deprecationErrors: false },
    maxPoolSize: 50,
    minPoolSize: 0,
    waitQueueTimeoutMS: 10000,
    serverSelectionTimeoutMS: 8000,
    heartbeatFrequencyMS: 10000
  });
  await _client.connect();
  _db = _client.db(DB);
  return _db;
}

async function close() {
  try { await _client?.close(); } catch {}
  _client = null; _db = null;
}

module.exports = { getDb, close };