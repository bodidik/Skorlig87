"use strict";

/**
 * MONGO BİRİNCİL VERİYİ DOSYADAN OKUMA.
 *
 * ⚠️ BU SINIF ÜÇ KEZ HATA ÜRETTİ:
 *   1. tr-lig haftalık ödülü yalnızca dosyaya yazılıyordu — "ödül kimsenin
 *      okumadığı dosyaya düşüyor, kullanıcının bakiyesi artmıyordu".
 *   2. Davet ödülü `addLc` ile yalnızca dosyaya yazılıyordu; bakiye Mongo'dan
 *      okunduğu için kullanıcıya "+15 LC kazandın" deniyor ama hiçbir şey
 *      değişmiyordu.
 *   3. `/api/admin/fixtures` yalnızca `data/fixtures.json` okuyordu; fikstürler
 *      Mongo birincil. Render'da `data/` geçici disk olduğu için deploy sonrası
 *      panel BOŞ liste gösteriyordu — üstelik pilot modda maçlar o panelden
 *      elle giriliyor.
 *
 * Ortak biçim: veri Mongo'ya yazılıyor, bir yer dosyadan okuyor. Belirti "hata"
 * değil — ekran boş, bakiye değişmemiş, kimse fark etmiyor.
 *
 * ⚠️ YEDEK OKUMA MEŞRU. Amaç dosya okumayı yasaklamak değil; dosyayı TEK
 * kaynak olarak kullanmayı yakalamak. Kural: dosya sabitini okuyan bir blok
 * ya `db` dalına ya da ilgili depoya da başvurmalı.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
const DIZINLER = ["routes", "services"];

/**
 * Mongo birincil tutulan veriler ve onların dosya AYNASI.
 * Anahtar: kaynak kodda geçen dosya sabiti adı.
 */
const AYNALAR = {
  FIXTURES_FILE: "fikstürler (lib/fixtures-store.cjs)",
  LEADERBOARD_FILE: "sıralama anlık görüntüleri",
  WALLET_FILE: "cüzdan (lc_wallet_users)",
  TOTALS_FILE: "sezon toplamları (season_totals)",
};

/** Blok içinde Mongo'ya başvuru var mı (yedek okuma meşru sayılsın)? */
const MONGO_IZI = /\bdb\b|getDb|locals\.db|Store\.|collection\(/;

/**
 * DOSYA İLKELLERİ — bunlar zaten "dosya yolunu oku" demek için var; hangi yolun
 * seçileceğine ÇAĞIRAN karar veriyor (`db ? ...Mongo : ...File`). Tanımlarına
 * Mongo şartı koymak yedek yolun kendisini imkânsız kılardı. Aynı ayrımı ödeme
 * nöbetçisinde de yapmak gerekmişti (creditLcMongo).
 */
const ILKELLER = new Set(["loadWallet", "loadWalletState"]);

/**
 * BİLEREK MUAF — her biri gerekçeli. Gerekçesiz muafiyet listesi nöbetçiyi
 * zamanla anlamsızlaştırır.
 */
const MUAF = new Set([
  // totals.cjs tamamen GÖLGELENMİŞ ölü kod: /api/rt/totals isteğini
  // totals-read.cjs karşılıyor (bkz. tests/rota-golgeleme.test.cjs).
  "routes/totals.cjs",
  /* ⚠️ GEREKÇE BAYATLAMIŞTI — muafiyetin kendisi kusuru gizledi.
   *
   * Eski gerekçe: "/board2 debug/eski kullanım; istemci çağırmıyor."
   * Bu ARTIK YANLIŞ: `mobile/app/stats/board2.tsx:50` bu ucu çağırıyor.
   * Muafiyet dururken uç ile ekran şekil olarak ayrıştı ve ekran kalıcı
   * boş kaldı (bkz. tests/board2-veri-sozlesmesi.test.cjs).
   *
   * Muafiyet KORUNUYOR ama artık dar ve doğru gerekçeyle: bu dosya sezon
   * toplamlarını zaten Mongo öncelikli okuyor (`SeasonTotals.loadTotals`,
   * satır 35). Dosya-öncelikli olan yalnızca `/board2`nin ham
   * `leaderboard.json` okuması ve o koleksiyonun canlı yazıcısı yok — Mongo'ya
   * çevirmek boş tablo döndürürdü. Bu, bu dosyanın değil `realtime`/`settle2`
   * yazma yolunun sorunu.
   *
   * DERS: "istemci çağırmıyor" gerekçesi zamanla çürüyor; muafiyet yazarken
   * çürümeyecek bir gerekçe seç. */
  "routes/totals-read.cjs",
  // /board eski bir uç; sıralamayı leaderboard.cjs ve totals-read veriyor.
  "routes/realtime.cjs",
]);

function bloklaraBol(kaynak) {
  const satirlar = kaynak.split("\n");
  const baslar = [];
  satirlar.forEach((l, i) => {
    if (/^(async\s+)?function\s+[A-Za-z0-9_$]+|^router\.(get|post|put|patch|delete)\(|^const\s+[A-Za-z0-9_$]+\s*=\s*(async\s*)?\(/.test(l)) {
      baslar.push(i);
    }
  });
  if (!baslar.length) return [{ bas: 0, metin: kaynak }];
  return baslar.map((bas, k) => ({
    bas,
    metin: satirlar.slice(bas, k + 1 < baslar.length ? baslar[k + 1] : satirlar.length).join("\n"),
  }));
}

test("Mongo birincil veri, dosyadan TEK kaynak olarak okunmuyor", () => {
  const kusurlu = [];
  let bakilan = 0;

  for (const d of DIZINLER) {
    const dizin = path.join(KOK, d);
    if (!fs.existsSync(dizin)) continue;
    for (const dosya of fs.readdirSync(dizin)) {
      if (!dosya.endsWith(".cjs")) continue;
      const kaynak = fs.readFileSync(path.join(dizin, dosya), "utf8");

      for (const blok of bloklaraBol(kaynak)) {
        for (const [sabit, ne] of Object.entries(AYNALAR)) {
          const okur = new RegExp(`readJson\\(\\s*${sabit}\\b`);
          if (!okur.test(blok.metin)) continue;
          bakilan++;
          if (MONGO_IZI.test(blok.metin)) continue;      // yedek okuma — meşru
          const ad = /^(?:async\s+)?function\s+([A-Za-z0-9_$]+)/.exec(blok.metin)?.[1];
          if (ad && ILKELLER.has(ad)) continue;         // dosya ilkeli
          if (MUAF.has(`${d}/${dosya}`)) continue;
          kusurlu.push(`${d}/${dosya}:${blok.bas + 1} — ${sabit} TEK kaynak (${ne})`);
        }
      }
    }
  }

  assert.ok(bakilan >= 3, `cok az dosya okumasi bulundu (${bakilan}) — tarama kalibi bozulmus olabilir`);
  assert.deepStrictEqual(
    kusurlu,
    [],
    "Bu bloklar Mongo birincil veriyi YALNIZCA dosyadan okuyor. Render'da\n" +
      "`data/` gecici disk: deploy sonrasi bos/bayat veri donerler.\n" +
      kusurlu.join("\n")
  );
});

test("admin fikstür ucu Mongo'dan okur", () => {
  // Somut regresyon kilidi: bu uc bir kez yalnizca dosyadan okuyordu.
  const src = fs.readFileSync(path.join(KOK, "routes", "admin-runtime.cjs"), "utf8");
  const i = src.indexOf('router.get("/fixtures"');
  assert.ok(i > 0, "/fixtures ucu bulunamadi");
  const govde = src.slice(i, src.indexOf("router.", i + 10));
  assert.ok(
    /FixturesStore\.loadAll/.test(govde),
    "admin fikstur ucu Mongo birincil depoyu kullanmiyor — deploy sonrasi bos liste doner"
  );
});
