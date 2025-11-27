"use strict";

const { MongoClient } = require("mongodb");

let clientPromise = null;

async function getClient() {
  if (clientPromise) return clientPromise;

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI_MISSING");
  }

  const opts = {
    maxPoolSize: 10,
  };

  const client = new MongoClient(uri, opts);
  clientPromise = client.connect();
  return clientPromise;
}

async function getDb() {
  const client = await getClient();
  const dbName = process.env.MONGODB_DB || "skorlig";
  return client.db(dbName);
}

async function pingDb() {
  const db = await getDb();
  const admin = db.admin();
  const r = await admin.ping();
  return r;
}

module.exports = {
  getDb,
  pingDb,
};
