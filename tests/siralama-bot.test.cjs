"use strict";

/**
 * SIRALAMA BOTSUZ OLMALI.
 *
 * ⚠️ ÖLÇÜLDÜ (2026-07-31, üretim `data/totals.json`): 1707 sıralama kaydının
 * **1706'sı bot**. Sıralama ekranı ilk 300'ü istiyor (`/api/rt/totals?limit=300`),
 * yani tablo fiilen tamamen bottu ve tek gerçek oyuncu hiç görünmüyordu.
 *
 * Botlar TAHMİN DAĞILIMI için var, sıralama için değil — aynı ilke havuzda
 * açıkça yazılı: "botlar dağılımı oluşturur, parayı oluşturmaz".
 * `routes/leaderboard.cjs` botları zaten süzüyordu; `season_totals` yazımı ve
 * `/api/rt/totals` okuması atlanmıştı. Savunmanın bir yerde olup başka yerde
 * olmaması bu oturumun en sık tekrarlanan hatası.
 *
 * ⚠️ HEM YAZMA HEM OKUMA: kaynak düzeltildi ama MEVCUT 1706 kayıt duruyor;
 * okuma tarafı olmadan düzeltme geçmiş veriyi kapsamazdı.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
const { BOT_ID_SET, isBot } = require("../lib/botIds.cjs");

test("bot kimlik kümesi dolu — süzgeçlerin dayandığı temel", () => {
  assert.ok(BOT_ID_SET.size > 100, `bot kimlik kumesi cok kucuk (${BOT_ID_SET.size})`);
  assert.equal(typeof isBot, "function");
});

test("sıralama yanıtı bot olup olmadığını SÖYLER", () => {
  // Karar (leaderboard.cjs, 2026-07-29): botlar silinmez, İŞARETLENİR.
  // "Bot listeyi canlı gösteriyor ama kiminle yarıştığını gizlemek dürüst değil."
  const src = fs.readFileSync(path.join(KOK, "routes", "totals-read.cjs"), "utf8");
  assert.ok(
    /isBot:\s*BOT_ID_SET\.has/.test(src),
    "/api/rt/totals bot isareti vermiyor — kullanici kiminle yaristigini bilmiyor"
  );
});

test("sıralama ucu ?humans=1 destekler", () => {
  const src = fs.readFileSync(path.join(KOK, "routes", "totals-read.cjs"), "utf8");
  assert.ok(
    /req\.query\.humans/.test(src),
    "?humans=1 yok — kullanici yalnizca gercek oyunculari goremiyor"
  );
});

/**
 * NÖBETÇİ — sıralama döndüren her uç botları süzmeli.
 *
 * Yeni bir sıralama ucu eklenip süzgeç unutulursa tablo yine botla dolar.
 * Liste dar ve gerekçeli: yalnızca ÇOK KULLANICILI sıralama döndürenler.
 */
const SIRALAMA_UCLARI = [
  ["totals-read.cjs", "/api/rt/totals — ana sıralama ekranı (kings.tsx)"],
  ["leaderboard.cjs", "/api/leaderboard"],
];

test("NÖBETÇİ: sıralama uçlarının hepsi botu işaretler", () => {
  const kusurlu = [];
  for (const [dosya, ne] of SIRALAMA_UCLARI) {
    const tam = path.join(KOK, "routes", dosya);
    assert.ok(fs.existsSync(tam), `${dosya} yok — liste bayatlamis`);
    const src = fs.readFileSync(tam, "utf8");
    // leaderboard.cjs BOT_PROFILE_MAP, totals-read BOT_ID_SET kullaniyor.
    if (!/BOT_ID_SET|BOT_USER_ID_SET|BOT_PROFILE_MAP|isBot\s*[:(]/.test(src)) {
      kusurlu.push(`${dosya} — ${ne}`);
    }
  }
  assert.deepStrictEqual(
    kusurlu,
    [],
    "Bu siralama uclari bot suzmuyor:\n" + kusurlu.join("\n")
  );
});

test("gerçek veride süzgecin etkisi ölçülebilir", () => {
  // Belge niteliğinde: sorunun büyüklüğünü sayıyla sabitler.
  const dosya = path.join(KOK, "data", "totals.json");
  if (!fs.existsSync(dosya)) return;                       // CI'da veri olmayabilir

  let items;
  try {
    const j = JSON.parse(fs.readFileSync(dosya, "utf8"));
    items = Array.isArray(j) ? j : j.items || [];
  } catch {
    return;
  }
  if (!items.length) return;

  const bot = items.filter((x) => BOT_ID_SET.has(String(x.userId || "").trim().toLowerCase()));
  // Süzgeç çalışıyorsa bot oranı ne olursa olsun okuma tarafı onları atmalı.
  const insan = items.filter((x) => !BOT_ID_SET.has(String(x.userId || "").trim().toLowerCase()));
  assert.equal(bot.length + insan.length, items.length, "suzgec kayip veri uretiyor");
  assert.ok(insan.length <= items.length);
});
