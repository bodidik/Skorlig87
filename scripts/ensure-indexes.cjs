"use strict";
const { getDb } = require("../db.cjs");

(async ()=>{
  const db = await getDb();
  await db.collection("predictions").createIndex({ fixtureId:1, userId:1, at:-1 });
  console.log("indexes: predictions OK");
  process.exit(0);
})();