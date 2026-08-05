"use strict";

/**
 * PUSH GÖNDERİMİ KİMLİK HARF DÜZENİNE DUYARLI DEĞİL.
 *
 * ⚠️ BULUNAN: `lib/push-store.cjs loadStore` anahtarları ORİJİNAL harf
 * düzeniyle kuruyordu (`items[d.userId]`) ve tek tüketicisi
 * `services/push.cjs sendToUsers` onları DOĞRUDAN indeksliyordu
 * (`store.items[uid]`). Gelen kimlik birebir tutmazsa kayıt bulunamıyor,
 * `continue` ediliyor ve BİLDİRİM SESSİZCE GİTMİYOR — hata yok, log yok,
 * dönen `sent` sayısı 0 ama kimse bakmıyor.
 *
 * ÖLÇÜLDÜ (düzeltme öncesi), "TestAli" olarak kayıtlı kullanıcı:
 *     sendToUsers(["TestAli"]) → 1 mesaj
 *     sendToUsers(["testali"]) → 0 mesaj   <<<
 *     sendToUsers(["TESTALI"]) → 0 mesaj   <<<
 *
 * ⚠️ AYNI DEPODA İKİ OKUMA YOLU TERS DAVRANIYORDU: `getUser` harf duyarsız
 * arıyor (`Object.keys().find(k => lower(k) === uid)`) ve aynı kaydı
 * BULUYOR. Yani riski gören biri orayı özenle yazmış, toplu okuma atlanmış.
 *
 * SOMUT TETİKLEYİCİ: `services/push-scheduler.cjs:345` maç sonucu bildirimini
 * leaderboard snapshot satırındaki `row.userId` ile gönderiyor. O alanın harf
 * düzeni güvenilmez — `routes/stats.cjs` aynı alanı okurken `$toLower` ile
 * karşılaştırıyor, yani kod tabanı bunu zaten kabul etmiş durumda.
 */

const os = require("os");
const nodePath = require("path");
const fs = require("fs");

const TMP = nodePath.join(os.tmpdir(), "skorlig-push-harf-test");
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
process.env.SKORLIG_DATA_DIR = TMP;
process.env.SKORLIG_PUSH = "1";
process.env.SKORLIG_PUSH_FILE_MIRROR = "1";
delete process.env.MONGODB_URI; // dosya moduna zorla

const { test, describe, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

/**
 * ⚠️ EXPO'YA GERÇEK İSTEK ATMIYORUZ. `sendRaw` global `fetch` kullanıyor;
 * yakalayıp gönderilen mesajları topluyoruz. Yakalamasaydık test dış ağa
 * çıkar, CI'da kırılgan olur ve gerçek cihazlara bildirim giderdi.
 */
let gonderilen = [];
globalThis.fetch = async (url, opts) => {
  const batch = JSON.parse(opts.body);
  gonderilen.push(...batch);
  return { json: async () => ({ data: batch.map(() => ({ status: "ok" })) }) };
};

const push = require("../services/push.cjs");
const PushStore = require("../lib/push-store.cjs");

const KAYIT = "TestAli";
const TOKEN = "ExponentPushToken[harf-test-1]";

before(async () => {
  const r = await push.registerToken(KAYIT, TOKEN);
  assert.equal(r.ok, true, `registerToken basarisiz: ${JSON.stringify(r)}`);
});

beforeEach(() => { gonderilen = []; });

const gonder = (uid, ek = {}) =>
  push.sendToUsers([uid], { type: "duel", title: "t", body: "b", ...ek });

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("fetch yakalayıcı ve kayıt GERÇEKTEN çalışıyor", async () => {
    /* ⚠️ Sıfır sonuç kanıt değil: yakalayıcı bozuksa ya da kayıt hiç
     * oluşmadıysa aşağıdaki "0 mesaj" iddiaları da kendiliğinden geçer ve
     * kusuru bulduğumu sanırdım. Önce POZİTİF yolun çalıştığını gösteriyoruz. */
    const s = await gonder(KAYIT);
    assert.equal(
      gonderilen.length, 1,
      `kayitli harf duzeniyle bile mesaj uretilmedi: ${JSON.stringify(s)} — ` +
      `yakalayici ya da kayit bozuk, test bir sey olcmuyor`
    );
    assert.equal(gonderilen[0].to, TOKEN, `yanlis token: ${gonderilen[0].to}`);
  });

  test("depo anahtarı GERÇEKTEN küçük harf", async () => {
    const store = await PushStore.loadStore(null);
    const anahtarlar = Object.keys(store.items);
    assert.ok(
      anahtarlar.includes(KAYIT.toLowerCase()),
      `anahtarlar kucuk harf degil: ${JSON.stringify(anahtarlar)}`
    );
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("gönderim harf düzeninden bağımsız", () => {
  for (const dene of ["TestAli", "testali", "TESTALI", "tEsTaLi"]) {
    test(`"${dene}" ile bildirim gidiyor`, async () => {
      const s = await gonder(dene);
      assert.equal(
        gonderilen.length, 1,
        `"${dene}" icin mesaj uretilmedi (sent=${s.sent}). Depo "${KAYIT}" ` +
        `olarak kayitli; gonderim harf duzenine duyarli ve bildirim SESSIZCE ` +
        `dusuyor. push-scheduler:345 kimligi leaderboard satirindan aliyor, ` +
        `o alanin harf duzeni garanti degil.`
      );
    });
  }
});

describe("düzeltme mevcut davranışı bozmuyor", () => {
  test("kapalı tercih hâlâ engelliyor", async () => {
    /* Harf duyarsızlık, tercih kapısını atlamak DEĞİL. */
    await push.setPrefs(KAYIT, { duel: false });
    const s = await gonder("testali", { type: "duel" });
    assert.equal(
      gonderilen.length, 0,
      `tercih kapaliyken mesaj uretildi: ${JSON.stringify(s)} — normalize ` +
      `ederken tercih kontrolu atlanmis`
    );
    await push.setPrefs(KAYIT, { duel: true }); // geri al
  });

  test("getPrefs kullanıcının GERÇEK tercihini döndürüyor", async () => {
    /**
     * ⚠️ BU İDDİA DÜZELTMENİN KENDİ YARATTIĞI REGRESYONDAN DOĞDU.
     *
     * `loadStore` anahtarları küçültülünce `getPrefs` ham `uid` ile
     * indekslediği için kaydı BULAMAZ hâle geldi. Sessiz sonuç:
     * `sanitizePrefs(undefined)` VARSAYILANI döndürür — kullanıcı kapattığı
     * bildirimi ekranda AÇIK görür ve `deviceCount` 0 çıkar. Yani depoyu
     * düzeltirken tüketicilerin HEPSİNİ geçirmek gerekiyordu.
     */
    await push.setPrefs(KAYIT, { result: false });

    const p1 = await push.getPrefs(KAYIT);            // kayıtlı düzen
    const p2 = await push.getPrefs(KAYIT.toUpperCase()); // farklı düzen

    assert.equal(
      p1.prefs.result, false,
      `kayitli harf duzeniyle bile tercih okunamadi: ${JSON.stringify(p1)}`
    );
    assert.equal(
      p2.prefs.result, false,
      `farkli harf duzeninde VARSAYILAN dondu: ${JSON.stringify(p2)} — ` +
      `kullanici kapattigi bildirimi ACIK gorur`
    );
    assert.ok(
      p2.deviceCount > 0,
      `deviceCount 0: ${JSON.stringify(p2)} — kayit bulunamiyor, ekran ` +
      `"kayitli cihaz yok" der`
    );

    await push.setPrefs(KAYIT, { result: true }); // geri al
  });

  test("kayıtsız kullanıcıya gönderim YOK (yanlış pozitif üretilmiyor)", async () => {
    /* Düzeltme "herkese gönder" demek değil. */
    const s = await gonder("hic-kayitli-olmayan");
    assert.equal(
      gonderilen.length, 0,
      `kayitsiz kullaniciya mesaj uretildi: ${JSON.stringify(s)}`
    );
  });

  test("broadcast çalışmaya devam ediyor", async () => {
    /* broadcast `Object.keys(store.items)` ile besleniyor; anahtarlar
     * küçüldüğünde sendToUsers'ın aramasıyla uyumlu kalmalı. */
    const s = await push.broadcast({ type: "daily", title: "t", body: "b" });
    assert.ok(
      gonderilen.length >= 1,
      `broadcast hic mesaj uretmedi: ${JSON.stringify(s)} — anahtar ` +
      `normalizasyonu broadcast ile sendToUsers arasindaki uyumu bozmus`
    );
  });
});

describe("iki harf düzeninde kayıtlı eski veri", () => {
  test("token'lar BİRLEŞİYOR, biri kaybolmuyor", async () => {
    /**
     * ⚠️ Normalizasyonun kolay yanlışı: aynı kullanıcı iki düzende kayıtlıysa
     * (migration öncesi veri) sonraki anahtarın öncekini EZMESİ. O durumda
     * kullanıcının bir cihazı sessizce bildirim dışı kalırdı.
     */
    const dosyaYolu = nodePath.join(TMP, "push-tokens.json");
    const store = JSON.parse(fs.readFileSync(dosyaYolu, "utf8"));
    store.items["CiftKayit"] = {
      userId: "CiftKayit", tokens: ["ExponentPushToken[cift-A]"],
      prefs: { matchStart: true, result: true, duel: true, daily: true },
    };
    store.items["ciftkayit"] = {
      userId: "ciftkayit", tokens: ["ExponentPushToken[cift-B]"],
      prefs: { matchStart: true, result: true, duel: true, daily: true },
    };
    fs.writeFileSync(dosyaYolu, JSON.stringify(store, null, 2));

    gonderilen = [];
    await gonder("CIFTKAYIT");
    const hedefler = gonderilen.map((m) => m.to).sort();
    assert.deepEqual(
      hedefler,
      ["ExponentPushToken[cift-A]", "ExponentPushToken[cift-B]"],
      `iki kayittan yalnizca biri kullanildi: ${JSON.stringify(hedefler)} — ` +
      `normalize ederken uzerine yazilmis, kullanicinin bir cihazi bildirim ` +
      `disi kaliyor`
    );
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: sendToUsers kimliği küçülterek arıyor", () => {
  const src = fs.readFileSync(
    nodePath.join(__dirname, "..", "services", "push.cjs"), "utf8"
  );
  const kod = src.split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");

  const bas = kod.indexOf("async function sendToUsers");
  assert.ok(bas >= 0, "sendToUsers bulunamadi — tarama bozuk");
  const kalan = kod.slice(bas + 10);
  const bit = kalan.search(/\n(async )?function /);
  const govde = bit >= 0 ? kalan.slice(0, bit) : kalan;

  /* Kimlik kümesi kurulurken küçültme yapılmalı — `store.items[uid]`
   * indekslemesi ondan besleniyor. */
  assert.ok(
    /toLowerCase\(\)/.test(govde),
    "sendToUsers kimligi kucultmuyor — depo anahtarlari kucuk harf oldugu " +
    "icin gelen kimlik birebir tutmazsa kayit bulunamaz ve bildirim SESSIZCE " +
    "gitmez. Olculdu: TestAli kayitliyken testali ile 0 mesaj."
  );
});

test("NÖBETÇİ: loadStore anahtarları normalize ediyor", () => {
  const src = fs.readFileSync(
    nodePath.join(__dirname, "..", "lib", "push-store.cjs"), "utf8"
  );
  const kod = src.split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");

  /* Üç dönüş yolu var (mongo / tohumlama / dosya); hepsi normalize etmeli.
   * Biri atlanırsa kusur o yoldan sessizce geri gelir. */
  const bas = kod.indexOf("async function loadStore");
  assert.ok(bas >= 0, "loadStore bulunamadi — tarama bozuk");
  const kalan = kod.slice(bas + 10);
  const bit = kalan.search(/\n(async )?function /);
  const govde = bit >= 0 ? kalan.slice(0, bit) : kalan;

  const donusler = [...govde.matchAll(/return\s+([^;]+);/g)].map((m) => m[1]);
  assert.ok(donusler.length >= 2, `loadStore donusleri bulunamadi: ${donusler.length}`);
  const normalizesiz = donusler.filter((d) => !/anahtarlariNormalizeEt/.test(d));
  assert.deepEqual(
    normalizesiz, [],
    `loadStore su donuslerde anahtarlari normalize etMIYOR: ` +
    `${normalizesiz.join(" | ")} — o yoldan okunan kayitlar orijinal harf ` +
    `duzeninde kalir ve sendToUsers onlari bulamaz`
  );
});
