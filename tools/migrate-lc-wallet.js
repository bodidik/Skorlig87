"use strict";

require("dotenv").config();
const { MongoClient } = require("mongodb");
const fs   = require("fs");
const path = require("path");

const DATA_DIR    = path.join(__dirname, "..", "data");
const WALLET_FILE = path.join(DATA_DIR, "lc-wallet.json");

async function run() {
  const uri    = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB || "skorlig";

  if (!uri) {
    console.error("MONGODB_URI yok. .env kontrol et.");
    process.exit(1);
  }

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);

  const usersCol  = db.collection("lc_wallet_users");
  const ledgerCol = db.collection("lc_wallet_ledger");

  let fileData;
  try {
    const txt = fs.readFileSync(WALLET_FILE, "utf8");
    fileData = JSON.parse(txt);
  } catch (e) {
    console.error("lc-wallet.json okunamadı veya yok:", e.message || e);
    await client.close();
    process.exit(1);
  }

  const users  = Array.isArray(fileData.users) ? fileData.users : [];
  const ledger = Array.isArray(fileData.ledger) ? fileData.ledger : [];

  console.log("Users:", users.length, "Ledger:", ledger.length);

  for (const u of users) {
    if (!u || !u.userId) continue;
    const uid      = String(u.userId).trim();
    const uidLower = uid.toLowerCase();

    const doc = {
      userId: uid,
      userIdLower: uidLower,
      balance: u.balance ?? 0,
      createdAt: u.createdAt || null,
      updatedAt: u.updatedAt || null,
      lastDailyAt: u.lastDailyAt || null,
      totalEarned: u.totalEarned ?? 0,
      totalSpent: u.totalSpent ?? 0,
      // is1987 bilgisi users tarafında varsa sonra doldurulabilir
    };

    await usersCol.updateOne(
      { userIdLower: uidLower },
      { $set: doc },
      { upsert: true }
    );
  }

  for (const tx of ledger) {
    if (!tx || !tx.userId) continue;
    const uid      = String(tx.userId).trim();
    const uidLower = uid.toLowerCase();

    const doc = {
      id: tx.id || null,
      userId: uid,
      userIdLower: uidLower,
      kind: tx.kind || null,
      amount: tx.amount ?? 0,
      reason: tx.reason || null,
      fixtureId: tx.fixtureId || null,
      meta: tx.meta || null,
      createdAt: tx.createdAt || null,
    };

    await ledgerCol.insertOne(doc);
  }

  console.log("Migration tamamlandı.");
  await client.close();
}

run().catch((e) => {
  console.error("Migration hata:", e);
  process.exit(1);
});
