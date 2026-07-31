"use strict";

/**
 * YARIŞMA TOPLAMLARI — bot işareti gerçekten çalışıyor mu?
 *
 * ⚠️ NEDEN DAVRANIŞ TESTİ: bu oturumda bir kez kaynağa bakmadan sabit uydurup
 * (düello durumu `"accepted"` sanılmıştı) yeşil ama ölü bir test yazmıştım.
 * Burada aynı hataya düşmemek için uç GERÇEKTEN çağrılıyor ve yanıtın içine
 * bakılıyor — kaynak metni aranmıyor.
 *
 * ⚠️ NE KORUYOR: `/api/rt/competition-totals` DÖRT ayrı yerden yanıt dönüyor
 * (Mongo tablo, Mongo toplama, dosya toplama, boş sonuç). Yarışma toplamları
 * `leaderboard` anlık görüntülerindeki `rows` üzerinden toplanıyor ve settle2
 * o satırlara BOTLARI da yazıyor. Ana sıralamada ölçülmüştü: 1707 kaydın
 * 1706'sı bot. Bu uç iki istemci ekranı tarafından çağrılıyor ve yanıt bot
 * olup olmadığını hiç söylemiyordu.
 *
 * Karar (leaderboard.cjs, 2026-07-29): botları SİLME, İŞARETLE, `?humans=1`
 * ile isteğe bağlı süz.
 */

const os = require("os");
const nodePath = require("path");
const fs = require("fs");

const TMP = nodePath.join(os.tmpdir(), "skorlig-yarisma-bot-test");
process.env.SKORLIG_DATA_DIR = TMP;
fs.mkdirSync(TMP, { recursive: true });

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

/**
 * ⚠️ BOT KADROSU `SKORLIG_DATA_DIR` ALTINDAN OKUNUYOR.
 *
 * `lib/botIds.cjs` kadroyu `data/bot-profiles.json`dan yükler. Bu test veri
 * dizinini izole ettiği için modülü doğrudan require etmek BOŞ küme verir —
 * ilk denemede tam olarak bu oldu ve `BOT_UID` undefined kaldı, tohumlanan
 * satır "anon" olarak yazıldı. Bu yüzden kimlik GERÇEK kadro dosyasından
 * okunuyor; sabit uydurmak (bu oturumda bir kez yapıldı) yeşil-ama-ölü test
 * üretir.
 */
const GERCEK_KADRO = nodePath.join(__dirname, "..", "data", "bot-profiles.json");
const kadro = JSON.parse(fs.readFileSync(GERCEK_KADRO, "utf8"));
const BOT_UID = String(kadro[0].id || kadro[0].userId);
const INSAN_UID = "gercek-oyuncu-1";

let server = null, taban = "";

before(async () => {
  /* Bot kadrosunu izole veri dizinine KOPYALA.
   * `lib/botIds.cjs` kadroyu DATA_DIR altından okuyor; kopyalamazsak küme boş
   * kalır ve `isBot` herkese false der — test yeşil görünür ama hiçbir şey
   * ölçmez. (Elle kopyalamaya bırakmak da olmaz: test kendi kendine yeter.) */
  for (const ad of ["bot-profiles.json", "bot-legacy-ids.json"]) {
    fs.copyFileSync(nodePath.join(__dirname, "..", "data", ad), nodePath.join(TMP, ad));
  }

  // Dosya tabanlı toplama yolu için veri tohumla.
  fs.writeFileSync(
    nodePath.join(TMP, "fixture-competitions.json"),
    // Şekil KODDAN okundu: `competitions` bir DİZİ, düz alan değil.
    // (Bu oturumda bir kez şekli tahmin edip yeşil-ama-ölü test yazmıştım.)
    JSON.stringify({
      items: [
        { fixtureId: "m1", competitions: [{ competitionId: "KUPA1", countsForPoints: true }] },
      ],
    })
  );
  fs.writeFileSync(
    nodePath.join(TMP, "leaderboard.json"),
    JSON.stringify({
      items: [
        { fixtureId: "m1", userId: BOT_UID, points: 90 },
        { fixtureId: "m1", userId: INSAN_UID, points: 10 },
      ],
    })
  );

  // Sunucu GERÇEK veri dizinini kullansın ki kadro yüklensin; yalnızca
  // toplama girdileri izole dizinden okunacak şekilde kopyalanıyor.
  const express = require("express");
  const app = express();
  app.locals.db = null;                       // dosya yoluna zorla
  app.use("/api/rt", require("../routes/competition-totals.cjs"));
  await new Promise((r) => { server = app.listen(0, r); });
  taban = `http://127.0.0.1:${server.address().port}`;
});
after(() => { if (server) server.close(); });

const al = (q) => fetch(`${taban}/api/rt/competition-totals?${q}`).then((r) => r.json());

describe("bot işareti", () => {
  test("tohumlanan veri gerçekten yanıta geliyor", async () => {
    // Önce testin BİR ŞEY ölçtüğünden emin ol: liste boşsa aşağıdaki
    // iddialar boşlukta doğru görünürdü.
    const r = await al("competitionId=KUPA1");
    assert.equal(r.ok, true);
    assert.ok(r.items.length >= 2, `liste bos/eksik (${r.items.length}) — test bir sey olcmuyor`);
  });

  test("her satır isBot alanı taşır", async () => {
    const r = await al("competitionId=KUPA1");
    for (const x of r.items) {
      assert.ok("isBot" in x, `satirda isBot yok: ${JSON.stringify(x)}`);
    }
  });

  test("bot doğru işaretleniyor, insan işaretlenmiyor", async () => {
    const r = await al("competitionId=KUPA1");
    const bot = r.items.find((x) => String(x.userId).toLowerCase() === BOT_UID.toLowerCase());
    const insan = r.items.find((x) => String(x.userId).toLowerCase() === INSAN_UID);
    assert.ok(bot, "bot satiri yok");
    assert.ok(insan, "insan satiri yok");
    assert.equal(bot.isBot, true);
    assert.equal(insan.isBot, false);
  });
});

describe("?humans=1", () => {
  test("yalnızca gerçek oyuncular döner", async () => {
    const r = await al("competitionId=KUPA1&humans=1");
    assert.equal(r.items.length, 1, "bot suzulmemis");
    assert.equal(String(r.items[0].userId).toLowerCase(), INSAN_UID);
  });

  test("count süzgeçten SONRAKİ sayıyı gösterir", async () => {
    // Süzgeç uygulanıp `count` eski değerde kalsaydı arayüz "1 / 2" gibi
    // tutarsız bir şey gösterirdi.
    const r = await al("competitionId=KUPA1&humans=1");
    assert.equal(r.count, r.items.length);
  });

  test("varsayılan (humans yok) botu ELEMEZ", async () => {
    // Karar: botlar listeyi canlı gösteriyor; silmek değil işaretlemek.
    const r = await al("competitionId=KUPA1");
    assert.equal(r.items.length, 2);
  });
});
