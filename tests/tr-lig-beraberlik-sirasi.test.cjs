"use strict";

/**
 * TR-LİG SIRASI ÖDÜLLE AYNI KURALI KULLANIYOR.
 *
 * ⚠️ BULUNAN: `routes/tr-league.cjs` sırayı İKİ FARKLI kuralla hesaplıyordu:
 *
 *   ödül dağıtımı : eşit puanlılar AYNI sırayı paylaşır (rank = i)
 *   ekrana giden  : `ix + 1` — beraberler 1., 2., 3. görünüyordu
 *
 * ÜÇÜNCÜ KOPYA İSTEMCİDEYDİ ve daha ağırdı — `mobile/app/tr-league.tsx`
 * satır sırasını VE GÖSTERİLEN ÖDÜL MİKTARINI dizi indeksinden türetiyordu:
 *     const medal  = ix < 3 ? REWARD_MEDALS[ix] : ` ${ix + 1}.`;
 *     const reward = rewards[ix];
 *
 * ÖLÇÜLDÜ (üç kişi 10 puanla eşit, haftalık ödüller 100/60/30):
 *     ali  → 100 LC aldı, ekranda 1. göründü, "100 LC" yazdı   ✓
 *     veli → 100 LC aldı, ekranda 2. göründü, "60 LC" yazdı    ✗
 *     cem  → 100 LC aldı, ekranda 3. göründü, "30 LC" yazdı    ✗
 *
 * Yani kullanıcıya ALMADIĞI bir ödül miktarı gösteriliyordu. Ödül mantığı
 * doğru olan (rekabet sıralaması: 1,1,1,4); gösterim ona uyduruldu ve sıra
 * artık sunucudan `row.rank` ile geliyor.
 *
 * ⚠️ AYNI SINIF BU OTURUMDA İKİNCİ KEZ: `weekly-picks` tablosu ile "kendi
 * sıram" da ayrışmıştı. Hesabın ikinci kopyası er geç ayrışıyor.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const nodePath = require("path");

const KOK = nodePath.join(__dirname, "..");

/* ── Değişmez: sıra kuralı ──────────────────────────────────────────────── */

describe("rekabet sıralaması", () => {
  /* Uç Mongo snapshot'ları üzerinden çalışıyor; kuralın kendisini sınıyoruz.
   * Nöbetçi ayrıca kaynakta tek kopya olduğunu doğruluyor. */
  function siralariHesapla(board) {
    const siralar = [];
    let rank = 0;
    let prevPoints = null;
    for (let i = 0; i < board.length; i++) {
      const p = Number(board[i]?.points ?? 0);
      if (prevPoints === null || p < prevPoints) {
        rank = i;
        prevPoints = p;
      }
      siralar.push(rank + 1);
    }
    return siralar;
  }

  test("eşit puanlılar AYNI sırayı paylaşıyor", () => {
    const board = [
      { userId: "ali", points: 10 },
      { userId: "veli", points: 10 },
      { userId: "cem", points: 10 },
      { userId: "deniz", points: 5 },
    ];
    assert.deepEqual(
      siralariHesapla(board), [1, 1, 1, 4],
      "beraberler farkli sira aldi — odul dagitimi ucune de birincilik veriyor"
    );
  });

  test("sonraki sıra ATLIYOR (1,1,1,4 — 1,1,1,2 değil)", () => {
    /* Standart rekabet sıralaması. Ödül tablosu 0-tabanlı indekslendiği için
     * "2" verseydik dördüncü kişi ikincilik ödülü alırdı. */
    const board = [
      { userId: "a", points: 9 },
      { userId: "b", points: 9 },
      { userId: "c", points: 3 },
    ];
    assert.deepEqual(siralariHesapla(board), [1, 1, 3]);
  });

  test("beraberlik yoksa sıradan numaralama", () => {
    const board = [
      { userId: "a", points: 9 },
      { userId: "b", points: 6 },
      { userId: "c", points: 3 },
    ];
    assert.deepEqual(siralariHesapla(board), [1, 2, 3]);
  });

  test("ÖDÜL ile SIRA aynı kuralı verirse çakışma olmaz (kusurun kanıtı)", () => {
    /**
     * ⚠️ Bu iddia kusurun NEDEN önemli olduğunu kayıt altına alıyor: eski
     * gösterim kuralı (`ix + 1`) ile ödül kuralı aynı kişide farklı sonuç
     * veriyordu.
     */
    const board = [
      { userId: "ali", points: 10 },
      { userId: "veli", points: 10 },
      { userId: "cem", points: 10 },
    ];
    const dogru = siralariHesapla(board);
    const eskiGosterim = board.map((_, ix) => ix + 1);

    assert.notDeepEqual(
      dogru, eskiGosterim,
      "iki kural ayni sonucu verdi — kurgu kusuru gostermiyor, senaryo bozuk"
    );
    /* Ödül tablosu 100/60/30 iken: üçü de dogru[i]=1 → hepsi 100 LC. Eski
     * gösterimde ikinci kişiye 60, üçüncüye 30 yazılıyordu. */
    const ODUL = [100, 60, 30];
    assert.equal(ODUL[dogru[1] - 1], 100, "veli'nin GERCEK odulu");
    assert.equal(ODUL[eskiGosterim[1] - 1], 60, "veli'ye ESKIDEN gosterilen odul");
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: tr-league sıra kuralı TEK kopyada", () => {
  const src = fs.readFileSync(nodePath.join(KOK, "routes", "tr-league.cjs"), "utf8");
  const kod = src.split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");

  /* Kural bir kez tanımlanmalı ve her yerde o çağrılmalı. */
  const tanim = (kod.match(/function siralariHesapla\s*\(/g) || []).length;
  assert.equal(tanim, 1, `siralariHesapla ${tanim} kez tanimlanmis`);

  /* `ix + 1` / `i + 1` ile doğrudan sıra üretimi kalmamalı. */
  const hamSira = [...kod.matchAll(/rank:\s*(ix|i|idx)\s*\+\s*1/g)].map((m) => m[0]);
  assert.deepEqual(
    hamSira, [],
    `sira dizinin indeksinden turetiliyor: ${hamSira.join(", ")} — beraberlikte ` +
    `odul dagitimindan AYRISIR (olculdu: uc kisi esit puanli, ucu de 100 LC ` +
    `aldi ama ekranda 1./2./3. gorundu)`
  );

  /* Ödül dağıtımı da aynı kaynağı kullanmalı. */
  const odulBolgesi = kod.slice(kod.indexOf("const awards = []"), kod.indexOf("const awards = []") + 700);
  assert.ok(
    /siralariHesapla\(/.test(odulBolgesi),
    "odul dagitimi kendi sira mantigini kullaniyor — gosterimle ayrisir"
  );
});

test("NÖBETÇİ: istemci sırayı sunucudan alıyor", () => {
  const ekran = nodePath.join(KOK, "..", "mobile", "app", "tr-league.tsx");
  if (!fs.existsSync(ekran)) return; // başka checkout

  const src = fs.readFileSync(ekran, "utf8")
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");

  assert.ok(
    /row\.rank/.test(src),
    "istemci row.rank okumuyor — sirayi dizi indeksinden turetiyorsa " +
    "beraberlikte yanlis sira VE yanlis odul miktari gosterir"
  );
  assert.ok(
    !/rewards\[\s*ix\s*\]/.test(src),
    "odul miktari hala dizi indeksinden secililiyor (rewards[ix]) — esit " +
    "puanli ikinci kisiye ALMADIGI tutar yazilir"
  );
});
