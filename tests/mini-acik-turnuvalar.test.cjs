"use strict";

/**
 * AÇIK TURNUVA LİSTESİ — `GET /api/mini/public`.
 *
 * ⚠️ NEREDEN ÇIKTI: kullanıcı deneyimi turu 2 (2026-08-03). Mobil
 * `app/(tabs)/live.tsx:954` bu ucu ÇAĞIRIYOR ama uç hiç yazılmamıştı.
 * `apiJson` 404'te hata fırlatmayıp `{ok:false}` döndüğü için çökme yok —
 * "AÇIK TURNUVALAR" bölümü sadece KALICI OLARAK BOŞ kalıyordu. Kullanıcı
 * hiçbir turnuvayı keşfedemiyor, ancak kod elle paylaşılırsa katılabiliyordu.
 * (Aynı sınıf: `/api/stats/team-ranks` de böyle ölüydü.)
 *
 * ⚠️ "AÇIK" KAVRAMI VERİDE YOKTU. Turnuva belgesinde görünürlük alanı yok;
 * katılım tek yoldan: `POST /join` + `code`. Tanım burada yapıldı:
 * bitmemiş + dolmamış + kullanıcının üye OLMADIĞI turnuva.
 *
 * ⚠️ LİSTELEMEK KATILIM KODUNU YAYINLAMAKTIR. `publicView` `code` içeriyor
 * ve mobil katılırken onu kullanıyor, yani kodsuz listeleme işe yaramazdı.
 * Bu bilinçli bir üründür — kullanıcı onayıyla yazıldı.
 */

const test = require("node:test");
const describe = require("node:test").describe;
const assert = require("node:assert/strict");
const os = require("os");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "skorlig-mini-"));
process.env.SKORLIG_DATA_DIR = TMP;
process.env.SKORLIG_BG = "0";

const vt = require.resolve(path.join(KOK, "middleware", "verifyToken.cjs"));
require.cache[vt] = { id: vt, filename: vt, loaded: true, exports: {
  verifyToken: (q, _r, n) => { q.uid = q.headers["x-user-id"]; n(); },
  optionalToken: (q, _r, n) => { q.uid = q.headers["x-user-id"] || null; n(); },
  getFirebaseAuth: () => null, kimlikModu: () => "test",
}};

const express = require("express");

/** Turnuva deposunu denetim altına al. */
const socialYol = require.resolve(path.join(KOK, "lib", "social-store.cjs"));
let _turnuvalar = [];
const gercekSocial = require(socialYol);
require.cache[socialYol].exports = {
  ...gercekSocial,
  loadMini: async () => _turnuvalar.slice(),
};

const app = express();
app.use((q, _r, n) => { q.app.locals.db = null; n(); });
app.use("/api/mini", require(path.join(KOK, "routes", "mini.cjs")));
const srv = app.listen(0);
const port = srv.address().port;

/**
 * ⚠️ `listening` OLAYI BEKLENMELİ — SÜİT ARADA BİR KIRILIYORDU.
 *
 * `app.listen(0)` port'u hemen atar ama soket kabul etmeye HAZIR olmaz. Tam
 * süit yükü altında ilk istek bağlantı reddi alıyor: `fetch failed` (undici).
 * ÖLÇÜLDÜ (2026-08-02): 8-10 koşuda 1 kırılma, iki farklı testte aynı hata.
 * Eşzamanlılığı 8'e düşürmek YETMEDİ — sebep paralellik miktarı değil,
 * beklenmemiş `listen`.
 *
 * Modül düzeyinde `await` yok, o yüzden söz olarak tutulup her istekten önce
 * bekleniyor (ilk istekten sonra zaten çözülmüş olur).
 */
const HAZIR = new Promise((c) => (srv.listening ? c() : srv.once("listening", c)));

const cagir = async (yol) => {
  await HAZIR;                       // soket kabul etmeye hazir olsun
  const r = await fetch(`http://127.0.0.1:${port}${yol}`);
  return { s: r.status, j: await r.json().catch(() => null) };
};

const turnuva = (id, o = {}) => ({
  id, code: "K" + id, name: "T" + id, ownerId: "sahip",
  fixtures: ["F1", "F2"], members: ["sahip"],
  createdAt: "2026-08-01T10:00:00.000Z", finishedAt: null, winners: null, rewardLc: 100,
  ...o,
});

test.after(() => { srv.close(); });

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("uç MEVCUT — 404 değil", async () => {
    _turnuvalar = [];
    const r = await cagir("/api/mini/public");
    assert.notEqual(r.s, 404, "uc hala yok — mobildeki bolum bos kalir");
    assert.equal(r.s, 200);
    assert.ok(Array.isArray(r.j?.items), "mobil j.items bekliyor");
  });
});

/* ── Asıl davranış ───────────────────────────────────────────────────────── */

describe("hangi turnuvalar listeleniyor", () => {
  test("bitmemiş, dolmamış turnuva LİSTELENİR", async () => {
    _turnuvalar = [turnuva("1")];
    const r = await cagir("/api/mini/public?userId=yeni");
    assert.equal(r.j.items.length, 1);
    assert.equal(r.j.items[0].id, "1");
    assert.ok(r.j.items[0].code, "katilim kodu yok — mobil katilamaz");
  });

  test("BİTMİŞ turnuva listelenmez", async () => {
    _turnuvalar = [turnuva("2", { finishedAt: "2026-08-02T10:00:00.000Z" })];
    assert.equal((await cagir("/api/mini/public?userId=yeni")).j.items.length, 0);
  });

  test("DOLU turnuva listelenmez (katılınamaz)", async () => {
    const uyeler = Array.from({ length: 50 }, (_, i) => "u" + i);
    _turnuvalar = [turnuva("3", { members: uyeler })];
    assert.equal((await cagir("/api/mini/public?userId=yeni")).j.items.length, 0);
  });

  test("ZATEN ÜYE olduğu turnuva listelenmez (o /mine'da)", async () => {
    _turnuvalar = [turnuva("4", { members: ["sahip", "ali"] })];
    assert.equal((await cagir("/api/mini/public?userId=ali")).j.items.length, 0);
    assert.equal((await cagir("/api/mini/public?userId=veli")).j.items.length, 1);
  });

  test("üyelik karşılaştırması harf duyarsız", async () => {
    /* Firebase UID'leri karışık harfli; harf duyarlı karşılaştırma kullanıcıya
     * kendi turnuvasını "açık" diye gösterirdi. */
    _turnuvalar = [turnuva("5", { members: ["Ali"] })];
    assert.equal((await cagir("/api/mini/public?userId=ali")).j.items.length, 0);
  });

  test("userId VERİLMEZSE hepsi listelenir (misafir keşfi)", async () => {
    _turnuvalar = [turnuva("6"), turnuva("7")];
    assert.equal((await cagir("/api/mini/public")).j.items.length, 2);
  });

  test("en YENİ turnuva üstte", async () => {
    _turnuvalar = [
      turnuva("eski", { createdAt: "2026-07-01T00:00:00.000Z" }),
      turnuva("yeni", { createdAt: "2026-08-01T00:00:00.000Z" }),
    ];
    assert.deepEqual((await cagir("/api/mini/public?userId=x")).j.items.map((t) => t.id), ["yeni", "eski"]);
  });
});

/* ── İleriye dönük gizlilik kapısı ───────────────────────────────────────── */

describe("özel turnuva kapısı", () => {
  /**
   * ⚠️ Bugün hiçbir belgede bu alan YOK — süzgeç hiçbir şeyi elemiyor.
   * İleride "yalnızca davetle" turnuva istenirse `create`'te alanı yazmak
   * yetsin diye listeleme tarafı baştan hazır. Test, o günün geldiğinde
   * kapının hâlâ çalıştığını garanti ediyor.
   */
  test("private: true listelenmez", async () => {
    _turnuvalar = [turnuva("8", { private: true })];
    assert.equal((await cagir("/api/mini/public?userId=x")).j.items.length, 0);
  });

  test('visibility: "private" listelenmez', async () => {
    _turnuvalar = [turnuva("9", { visibility: "private" })];
    assert.equal((await cagir("/api/mini/public?userId=x")).j.items.length, 0);
  });

  test("alan YOKSA listelenir (bugünkü davranış)", async () => {
    _turnuvalar = [turnuva("10")];
    assert.equal((await cagir("/api/mini/public?userId=x")).j.items.length, 1);
  });
});

/* ── Nöbetçi ─────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: uç bilinen-ölü listesinde DEĞİL", () => {
  /* Düzeltilen uç ölü listede kalırsa liste yalan söylemeye başlar —
   * `team-ranks`'te bu tam olarak yaşandı ve bayatlama nöbetçisi yakaladı. */
  /* ⚠️ YORUMLAR ELENMELİ: listeden çıkarırken yerine "…CIKARILDI" notu
   * bırakıldı ve o not yolun kendisini tırnak içinde içeriyor. İlk yazımımda
   * ham metinde aradım ve nöbetçi KENDİ AÇIKLAMAMI yakalayıp kod doğruyken
   * kırıldı. (Aynı tuzağa bu oturumda iki kez daha düştüm: fonksiyon tanımını
   * çağrı sanmak.) */
  const src = fs.readFileSync(path.join(KOK, "tests", "istemci-uc-eslesme.test.cjs"), "utf8")
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");
  const olu = src.slice(src.indexOf("BILINEN_OLU"), src.indexOf("]", src.indexOf("BILINEN_OLU")));
  assert.ok(!/"\/api\/mini\/public"/.test(olu), "/api/mini/public hala olu listede");
});
