"use strict";

/**
 * ENGELLENEN KULLANICI, ENGELLEYENE DÜELLO ATAMAZ.
 *
 * ⚠️ BULUNAN KUSUR (2026-08-03, routes/duels.cjs POST /duels/create):
 * kişiye özel meydan okuma (`challengedId`) engel listesini HİÇ sormuyordu.
 *
 * ÖLÇÜLDÜ (gerçek rotalar, bellek-içi Mongo — üretime dokunulmadan):
 *     KURBAN, TACIZCI'yi engelliyor          → 200 blocked:true
 *     TACIZCI, KURBAN'a ÖZEL düello açıyor   → 200 OLUŞTU
 *     KURBAN'ın arenası                      → düello GÖRÜNÜYOR (creatorName ile)
 *     KURBAN'a push                          → "⚔️ Sana meydan okundu"
 * Yani engellenen kişi, engelleyene bildirim gönderebiliyordu — engellemenin
 * önlemek için var olduğu şeyin ta kendisi.
 *
 * ⚠️ AYNI SINIF EYLEM KOMŞUSUNDA KORUNUYORDU: `routes/mini.cjs` turnuvaya kişi
 * davetinde engeli İKİ YÖNDE sınıyordu. Düello daveti o kapıyı hiç almamıştı.
 * Kural artık tek kaynakta: `SocialStore.engelliMi`.
 *
 * DÜZELTMEDEN SONRA aynı ölçüm: 403 BLOCKED · arena boş · 0 bildirim ·
 * engelsiz üçüncü kişi hâlâ düello açabiliyor.
 */

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const KOK = path.join(__dirname, "..");

const VERI_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "skorlig-engel-"));
process.env.SKORLIG_DATA_DIR = VERI_DIR;

// ⚠️ Kimlik ara katmanı `x-user-id` ile değiştiriliyor (bu depodaki düello
// testlerinin kalıbı) — Firebase olmadan gerçek rotalar koşabilsin.
const vt = require.resolve(path.join(KOK, "middleware", "verifyToken.cjs"));
require.cache[vt] = {
  id: vt, filename: vt, loaded: true, exports: {
    verifyToken: (q, r, n) => {
      if (!q.headers["x-user-id"]) return r.status(401).json({ ok: false, error: "AUTH" });
      q.uid = q.headers["x-user-id"]; n();
    },
    optionalToken: (q, _r, n) => { q.uid = q.headers["x-user-id"] || null; n(); },
  },
};

// Bildirimler yakalanır: asıl zarar "engelleyenin telefonuna bildirim düşmesi".
const bildirimler = [];
{
  const pp = require.resolve(path.join(KOK, "services", "push.cjs"));
  const gercek = require(pp);
  require.cache[pp].exports = {
    ...gercek,
    sendToUsers: async (ids, p) => { bildirimler.push({ ids, p }); return { ok: true }; },
  };
}

const express = require("express");
const SocialStore = require(path.join(KOK, "lib", "social-store.cjs"));

let mongod = null, client = null, db = null, srv = null, port = 0;
const FID = "TEST-ENGEL-DUELLO";

before(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const { MongoClient } = require("mongodb");
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  db = client.db("test");

  for (const uid of ["KURBAN", "TACIZCI", "TEMIZ"]) {
    await db.collection("lc_wallet_users").insertOne({
      userId: uid, userIdLower: uid.toLowerCase(), balance: 500,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      totalEarned: 500, totalSpent: 0,
    });
  }
  await db.collection("fixtures").insertOne({
    fixtureId: FID, home: "Galatasaray", away: "Fenerbahce",
    kickoffISO: new Date(Date.now() + 6 * 3600 * 1000).toISOString(),
    status: "NS", league: "Super Lig", country: "Türkiye",
  });

  const app = express();
  app.use(express.json());
  app.locals.db = db;
  app.use("/api/friends", require(path.join(KOK, "routes", "friends.cjs")));
  app.use("/api", require(path.join(KOK, "routes", "duels.cjs")));
  await new Promise((r) => { srv = app.listen(0, r); });
  port = srv.address().port;
});

after(async () => {
  srv?.close();
  await client?.close();
  await mongod?.stop();
  try { fs.rmSync(VERI_DIR, { recursive: true, force: true }); } catch { /* geçici */ }
});

async function cagir(yol, opt = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${yol}`, {
    method: opt.method || "GET",
    headers: { "content-type": "application/json", ...(opt.uid ? { "x-user-id": opt.uid } : {}) },
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  });
  let j = null; try { j = await r.json(); } catch { /* gövdesiz yanıt */ }
  return { st: r.status, j };
}

const duelloAc = (kimden, kime) =>
  cagir("/api/duels/create", {
    method: "POST", uid: kimden,
    body: { fixtureId: FID, stake: 5, challengedId: kime, creatorName: kimden },
  });

describe("engel — düello daveti", () => {
  test("kurulum sınandı: engelSİZ düello GERÇEKTEN açılıyor", async () => {
    /**
     * ⚠️ Bu olmadan iddia boş: uç zaten çalışmıyorsa (bakiye/maç/kilit) her
     * denemede hata döner ve "engel çalışıyor" sanırdık. Ölçülen şeyin
     * engel olduğunu bu test garanti ediyor.
     */
    const r = await duelloAc("TEMIZ", "KURBAN");
    assert.equal(r.st, 200, `engelsiz duello acilamadi: ${JSON.stringify(r.j)}`);
    assert.ok(r.j?.duel?.id, "duello kaydi donmedi");
  });

  test("engel KONULDU (ön koşul)", async () => {
    const r = await cagir("/api/friends/block", {
      method: "POST", uid: "KURBAN", body: { target: "TACIZCI" },
    });
    assert.equal(r.st, 200);
    assert.equal(r.j?.blocked, true);
    assert.equal(await SocialStore.engelliMi("KURBAN", "TACIZCI", db), true, "engel depoda yok");
  });

  test("ENGELLENEN → ENGELLEYENE düello AÇAMAZ", async () => {
    const r = await duelloAc("TACIZCI", "KURBAN");
    assert.equal(r.st, 403, `duello olusturuldu (${r.st}) — engel delindi`);
    assert.equal(r.j?.error, "BLOCKED");
  });

  test("ENGELLEYEN → ENGELLENENE de açamaz (kural YÖNSÜZ)", async () => {
    /**
     * ⚠️ Yalnızca tek yöne bakmak, engelleyenin engellediği kişiyi rahatsız
     * etmesine izin verirdi. Engel bir ilişki durumu, tek yönlü bir izin değil.
     */
    const r = await duelloAc("KURBAN", "TACIZCI");
    assert.equal(r.st, 403, "ters yonde engel uygulanmiyor");
  });

  test("ASIL ZARAR: engellenene BİLDİRİM gitmiyor", async () => {
    /* Düello kaydı oluşmasa bile bildirim ayrı bir kod yolundan gidebilir;
     * asıl kullanıcı zararı telefona düşen "sana meydan okundu" bildirimiydi. */
    bildirimler.length = 0;
    await duelloAc("TACIZCI", "KURBAN");
    assert.equal(bildirimler.length, 0,
      `engellenen kisi bildirim gonderebildi: ${JSON.stringify(bildirimler[0]?.p?.title)}`);
  });

  test("ENGELLENEN DÜELLO ARENADA GÖRÜNMÜYOR", async () => {
    /* Bildirim engellense bile kayıt oluşsaydı, engelleyen kişi rakibin adını
     * arena listesinde görürdü — engelin amacı temasın kesilmesi. */
    const r = await cagir("/api/duels/arena?userId=KURBAN", { uid: "KURBAN" });
    const gruplar = r.j?.matches || [];
    const tacizciden = gruplar.flatMap((g) => g.preview || [])
      .filter((d) => String(d.creatorId || "").toLowerCase() === "tacizci");
    assert.equal(tacizciden.length, 0, "engellenen kisinin duellosu arenada gorunuyor");
  });

  test("TERS RİSK: engelsiz üçüncü kişi HÂLÂ açabiliyor", async () => {
    /**
     * ⚠️ ASIL TEHLİKE AŞIRI KISITLAMA. Engel denetimi yanlış yazılırsa
     * (ör. liste okunamayınca fail-closed) tüm özel düellolar sessizce
     * kapanır ve özellik ölür — kusurdan daha görünmez bir zarar.
     */
    const r = await duelloAc("TEMIZ", "KURBAN");
    assert.equal(r.st, 200, `engelsiz kisi engellendi: ${JSON.stringify(r.j)}`);
  });

  test("ÜCRET DÜŞÜLMEDEN reddediliyor (para götürmesin)", async () => {
    /* ⚠️ Kapı `deductLc`ten SONRA konsaydı reddedilen davet yine bahis
     * bedelini götürürdü. Bakiye tek satırlık kanıt. */
    const once = await db.collection("lc_wallet_users").findOne({ userIdLower: "tacizci" });
    await duelloAc("TACIZCI", "KURBAN");
    const sonra = await db.collection("lc_wallet_users").findOne({ userIdLower: "tacizci" });
    assert.equal(Number(sonra.balance), Number(once.balance),
      "reddedilen duello bakiyeden LC dusurdu");
  });

  test("NÖBETÇİ: engel kuralı TEK KAYNAKTAN sorulur", () => {
    /**
     * ⚠️ KUSURUN KÖKÜ KOPYAYDI: kural mini.cjs'te elle yazılmıştı, duels.cjs'te
     * hiç yoktu. Yeni bir yüzey kendi kopyasını yazarsa aynı boşluk geri gelir.
     */
    const oku = (rel) => fs.readFileSync(path.join(KOK, rel), "utf8")
      .split(/\r?\n/).map((l) => {
        const t = l.trim();
        return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
      }).join("\n");

    assert.ok(/SocialStore\.engelliMi\(/.test(oku(path.join("routes", "duels.cjs"))),
      "duels.cjs ortak engel denetimini kullanmiyor");
    assert.ok(/SocialStore\.engelliMi\(/.test(oku(path.join("routes", "mini.cjs"))),
      "mini.cjs ortak engel denetimini kullanmiyor");
    assert.ok(!/blocks \|\| \[\]\)\.some/.test(oku(path.join("routes", "mini.cjs"))),
      "mini.cjs kendi engel kopyasina donmus");
  });
});
