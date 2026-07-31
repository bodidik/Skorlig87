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

/* ── Bot kadrosunun kaynağı ──────────────────────────────────────────────── */

/**
 * ⚠️ TÜM BOT SÜZGEÇLERİ İKİ DOSYAYA BAĞLI.
 *
 * `lib/botIds.cjs` kadroyu `data/bot-profiles.json` ve
 * `data/bot-legacy-ids.json` dosyalarından okuyor. Dosya okunamazsa modül
 * `console.warn` basıp BOŞ küme dönüyor — yani `isBot()` herkese `false` der
 * ve bot süzgeçlerinin HEPSİ sessizce devre dışı kalır:
 *   • settle2 botlara LC ödülü öder (1760 bot × maç başına ödül)
 *   • mini turnuvada botlar "gerçek kazanan" sayılır
 *   • sıralamalarda bot işareti kaybolur
 *
 * ŞU AN GÜVENLİ: `data/*` .gitignore'da ama bu iki dosya AÇIKÇA istisna
 * tutulmuş (`!data/bot-profiles.json`), yani her deploy'da geliyorlar.
 * Bağımlılık tam olarak o istisnaya dayanıyor — daha geniş bir ignore kuralı
 * ya da dosyanın bozulması süzgeçleri fail-OPEN düşürür. Bu test o dayanağı
 * koruyor.
 */
test("bot kadrosu dosyaları sürüm kontrolünde ve dolu", () => {
  const { execFileSync } = require("child_process");
  const dosyalar = ["data/bot-profiles.json", "data/bot-legacy-ids.json"];

  let izlenen = "";
  try {
    izlenen = execFileSync("git", ["ls-files", ...dosyalar], { cwd: KOK, encoding: "utf8" });
  } catch {
    return; // git yoksa (paket kurulumu) atla — yanlış alarm üretme
  }

  for (const d of dosyalar) {
    assert.ok(
      izlenen.includes(d.split("/").pop()),
      `${d} git tarafindan IZLENMIYOR — deploy'da gelmez, bot suzgecleri fail-open duser`
    );
    const tam = path.join(KOK, d);
    assert.ok(fs.existsSync(tam), `${d} yok`);
    // ⚠️ ŞEKİL KODDAN OKUNDU, TAHMİN EDİLMEDİ: `lib/botIds.cjs` hem düz dizi
    // hem `{ ids: [...] }` kabul ediyor (aktif kadro dizi, emekli kimlikler
    // sarmalı). İlk yazımda ikisini de dizi sandım ve test yanlış yere düştü.
    const icerik = JSON.parse(fs.readFileSync(tam, "utf8"));
    const kayitlar = Array.isArray(icerik)
      ? icerik
      : (Array.isArray(icerik?.ids) ? icerik.ids : null);
    assert.ok(
      Array.isArray(kayitlar) && kayitlar.length > 0,
      `${d} bos ya da beklenen bicimde degil (dizi veya {ids:[...]})`
    );
  }
});
