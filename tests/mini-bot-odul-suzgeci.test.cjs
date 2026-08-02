"use strict";

/**
 * MİNİ TURNUVA ÖDÜLÜ BOTA GİTMESİN — bot tespiti tek kaynaktan.
 *
 * ⚠️ KUSUR: `routes/mini.cjs` kendi bot tespitini taşıyordu:
 *     String(uid).toLowerCase().startsWith("bot_")
 * Ama üretimdeki botların adları böyle DEĞİL: `Marakana49`, `AliSamiYen24`,
 * `FBSpirit60`, `TanjuColak`, `Hagi72`… Bot kimlikleri `bot-profiles.json` +
 * `bot-legacy-ids.json` dosyalarından gelen bir KÜMEDE tutuluyor
 * (`lib/botIds.cjs`), ad kalıbında değil.
 *
 * ÖLÇÜLDÜ: `BOT_ID_SET` 2720 kimlik; bunların **2631'i (%96.7)** `bot_` ile
 * başlamıyor — yani süzgeç botların neredeyse tamamını "gerçek oyuncu"
 * sayıyordu.
 *
 * ⚠️ BEDELİ PARA: `gercekKazananlar` mini turnuva LC ödülünü kimin alacağını
 * belirliyor. Bot kazanan elenmeyince hem karşılıksız LC üretiliyor hem de
 * ödül bölüşüldüğü için gerçek oyuncunun payı azalıyor.
 *
 * ÜRETİMDE HENÜZ SIZMADI: tek turnuva `winners: []`, `rewardLc: 0` ile
 * bitmiş, mini ödül defter kaydı 0. Ama üyelerinden `FBSpirit60` gerçek bir
 * bot ve süzgeçten geçiyordu — kazananla bitseydi LC alacaktı.
 *
 * Bu depodaki en sık kusur şekli: aynı savunmanın ikinci kopyası, sessizce
 * ayrışıyor.
 */

const test = require("node:test");
const describe = require("node:test").describe;
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
process.env.SKORLIG_BG = "0";

const { isBot, BOT_ID_SET } = require("../lib/botIds.cjs");

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("bot kimlik kümesi dolu", () => {
    assert.ok(BOT_ID_SET.size > 100, `BOT_ID_SET ${BOT_ID_SET.size} — test bir sey olcmuyor`);
  });

  test("botların ÇOĞU bot_ öneki taşımıyor — kusurun sebebi", () => {
    /**
     * ⚠️ Bu testin işi, eski süzgecin neden yetersiz olduğunu KANITLAMAK.
     * Sayı düşerse (yani botlar bir gün gerçekten bot_ ile adlandırılırsa)
     * bu test kırılır ve o zaman buradaki gerekçe gözden geçirilmeli.
     */
    let onekSiz = 0;
    for (const id of BOT_ID_SET) if (!String(id).toLowerCase().startsWith("bot_")) onekSiz++;
    const oran = onekSiz / BOT_ID_SET.size;
    assert.ok(oran > 0.5,
      `botlarin yalnizca %${(100 * oran).toFixed(1)}'i onekesiz — eski suzgec artik yeterli olabilir, gerekce gozden gecirilmeli`);
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("ödül süzgeci", () => {
  /* Rota modülünü yüklemeden saf davranışı sınamak için aynı bağı kuruyoruz:
   * mini.cjs artık botIds.isBot kullanıyor (nöbetçi bunu kilitliyor). */
  const gercekKazananlar = (ids) => (ids || []).filter((u) => u && !isBot(u));

  test("ÖNEKSİZ bot kimliği eleniyor", () => {
    const bot = [...BOT_ID_SET].find((id) => !String(id).startsWith("bot_"));
    assert.ok(bot, "oneksiz bot bulunamadi");
    assert.deepEqual(gercekKazananlar([bot]), [], `${bot} elenmedi — bota LC gider`);
  });

  test("bot_ önekli kimlik de eleniyor (eski davranış korunuyor)", () => {
    const bot = [...BOT_ID_SET].find((id) => String(id).startsWith("bot_"));
    if (bot) assert.deepEqual(gercekKazananlar([bot]), []);
  });

  test("GERÇEK oyuncu elenmiyor", () => {
    /* Fazla eleme de kusurdur: gerçek kazanan ödülünü alamaz. */
    assert.deepEqual(gercekKazananlar(["demo1"]), ["demo1"]);
    assert.deepEqual(gercekKazananlar(["xXhSFvM1SFYN3kUYAdMGRaUkPp53"]), ["xXhSFvM1SFYN3kUYAdMGRaUkPp53"]);
  });

  test("karışık listede yalnızca botlar düşüyor", () => {
    const bot = [...BOT_ID_SET].find((id) => !String(id).startsWith("bot_"));
    assert.deepEqual(gercekKazananlar(["demo1", bot, "gercek2"]), ["demo1", "gercek2"]);
  });

  test("boş/bozuk girdi", () => {
    assert.deepEqual(gercekKazananlar([]), []);
    assert.deepEqual(gercekKazananlar(null), []);
    assert.deepEqual(gercekKazananlar([null, "", undefined]), []);
  });
});

/* ── Nöbetçi ─────────────────────────────────────────────────────────────── */

const kaynak = fs.readFileSync(path.join(KOK, "routes", "mini.cjs"), "utf8")
  .split("\n")
  .map((l) => {
    const t = l.trim();
    return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
  })
  .join("\n");

test("NÖBETÇİ: mini.cjs kendi bot tespitini YAZMIYOR", () => {
  assert.ok(!/startsWith\("bot_"\)/.test(kaynak),
    "yerel bot tespiti geri gelmis — botlarin %96.7'si suzgecten kacar ve odul alir");
  assert.ok(/require\("\.\.\/lib\/botIds\.cjs"\)/.test(kaynak),
    "ortak bot kimlik kaynagi kullanilmiyor");
});

test("NÖBETÇİ: ödül yolu süzgeçten geçiyor", () => {
  assert.ok(/gercekKazananlar\(/.test(kaynak), "odul yolunda bot suzgeci yok");
  const cagri = (kaynak.match(/gercekKazananlar\(/g) || []).length;
  assert.ok(cagri >= 3, `gercekKazananlar ${cagri} yerde — odul yollarindan biri suzgecsiz kalmis olabilir`);
});
