"use strict";

/**
 * `GET /api/mini/board` KİŞİSEL ALANLARI YALNIZCA SAHİBİNE DÖNDÜRÜR.
 *
 * ⚠️ BULUNAN: uç hiçbir kimlik ara katmanı taşımıyordu ama `?userId=` okuyup o
 * kişinin `myRow`, `myRank` ve `friendsInBoard` alanlarını döndürüyordu.
 * Sonuncusu `SocialStore.loadFriends` ile o kullanıcının ARKADAŞ LİSTESİNİ
 * okuyup panoyla kesiştiriyor. Yani isteyen herkes başkasının kimliğini yazıp
 * o kişinin bu turnuvadaki arkadaşlarını öğrenebiliyordu — kullanıcı
 * kimlikleri sıralama tablolarında zaten görünür, yani hedef seçmek kolaydı.
 *
 * ⚠️ NEDEN GÖRÜLMEDİ: `kimlik-sinifi-nobeti` nöbetçisi bunu YAKALADI ve o
 * günden beri KIRMIZIYDI — kişisel alanlar uca sonradan eklendi, kimlik kapısı
 * eklenmedi. Kırık test, süitteki 74 hatanın arasında kayboldu; kalan 73'ü ise
 * bu depoda değil, worktree kurulumunda (node_modules erişilemiyordu).
 * Yani nöbetçi işini yaptı, gürültü onu görünmez kıldı.
 *
 * ⚠️ KİMLİK ARTIK JETONDAN. `?userId=` yok sayılıyor. İstemci onu derin
 * bağlantının sorgusundan alıyor (`app/mini/[id].tsx`, yoksa "demo1"), yani
 * hem sızıntının taşıyıcısıydı hem de sessiz bir kusur: parametresiz açılan
 * ekran giriş yapmış kullanıcıya BAŞKASININ satırını gösteriyordu.
 *
 * Pano herkese açık kalıyor (`optionalToken`); yalnızca kişisel blok kapalı.
 */

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "skorlig-mini-kimlik-"));
process.env.SKORLIG_DATA_DIR = TMP;
process.env.SKORLIG_BG = "0";

/**
 * ⚠️ `optionalToken` GERÇEĞİ GİBİ TAKLİT EDİLİYOR: jeton başlığı YOKSA
 * `req.uid = null`. Eskisi gibi `x-user-id`yi koşulsuz kabul eden bir taklit,
 * düzeltmenin tam sınamak istediği "jeton olmadan kişisel veri yok" kuralını
 * atlar ve test yanlış yere yeşil yanardı.
 */
const vt = require.resolve(path.join(KOK, "middleware", "verifyToken.cjs"));
require.cache[vt] = { id: vt, filename: vt, loaded: true, exports: {
  verifyToken: (q, _r, n) => { q.uid = q.headers["x-user-id"]; n(); },
  optionalToken: (q, _r, n) => {
    q.uid = q.headers["x-auth-token"] ? (q.headers["x-user-id"] || null) : null;
    n();
  },
  getFirebaseAuth: () => null, kimlikModu: () => "test",
}};

const AYSE = "ayse", BURAK = "burak", CEM = "cem", DENIZ = "deniz";

/* Turnuva ve arkadaşlık deposu denetim altında — ölçülen şey uç, depo değil. */
const socialYol = require.resolve(path.join(KOK, "lib", "social-store.cjs"));
const gercekSocial = require(socialYol);
const TURNUVA = {
  id: "m1", code: "MINI01", name: "Kimlik",
  ownerId: AYSE,
  members: [AYSE, BURAK, CEM, DENIZ],
  fixtures: [],
  createdAt: new Date().toISOString(),
  finishedAt: null,
};
require.cache[socialYol].exports = {
  ...gercekSocial,
  loadMini: async () => [JSON.parse(JSON.stringify(TURNUVA))],
  /* AYŞE ile BURAK arkadaş; CEM ile DENIZ arkadaş. Ayşe'nin grafiği sızarsa
   * yanıtta BURAK görünür. */
  loadFriends: async () => ({
    links: [{ a: AYSE, b: BURAK }, { a: CEM, b: DENIZ }],
    requests: [], blocks: [],
  }),
};

const express = require("express");

let srv = null, port = 0;

before(async () => {
  const app = express();
  app.use((q, _r, n) => { q.app.locals.db = null; n(); });
  app.use("/api/mini", require(path.join(KOK, "routes", "mini.cjs")));
  srv = app.listen(0);
  /* `listening` beklenmezse port bazen 0 kalıyor ve süit arada bir kırılıyor. */
  await new Promise((r) => (srv.listening ? r() : srv.once("listening", r)));
  port = srv.address().port;
});

after(async () => {
  if (srv) await new Promise((r) => srv.close(r));
  fs.rmSync(TMP, { recursive: true, force: true });
});

/** @param {{jeton?:string, sorguUserId?:string}} opt */
async function board(opt = {}) {
  let yol = `http://127.0.0.1:${port}/api/mini/board?id=m1`;
  if (opt.sorguUserId) yol += `&userId=${encodeURIComponent(opt.sorguUserId)}`;
  const basliklar = {};
  if (opt.jeton) {
    basliklar["x-auth-token"] = "sahte-jeton";
    basliklar["x-user-id"] = opt.jeton;
  }
  const r = await fetch(yol, { headers: basliklar });
  return { durum: r.status, govde: await r.json() };
}

const kimlikler = (satirlar) =>
  (satirlar || []).map((x) => String(x.userId || "").toLowerCase()).sort();

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("pano gerçekten dolu ve arkadaşlık verisi işliyor", async () => {
    /* Sızıntı iddiaları "alan boş" ile "alan yok" ayrımına dayanıyor. Kişisel
     * blok her koşulda boş dönseydi aşağıdaki testler bir şey ölçmezdi. */
    const { durum, govde } = await board({ jeton: AYSE });
    assert.equal(durum, 200, `durum ${durum}`);
    assert.deepEqual(
      kimlikler(govde.board), [AYSE, BURAK, CEM, DENIZ].sort(),
      `pano beklenen uyeleri tasimiyor: ${JSON.stringify(govde.board)}`
    );
    assert.ok(govde.myRow, "kendi satiri BOS — kurulum bozuk, sizinti testleri anlamsiz olurdu");
    assert.deepEqual(
      kimlikler(govde.friendsInBoard), [BURAK],
      `ayse'nin arkadas kesisimi beklenen degil: ${JSON.stringify(govde.friendsInBoard)}`
    );
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("kişisel alanlar sorgudan seçilemiyor", () => {
  test("KİMLİKSİZ istek başkasının arkadaş listesini ALAMAZ", async () => {
    /**
     * ⚠️ ASIL SIZINTI BUYDU: jeton yok, `?userId=` var. Eskiden bu istek
     * Ayşe'nin satırını, sırasını ve ARKADAŞLARINI döndürüyordu.
     */
    const { durum, govde } = await board({ sorguUserId: AYSE });

    assert.equal(durum, 200, `pano herkese acik kalmali, durum ${durum}`);
    assert.deepEqual(
      kimlikler(govde.friendsInBoard), [],
      `kimliksiz istege arkadas listesi dondu: ${JSON.stringify(govde.friendsInBoard)} — ` +
      `isteyen herkes baskasinin sosyal grafigini okuyabiliyor`
    );
    assert.equal(govde.myRow, null, `kimliksiz istege kendi satiri dondu: ${JSON.stringify(govde.myRow)}`);
    assert.equal(govde.myRank, null, `kimliksiz istege sira dondu: ${govde.myRank}`);
  });

  test("BAŞKASININ kimliğini yazmak o kişinin verisini getirmiyor", async () => {
    /* Cem giriş yapmış ve sorguya Ayşe'yi yazıyor. Dönen kişisel blok CEM'e
     * ait olmalı — Ayşe'nin arkadaşı Burak GÖRÜNMEMELİ. */
    const { govde } = await board({ jeton: CEM, sorguUserId: AYSE });

    assert.equal(
      String(govde.myRow?.userId || "").toLowerCase(), CEM,
      `sorgudaki kimlik kazandi: myRow=${JSON.stringify(govde.myRow)} — jetondaki ` +
      `kimlik her zaman yenmeli`
    );
    assert.deepEqual(
      kimlikler(govde.friendsInBoard), [DENIZ],
      `cem'e ayse'nin arkadas kesisimi dondu: ${JSON.stringify(govde.friendsInBoard)}`
    );
    assert.ok(
      !kimlikler(govde.friendsInBoard).includes(BURAK),
      "ayse'nin arkadasi sizdi"
    );
  });

  test("sorgu parametresi OLMADAN kendi verisi geliyor", async () => {
    /* ⚠️ Düzeltme "kişisel alanları kapat" DEĞİL. İstemci parametreyi
     * göndermese de (ya da eski bağlantıdan yabancı bir değer taşısa da)
     * ekranın kendi satırını göstermesi gerekiyor. */
    const { govde } = await board({ jeton: BURAK });
    assert.equal(String(govde.myRow?.userId || "").toLowerCase(), BURAK);
    assert.deepEqual(kimlikler(govde.friendsInBoard), [AYSE]);
  });

  test("uyumsuz ?userId= 403 üretmiyor — pano yine dönüyor", async () => {
    /* Reddetmek ekranı komple karartırdı: istemci derin bağlantıdan gelen
     * yabancı bir kimlik taşıyabiliyor. Yok saymak sızıntıyı aynı ölçüde
     * kapatıyor. */
    const { durum, govde } = await board({ jeton: CEM, sorguUserId: "bambaska" });
    assert.equal(durum, 200, `durum ${durum} — pano karartilmis`);
    assert.equal(govde.ok, true);
    assert.deepEqual(kimlikler(govde.board), [AYSE, BURAK, CEM, DENIZ].sort());
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: /board kimlik ara katmanı taşıyor ve sorgudan kimlik okumuyor", () => {
  /**
   * Davranış testleri sızıntıyı yakalar; bu nöbetçi NEDENİ söyler. İki kural
   * birden: rota bir kimlik kapısından geçmeli VE kişisel blok sorgudaki
   * `userId`ye dönmemeli. İkisinden biri gevşerse sınıf geri gelir —
   * `kimlik-sinifi-nobeti` genel taraması yalnızca birincisini görüyor.
   */
  const src = fs.readFileSync(path.join(KOK, "routes", "mini.cjs"), "utf8");
  const bas = src.indexOf('router.get("/board"');
  assert.ok(bas > 0, "/board rotasi bulunamadi");
  const kalan = src.slice(bas);
  const bit = kalan.search(/\nrouter\.(get|post|put|patch|delete)\(/);
  const govdeHam = bit >= 0 ? kalan.slice(0, bit) : kalan;
  const govde = govdeHam.split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");

  assert.ok(
    /router\.get\("\/board",\s*(optionalToken|verifyToken)/.test(govde),
    "/board kimlik ara katmani tasimiyor — kisisel alanlar dogrulanmamis kimlige aciliyor"
  );
  assert.ok(
    !/req\.query\.userId/.test(govde),
    "/board yine sorgudan userId okuyor — kisisel alanlar istemcinin sectigi " +
    "kimlige donerse sosyal grafik sizar"
  );
});
