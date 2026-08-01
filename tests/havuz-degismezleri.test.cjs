"use strict";

/**
 * HAVUZ (pari-mutuel) — ÖDEME HAVUZU AŞMAZ.
 *
 * ⚠️ BU TURDA KUSUR BULUNMADI. Somut şüphelerle geldim, hepsini ölçtüm:
 *
 * 1) YUVARLAMA. `settlePool` her kazanana `Math.round(bahis * carpan)` ödüyor.
 *    Turnuva ödemesinde tam bu desen havuzdan fazla ödeme üretmişti (ayrı
 *    commit'te en-büyük-kalan yöntemiyle düzeltildi).
 *    ÖLÇÜLDÜ (2..60 kazanan taraması): kuramsal tutara göre en büyük SAPMA
 *    +2.50 LC / 270 LC havuz (%0.93) ve iki yönlü — 40 kazananlı senaryoda
 *    −0.25 LC. Kesinti %5 olduğu için havuz her hâlükârda net LC YAKIYOR;
 *    yani bu bir enflasyon sızıntısı değil. Değiştirmedim.
 *
 * 2) ERTELENEN MAÇ. `settlePool` yalnızca settle2'den, sonuç gelince
 *    çağrılıyor — dosyanın kendi notu "sonuç gelmezse bahisler sonsuza kadar
 *    havuzda" diyor. KAYNAĞI DOĞRULADIM: `services/bayat-temizleyici.cjs`
 *    `havuzlariTemizle` bayat maçtaki bahisleri `pool_void_refund` ile iade
 *    ediyor. Kapatılmış.
 *
 * 3) EKRANDAKİ ÇARPAN. `summary` çarpanı `r2` ile 2 basamağa yuvarlayıp
 *    gösteriyor, `settlePool` HAM çarpanla ödüyor. Bu oturumda tam bu ayrışma
 *    bir kez kusur çıkardı (kartta gösterilen oran ile ödül çelişiyordu).
 *    Ölçtüğüm senaryolarda ödeme aynı çıktı; aşağıdaki test farkı sınırlıyor.
 *
 * 4) `burned` KURAMSAL kesinti (`toplam × %5`), gerçek kalıntı
 *    (`toplam − ödenen`) değil; ikisi yuvarlama kadar ayrışıyor. Nerede
 *    kullanıldığını aradım: yalnızca settle2'de bir LOG satırı. Muhasebeye
 *    girmiyor, o yüzden dokunmadım.
 *
 * Test bir düzeltmeyi değil, paranın YÜK TAŞIYAN değişmezini koruyor:
 * havuzdan çıkan, havuza girenden fazla olamaz.
 */

const os = require("os");
const path = require("path");
const fs = require("fs");

const TMP = path.join(os.tmpdir(), "skorlig-havuz-degismez-test");
process.env.SKORLIG_DATA_DIR = TMP;
process.env.SKORLIG_BG = "0";
process.env.SKORLIG_WALLET_FILE_MIRROR = "0";

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const KOK = path.join(__dirname, "..");
const Pool = require("../lib/pool-store.cjs");

let mongod = null, client = null, db = null;

before(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const { MongoClient } = require("mongodb");
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  db = client.db("test");
});

after(async () => {
  if (client) await client.close();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  await db.collection(Pool.COLL_BETS).deleteMany({});
  await db.collection(Pool.COLL_POOLS).deleteMany({});
  await db.collection("lc_wallet_users").deleteMany({});
});

/** Bahisleri doğrudan yerleştirir (tavan/kilit kuralları ayrı sınanıyor). */
async function bahisler(liste, fid = "fx") {
  let i = 0;
  for (const b of liste) {
    i++;
    await db.collection(Pool.COLL_BETS).insertOne({
      fixtureId: fid, userId: `u${i}`, userIdLower: `u${i}`,
      side: b.side, amount: b.amount, createdAt: new Date().toISOString(),
    });
  }
  return liste.reduce((a, b) => a + b.amount, 0);
}

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("sonuçlandırma gerçekten para dağıtıyor", async () => {
    const havuz = await bahisler([
      { side: "H", amount: 10 }, { side: "H", amount: 15 }, { side: "A", amount: 20 },
    ]);
    const r = await Pool.settlePool("fx", "H", db);
    assert.equal(r.ok, true, `settle basarisiz: ${r.reason}`);
    assert.ok(r.paid > 0, "hic odeme yapilmamis — test bir sey olcmuyor");
    assert.ok(havuz > 0);
  });

  test("kesinti oranı beklenen aralıkta", () => {
    assert.ok(Pool.CUT_PCT > 0 && Pool.CUT_PCT < 0.2, `kesinti ${Pool.CUT_PCT} beklenmedik`);
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("ödeme havuzu aşmaz", () => {
  test("geniş taramada ödenen <= havuz", async () => {
    /**
     * ⚠️ ASIL DEĞİŞMEZ BU. Ödeme `creditLc` ile ÜRETİLİYOR (bir kasadan
     * çekilmiyor), yani havuzdan fazla ödemek doğrudan LC basmak demek.
     * Turnuva tarafında aynı desen tam olarak bunu yapıyordu.
     */
    let enBuyukSapma = 0, enBuyukAd = "";
    for (let n = 2; n <= 40; n++) {
      await db.collection(Pool.COLL_BETS).deleteMany({});
      await db.collection(Pool.COLL_POOLS).deleteMany({});

      const liste = [];
      for (let i = 0; i < n; i++) liste.push({ side: "H", amount: 5 + (i * 3) % 11 });
      liste.push({ side: "A", amount: 37 });
      const havuz = await bahisler(liste);

      const r = await Pool.settlePool("fx", "H", db);
      assert.ok(
        r.paid <= havuz,
        `${n} kazanan: odenen ${r.paid} > havuz ${havuz} — havuzdan fazla odeniyor, LC basiliyor`
      );
      const kuramsal = havuz * (1 - Pool.CUT_PCT);
      const sapma = Math.abs(r.paid - kuramsal);
      if (sapma > enBuyukSapma) { enBuyukSapma = sapma; enBuyukAd = `${n} kazanan, havuz ${havuz}`; }
    }
    /* Ölçüm anında en büyük sapma 2.50 LC idi. Eşik biraz üstünde: amaç tam
     * sayıyı dondurmak değil, yuvarlamanın BİRİKMEYE başlamasını yakalamak. */
    assert.ok(
      enBuyukSapma <= 6,
      `yuvarlama sapmasi ${enBuyukSapma.toFixed(2)} LC (${enBuyukAd}) — olcum aninda 2.50 idi`
    );
  });

  test("kaybeden yoksa kesinti alınmıyor — herkes bahsini geri alıyor", async () => {
    const havuz = await bahisler([
      { side: "H", amount: 10 }, { side: "H", amount: 25 }, { side: "H", amount: 7 },
    ]);
    const r = await Pool.settlePool("fx", "H", db);
    assert.equal(r.paid, havuz, "tek taraf varken kesinti alinmis");
    assert.equal(r.burned, 0);
  });

  test("kazanan yoksa havuz tamamen iade", async () => {
    const havuz = await bahisler([
      { side: "H", amount: 10 }, { side: "A", amount: 25 },
    ]);
    const r = await Pool.settlePool("fx", "D", db);
    assert.equal(r.paid, havuz, "kazanan yokken iade eksik");
    assert.equal(r.burned, 0, "kimseden kesinti alinmamali");
  });

  test("kaybeden varken havuz net LC YAKIYOR", async () => {
    /* Havuzun ekonomideki rolü bu: musluk değil, gider. */
    const havuz = await bahisler([
      { side: "H", amount: 30 }, { side: "H", amount: 20 }, { side: "A", amount: 50 },
    ]);
    const r = await Pool.settlePool("fx", "H", db);
    assert.ok(r.paid < havuz, `odenen ${r.paid} >= havuz ${havuz} — havuz LC yakmiyor`);
  });
});

describe("mühür", () => {
  test("ikinci sonuçlandırma ödeme yapmıyor", async () => {
    await bahisler([{ side: "H", amount: 10 }, { side: "A", amount: 20 }]);
    const r1 = await Pool.settlePool("fx", "H", db);
    const r2 = await Pool.settlePool("fx", "H", db);
    assert.ok(r1.paid > 0);
    assert.equal(r2.ok, false);
    assert.equal(r2.reason, "ALREADY_SETTLED", "muhur tutmadi — cifte odeme");
  });

  test("eşzamanlı sonuçlandırmadan yalnızca biri ödüyor", async () => {
    await bahisler([{ side: "H", amount: 10 }, { side: "A", amount: 20 }]);
    const hepsi = await Promise.all(
      Array.from({ length: 6 }, () => Pool.settlePool("fx", "H", db))
    );
    const odeyen = hepsi.filter((r) => r.ok && r.paid > 0);
    assert.equal(odeyen.length, 1, `${odeyen.length} cagri odeme yapti — muhur yarisi kaybetti`);
  });
});

describe("ekrandaki çarpan ile ödenen", () => {
  test("gösterilen çarpanla hesaplanan tutardan sapma bahis başına 1 LC'yi geçmiyor", async () => {
    /**
     * `summary` çarpanı 2 basamağa yuvarlıyor, `settlePool` ham çarpanla
     * ödüyor. Tam eşitlik istemek yanlış olurdu (ham değer daha doğru); ama
     * oyuncunun ekranda gördüğüyle aldığı arasındaki fark küçük kalmalı.
     */
    const liste = [];
    for (let i = 0; i < 12; i++) liste.push({ side: "H", amount: 10 + i * 4 });
    liste.push({ side: "A", amount: 90 });
    await bahisler(liste);

    const ozet = await Pool.summary("fx", db);
    const gosterilen = ozet.multipliers.H;
    const r = await Pool.settlePool("fx", "H", db);

    const beklenen = liste
      .filter((b) => b.side === "H")
      .reduce((a, b) => a + Math.round(b.amount * gosterilen), 0);
    const kazananSayisi = liste.filter((b) => b.side === "H").length;
    assert.ok(
      Math.abs(r.paid - beklenen) <= kazananSayisi,
      `ekranda ${gosterilen}x ile beklenen ${beklenen}, odenen ${r.paid} — ` +
        "gosterilen oran ile odeme ayrismis"
    );
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

const kaynak = (rel) =>
  fs.readFileSync(path.join(KOK, rel), "utf8")
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");

test("NÖBETÇİ: mühür ödemeden ÖNCE alınıyor", () => {
  const src = kaynak("lib/pool-store.cjs");
  const iMuhur = src.indexOf("ALREADY_SETTLED");
  const iOdeme = src.indexOf('"pool_win"');
  assert.ok(iMuhur > 0 && iOdeme > iMuhur, "odeme muhurden once yapiliyor — cifte odeme riski");
});

test("NÖBETÇİ: bayat havuz iadesi hâlâ bağlı", () => {
  /**
   * `settlePool` yalnızca sonuç gelince çağrılıyor. Ertelenen maçta parayı
   * çözen tek şey bayat temizleyici; bağlantı koparsa para sessizce kilitli
   * kalır ve hiçbir hata görünmez.
   */
  const src = kaynak("services/bayat-temizleyici.cjs");
  assert.ok(/pool_void_refund/.test(src), "bayat havuz iadesi kaldirilmis — para sonsuza kilitli kalir");
  assert.ok(/havuzlariTemizle/.test(src) && /havuzlariTemizle\(db/.test(src), "havuz temizligi tura bagli degil");
});

test("NÖBETÇİ: botlar havuza giremiyor", () => {
  /* Bota para vermek ya gerçek kullanıcının parasını sistemden çıkarır ya da
   * LC enflasyonu yaratır — dosyanın kendi kararı. */
  const src = kaynak("lib/pool-store.cjs");
  assert.ok(/isBot\)\s*return \{ ok: false, reason: "BOT_NOT_ALLOWED" \}/.test(src), "bot suzgeci kalkmis");
});
