import { MongoClient, ServerApiVersion } from "mongodb";

const uri = process.env.MONGODB_URI || "mongodb+srv://hucigo11:numvs0Aqe8mEKGv1@cluster0.2omgunq.mongodb.net/skorlig?retryWrites=true&w=majority&appName=SkorLig";

const client = new MongoClient(uri, {
  serverApi: { version: ServerApiVersion.v1, strict: false, deprecationErrors: false },
  maxPoolSize: 20,
  minPoolSize: 0,
  waitQueueTimeoutMS: 10000,
  serverSelectionTimeoutMS: 8000,
  heartbeatFrequencyMS: 10000
});

try {
  await client.connect();
  const dbName = process.env.MONGODB_DB || "skorlig";
  const res = await client.db(dbName).command({ ping: 1 });
  console.log("PING OK:", res);
  process.exit(0);
} catch (e) {
  console.error("PING FAIL:", e?.message || e);
  process.exit(1);
} finally {
  await client.close().catch(()=>{});
}