"use strict";

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skorlig-push-at-"));
process.env.SKORLIG_DATA_DIR = tmpDir;
process.env.SKORLIG_PUSH = "0";

const KOK = path.join(__dirname, "..");

let mongod;

before(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
});

after(async () => {
  try { const m = require(path.join(KOK, "lib", "mongo.cjs")); await m.close(); } catch {}
  delete process.env.MONGODB_URI;
  await mongod?.stop();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe("push token kaydi atomik (saveUser tabanli)", () => {
  test("registerToken baska hesaptaki ayni jetonu soker", async () => {
    const Push = require(path.join(KOK, "services", "push.cjs"));
    const PushStore = require(path.join(KOK, "lib", "push-store.cjs"));
    const TOK = "ExponentPushToken[AYNI_CIHAZ_123]";

    await Push.registerToken("ali", TOK);
    const ali1 = await PushStore.getUser("ali");
    assert.ok(ali1.tokens.includes(TOK), "ali jetonu almali");

    await Push.registerToken("veli", TOK);
    const ali2 = await PushStore.getUser("ali");
    const veli = await PushStore.getUser("veli");
    assert.ok(veli.tokens.includes(TOK), "veli jetonu almali");
    assert.ok(!(ali2?.tokens || []).includes(TOK),
      "ali hala jetona sahip — cihaz el degistirmesi calismamis");
  });

  test("esanli registerToken diger kullanicinin jetonunu SILMEZ", async () => {
    const Push = require(path.join(KOK, "services", "push.cjs"));
    const PushStore = require(path.join(KOK, "lib", "push-store.cjs"));

    const TOK_A = "ExponentPushToken[CIHAZ_A_456]";
    const TOK_B = "ExponentPushToken[CIHAZ_B_789]";

    await Promise.all([
      Push.registerToken("user1", TOK_A),
      Push.registerToken("user2", TOK_B),
    ]);

    const u1 = await PushStore.getUser("user1");
    const u2 = await PushStore.getUser("user2");
    assert.ok(u1.tokens.includes(TOK_A), "user1 jetonunu kaybetti");
    assert.ok(u2.tokens.includes(TOK_B), "user2 jetonunu kaybetti");
  });

  test("setPrefs diger kullaniciyi etkilemez", async () => {
    const Push = require(path.join(KOK, "services", "push.cjs"));
    const PushStore = require(path.join(KOK, "lib", "push-store.cjs"));

    await Push.registerToken("pref1", "ExponentPushToken[P1]");
    await Push.registerToken("pref2", "ExponentPushToken[P2]");

    await Push.setPrefs("pref1", { daily: false });

    const p2 = await PushStore.getUser("pref2");
    assert.ok(p2, "pref2 kaybi — setPrefs baska kullaniciyi sildi");
    assert.ok(p2.tokens.includes("ExponentPushToken[P2]"),
      "pref2 jetonu kayip — setPrefs saveStore kullanmaya devam ediyor olabilir");
  });

  test("pullBadTokens gecersiz jetonu kaldirir", async () => {
    const Push = require(path.join(KOK, "services", "push.cjs"));
    const PushStore = require(path.join(KOK, "lib", "push-store.cjs"));
    const BAD = "ExponentPushToken[OLEN_CIHAZ]";

    await Push.registerToken("prune_user", BAD);
    const once = await PushStore.getUser("prune_user");
    assert.ok(once.tokens.includes(BAD), "jeton kayit edilmemis");

    await PushStore.pullBadTokens([BAD]);
    const sonra = await PushStore.getUser("prune_user");
    assert.ok(!(sonra?.tokens || []).includes(BAD),
      "gecersiz jeton hala duruyor — pullBadTokens calismamis");
  });

  test("KURULUM SINANDI: saveStore artik kullanilmiyor", () => {
    const src = fs.readFileSync(
      path.join(KOK, "services", "push.cjs"), "utf8"
    );
    assert.ok(
      !(/PushStore\.saveStore/.test(src)),
      "services/push.cjs hala PushStore.saveStore kullaniyor — whole-map overwrite riski"
    );
  });
});
