"use strict";

/**
 * /api/pred/match-board YÖNETİCİ BİLDİRİMİNİN OKUDUĞU ALANLARI ÜRETİR.
 *
 * ⚠️ BULUNAN: live.tsx yönetici düğmesi (adminRunMatchBoard) ucu doğru yoldan
 * çağırıp yanıttan `j.leaderboard` ve `j.finalScore` okuyordu. Uç ise şunu
 * döndürüyordu:
 *
 *     { ok, fixtureId, updatedAt, segment, count, items }
 *
 * `leaderboard` HİÇBİR dönüş yolunda yok; `finalScore` da yoktu. Sonuç:
 *
 *     "match-board OK • skor: - • satır: 0"
 *
 * ...tablo dolu olsa bile. Bu boş ekrandan DAHA KÖTÜ: bildirim BAŞARI diyor
 * ve YANLIŞ sayı veriyor. Bir yönetici sonuçlandırmayı doğrularken sahte
 * güvence alıyor. `j.ok` true olduğu için `normalizeApiError` hiç çalışmıyor.
 *
 * ⚠️ DOĞRU AD KARDEŞ EKRANDA ZATEN KULLANILIYORDU: mystatus.tsx aynı uçtan
 * `j.items` okuyor. Yani uç değil, bu çağrı yanlıştı.
 *
 * ⚠️ SKOR AYRI BİR MESELE: `count` istemci tarafında düzeltilebilirdi ama
 * kesin skor bu uçta GERÇEKTEN yoktu. `leaderboard.json` maç bazlı tahmin
 * satırları tutar, skor tutmaz; skorun tek kaynağı settle anında yazılan
 * `match_results` snapshot'ı (bkz. lib/match-results.cjs, routes/settle2.cjs).
 * Bu yüzden `finalScore` sunucu tarafına EKLENDİ — istemcide uydurulacak bir
 * yeri yoktu.
 *
 * ⚠️ NEDEN YAKALANMADI: `tests/istemci-uc-eslesme.test.cjs` yalnızca YOLLARI
 * karşılaştırıyor, yanıtın ŞEKLİNİ değil. Bu oturumda aynı sınıftan BEŞ ölü
 * çağrı çıktı (weekly-picks/leaderboard, rt/competition-totals, rt/board2,
 * stats/user ve bu). Beşi de: doğru yol, yanlış şekil, `ok:true`, sessiz.
 */

const os = require("os");
const nodePath = require("path");
const fs = require("fs");

const TMP = nodePath.join(os.tmpdir(), "skorlig-match-board-sozlesme-test");
process.env.SKORLIG_DATA_DIR = TMP;
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

const FID_BITMIS = "mb-bitmis";
const FID_OYNANIYOR = "mb-oynaniyor";
const ALI = "mb-ali";
const VELI = "mb-veli";

let server = null, taban = "";

before(async () => {
  /* Şekil KODDAN okundu: leaderboard.json satırları MAÇ BAZLI
   * (realtime.cjs:303-311). İki maç, birinde iki oyuncu birinde bir. */
  fs.writeFileSync(
    nodePath.join(TMP, "leaderboard.json"),
    JSON.stringify({
      items: [
        { fixtureId: FID_BITMIS, userId: ALI, points: 10, country: "Türkiye" },
        { fixtureId: FID_BITMIS, userId: VELI, points: 4, country: "Türkiye" },
        { fixtureId: FID_OYNANIYOR, userId: ALI, points: 0, country: "Türkiye" },
      ],
      updatedAt: new Date().toISOString(),
    })
  );

  /* Skorun tek kaynağı. Yalnızca BİTMİŞ maçın snapshot'ı var — sonuçlanmamış
   * maçta `finalScore` null dönmeli, uydurulmamalı. */
  fs.writeFileSync(
    nodePath.join(TMP, "match-results.json"),
    JSON.stringify({
      items: [
        {
          fixtureId: FID_BITMIS,
          finalScore: { home: 3, away: 1 },
          computedAt: new Date().toISOString(),
        },
      ],
      updatedAt: new Date().toISOString(),
    })
  );

  const express = require("express");
  const app = express();
  app.use(express.json());
  app.use("/api", require("../routes/pred.cjs"));
  await new Promise((r) => { server = app.listen(0, r); });
  taban = `http://127.0.0.1:${server.address().port}`;
});

after(() => { if (server) server.close(); });

const al = (yol) => fetch(`${taban}${yol}`).then((r) => r.json());

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("uç GERÇEKTEN yanıt veriyor", async () => {
    /* ⚠️ Sıfır sonuç kanıt değil: uç 404/500 verseydi aşağıdaki "alan var"
     * iddiaları da düşerdi ve kusuru yanlış yerde arardım. */
    const j = await al(`/api/pred/match-board?fixtureId=${FID_BITMIS}`);
    assert.equal(j.ok, true, `match-board basarisiz: ${JSON.stringify(j).slice(0, 200)}`);
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("yönetici bildiriminin ihtiyaç duyduğu veri ULAŞILABİLİR", () => {
  test("satır sayısı count alanında ve GERÇEK sayıyı veriyor", async () => {
    const j = await al(`/api/pred/match-board?fixtureId=${FID_BITMIS}`);
    assert.equal(
      j.count, 2,
      `count ${j.count} — bildirim satir sayisini buradan okuyor, ` +
      `anahtarlar: ${JSON.stringify(Object.keys(j))}`
    );
    assert.equal(j.items.length, 2, "items ile count ayrismis");
  });

  test("kesin skor finalScore alanında mevcut", async () => {
    const j = await al(`/api/pred/match-board?fixtureId=${FID_BITMIS}`);
    assert.deepEqual(
      j.finalScore, { home: 3, away: 1 },
      `finalScore yok/yanlis: ${JSON.stringify(j.finalScore)} — bildirim ` +
      `skoru buradan okuyor, kaynak match_results snapshot'i`
    );
  });

  test("sonuçlanmamış maçta finalScore NULL — uydurulmuyor", async () => {
    /* Yönetici bildirimi "-" gösterir. Yanlış skor gostermek, hic skor
     * gostermemekten kotu; bu ucun tamami zaten o dersin urunu. */
    const j = await al(`/api/pred/match-board?fixtureId=${FID_OYNANIYOR}`);
    assert.equal(j.ok, true);
    assert.equal(j.finalScore, null, `finalScore: ${JSON.stringify(j.finalScore)}`);
    assert.equal(j.count, 1, "sonuclanmamis macta satirlar yine de sayilmali");
  });

  test("hiç satırı olmayan maçta count 0 ve ok true", async () => {
    const j = await al(`/api/pred/match-board?fixtureId=mb-yok`);
    assert.equal(j.ok, true);
    assert.equal(j.count, 0);
    assert.deepEqual(j.items, []);
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: live.tsx yönetici bildirimi ARTIK var olmayan alan okumuyor", () => {
  /* Worktree'de `../../mobile` YOK; override olmadan bu nöbetçi sessizce
   * atlanıyor ve "geçti" gibi görünüyordu. bkz. istemci-uc-eslesme.test.cjs */
  const mobilKok = process.env.SKORLIG_MOBILE_DIR ||
    nodePath.join(__dirname, "..", "..", "mobile");
  const ekran = nodePath.join(mobilKok, "app", "(tabs)", "live.tsx");
  if (!fs.existsSync(ekran)) return; // başka checkout — iddia atlanır

  /* ⚠️ YORUMLAR ELENMELİ. Düzeltmenin KENDİ açıklama notu "eskiden
   * `j.leaderboard` okunuyordu" diyor; ham metin taramasi bunu canli kod
   * sanip duzeltmeden SONRA da kirmizi kalirdi. Kardes testler ayni tuzagi
   * birden cok kez belgelemis (bkz. stats-me-ekran-sozlesmesi.test.cjs:147). */
  const src = fs.readFileSync(ekran, "utf8")
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");

  assert.ok(
    !src.includes("j.leaderboard"),
    "live.tsx /api/pred/match-board yanitinda OLMAYAN `j.leaderboard` alanini " +
    "okuyor. Uc sunlari uretiyor: ok, fixtureId, updatedAt, segment, count, " +
    "items, finalScore. `ok` true oldugu icin bildirim HATA GOSTERMEDEN " +
    "satir sayisini 0 raporlar."
  );
});
