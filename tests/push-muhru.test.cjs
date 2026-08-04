"use strict";

/**
 * BİLDİRİM ÇİFT-GÖNDERİM MÜHRÜ.
 *
 * ⚠️ BULUNAN: koruma yalnızca `data/push-sent.json` dosyasındaydı ve iki
 * biçimde çöküyordu:
 *
 *   1) Render'da `data/` GEÇİCİ disk — her deploy'da siliniyor. Anahtarlar
 *      kaybolunca hâlâ pencerede olan maçlar için "başlıyor" ve "sonuç"
 *      bildirimleri TEKRAR gidiyordu.
 *   2) `withFileLock` yalnızca tek süreç için anlamlı; ikinci instance'ta
 *      koruma hiç çalışmıyordu.
 *
 * Kod tabanı bu dersi tr-lig'de zaten almıştı (`_finalizingWeek` süreç-içi
 * Set → Mongo mührü) ama buraya taşınmamıştı.
 */

const os = require("os");
const nodePath = require("path");
const fs = require("fs");
/* ⚠️ BENZERSIZ DIZIN — sabit ad `bildirim-muhru-fail-closed.test.cjs` ile
 * ayniydi ve o dosyanin `before` hooku dizini `rmSync` ile siliyordu.
 * node --test iki dosyayi paralel kosuyor; gerekce icin oteki dosyaya bak. */
process.env.SKORLIG_DATA_DIR = fs.mkdtempSync(
  nodePath.join(os.tmpdir(), "skorlig-push-muhur-")
);

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const PushSent = require("../lib/push-sent-store.cjs");

let mongod = null, client = null, db = null;

before(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const { MongoClient } = require("mongodb");
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  db = client.db("test");
});
after(async () => {
  if (client) await client.close();
  if (mongod) await mongod.stop();
});
beforeEach(async () => {
  await db.collection(PushSent.COLL).deleteMany({});
});

describe("anahtar alma", () => {
  test("ilk turda hepsi alınır", async () => {
    const r = await PushSent.claimKeys(["start:m1", "start:m2"], db);
    assert.deepEqual(r.sort(), ["start:m1", "start:m2"]);
  });

  test("ikinci tur AYNI anahtarı alamaz", async () => {
    await PushSent.claimKeys(["start:m1"], db);
    const r = await PushSent.claimKeys(["start:m1"], db);
    assert.deepEqual(r, [], "ayni bildirim ikinci kez gonderilir");
  });

  test("karışık listede yalnızca yeni olanlar alınır", async () => {
    await PushSent.claimKeys(["start:m1"], db);
    const r = await PushSent.claimKeys(["start:m1", "start:m2", "result:m3"], db);
    assert.deepEqual(r.sort(), ["result:m3", "start:m2"]);
  });

  test("EŞZAMANLI iki tur aynı anahtarı ikisi birden alamaz", async () => {
    /**
     * ⚠️ ASIL KORUNAN DURUM BU. Dosya sürümünde iki instance listeyi aynı anda
     * "boş" görüp ikisi de gönderiyordu. Mühür yazmanın İÇİNDE (benzersiz
     * indeks + insertOne) olduğu için yalnızca biri geçebilir.
     */
    const [a, b] = await Promise.all([
      PushSent.claimKeys(["start:yaris"], db),
      PushSent.claimKeys(["start:yaris"], db),
    ]);
    assert.equal(a.length + b.length, 1, "iki tur da anahtari almis — cift bildirim");
  });

  test("aynı listede tekrarlanan anahtar bir kez sayılır", async () => {
    const r = await PushSent.claimKeys(["start:m1", "start:m1"], db);
    assert.deepEqual(r, ["start:m1"]);
  });
});

describe("bozuk girdi", () => {
  test("boş liste boş döner", async () => {
    assert.deepEqual(await PushSent.claimKeys([], db), []);
    assert.deepEqual(await PushSent.claimKeys(null, db), []);
  });

  test("boş/anlamsız anahtarlar elenir", async () => {
    assert.deepEqual(await PushSent.claimKeys(["", "   ", null, undefined], db), []);
  });

  test("db yoksa null döner — çağıran dosya yoluna düşsün", async () => {
    // ⚠️ null ile [] farkı ÖNEMLİ: [] "hiçbiri alınmadı" (gönderme) demek,
    // null "Mongo yok, eski yolu dene" demek. Karıştırılırsa Mongo
    // erişilemezken bildirimler tamamen susardı.
    assert.equal(await PushSent.claimKeys(["start:m1"], null), null);
  });
});

describe("TTL", () => {
  test("süre dolumu için TTL indeksi kurulur", async () => {
    await PushSent.claimKeys(["start:m1"], db);
    const idx = await db.collection(PushSent.COLL).indexes();
    const ttl = idx.find((i) => i.expireAfterSeconds !== undefined);
    assert.ok(ttl, "TTL indeksi yok — koleksiyon sonsuza kadar buyur");
    assert.equal(ttl.expireAfterSeconds, PushSent.TTL_SN);
  });

  test("anahtar benzersiz indeksle korunuyor", async () => {
    await PushSent.claimKeys(["start:m1"], db);
    const idx = await db.collection(PushSent.COLL).indexes();
    const uniq = idx.find((i) => i.unique && i.key && i.key.key === 1);
    assert.ok(uniq, "key uzerinde benzersiz indeks yok — muhur atomik degil");
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: zamanlayıcı önce Mongo mührünü deniyor", () => {
  const src = fs.readFileSync(
    nodePath.join(__dirname, "..", "services", "push-scheduler.cjs"), "utf8"
  );
  const govde = src.slice(src.indexOf("async function claimKeys"));
  const blok = govde.slice(0, govde.indexOf("\n}\n"));
  assert.ok(
    /PushSent\.claimKeys/.test(blok),
    "zamanlayici Mongo muhrunu kullanmiyor — deploy sonrasi cift bildirim gider"
  );
  assert.ok(
    /withFileLock/.test(blok),
    "dosya yedegi kaldirilmis — Mongo erisilemezken bildirimler tamamen susar"
  );
});
