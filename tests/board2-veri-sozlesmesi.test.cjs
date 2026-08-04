"use strict";

/**
 * /api/rt/board2 EKRANIN OKUDUĞU ŞEKLİ DÖNDÜRÜR.
 *
 * ⚠️ BULUNAN: uç ile tek istemcisi ÜÇ ayrı alanda uyuşmuyordu, ve uyuşmazlığın
 * her biri tek başına ekranı boşaltmaya yetiyordu:
 *
 *   uç (totals-read.cjs:59-66)     istemci (mobile/app/stats/board2.tsx)
 *   ------------------------------ -------------------------------------
 *   { leaderboard: [...] }         `Array.isArray(j.items)`   satır 53
 *   satır: { points }              `x.points`  → ham satır PER MAÇ, kişi başı DEĞİL
 *   satır: (bayrak yok)            `x.flag`    → hep boş
 *
 * İlk uyuşmazlık öldürücü: `j.items` undefined → `setItems([])` → boş durum
 * çizilir, `loadError` false kaldığı için HATA DA GÖSTERİLMEZ. Ekranın adı
 * "Bayraklı Liderlik" (i18n `linkFlagBoard`) ve kalıcı olarak boştu.
 *
 * İkincisi daha sinsi: `leaderboard.json` satırları MAÇ BAZLI
 * (`realtime.cjs:303-311` → {fixtureId, userId, points, country, detail}).
 * Yalnızca anahtarı `items` yapsaydım ekran aynı kullanıcıyı her maç için
 * ayrı satır olarak listelerdi — "liderlik tablosu" değil ham kayıt dökümü.
 * Kişi başı toplama ŞART.
 *
 * ⚠️ NEDEN YAKALANMADI (iki ayrı kör nokta):
 *  1) `tests/istemci-uc-eslesme.test.cjs` yalnızca YOLUN var olduğunu sınıyor,
 *     yanıtın ŞEKLİNİ değil. board2.tsx:47-49 yolun düzeltildiğini belgeliyor
 *     ("/api/stats/board2 diye bir uç YOK") — yol düzeldi, şekil kırık kaldı.
 *  2) `tests/mongo-birincil.test.cjs:63` bu ucu "istemci çağırmıyor"
 *     gerekçesiyle muaf tutuyor. O yorum ARTIK YANLIŞ: board2.tsx çağırıyor.
 *
 * ⚠️ Bu ekranı bu oturumda i18n için düzeltmiştim; metinleri çevirirken veri
 * yolunun ölü olduğunu görmedim. Ekranın "çalıştığını" varsaymak yetmiyor.
 */

const os = require("os");
const nodePath = require("path");
const fs = require("fs");

const TMP = nodePath.join(os.tmpdir(), "skorlig-board2-sozlesme-test");
process.env.SKORLIG_DATA_DIR = TMP;
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

let server = null, taban = "";

const ALI = "board2-ali";
const VELI = "board2-veli";

before(async () => {
  /* Şekil KODDAN okundu: realtime.cjs:303-311 satırları MAÇ BAZLI yazıyor.
   * Ali iki maçta oynadı (10 + 6), Veli bir maçta (4). */
  fs.writeFileSync(
    nodePath.join(TMP, "leaderboard.json"),
    JSON.stringify({
      items: [
        { fixtureId: "m1", userId: ALI,  points: 10, penalty: 0, country: "Türkiye" },
        { fixtureId: "m2", userId: ALI,  points: 6,  penalty: 0, country: "Türkiye" },
        { fixtureId: "m1", userId: VELI, points: 4,  penalty: 2, country: "Germany" },
      ],
      totals: {},
      updatedAt: "2026-08-04T10:00:00.000Z",
    })
  );

  const express = require("express");
  const app = express();
  app.locals.db = null;
  app.use("/api/rt", require("../routes/totals-read.cjs"));
  await new Promise((r) => { server = app.listen(0, r); });
  taban = `http://127.0.0.1:${server.address().port}`;
});

after(() => { if (server) server.close(); });

const al = () => fetch(`${taban}/api/rt/board2`).then((r) => r.json());

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("tohum GERÇEKTEN ucun okuduğu dosyada", async () => {
    /* ⚠️ Sıfır sonuç kanıt değil: dosyayı yanlış dizine yazsaydım boş yanıtı
     * kusur sanırdım. Uç en azından bir şey görmeli. */
    const j = await al();
    assert.equal(j.ok, true);
    const kayitVar =
      (Array.isArray(j.items) && j.items.length > 0) ||
      (Array.isArray(j.leaderboard) && j.leaderboard.length > 0);
    assert.ok(
      kayitVar,
      `uc hicbir kayit gormuyor: ${JSON.stringify(j).slice(0, 200)} — tohum ` +
      `yanlis dizinde, test bir sey olcmuyor`
    );
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("istemci sözleşmesi", () => {
  test("items ANAHTARI var (board2.tsx:53 bunu okuyor)", async () => {
    const j = await al();
    assert.ok(
      Array.isArray(j.items),
      `items yok: ${JSON.stringify(Object.keys(j))} — board2.tsx ` +
      `Array.isArray(j.items) false gorup setItems([]) yapiyor ve HATA DA ` +
      `gostermiyor (loadError false kaliyor)`
    );
  });

  test("satırlar KİŞİ BAZINDA toplanmış (maç bazında değil)", async () => {
    /* Ali iki maçta oynadı; liderlik tablosunda TEK satır olmalı. */
    const j = await al();
    const aliSatirlari = j.items.filter((x) => x.userId === ALI);
    assert.equal(
      aliSatirlari.length, 1,
      `Ali icin ${aliSatirlari.length} satir var — ham mac kayitlari ` +
      `donuyor, kisi bazinda toplanmamis. Ekran ayni kullaniciyi her mac ` +
      `icin ayri listeler.`
    );
    assert.equal(
      aliSatirlari[0].points, 16,
      `Ali puani ${aliSatirlari[0].points} (10+6=16 olmali)`
    );
  });

  test("points ALANI var (board2.tsx x.points ciziyor)", async () => {
    /* `/api/rt/totals` bu veriyi `totalPoints` adiyla donduruyor; ekran
     * `points` okuyor. Ad farki puan sutununu bos birakir. */
    const j = await al();
    for (const x of j.items) {
      assert.ok(
        typeof x.points === "number",
        `satirda sayisal points yok: ${JSON.stringify(x)}`
      );
    }
  });

  test("flag ALANI var (ekranin adi Bayrakli Liderlik)", async () => {
    const j = await al();
    const ali = j.items.find((x) => x.userId === ALI);
    const veli = j.items.find((x) => x.userId === VELI);
    assert.equal(ali.flag, "🇹🇷", `Turkiye bayragi gelmedi: ${JSON.stringify(ali)}`);
    assert.equal(veli.flag, "🇩🇪", `Almanya bayragi gelmedi: ${JSON.stringify(veli)}`);
  });

  test("puana göre azalan sıralı (ekran sira numarasi basiyor)", async () => {
    /* board2.tsx satir 128 `idx+1` yaziyor — yani SIRAYI sunucudan geldiği
     * gibi kabul ediyor, kendi siralamiyor. */
    const j = await al();
    const puanlar = j.items.map((x) => x.points);
    const sirali = [...puanlar].sort((a, b) => b - a);
    assert.deepEqual(
      puanlar, sirali,
      `sirali degil: ${JSON.stringify(puanlar)} — ekran idx+1 ile sira ` +
      `numarasi basiyor, yanlis sira yanlis derece demek`
    );
  });
});

describe("geriye dönük uyumluluk", () => {
  test("leaderboard anahtarı KORUNDU (eski tüketiciler kırılmasın)", async () => {
    /* Uç "debug / eski kullanım" olarak belgelenmişti; alan EKLENIYOR,
     * mevcut alan kaldirilmiyor. */
    const j = await al();
    assert.ok(
      Array.isArray(j.leaderboard),
      "leaderboard anahtari kaldirilmis — eski tuketici varsa kirilir"
    );
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: board2.tsx'in okuduğu HER alanı uç üretiyor", async () => {
  /**
   * İstemci ile sunucu arasındaki şekil sözleşmesini kaynaktan çıkarıp
   * karşılaştırır. `istemci-uc-eslesme.test.cjs` yalnızca YOLU eşliyor; bu
   * nöbetçi ALANLARI eşliyor — kusurun asıl sınıfı buydu.
   */
  const ekran = nodePath.join(
    __dirname, "..", "..", "mobile", "app", "stats", "board2.tsx"
  );
  if (!fs.existsSync(ekran)) return; // başka checkout — iddia atlanır

  const src = fs.readFileSync(ekran, "utf8");

  /* Ekranın satırdan okuduğu alanlar: `x.<ad>` geçişleri. */
  const okunan = new Set(
    [...src.matchAll(/\bx\.([a-zA-Z_][a-zA-Z0-9_]*)/g)].map((m) => m[1])
  );
  assert.ok(
    okunan.size > 0,
    "ekranda x.<alan> gecisi bulunamadi — tarama bozuk (bicim degisti mi?)"
  );

  const j = await al();
  assert.ok(Array.isArray(j.items) && j.items.length > 0, "items bos — karsilastirilamaz");
  const uretilen = new Set(Object.keys(j.items[0]));

  const eksik = [...okunan].filter((a) => !uretilen.has(a));
  assert.deepEqual(
    eksik, [],
    `board2.tsx su alanlari okuyor ama /api/rt/board2 uretmiyor: ${eksik.join(", ")}.\n` +
    `Uretilen alanlar: ${[...uretilen].join(", ")}`
  );
});
