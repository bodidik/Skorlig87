"use strict";

/**
 * KISMİ SONUÇLANAN KUPON LC BASMAZ.
 *
 * ⚠️ BULUNAN: ödül kademeleri `doğru / ÇÖZÜLEN` oranına bakıyor
 * (`lib/kupon-settle.cjs`: `const toplam = cozulen`), yani maçlar ertelendikçe
 * "tam isabet" KOLAYLAŞIYOR ama ödül aynı kalıyor. Kupon LC yakmak üzere
 * ayarlanmışken bir noktadan sonra LC BASMAYA başlıyor.
 *
 * ÖLÇÜLDÜ (p=0.5, `Kupon.beklenenOdul` ile — o fonksiyon zaten tam bu karar
 * için yazılmış; kendi notu da öyle diyor):
 *     ülke   8 maç: 8→-3.91  7→-6.42  6→-3.91  5→-2.19  4→+4.38
 *     avrupa 6 maç: 6→-5.86  5→-3.28  4→+6.56  3→+17.63
 *
 * Eski eşik (`ASGARI_COZULEN_ORAN = 0.5`) ülke kuponunu 4 maçta, Avrupa
 * kuponunu 3 maçta sonuçlandırıyordu — ikisi de LC BASAN bölgede. Yani eşik,
 * ekonominin ters döndüğü noktanın YANLIŞ tarafındaydı.
 *
 * Erteleme kullanıcının elinde değil ama öngörülebilir (kış kar tatilleri,
 * fikstür kaymaları) — yani bu, tetiklenmesi beklenen bir musluk.
 *
 * ⚠️ EŞİK SABİT YAZILMADI, ödül tablosundan TÜRETİLİYOR: kademeler değişirse
 * elle yazılmış bir sayı sessizce bayatlardı (bu oturumda elle tutulan
 * listelerin gerçeklikten ayrışması üç kez hata üretti).
 */

const test = require("node:test");
const describe = require("node:test").describe;
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const Kupon = require("../lib/kupon.cjs");
const KuponSettle = require("../lib/kupon-settle.cjs");

/** Ölçüm varsayımı: maç başına %50 isabet — kod tabanının nötr kabulü. */
const P = 0.5;

const TURLER = [
  { tur: "ulke", mac: 8 },
  { tur: "avrupa", mac: 6 },
];

const net = (n, tur) =>
  Kupon.beklenenOdul(P, n, tur) - Number(Kupon.GIRIS_BEDELI[tur] || 0);

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("ekonomi fonksiyonu ve giriş bedelleri okunabiliyor", () => {
    assert.equal(typeof Kupon.beklenenOdul, "function", "beklenenOdul yok");
    for (const { tur } of TURLER) {
      assert.ok(Number(Kupon.GIRIS_BEDELI[tur]) > 0, `${tur} giris bedeli yok`);
    }
  });

  test("TAM çözülen kupon LC yakıyor (tasarım böyle)", () => {
    // Bu doğru olmasaydı kuponun kendisi zaten musluktu ve bulgu başka olurdu.
    for (const { tur, mac } of TURLER) {
      assert.ok(net(mac, tur) < 0, `${tur}: tam cozulmus kupon LC basiyor (${net(mac, tur).toFixed(2)})`);
    }
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("kısmi sonuçlandırma eşiği", () => {
  for (const { tur, mac } of TURLER) {
    test(`${tur}: PUANLANAN hiçbir yapılandırma LC basmıyor`, () => {
      const esik = KuponSettle._asgariCozulen(mac, tur);
      const basanlar = [];
      for (let n = esik; n <= mac; n++) {
        const d = net(n, tur);
        if (d > 0) basanlar.push(`cozulen ${n}: net +${d.toFixed(2)}`);
      }
      assert.deepStrictEqual(
        basanlar, [],
        `${tur} kuponu esigin (${esik}) ustunde LC basiyor:\n` + basanlar.join("\n")
      );
    });

    test(`${tur}: eşik gereğinden KATI değil (kupon boşuna iade edilmiyor)`, () => {
      /**
       * Kapalı tarafa fazla kaçmak da hata olurdu: eşiği gereksiz yükseltmek
       * puanlanabilecek kuponları iade ettirir, oyunu köreltir.
       */
      const esik = KuponSettle._asgariCozulen(mac, tur);
      if (esik <= 1) return;
      // Eşiğin BİR ALTI gerçekten LC basmalı — yoksa eşik fazla yüksek.
      const altNet = net(esik - 1, tur);
      const oran = Number(process.env.SKORLIG_KUPON_ASGARI_ORAN || 0.5);
      const oranTabani = Math.ceil(mac * oran);
      if (esik > oranTabani) {
        assert.ok(
          altNet > 0,
          `${tur}: esik ${esik}, bir alti (${esik - 1}) LC basmiyor (${altNet.toFixed(2)}) — esik gereksiz yuksek`
        );
      }
    });
  }

  test("ESKİ eşik LC basan bölgede sonuçlandırıyordu (bulgunun büyüklüğü)", () => {
    const eskiEsik = (mac) => Math.ceil(mac * 0.5);
    const basanlar = [];
    for (const { tur, mac } of TURLER) {
      const d = net(eskiEsik(mac), tur);
      if (d > 0) basanlar.push(`${tur}: ${eskiEsik(mac)} macta net +${d.toFixed(2)}`);
    }
    assert.ok(
      basanlar.length === TURLER.length,
      `eski esik artik LC basmiyor — olcum bayatlamis olabilir: ${JSON.stringify(basanlar)}`
    );
  });
});

/* ── Eşik türetiliyor ────────────────────────────────────────────────────── */

describe("eşik ödül tablosundan türetiliyor", () => {
  test("kademeler cömertleşince eşik KENDİLİĞİNDEN yükseliyor", () => {
    /**
     * Sabit sayı yazılsaydı kademeler değiştiğinde eşik sessizce bayatlardı.
     * Burada 5/8 kademesi şişiriliyor ve eşiğin yükselmesi bekleniyor.
     */
    const eski = process.env.SKORLIG_KUPON_ODUL_5;
    process.env.SKORLIG_KUPON_ODUL_5 = "500";
    try {
      // Modüller sabitleri yükleme anında okuyor; taze kopya gerekiyor.
      for (const p of [require.resolve("../lib/kupon.cjs"), require.resolve("../lib/kupon-settle.cjs")]) {
        delete require.cache[p];
      }
      const KS2 = require("../lib/kupon-settle.cjs");
      const yeni = KS2._asgariCozulen(8, "ulke");
      assert.ok(
        yeni > 5,
        `5/8 kademesi 500 LC'ye cikinca esik ${yeni} kaldi — esik tablodan turetilmiyor`
      );
    } finally {
      if (eski === undefined) delete process.env.SKORLIG_KUPON_ODUL_5;
      else process.env.SKORLIG_KUPON_ODUL_5 = eski;
      for (const p of [require.resolve("../lib/kupon.cjs"), require.resolve("../lib/kupon-settle.cjs")]) {
        delete require.cache[p];
      }
    }
  });

  test("operatör eşiği YÜKSELTEBİLİR, indiremez", () => {
    /**
     * `SKORLIG_KUPON_ASGARI_ORAN` ile sıkı olan kazanıyor: yapılandırma
     * kazayla LC basan bölgeye inemesin.
     */
    const src = fs.readFileSync(path.join(__dirname, "..", "lib", "kupon-settle.cjs"), "utf8");
    assert.ok(/Math\.max\(/.test(src), "siki-olan-kazanir kurali yok");
    assert.ok(
      /ekonomikTaban\(toplamMac, tur\)/.test(src),
      "ekonomik taban esik hesabina girmiyor"
    );
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: eşik kapısı türetilmiş değeri kullanıyor", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "lib", "kupon-settle.cjs"), "utf8")
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");

  assert.ok(
    /cozulen < asgariCozulen\(/.test(src),
    "kapi hala ham orani kullaniyor — turetilmis taban devre disi"
  );
  assert.ok(
    !/cozulen < Math\.ceil\(toplamMac \* ASGARI_COZULEN_ORAN\)/.test(src),
    "eski kapi geri gelmis"
  );
});
