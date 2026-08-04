"use strict";

/**
 * /api/rt/live-gs CANLI HATTIN YAZDIĞI DURUMU GÖRÜR.
 *
 * ⚠️ BULUNAN: bu uç durumu YALNIZCA `data/rt-live-gs.json`den okuyordu
 * (`rt.live-gs.cjs:180 getFixtureState` → `loadLive()` → satır 23 LIVE_FILE).
 * O dosyayı ise yalnızca YÖNETİCİ yazıyor (admin POST / provider çekimi).
 *
 * Gerçek canlı durum her fikstür için `data/live/<fid>.json`de duruyor ve onu
 * `services/livescore-sync.cjs:306 writeLiveState` yazıyor. Uygulamanın geri
 * kalanı oradan okuyor: realtime.cjs, settle2.cjs, pred-weights.cjs, mini.cjs,
 * tr-league.cjs, lib/fikstur-kilit.cjs, services/tournament.cjs.
 *
 * Yani yönetici elle girmediyse — ki normal işleyiş bu — uç
 * `{ok:true, exists:false, state:null}` dönüyordu. HTTP 200, hata yok.
 *
 * KULLANICIYA ULAŞAN ETKİ (zincir uçtan uca izlendi):
 *   mobile/app/(tabs)/predict.tsx:493  → `/api/rt/live-gs?fixtureId=...`
 *                                        (`team` GÖNDERMİYOR, yani provider
 *                                        kolu da hiç çalışmıyor)
 *   predict.tsx:496                    → `j.exists` false → setLiveState(null)
 *   predict.tsx:507 computePredLock    → `if (!st) return {locked:false}`
 * Sonuç: maç 1. yarıda bile ekranda AÇIK görünüyor, Tahmin Et butonu etkin
 * kalıyor, gönderim sunucuda reddediliyor (`pred.cjs` TAHMIN_KILIT_DK).
 * Dosyanın kendi notu (rt.live-gs.cjs:471-477) bu ürünün bu hatayı bir kez
 * yaşadığını söylüyor: liste açık diyordu, sunucu kilitliyordu.
 *
 * ⚠️ NEDEN YAKALANMADI: tek mevcut test
 * (`canli-dakika-ve-kilit-tek-kaynak.test.cjs:30`) yalnızca `lockBeforeMin`
 * alanının döndüğünü sınıyor; `exists`/`state` yolunu hiç dövmüyor.
 */

const os = require("os");
const nodePath = require("path");
const fs = require("fs");

const TMP = nodePath.join(os.tmpdir(), "skorlig-live-gs-kaynak-test");
process.env.SKORLIG_DATA_DIR = TMP;
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(nodePath.join(TMP, "live"), { recursive: true });

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

const FID_CANLI = "lgs-999";
const FID_YOK   = "lgs-hic-yok";

let server = null, taban = "";

before(async () => {
  /* Şekil KODDAN okundu: services/livescore-sync.cjs:306-317 `writeLiveState`.
   * `score` iç içe bir nesne; uç ise homeGoals/awayGoals düz alan döndürüyor —
   * eşleme düzeltmenin bir parçası. */
  fs.writeFileSync(
    nodePath.join(TMP, "live", `${FID_CANLI}.json`),
    JSON.stringify({
      fixtureId: FID_CANLI,
      status: "LIVE",
      isLive: true,
      score: { home: 1, away: 0 },
      minute: 34,
      kickoffISO: new Date(Date.now() - 34 * 60_000).toISOString(),
      updatedAt: new Date().toISOString(),
      source: "livescore-sync",
    })
  );

  const express = require("express");
  const app = express();
  app.locals.db = null;
  app.use(express.json());
  app.use("/api/rt", require("../routes/rt.live-gs.cjs"));
  await new Promise((r) => { server = app.listen(0, r); });
  taban = `http://127.0.0.1:${server.address().port}`;
});

after(() => { if (server) server.close(); });

const al = (fid) =>
  fetch(`${taban}/api/rt/live-gs?fixtureId=${encodeURIComponent(fid)}`)
    .then((r) => r.json());

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("tohum GERÇEKTEN uygulamanın okuduğu yerde ve şekilde", async () => {
    /**
     * ⚠️ SIFIR SONUÇ KANIT DEĞİL. Dosyayı yanlış dizine ya da yanlış şekilde
     * yazsaydım "exists:false" görür ve kusuru bulduğumu sanırdım — oysa
     * yalnızca tohumum yanlış olurdu.
     *
     * Bağımsız bir okuyucuyla kanıtlıyoruz: `lib/fikstur-kilit.cjs` AYNI
     * dosyayı okuyor (satır 59) ve uygulamanın her yerinde kullanılıyor.
     * Tohum doğruysa maçı "başlamış" saymalı.
     */
    const { fiksturKilidi } = require("../lib/fikstur-kilit.cjs");
    const k = await fiksturKilidi(FID_CANLI, { db: null });
    assert.equal(
      k.locked, true,
      `bagimsiz okuyucu tohumu gormedi: ${JSON.stringify(k)} — dosya yanlis ` +
      `dizinde/sekilde, test bir sey olcmuyor`
    );
    assert.equal(k.reason, "MATCH_ALREADY_STARTED", `beklenmeyen sebep: ${k.reason}`);
  });

  test("rt-live-gs.json BİLEREK yok (yönetici hiç girmedi)", () => {
    assert.ok(
      !fs.existsSync(nodePath.join(TMP, "rt-live-gs.json")),
      "yonetici modeli var — test dogru senaryoyu kurmuyor"
    );
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("canlı hattın durumu uca yansıyor", () => {
  test("exists TRUE döner", async () => {
    const j = await al(FID_CANLI);
    assert.equal(j.ok, true);
    assert.equal(
      j.exists, true,
      `exists:false — uc yalnizca yonetici modelini okuyor, canli hattin ` +
      `yazdigi data/live/<fid>.json'i gormuyor. predict.tsx:496 bunu null'a ` +
      `cevirip kilidi tamamen kaldiriyor.`
    );
  });

  test("status canlı geliyor (kilit kuralının girdisi)", async () => {
    /* predict.tsx:514 — `status !== "NS"` ise kilit. Yanlis status kilidi
     * sessizce kaldirir. */
    const j = await al(FID_CANLI);
    assert.equal(
      String(j.status).toUpperCase(), "LIVE",
      `status "${j.status}" — computePredLock NS disini kilitli sayiyor, ` +
      `bu alan yanlissa mac acik gorunur`
    );
  });

  test("skor iç içe score'dan düz alanlara eşleniyor", async () => {
    /* Canlı hat `score:{home,away}` yaziyor, uc `homeGoals/awayGoals`
     * donduruyor — eslemeyi atlamak skoru bos birakir. */
    const j = await al(FID_CANLI);
    assert.equal(j.homeGoals, 1, `homeGoals: ${j.homeGoals}`);
    assert.equal(j.awayGoals, 0, `awayGoals: ${j.awayGoals}`);
  });

  test("kickoffISO geliyor (ikinci kilit kuralının girdisi)", async () => {
    /* predict.tsx:527 — kickoff'a N dk kala kilit. Alan yoksa o kural da
     * sessizce devre disi kalir. */
    const j = await al(FID_CANLI);
    assert.ok(j.kickoffISO, `kickoffISO yok: ${JSON.stringify(j).slice(0, 160)}`);
    assert.ok(
      Number.isFinite(new Date(j.kickoffISO).getTime()),
      `kickoffISO ayristirilamiyor: ${j.kickoffISO}`
    );
  });

  test("lockBeforeMin hâlâ dönüyor (mevcut sözleşme bozulmadı)", async () => {
    const { TAHMIN_KILIT_DK } = require("../lib/ekonomi.cjs");
    const j = await al(FID_CANLI);
    assert.equal(j.lockBeforeMin, TAHMIN_KILIT_DK);
  });
});

describe("gerçekten durumu olmayan maç", () => {
  test("exists FALSE döner (yanlış pozitif üretilmiyor)", async () => {
    /* Düzeltme "her zaman exists:true" demek DEĞİL. Durumu olmayan maç için
     * uç dürüstçe yok demeli; aksi hâlde kilit bu kez yanlis yone kayardi. */
    const j = await al(FID_YOK);
    assert.equal(j.ok, true);
    assert.equal(
      j.exists, false,
      `durumu olmayan mac icin exists:true — uc uydurma durum donduruyor`
    );
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: durum okuması canlı hattın dizinine de bakıyor", () => {
  /**
   * Kaynak taraması, davranış testinin tamamlayıcısı: `getFixtureState`
   * yönetici modeliyle YETİNMEMELİ. `LIVE_DIR`/`LIVE_STATE_FILE` geçişi
   * fonksiyonun kendisinde aranıyor — dosyanın başka yerinde (yazma yolunda)
   * zaten geçiyor, o yüzden kapsam fonksiyona daraltıldı.
   */
  const src = fs.readFileSync(
    nodePath.join(__dirname, "..", "routes", "rt.live-gs.cjs"), "utf8"
  );
  const kod = src.split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");

  const bas = kod.indexOf("async function getFixtureState");
  assert.ok(bas >= 0, "getFixtureState bulunamadi — tarama bozuk");
  /* Fonksiyon gövdesi: bir sonraki üst düzey `\nasync function` / `\nfunction`e kadar. */
  const kalan = kod.slice(bas + 10);
  const bit = kalan.search(/\n(async )?function /);
  const govde = bit >= 0 ? kalan.slice(0, bit) : kalan;

  assert.ok(
    /LIVE_STATE_FILE|LIVE_DIR/.test(govde),
    "getFixtureState yalnizca yonetici modelini (rt-live-gs.json) okuyor. " +
    "Canli hat durumu data/live/<fid>.json'a yaziyor (livescore-sync.cjs:306) " +
    "ve uygulamanin geri kalani oradan okuyor; bu uc gormezse predict ekrani " +
    "basalamis maci acik gosterir."
  );
});
