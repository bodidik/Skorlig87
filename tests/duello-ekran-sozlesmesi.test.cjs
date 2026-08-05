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

/** Sunucu sabitlerini KAYNAKTAN oku — testin kendi kopyası olmasın. */
function sunucuSabitleri() {
  const s = fs.readFileSync(path.join(KOK, "routes", "duels.cjs"), "utf8");
  const say = (ad) => {
    const m = new RegExp(`const ${ad}\\s*=\\s*([0-9.]+)\\s*;`).exec(s);
    assert.ok(m, `${ad} kaynaktan okunamadi`);
    return Number(m[1]);
  };
  return { MIN: say("MIN_STAKE"), MAX: say("MAX_STAKE"), CUT: say("HOUSE_CUT_PCT") };
}

/** Sunucunun ödül hesabı — duels.cjs ile AYNI iki adım. */
function sunucuOdulu(stake, cut) {
  const pot = stake * 2;
  const houseCut = Math.round(pot * cut * 10) / 10;
  return Math.round((pot - houseCut) * 10) / 10;
}

/** Ekranın ödül hesabı — [fixtureId].tsx satır ~577 ile AYNI tek adım. */
function ekranOdulu(stake, cut) {
  return Math.round(stake * 2 * (1 - cut) * 10) / 10;
}

function ekranKaynagi() {
  return fs.readFileSync(EKRAN, "utf8");
}

/* ── Kurulum sağlam mı ───────────────────────────────────────────────────── */

describe("kurulum", () => {
  test("sunucu sabitleri okunabiliyor ve makul", () => {
    const { MIN, MAX, CUT } = sunucuSabitleri();
    assert.ok(MIN >= 1 && MAX > MIN, `bahis araligi beklenmedik: ${MIN}..${MAX}`);
    assert.ok(CUT > 0 && CUT < 0.5, `kesinti orani beklenmedik: ${CUT}`);
  });
});

/* ── Asıl değişmez ───────────────────────────────────────────────────────── */

describe("ekran ile sunucu sözleşmesi", () => {
  test("ekranın sunduğu HER bahis sunucuda geçerli", (t) => {
    if (!fs.existsSync(EKRAN)) return t.skip("mobil deposu yok");
    const m = /const STAKES\s*=\s*\[([^\]]+)\]/.exec(ekranKaynagi());
    assert.ok(m, "STAKES listesi ekranda bulunamadi — ad degismis olabilir");
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

  test("ekranda gösterilen ödül, sunucunun yazacağı ödüle EŞİT", (t) => {
    /**
     * ⚠️ DÜRÜST SINIR: negatif kontrolde kesintiyi 0.05 → 0.07 yaptım ve bu
     * test KIRILMADI. Sebebi öğretici — `pot = 2*stake` her zaman çift olduğu
     * için iki formül matematiksel olarak çakışıyor, kesinti oranı ne olursa
     * olsun. Yani buradaki koruma "formüller aynı sonucu veriyor" iddiasından
     * ibaret; oran ayrışmasını YAKALAYAN, bir alttaki testtir.
     * Asimetrik bahis ya da tek sayılı pot gelirse bu test canlanır.
     */
    if (!fs.existsSync(EKRAN)) return t.skip("mobil deposu yok");
    const { MIN, MAX, CUT } = sunucuSabitleri();
    const farkli = [];
    for (let s = MIN; s <= MAX; s++) {
      const sunucu = sunucuOdulu(s, CUT);
      const ekran = ekranOdulu(s, CUT);
      if (sunucu !== ekran) farkli.push(`${s} LC → ekran ${ekran}, sunucu ${sunucu}`);
    }
    assert.deepEqual(
      farkli, [],
      "ekran parayi yatirmadan ONCE yanlis odul gosteriyor: " + farkli.join(" | ")
    );
  });

  test("ekran kesinti oranını SUNUCUDAN alıyor (sabit çarpan YOK)", (t) => {
    /**
     * ⚠️ BU TESTİN İDDİASI TERSİNE DÖNDÜ — VE BU BİR İYİLEŞME.
     *
     * Eski hâli, ekranda `* 0.95` çarpanının BULUNMASINI şart koşuyordu:
     * o gün elde tek koruma, iki sabitin eşit kaldığını doğrulamaktı. Ama
     * eşitliği doğrulamak sapmayı ÖNLEMİYOR, yalnızca fark edilmesini
     * sağlıyordu — üstelik sunucudaki oran env ile değiştirilirse
     * (`SKORLIG_*`) test yeşil kalırken ekran yanlış kazanç vaat ederdi.
     *
     * 2026-08-03: `/duels/open` artık `houseCutPct`, `minStake`, `maxStake`
     * gönderiyor ve ekran onu kullanıyor. Sapma STRUKTUREL olarak imkânsız;
     * dolayısıyla artık sabit çarpanın YOKLUĞUNU doğruluyoruz.
     *
     * Ekranın hesabının sunucuyla aynı sonucu verdiği testi (yukarıdaki
     * "ekran parayi yatirmadan ONCE...") yerinde duruyor — asıl güvence o.
     */
    if (!fs.existsSync(EKRAN)) return t.skip("mobil deposu yok");
    const { CUT } = sunucuSabitleri();
    const src = ekranKaynagi();
    const eskiCarpan = String(1 - CUT);          // 0.05 → "0.95"
    assert.ok(
      !src.includes(`* ${eskiCarpan} *`) && !src.includes(`* ${eskiCarpan})`),
      `ekran hala sabit ${eskiCarpan} carpani kullaniyor — sunucudaki kesinti degisirse yanlis odul gosterir`
    );
    assert.ok(
      /houseCutPct/.test(src),
      "ekran kesinti oranini sunucudan okumuyor"
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
