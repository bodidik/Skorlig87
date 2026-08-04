"use strict";

/**
 * PARAMETRİK ROTA, KARDEŞ ROTAYI GÖLGELEMEZ.
 *
 * ⚠️ BULUNAN: `series.cjs` `/api` köküne bağlanıyor ve tek segmentlik bir
 * joker tanımlıyor:
 *
 *     server.cjs:361  app.use("/api", require("./routes/series.cjs"))
 *     series.cjs:31   router.get("/:sid/leaderboard", ...)
 *
 * Yani gerçek URL `/api/:sid/leaderboard` — yani İKİ segmentlik HER isteği
 * yakalıyor. `weekly-picks` 26 satır SONRA bağlanıyor (server.cjs:387) ve
 * `/leaderboard` tanımlıyor. Express mount sırasına göre eşleştirdiği için:
 *
 *     GET /api/weekly-picks/leaderboard  →  series.cjs (sid="weekly-picks")
 *     weekly-picks.cjs:488               →  ÖLÜ KOD, hiç çalışmıyor
 *
 * Üstelik gölgeleyen yanıt da boş: series.cjs `preds.json`i
 * `{matches:[…], preds:[…]}` sanıyor, oysa tek yazıcı (`models/preds.cjs:84`)
 * DÜZ DİZİ yazıyor. `[].matches` undefined → iki dizi de boş → leaderboard
 * her zaman [].
 *
 * KULLANICIYA ULAŞAN ETKİ: `mobile/components/Picks1987.tsx:209` bu ucu
 * çağırıp `j.items` / `j.me` / `j.total1987` okuyor. series `{ok:true,
 * leaderboard:[]}` dönüyor — `ok` true olduğu için ekran BAŞARI kolunu
 * seçiyor ve boş tabloyu, `null` sırayı, `0` katılımcıyı çiziyor. Sessiz
 * hatanın ders kitabı hâli: HTTP 200 + ok:true + boş veri.
 *
 * ⚠️ NEDEN MEVCUT NÖBETÇİ KAÇIRDI: `tests/rota-golgeleme.test.cjs:89` tam
 * yolları METİN olarak birleştirip donmuş bir kümeyle karşılaştırıyor.
 * `GET /api/:sid/leaderboard` ile `GET /api/weekly-picks/leaderboard` farklı
 * metinler, dolayısıyla çakışma hiç görünmüyor. O nöbetçi yalnızca BİREBİR
 * çakışmayı yakalıyor, parametrik olanı değil. Bu test o kör noktayı kapatır.
 */

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const nodePath = require("path");

let server = null, taban = "";

before(async () => {
  const express = require("express");
  const app = express();
  app.locals.db = null;
  app.use(express.json());

  /* ⚠️ ÖNEK VE SIRA server.cjs'ten OKUNUYOR, elle yazılmıyor.
   *
   * Elle `/api` yazsaydım düzeltmeden sonra test gölgelemeyi kendi kurduğu
   * kurulumda üretmeye devam eder, yani düzeltmeyi hiç doğrulamazdı. Öneki
   * kaynaktan çekmek, testi gerçek yapılandırmaya bağlar: server.cjs ileride
   * yanlışlıkla `/api` köküne geri alınırsa bu test kırmızıya döner.
   *
   * Sıra da bilerek server.cjs'teki gibi (series ÖNCE). */
  const srv = fs.readFileSync(nodePath.join(__dirname, "..", "server.cjs"), "utf8");
  const seriesOnek = srv.match(
    /app\.use\(\s*"([^"]+)"\s*,\s*require\(\s*"\.\/routes\/series\.cjs"/
  )?.[1];
  assert.ok(seriesOnek, "server.cjs icinde series mount'u bulunamadi — tarama bozuk");

  app.use(seriesOnek, require("../routes/series.cjs"));
  app.use("/api/weekly-picks", require("../routes/weekly-picks.cjs"));

  await new Promise((r) => { server = app.listen(0, r); });
  taban = `http://127.0.0.1:${server.address().port}`;
});

after(() => { if (server) server.close(); });

const al = (yol) => fetch(`${taban}${yol}`).then(async (r) => ({
  durum: r.status,
  govde: await r.json().catch(() => null),
}));

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("iki rota da GERÇEKTEN bağlandı", async () => {
    /* Bir mount sessizce patlasaydı aşağıdaki iddialar boşlukta doğru
     * görünürdü. En az birinin yanıt verdiğini doğruluyoruz. */
    const r = await al("/api/weekly-picks/leaderboard");
    assert.notEqual(r.durum, 404, "hicbir rota yanit vermiyor — mount bozuk");
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("weekly-picks/leaderboard gölgelenmiyor", () => {
  test("yanıt weekly-picks uygulamasından geliyor", async () => {
    const { govde } = await al("/api/weekly-picks/leaderboard?limit=50");

    /* Kimin yanıtladığını ŞEKİLDEN anlıyoruz:
     *   weekly-picks → { ok, count, items, week }  (satır 504/545)
     *   series       → { ok, size, requested, finished, leaderboard } (satır 73)
     * `size`/`leaderboard` görmek gölgelemenin kanıtı. */
    assert.ok(govde, "yanit govdesi yok");
    assert.ok(
      !("leaderboard" in govde) && !("requested" in govde),
      `yanit series.cjs'ten geldi: ${JSON.stringify(govde)} — parametrik rota ` +
      `/api/:sid/leaderboard kardes rotayi golgeliyor`
    );
    assert.ok(
      "items" in govde,
      `yanitta items yok: ${JSON.stringify(govde)} — mobile/components/` +
      `Picks1987.tsx:209 j.items okuyor`
    );
  });

  test("mobilin okuduğu alanlar mevcut (items / total1987)", async () => {
    /* Picks1987.tsx:211-213:
     *     setBoard(j.items ?? []); setMyRank(j.me ?? null);
     *     setTotal1987(j.total1987 ?? 0);
     * `ok:true` gelip bu alanlar yoksa ekran sessizce boş çizer. */
    const { govde } = await al("/api/weekly-picks/leaderboard?limit=50&userId=biri");
    assert.equal(govde.ok, true);
    assert.ok(Array.isArray(govde.items), `items dizi degil: ${JSON.stringify(govde)}`);
    assert.ok(
      "total1987" in govde || govde.count === 0,
      `total1987 yok ve count sifir degil: ${JSON.stringify(govde)}`
    );
  });
});

describe("series kendi ön ekinde çalışıyor", () => {
  test("/api/series/:sid/leaderboard 404 DEĞİL", async () => {
    /* series.cjs'in kendi belgesi (satır 27) bu URL'i vaat ediyor; `/api`
     * kokune baglandigi surece o URL 404 veriyordu. */
    const r = await al("/api/series/abc/leaderboard");
    assert.notEqual(
      r.durum, 404,
      "series kendi belgeledigi URL'de 404 — /api/series onekine baglanmali"
    );
  });

  test("series artık rastgele iki segmentlik yolu YUTMUYOR", async () => {
    /* Gölgelemenin özü buydu: `/api/<herhangi>/leaderboard` series'e
     * düşüyordu. Artık düşmemeli. */
    const { govde } = await al("/api/rastgele-birsey/leaderboard");
    if (govde) {
      assert.ok(
        !("requested" in govde),
        `series hala joker yakaliyor: ${JSON.stringify(govde)}`
      );
    }
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: /api köküne PARAMETRİK ilk segmentle rota bağlanmıyor", () => {
  /**
   * Kaynak taraması, davranış testinin tamamlayıcısı. Mevcut nöbetçi
   * (`rota-golgeleme.test.cjs`) tam yolları METİN olarak karşılaştırdığı için
   * `/api/:sid/...` ile `/api/weekly-picks/...` çakışmasını göremiyor.
   *
   * Kural: `/api` köküne bağlanan bir router'ın İLK yol segmenti parametre
   * (`:x`) olamaz — öyleyse `/api` altındaki HER iki-segmentli kardeş rotayı
   * yutar ve mount sırasına göre sessizce gölgeler.
   */
  const srv = fs.readFileSync(
    nodePath.join(__dirname, "..", "server.cjs"), "utf8"
  );

  /* `/api` KÖKÜNE bağlanan router dosyalarını çıkar (alt önek olanlar güvenli). */
  const kokeBaglilar = [];
  for (const m of srv.matchAll(
    /app\.use\(\s*"\/api"\s*,\s*require\(\s*"\.\/routes\/([\w.-]+)"\s*\)/g
  )) {
    kokeBaglilar.push(m[1]);
  }
  assert.ok(
    kokeBaglilar.length > 0,
    "/api kokune bagli hic router bulunamadi — tarama bozuk (server.cjs bicimi degisti mi?)"
  );

  const suclu = [];
  for (const dosya of kokeBaglilar) {
    const yol = nodePath.join(__dirname, "..", "routes", dosya);
    if (!fs.existsSync(yol)) continue;
    const src = fs.readFileSync(yol, "utf8");
    const kod = src.split("\n")
      .map((l) => {
        const t = l.trim();
        return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
      })
      .join("\n");

    for (const m of kod.matchAll(
      /router\.(get|post|put|patch|delete)\(\s*"(\/[^"]*)"/g
    )) {
      const yolDeseni = m[2];
      const ilkSegment = yolDeseni.split("/")[1] || "";
      if (ilkSegment.startsWith(":")) {
        suclu.push(`${dosya}: ${m[1].toUpperCase()} ${yolDeseni}`);
      }
    }
  }

  assert.deepEqual(
    suclu, [],
    "/api kokune bagli router(lar) PARAMETRIK ilk segmentle rota tanimliyor.\n" +
    "Bu, /api altindaki her kardes rotayi mount sirasina gore sessizce\n" +
    "golgeler (weekly-picks/leaderboard tam olarak boyle olmustu).\n" +
    "Cozum: router'i kendi onekine bagla (ornegin /api/series).\n" +
    suclu.join("\n")
  );
});
