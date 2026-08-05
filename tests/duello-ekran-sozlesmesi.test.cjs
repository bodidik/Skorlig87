"use strict";

/**
 * DÜELLO EKRANI İLE SUNUCU AYNI SAYILARI SÖYLÜYOR.
 *
 * ⚠️ BU TURDA KUSUR BULUNMADI. Üç somut şüpheyle geldim, üçünü de ölçtüm:
 *
 * 1) BAHİS SEÇENEKLERİ. Ekran sabit bir liste sunuyor
 *    (`mobile/app/duel/[fixtureId].tsx` → `STAKES`), sunucu ayrı bir aralık
 *    doğruluyor (`MIN_STAKE`/`MAX_STAKE`). Liste aralığın dışına taşarsa
 *    kullanıcı basınca INVALID_STAKE alır. ÖLÇÜLDÜ: liste [1,2,3,5,8,10,12],
 *    aralık 1..12 — taşma YOK.
 *
 * 2) ÖDÜL FORMÜLÜ İKİ YERDE. Sunucu önce KESİNTİYİ yuvarlayıp çıkarıyor
 *    (`round(pot*0.05*10)/10` sonra `round((pot-cut)*10)/10`); ekran ise tek
 *    adımda `round(pot*0.95*10)/10` yapıyor. Farklı formüller aynı sonucu
 *    vermek zorunda değil. ÖLÇÜLDÜ: sunulan her bahis için ikisi de aynı —
 *    çünkü `pot = 2*stake` her zaman ÇİFT, yani kesinti yuvarlaması hiç
 *    devreye girmiyor. Bu bir tesadüf değil ama KIRILGAN: tek sayılı bir pot
 *    (ör. asimetrik bahis) ya da değişen bir kesinti oranı ayrışma üretir.
 *    Test bunu her seçenek için sabitliyor.
 *
 * 3) KESİNTİ ORANI EKRANDA SABİT YAZILI (`0.95`, dört yerde). Sunucudaki
 *    `HOUSE_CUT_PCT` değişirse ekran ESKİ ödülü gösterir — üstelik kullanıcı
 *    parayı yatırmadan ÖNCE gördüğü sayı odur. Bu oturumda tam bu sınıf bir
 *    kusur bulunmuştu (kartta gösterilen oran ile ödül çelişiyordu). Şu an
 *    değerler tutuyor; test ayrışmayı yakalayacak.
 *
 * ⚠️ ÇAPRAZ DEPO: API deposu mobil çekimine bağımlı olamaz; yan dizin yoksa
 * test atlanır.
 */

const test = require("node:test");
const describe = require("node:test").describe;
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
const MOBIL = require("./_mobil-dizin.cjs").MOBIL;
const EKRAN = path.join(MOBIL, "app", "duel", "[fixtureId].tsx");

/* ⚠️ SABİTLER VE HESAP ARTIK TEK KAYNAKTAN — regex'le okunup burada yeniden
 * yazılmıyor. Kesinti 2026-08-05'te kademeli tam sayıya çevrildi
 * (bkz. lib/duello-kesinti.cjs); kopya formül o gün sessizce yanlış hesabı
 * sınamaya devam ederdi. */
const KESINTI = require("../lib/duello-kesinti.cjs");

function sunucuSabitleri() {
  return { MIN: KESINTI.MIN_STAKE, MAX: KESINTI.MAX_STAKE };
}

/** Sunucunun ödül hesabı — duels.cjs ile AYNI fonksiyon. */
function sunucuOdulu(stake) {
  return KESINTI.duelloPaylari(stake).winAmount;
}

function ekranKaynagi() {
  return fs.readFileSync(EKRAN, "utf8");
}

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("sunucu sabitleri okunabiliyor ve makul", () => {
    const { MIN, MAX } = sunucuSabitleri();
    assert.ok(MIN >= 1 && MAX > MIN, `bahis araligi beklenmedik: ${MIN}..${MAX}`);
  });

  test("üretim rotası bu hesabı kullanıyor", () => {
    /* Rota kendi kopyasını tutmaya dönerse bu dosya yanlış kaynağı sınar. */
    const s = fs.readFileSync(path.join(KOK, "routes", "duels.cjs"), "utf8");
    assert.ok(/require\("\.\.\/lib\/duello-kesinti\.cjs"\)/.test(s),
      "duels.cjs kesinti modulunu kullanmiyor — test bir sey olcmuyor");
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("ekran ile sunucu sözleşmesi", () => {
  test("ekranın sunduğu HER bahis sunucuda geçerli", (t) => {
    if (!fs.existsSync(EKRAN)) return t.skip("mobil deposu yok");
    /* Liste artık sunucudan geliyor; `YEDEK_STAKES` eski sunucular için duran
     * yedek ve o da aralık dışına taşabilir — asıl sınanan o. */
    const m = /const (?:YEDEK_)?STAKES\s*=\s*\[([^\]]+)\]/.exec(ekranKaynagi());
    assert.ok(m, "bahis listesi ekranda bulunamadi — ad degismis olabilir");
    const stakes = m[1].split(",").map((x) => Number(x.trim())).filter(Number.isFinite);
    assert.ok(stakes.length >= 3, `yalnizca ${stakes.length} secenek okundu — ayristirma bozuk`);

    const { MIN, MAX } = sunucuSabitleri();
    const disarida = stakes.filter((s) => s < MIN || s > MAX || !Number.isInteger(s));
    assert.deepEqual(
      disarida, [],
      `ekran sunucunun reddedecegi bahis sunuyor (aralik ${MIN}..${MAX}): ${disarida.join(", ")} — ` +
        "kullanici basinca INVALID_STAKE alir"
    );
  });

  test("sunucunun gönderdiği ödül tablosu, yazacağı ödülle AYNI", () => {
    /**
     * ⚠️ ARTIK SUNUCUNUN İKİ YOLU KARŞILAŞTIRILIYOR: `/duels/open`in ekrana
     * gönderdiği tablo (`odulTablosu`) ile düello kurulurken cüzdana yazılan
     * `winAmount` (`duelloPaylari`). Ekran hesap yapmadığı için sapma ancak
     * bu iki sunucu yolu ayrışırsa doğar.
     */
    for (const satir of KESINTI.odulTablosu()) {
      assert.equal(satir.winAmount, sunucuOdulu(satir.stake),
        `bahis ${satir.stake}: tabloda ${satir.winAmount}, kayitta ${sunucuOdulu(satir.stake)}`);
    }
  });

  test("ekran ödülü HİÇ hesaplamıyor (sabit çarpan YOK)", (t) => {
    /**
     * ⚠️ BU TESTİN İDDİASI İKİ KEZ SIKILAŞTI.
     *
     * 1) İlk hâli ekranda `* 0.95` çarpanının BULUNMASINI şart koşuyordu —
     *    eşitliği doğrulamak sapmayı ÖNLEMİYOR, yalnızca fark ettiriyordu.
     * 2) 2026-08-03: oran sunucudan alınmaya başlandı, ama ÇARPMA hâlâ
     *    ekrandaydı (`pot * (1 - houseCutPct)`).
     * 3) 2026-08-05: kesinti kademeli TAM SAYI LC oldu (bkz.
     *    lib/duello-kesinti.cjs) ve tek bir oranla ifade edilemez hâle geldi —
     *    bahis 5'te %10, bahis 12'de %4.2, bahis 1-4'te %0. Sunucu artık her
     *    bahsin ödülünü HESAPLANMIŞ gönderiyor; ekranın çarpacak bir şeyi yok.
     *
     * Yani sapma artık yapısal olarak imkânsız ve bu iddia onu tutuyor.
     */
    if (!fs.existsSync(EKRAN)) return t.skip("mobil deposu yok");
    const src = ekranKaynagi()
      .split("\n")
      .map((l) => {
        const x = l.trim();
        return x.startsWith("*") || x.startsWith("//") || x.startsWith("/*") ? "" : l;
      })
      .join("\n");

    assert.ok(
      !/\(1\s*-\s*houseCutPct\)/.test(src),
      "ekran hala kesinti oraniyla carpiyor — kademeli kesinti tek oranla ifade edilemez"
    );
    assert.ok(
      !/\bpot\s*\*\s*[\d.]/.test(src) && !/stake\s*\*\s*2\s*\*/.test(src),
      "ekranda hala sabit carpanli odul hesabi var"
    );
    assert.ok(
      /odulTablosu/.test(src),
      "ekran odul tablosunu sunucudan okumuyor"
    );
  });
});

/* ── Nöbetçi ────────────────────────────────────────────────────────────── */

test("NÖBETÇİ: sunucu bahis aralığını GERÇEKTEN doğruluyor", () => {
  /**
   * Ekran listesi bir güvenlik sınırı değil; istemci istediği sayıyı
   * gönderebilir. Asıl koruma sunucudaki aralık denetimi.
   */
  const src = fs.readFileSync(path.join(KOK, "routes", "duels.cjs"), "utf8")
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : l;
    })
    .join("\n");
  assert.ok(
    /s\s*<\s*MIN_STAKE\s*\|\|\s*s\s*>\s*MAX_STAKE/.test(src),
    "bahis aralik denetimi kalkmis — istemci istedigi bahsi kurabilir"
  );
  assert.ok(/Math\.floor\(Number\(stake\)\)/.test(src), "kesirli bahis tam sayiya indirgenmiyor");
});
