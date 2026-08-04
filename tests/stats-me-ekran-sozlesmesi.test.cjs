"use strict";

/**
 * app/stats/me.tsx EKRANININ OKUDUĞU ALANLAR GERÇEKTEN ÜRETİLİYOR.
 *
 * ⚠️ BULUNAN: ekran `/api/stats/user` çağırıp `j.flag`, `j.team`, `j.total`,
 * `j.items` okuyordu. Bu DÖRT alanın HİÇBİRİ hiçbir dönüş yolunda yok —
 * ne Mongo kolunda ne dosya kolunda. Uç şunu döndürüyor:
 *
 *     { ok, kendisi, userId, source,
 *       season: { total, played, penalties, avg, lastAt, key, kisitli },
 *       recentMatches, wallet, walletLedger }
 *
 * Ekran var olmayan bir API'ye göre yazılmış: satır şekli de üçüncü bir şey
 * (`it.home`/`it.away` tahmin skoru + iç içe `it.live`), ne `recentMatches`
 * ne de `/api/pred/my` bunu üretiyor.
 *
 * Kullanıcının gördüğü: başlıkta yalnız ham userId (bayrak yok, takım yok),
 * "Genel Puan" HERKESE sabit 0, "Son oynananlar" kalıcı boş.
 *
 * HATA GÖSTERİLMİYOR: tek koruma `if (!j?.ok) throw` (me.tsx:73) ve `ok` her
 * zaman true. Alert hiç çalışmıyor. Ekran `stats.tsx:695`ten erişilebilir
 * ("Detaylı Ben Sayfası").
 *
 * ⚠️ AYNI UCU KARDEŞ EKRAN DOĞRU OKUYOR: `competition-kings.tsx:182`
 * `s.recentMatches` diyor. Yani uç değil, bu ekran yanlıştı.
 *
 * ⚠️ NEDEN YAKALANMADI: `istemci-uc-eslesme.test.cjs` yalnızca YOLUN var
 * olduğunu sınıyor, yanıtın ŞEKLİNİ değil. Bu oturumda aynı sınıftan DÖRT
 * ölü ekran çıktı (1987 sıralama, kupa tablosu, board2, bu).
 */

const os = require("os");
const nodePath = require("path");
const fs = require("fs");

const TMP = nodePath.join(os.tmpdir(), "skorlig-stats-me-sozlesme-test");
process.env.SKORLIG_DATA_DIR = TMP;
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

const UID = "statsme-ali";
const ULKE = "Türkiye";
const TAKIM = "Galatasaray";

let mongod = null, client = null, db = null, server = null, taban = "";

before(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const { MongoClient } = require("mongodb");
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  db = client.db("test");

  await db.collection("users").insertOne({
    userId: UID, userIdLower: UID, nickname: "Ali",
    mainTeam: TAKIM, country: ULKE, totals: 0,
  });

  const express = require("express");
  const app = express();
  app.locals.db = db;
  app.use(express.json());
  app.use("/api/stats", require("../routes/stats.cjs"));
  app.use("/api/users", require("../routes/users.cjs"));
  await new Promise((r) => { server = app.listen(0, r); });
  taban = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) server.close();
  if (client) await client.close();
  if (mongod) await mongod.stop();
});

const al = (yol) => fetch(`${taban}${yol}`).then((r) => r.json());

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("uçlar GERÇEKTEN yanıt veriyor", async () => {
    /* ⚠️ Sıfır sonuç kanıt değil: uç 404/500 verse aşağıdaki "alan yok"
     * iddiaları da düşerdi ve kusuru yanlış yerde arardım. */
    const s = await al(`/api/stats/user?userId=${UID}`);
    const p = await al(`/api/users/profile?userId=${UID}`);
    assert.equal(s.ok, true, `stats/user basarisiz: ${JSON.stringify(s).slice(0, 200)}`);
    assert.equal(p.ok, true, `users/profile basarisiz: ${JSON.stringify(p).slice(0, 200)}`);
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("ekranın ihtiyaç duyduğu veri ULAŞILABİLİR", () => {
  test("toplam puan season.total'da mevcut", async () => {
    const j = await al(`/api/stats/user?userId=${UID}`);
    assert.ok(
      j.season && typeof j.season.total === "number",
      `season.total yok: ${JSON.stringify(Object.keys(j))} — ekran "Genel Puan" ` +
      `icin bir kaynak bulamiyor`
    );
  });

  test("takım adı profile.mainTeam'de mevcut", async () => {
    const j = await al(`/api/users/profile?userId=${UID}`);
    assert.equal(j.profile?.mainTeam, TAKIM, `mainTeam: ${j.profile?.mainTeam}`);
  });

  test("BAYRAK sunucudan geliyor (mobilde ülke→bayrak tablosu YOK)", async () => {
    /* Bayrak tek kaynak `lib/countries.cjs`; istemciye 200+ ülkelik ikinci bir
     * tablo koymak iki kaynagin ayrismasi demekti (ayni karar /board2'de de
     * verildi). Ekran bayragi gosteriyor, uc uretmeliydi. */
    const j = await al(`/api/users/profile?userId=${UID}`);
    assert.equal(
      j.profile?.flag, "🇹🇷",
      `profile.flag yok/yanlis: ${JSON.stringify(j.profile)} — ulke "${ULKE}" ` +
      `kayitli ama bayrak turetilmiyor`
    );
  });

  test("ülkesi olmayan kullanıcıda bayrak BOŞ, undefined değil", async () => {
    await db.collection("users").insertOne({
      userId: "statsme-ulkesiz", userIdLower: "statsme-ulkesiz", totals: 0,
    });
    const j = await al(`/api/users/profile?userId=statsme-ulkesiz`);
    assert.equal(j.profile?.flag, "", `bayrak "${j.profile?.flag}" — bos string olmali`);
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: stats/me ekranı ARTIK var olmayan alanları okumuyor", () => {
  /**
   * Bu sınıfın genel nöbetçisi: ekranın `/api/stats/user` yanıtından okuduğu
   * alanların ucun ÜRETTİĞİ alanlar arasında olması gerekir.
   *
   * `istemci-uc-eslesme.test.cjs` yalnızca yolu eşliyor — bu oturumda dört
   * ölü ekranın dördü de yolu doğru, şekli yanlıştı.
   */
  const ekran = nodePath.join(
    __dirname, "..", "..", "mobile", "app", "stats", "me.tsx"
  );
  if (!fs.existsSync(ekran)) return; // başka checkout — iddia atlanır

  /* ⚠️ YORUMLAR ELENMELİ — İLK HÂLİ HAM METİNDE ARIYORDU.
   *
   * Düzeltmenin KENDİ açıklama notu "eskiden `j.total` okunuyordu" diyor;
   * ham metin taraması bunu canlı kod sandı ve nöbetçi düzeltme yapıldıktan
   * SONRA da kırmızı kaldı. Bu deponun kardeş testleri aynı tuzağı birden
   * çok kez belgelemiş (bkz. tahmin-cifte-ucret.test.cjs:205 notu). */
  const src = fs.readFileSync(ekran, "utf8")
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");

  /* Uçun ÜRETMEDİĞİ, eskiden okunan alanlar. Geri gelirlerse ekran yine
   * sessizce boşalır. */
  const OLU = ["j.flag", "j.team", "j.total", "j.items"];
  const geriGelen = OLU.filter((a) => src.includes(a));

  assert.deepEqual(
    geriGelen, [],
    `stats/me ekrani /api/stats/user yanitinda OLMAYAN alanlari okuyor: ` +
    `${geriGelen.join(", ")}.\nUc sunlari uretiyor: ok, kendisi, userId, ` +
    `source, season{total,played,penalties,avg,...}, recentMatches, wallet, ` +
    `walletLedger. Ekran "ok" true oldugu icin HATA GOSTERMEDEN bos cizer.`
  );
});
