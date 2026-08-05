"use strict";

/**
 * TAHMİN OKUMA YOLLARI MONGO'YU TERCİH ETMELİ (ayna kapatılabilir kalsın).
 *
 * ⚠️ NEDEN: `data/preds.json` her tahmin gönderiminde baştan yazılıyor.
 * ÖLÇÜLDÜ (72.851 kayıt, 25.3 MB, gerçek üretim dosyası):
 *     readFile         173 ms
 *     JSON.parse       319 ms  — OLAY DÖNGÜSÜNÜ BLOKLAR
 *     JSON.stringify   270 ms  — OLAY DÖNGÜSÜNÜ BLOKLAR
 *     disk yazımı       93 ms
 *     tahmin başına    854 ms · bunun 589 ms'i blokaj
 * Blokaj süresince sunucu HİÇBİR isteği işleyemiyor.
 *
 * Çözüm `SKORLIG_PREDS_FILE_MIRROR=0` — ama bu bayrak ancak TÜM okuma yolları
 * Mongo'ya gidiyorsa çevrilebilir. Aksi halde `preds.json` donar ve yalnızca
 * dosyayı okuyan kod donmuş veriyle çalışır: çökme yok, hata yok, SESSİZ
 * yanlış sonuç (bkz. `routes/duels.cjs` satır ~372'deki migration tuzağı notu).
 *
 * ⚠️ BU NÖBETÇİ BULMUŞTU: `GET /api/weekly-picks/my` yalnızca dosyaya
 * bakıyordu. Ayna kapatılsa, kullanıcı 3 LC ödediği haftalık tahminlerini
 * "hiç yapmamış" görecekti.
 *
 * Bu dosya kaynak kodu tarar — çalışan Mongo gerektirmez, CI'da da çalışır.
 * Kardeşi: `tests/match-results-ayna-maliyeti.test.cjs`.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const nodePath = require("path");

const KOK = nodePath.join(__dirname, "..");

/** Yorum satırlarını siler — "Mongo" kelimesi yorumda geçince yanılmayalım. */
function yorumsuz(src) {
  return src
    .split("\n")
    .map((l) => {
      const t = l.trim();
      if (t.startsWith("*") || t.startsWith("//") || t.startsWith("/*")) return "";
      return l.replace(/\/\/.*$/, "");
    })
    .join("\n");
}

/** `bas` işaretinden sonraki gövdeyi, `bit` işaretine (ya da dosya sonuna) kadar alır. */
function govde(kod, bas, bit) {
  const i = kod.indexOf(bas);
  assert.ok(i >= 0, `isaret bulunamadi: ${bas} — tarama bozuk, testi guncelle`);
  const kalan = kod.slice(i + bas.length);
  const j = bit ? kalan.indexOf(bit) : -1;
  return j >= 0 ? kalan.slice(0, j) : kalan;
}

/* Mongo kolunu ele veren ifadeler. */
const MONGO = /collection\(\s*["']predictions["']\s*\)|FromMongo|getPredsForFixture|getMyLatestPred/;
/* Dosya kolunu ele veren ifadeler. */
const DOSYA = /PREDS_FILE|loadPredList|FromFile/;

/**
 * Her satır: tek bir okuma yolu.
 * `bas`/`bit` gövdeyi kırpar; gövdede Mongo kolu dosya kolundan ÖNCE gelmeli.
 */
const YOLLAR = [
  {
    ad: "settle2.loadFixturePreds — maçı sonuçlandıran tahmin kaynağı",
    dosya: "routes/settle2.cjs",
    bas: "async function loadFixturePreds",
    bit: "async function fileExists",
  },
  {
    ad: "duels.settleDuelsForFixture — düello puanı için tahmin okuma",
    dosya: "routes/duels.cjs",
    bas: "async function settleDuelsForFixture",
    bit: "function getUserPred",
  },
  {
    ad: "weekly-picks.getUserPred — 3 LC ücret kararını besleyen okuma",
    dosya: "routes/weekly-picks.cjs",
    bas: "async function getUserPred(",
    bit: "\nrouter.",
  },
  {
    ad: "weekly-picks.getUserPredsBatch — toplu tahmin okuma",
    dosya: "routes/weekly-picks.cjs",
    bas: "async function getUserPredsBatch",
    bit: "async function getUserPred(",
  },
  {
    ad: "weekly-picks GET /my — kullanıcının haftalık tahmin ekranı",
    dosya: "routes/weekly-picks.cjs",
    bas: 'router.get("/my"',
    bit: "res.json(",
  },
  {
    ad: "pred.listeyiDondur — tahmin listesi ucu",
    dosya: "routes/pred.cjs",
    bas: "async function listeyiDondur",
    bit: "\nrouter.",
  },
  {
    ad: "pred GET /pred/my — kullanıcının tahmin kartları",
    dosya: "routes/pred.cjs",
    bas: 'router.get("/pred/my"',
    bit: "\nrouter.",
  },
  {
    ad: "models/preds.getPredsForFixture — canlı ekranın tahmin havuzu",
    dosya: "models/preds.cjs",
    bas: "async function getPredsForFixture",
    bit: "async function getMyLatestPred",
  },
  {
    ad: "models/preds.getMyLatestPred — kullanıcının son tahmini",
    dosya: "models/preds.cjs",
    bas: "async function getMyLatestPred",
    bit: "module.exports",
  },
];

describe("okuma yolları Mongo'yu tercih ediyor", () => {
  for (const yol of YOLLAR) {
    test(yol.ad, () => {
      const kod = yorumsuz(fs.readFileSync(nodePath.join(KOK, yol.dosya), "utf8"));
      const g = govde(kod, yol.bas, yol.bit);

      const mongoIdx = g.search(MONGO);
      const dosyaIdx = g.search(DOSYA);

      assert.ok(
        mongoIdx >= 0,
        `${yol.dosya}: ${yol.ad} — Mongo kolu YOK. Ayna kapatildiginda ` +
        `(SKORLIG_PREDS_FILE_MIRROR=0) preds.json donar; bu yol donmus ` +
        `veriyle calisir, hic hata vermeden.`
      );
      assert.ok(
        dosyaIdx < 0 || mongoIdx < dosyaIdx,
        `${yol.dosya}: ${yol.ad} — dosyayi Mongo'dan ONCE okuyor. Ayna ` +
        `kapaliyken preds.json yazilmaz, yani bu yol sessizce bayat veri ` +
        `dondurur (bkz. routes/duels.cjs migration tuzagi notu).`
      );
    });
  }
});

test("realtime.cjs: her preds.json okuması bir Mongo denemesinden sonra geliyor", () => {
  /**
   * Üç canlı-maç ucu da `getPredsForFixture`/`getMyLatestPred` ile başlıyor ve
   * dosyaya yalnızca sonuç boşsa düşüyor. Biri dosyayı öne alırsa ayna
   * kapalıyken canlı ekran "kimse tahmin vermemiş" gösterir — bu sınıf hata
   * bir kez zaten yaşandı (bkz. models/preds.cjs koleksiyon adı notu).
   */
  const kod = yorumsuz(
    fs.readFileSync(nodePath.join(KOK, "routes", "realtime.cjs"), "utf8")
  );

  const re = /readJson\(\s*PREDS_FILE/g;
  const yerler = [];
  let m;
  while ((m = re.exec(kod))) yerler.push(m.index);

  assert.ok(yerler.length > 0, "realtime.cjs'te PREDS_FILE okumasi bulunamadi — tarama bozuk");

  for (const idx of yerler) {
    const onceki = kod.slice(Math.max(0, idx - 700), idx);
    assert.ok(
      /getPredsForFixture|getMyLatestPred/.test(onceki),
      `realtime.cjs @${idx}: preds.json, Mongo denenmeden okunuyor — ayna ` +
      `kapaliyken canli ekran bos tahmin havuzu gosterir`
    );
  }
});

test("NÖBETÇİ: preds.json'dan Mongo'ya tohumlama yolu yok", () => {
  /**
   * ⚠️ `lib/social-store.cjs` koleksiyon boşsa dosyadan tohumluyor; aynayı
   * kapatmak orada bayat dosyanın Mongo'ya geri yazılmasına yol açmıştı
   * (silinen arkadaşlık dirildi). Tahmin tarafında böyle bir yol YOK:
   * `upsertPredictionMongo` / `upsertManyPredictionsMongo` yalnızca yeni gelen
   * kayıtla besleniyor. Biri dosya listesini bu yazıcılara bağlarsa, kapalı
   * ayna donmuş tahminleri Mongo'ya geri yazar.
   */
  const kod = yorumsuz(
    fs.readFileSync(nodePath.join(KOK, "routes", "pred.cjs"), "utf8")
  );

  const yazicilar = /upsert(?:Many)?Predictions?Mongo\(\s*db\s*,\s*([A-Za-z0-9_.]+)/g;
  const dosyadanGelen = new Set(["list", "wrap", "predList", "loaded.list", "preds", "predsAll"]);

  let m;
  let sayac = 0;
  while ((m = yazicilar.exec(kod))) {
    sayac++;
    assert.ok(
      !dosyadanGelen.has(m[1]),
      `routes/pred.cjs: Mongo yazicisina dosyadan okunan liste (${m[1]}) ` +
      `veriliyor — bu bir tohumlama yolu. Ayna kapatildiginda bayat ` +
      `preds.json Mongo'ya geri yazilabilir.`
    );
  }
  assert.ok(sayac > 0, "Mongo yazici cagrisi bulunamadi — tarama bozuk, testi guncelle");
});

test("ayna varsayılanı hâlâ AÇIK — doğrulama GO demedi", () => {
  /**
   * ⚠️ Kardeş bayrak `SKORLIG_MATCHRESULTS_FILE_MIRROR` ortama bağlı hale
   * getirildi (dc81212): Mongo varsa kapalı. Tahmin tarafında bunu YAPMIYORUZ,
   * çünkü DEPLOY.md (A4) bir doğrulama kapısı koyuyor ve kapı GO demedi.
   *
   * ÖLÇÜLDÜ — `node scripts/verify-migration.cjs`, gerçek veri:
   *     dosyada 73.571 tahmin · Mongo'da 44.603 kayıt
   *     dosyada olup Mongo'da OLMAYAN: 30.754 (30.746 bot, 8 insan)
   *     SONUC: NO-GO
   *
   * Render'da hiçbir SKORLIG_* değişkeni set değil — yani buradaki varsayılan
   * doğrudan üretimi belirliyor. Varsayılanı kapatmak, migration tamamlanmadan
   * 30 binden fazla tahmini tek kaynaktan mahrum bırakırdı.
   *
   * ⚠️ Bu testi değiştirmeden önce `scripts/verify-migration.cjs` GO demeli.
   */
  const src = fs.readFileSync(nodePath.join(KOK, "routes", "pred.cjs"), "utf8");
  const satir = yorumsuz(src)
    .split("\n")
    .find((l) => l.includes("const PREDS_FILE_MIRROR"));

  assert.ok(satir, "PREDS_FILE_MIRROR tanimi bulunamadi — tarama bozuk");
  assert.ok(
    /\?\?\s*["']1["']/.test(satir),
    `ayna varsayilani degistirilmis: ${satir.trim()} — verify-migration.cjs ` +
    `NO-GO diyor (30.754 tahmin Mongo'da yok). Once migration tamamlanmali.`
  );
});
