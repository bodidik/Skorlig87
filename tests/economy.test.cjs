"use strict";

/**
 * Ekonomi denge kuralları.
 *
 * NEDEN VAR (ölçüldü 2026-07-29): LC arzı kontrolsüzdü — giriş 2.182 / çıkış 15,
 * oran 145:1. Sebep iki delikti:
 *
 *   1) İade eşiği `base > 0` idi → "kıl payı bildim" bile kârlıydı.
 *      1291 gerçek oyuncunun performansıyla: oyuncuların **%100'ü** her maçta
 *      kâr ediyordu, ortalama +2.21 LC.
 *   2) Günlük hak koşulsuz ekleniyordu → oynamayan bile biriktiriyordu,
 *      aylık +143 LC.
 *
 * Bu kurallar sessizce geri kayarsa belirti "para hatası" değil, "ekonomi
 * yavaşça şişiyor" olur — aylar sonra fark edilir. O yüzden testle tutuluyor.
 *
 * Çalıştırma:  npm test
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const nodePath = require("path");

const { _dagilim, _akis } = require("../lib/economy-report.cjs");

/**
 * ⚠️ BURADA ÖDÜL MERDİVENİNİN KOPYASI VARDI — VE YORUMU İTİRAF EDİYORDU:
 * "settle2'deki kuralın birebir kopyası — orada değişirse burada da
 * değişmeli." Elle senkron gerektiren her kopya, sapmayı bekleyen bir
 * hatadır: merdiven `lib/ekonomi.cjs macOdulu` içinde değişse bu test ESKİ
 * değerlerle YİNE geçerdi — üstelik tek işi ekonomi değişmezlerini
 * korumak olan bir test.
 *
 * `LC_ENTRY_COST = 3` de aynı durumdaydı; `MAC_GIRIS_BEDELI` tek kaynak.
 */
const { macOdulu: odul, MAC_GIRIS_BEDELI: LC_ENTRY_COST } = require("../lib/ekonomi.cjs");

function netLc(base, esik) {
  const iade = base >= esik ? LC_ENTRY_COST : 0;
  return iade + odul(base) - LC_ENTRY_COST;
}

describe("iade eşiği", () => {
  test("ESKİ kural (base>0) neredeyse her tahmini kârlı yapıyordu", () => {
    // Regresyon kaydı: bu davranışa dönülürse enflasyon geri gelir.
    assert.equal(netLc(1, 1), 1, "kıl payı bilen bile +1 kazanıyordu");
    assert.equal(netLc(3, 1), 2, "medyan oyuncu +2");
    assert.equal(netLc(0, 1), -3, "yalnızca TAMAMEN yanılan kaybediyordu");
  });

  test("YENİ kural (base>=6): zayıf tahmin artık kaybettirir", () => {
    assert.equal(netLc(0, 6), -3);
    assert.equal(netLc(1, 6), -2);
    assert.equal(netLc(3, 6), -1, "medyan oyuncu artık hafif negatif");
  });

  test("gerçek isabet hâlâ kazandırır", () => {
    assert.equal(netLc(6, 6), 4);
    assert.equal(netLc(12, 6), 7);
    assert.equal(netLc(30, 6), 15);
  });

  test("eşik yükseldikçe ortalama düşer (yön kontrolü)", () => {
    const ortalama = (esik) =>
      [0, 1, 3, 6, 12, 20, 30].reduce((a, b) => a + netLc(b, esik), 0) / 7;
    assert.ok(ortalama(1) > ortalama(6), "base>0 en enflasyonist olmalı");
    assert.ok(ortalama(6) > ortalama(12));
  });
});

describe("günlük hak — tabana tamamlama", () => {
  // routes/lc-wallet.cjs gunlukMiktar ile aynı kural.
  // routes/lc-wallet.cjs ile AYNI: taban bir gunluk oyun bedelinden az olmali
  // (taban 15 iken 5 tahmin kaybeden ertesi gun tam tamamlanir = kayip bedava).
  // routes/lc-wallet.cjs ile AYNI kademeler (gunlukTaban).
  // Kullanıcı isteği (2026-07-30): temel miktar 3-4 LC yeterli, üst üste
  // alana bonus olsun. Bonus TABANI YÜKSELTEREK verilir — koşulsuz ekleme
  // birikir, tamamlama birikmez.
  /**
   * ⚠️ BU BLOK KURALI YENİDEN YAZIYORDU — YANİ BOŞ YERE YEŞİLDİ.
   * Eskiden burada üretimdeki formülün bir KOPYASI vardı:
   *     const gunluk = (b, taban) => b >= taban ? 0 : taban - b;
   * `routes/lc-wallet.cjs gunlukMiktar` değişse bu test YİNE geçerdi; yani
   * ekonominin en kritik anti-enflasyon kuralı ("zengine verme") fiilen
   * denetimsizdi. Artık GERÇEK fonksiyon çağrılıyor.
   * Kapsamlı değişmezler: tests/ekonomi-enflasyon-guvencesi.test.cjs
   */
  const Wallet = require("../routes/lc-wallet.cjs");
  const TABANLAR = Wallet._TABANLAR;
  const TABAN = TABANLAR.DAILY_FLOOR;      // 1-2. gün
  const TABAN_3 = TABANLAR.DAILY_FLOOR_3;  // 3-6. gün
  const TABAN_7 = TABANLAR.DAILY_FLOOR_7;  // 7+ gün
  /**
   * Gerçek üretim fonksiyonu. Çağıranlar TABANI veriyor; `gunlukMiktar` ise
   * (bakiye, premium, seri) alıyor — taban oradan türetiliyor. Bu sarmalayıcı
   * istenen tabanı üretecek girdiyi seçiyor.
   */
  const gunluk = (bakiye, taban = TABAN) => {
    if (taban === TABANLAR.DAILY_FLOOR_PREM) return Wallet._gunlukMiktar(bakiye, true, 0);
    const seri = taban === TABAN_7 ? 7 : taban === TABAN_3 ? 3 : 0;
    return Wallet._gunlukMiktar(bakiye, false, seri);
  };

  test("parasız oyuncuya tabana kadar verilir", () => {
    assert.equal(gunluk(0), 3, "1-2. günde temel taban");
    assert.equal(gunluk(2), 1, "medyan bakiye 2 LC ölçülmüştü → fark kadar");
  });

  test("ZENGİN oyuncuya HİÇBİR ŞEY verilmez", () => {
    // Asıl düzeltme bu: eskiden 229 LC'si olan da her gün +5 alıyordu.
    assert.equal(gunluk(3), 0, "taban 3 → 3 LC'si olana verilmez");
    assert.equal(gunluk(100), 0);
    assert.equal(gunluk(229), 0);
  });

  test("arz oyuncu sayısıyla SINIRLI kalır", () => {
    // Koşulsuz eklemede toplam arz zamanla sonsuza gider; tabanla sınırlıdır.
    const oyuncular = [0, 2, 5, 15, 50, 229];
    const eklenen = oyuncular.reduce((a, b) => a + gunluk(b), 0);
    const ustSinir = oyuncular.length * TABAN;
    assert.ok(eklenen <= ustSinir, "günlük ekleme oyuncu×taban'ı aşamaz");
    // Taban 3: yalnızca 0 (+3) ve 2 (+1) alır; 5 ve üstü hiçbir şey almaz.
    assert.equal(eklenen, 3 + 1, "yalnızca taban altındakiler alır");
  });

  test("KAYIP BEDAVA OLMAMALI — taban < günlük oyun bedeli", () => {
    // Kendi ilk önerimdeki kusur buydu: taban 15 iken oyuncu 5 tahmin yapıp
    // (5×3=15 LC) hepsini kaybetse ertesi gün tam tamamlanıyordu — zararı
    // sistem karşılıyor, iade eşiği düzeltmesi anlamsızlaşıyordu.
    const GIRIS_BEDELI = 3;
    // Kural EN YÜKSEK kademe için de geçerli olmalı — seri bonusu bu sınırı
    // delerse kaybetmek yine bedava olur.
    assert.ok(TABAN_7 < GIRIS_BEDELI * 3, "en yüksek taban 3 maçlık bedelin altında kalmalı");
    assert.equal(TABAN, GIRIS_BEDELI, "temel taban = 1 maç");
  });

  test("üst üste gün TABANI yükseltir, EKLEME yapmaz", () => {
    // Ayrım kritik: bonus tabana EKLENSEYDİ zengin oyuncu da her gün alırdı
    // ve arz birikirdi. Taban yükseltmede zengine yine 0 verilir.
    assert.equal(gunluk(0, TABAN), 3, "1. gün");
    assert.equal(gunluk(0, TABAN_3), 5, "3. gün");
    assert.equal(gunluk(0, TABAN_7), 7, "7. gün");
    assert.equal(gunluk(21, TABAN_7), 0, "bakiyesi yüksek oyuncu seride bile 0 alır");
  });

  test("0 LC verilecekse GÜN YAKILMAMALI", () => {
    // Ölçüldü (2026-07-30): bakiye 21, taban 6 → verilen 0, ama lastDailyAt
    // yazılıyordu. Kullanıcı butona basıp hiçbir şey almıyor, üstüne o günkü
    // hakkını kaybediyordu. Kural: miktar 0 ise talep REDDEDİLİR.
    const miktar = gunluk(21, TABAN_7);
    assert.equal(miktar, 0);
    assert.ok(miktar <= 0, "bu durumda uç BALANCE_ABOVE_FLOOR dönmeli, gün yazmamalı");
  });

  test("premium yüksek TABAN alır, koşulsuz para değil", () => {
    assert.equal(gunluk(8, 12), 4, "premium tabanı 12");
    assert.equal(gunluk(12, 12), 0, "tabanı aşan premium da 0 alır");
  });
});

describe("ekonomi raporu", () => {
  test("dağılım ve yoğunlaşma", () => {
    const d = _dagilim([1, 1, 2, 2, 2, 5, 10, 50, 100, 900]);
    assert.equal(d.cuzdan, 10);
    assert.equal(d.toplamArz, 1073);
    assert.equal(d.medyan, 5);
    assert.equal(d.max, 900);
    // Tek oyuncu arzın çoğunu tutuyorsa erken uyarı işareti.
    assert.ok(d.enZenginYuzde10Payi >= 80, "yoğunlaşma yakalanmalı");
  });

  test("akış: giriş/çıkış ayrımı ve oran", () => {
    const a = _akis(
      [
        { amount: 100, reason: "match_reward", createdAt: "2026-07-29T10:00:00Z" },
        { amount: 50, reason: "daily", createdAt: "2026-07-29T10:00:00Z" },
        { amount: -10, reason: "match_pred", createdAt: "2026-07-29T10:00:00Z" },
      ],
      null
    );
    assert.equal(a.toplamGiris, 150);
    assert.equal(a.toplamCikis, 10);
    assert.equal(a.girisCikisOrani, 15);
    assert.equal(a.durum, "ENFLASYONIST");
  });

  test("gider hiç yoksa oran null — sıfıra bölme yok", () => {
    const a = _akis([{ amount: 10, reason: "daily", createdAt: "2026-07-29T10:00:00Z" }], null);
    assert.equal(a.girisCikisOrani, null);
    assert.equal(a.durum, "ENFLASYONIST");
  });

  test("pencere dışındaki kayıtlar sayılmaz", () => {
    const a = _akis(
      [
        { amount: 100, reason: "eski", createdAt: "2020-01-01T00:00:00Z" },
        { amount: 5, reason: "yeni", createdAt: "2026-07-29T10:00:00Z" },
      ],
      "2026-07-01T00:00:00Z"
    );
    assert.equal(a.toplamGiris, 5, "eski kayıt pencereye girmemeli");
    assert.equal(a.islem, 1);
  });

  test("dengeli ekonomi doğru etiketlenir", () => {
    const a = _akis(
      [
        { amount: 50, reason: "odul", createdAt: "2026-07-29T10:00:00Z" },
        { amount: -50, reason: "giris", createdAt: "2026-07-29T10:00:00Z" },
      ],
      null
    );
    assert.equal(a.durum, "dengeli");
    assert.equal(a.girisCikisOrani, 1);
  });

  test("boş veri patlamaz", () => {
    const d = _dagilim([]);
    assert.equal(d.cuzdan, 0);
    assert.equal(d.toplamArz, 0);
    const a = _akis([], null);
    assert.equal(a.toplamGiris, 0);
    assert.equal(a.girisCikisOrani, null);
  });
});

describe("mini turnuva ödülü — beraberlikte bölüşülür", () => {
  /**
   * Eskiden beraberlikte HERKESE tam MINI_WIN_LC veriliyordu: aynı tahmini
   * yapan 5 hesap turnuva başına 5×20 = 100 LC üretiyordu. Giriş ücretsiz
   * olduğu için bunun karşılığı yoktu — karşılıksız LC musluğu.
   *
   * Değişmez: turnuva başına DAĞITILAN TOPLAM, MINI_WIN_LC'yi aşamaz.
   */
  const mini = require("../routes/mini.cjs");
  const pay = mini._kazananPayi;
  const TOPLAM = mini._MINI_WIN_LC;

  test("hiçbir kazanan sayısında toplam ödül aşılmaz", () => {
    for (let n = 1; n <= 50; n++) {          // MAX_MEMBERS = 50
      const kisiBasi = pay(n);
      const dagitilan = Math.round(kisiBasi * n * 10) / 10;
      assert.ok(
        dagitilan <= TOPLAM + 1e-9,
        `${n} kazananda ${dagitilan} LC dagitiliyor, tavan ${TOPLAM}`
      );
    }
  });

  test("tek kazanan tam ödülü alır", () => {
    assert.equal(pay(1), TOPLAM);
  });

  test("iki kazanan yarı yarıya böler", () => {
    assert.equal(Math.round(pay(2) * 2 * 10) / 10, TOPLAM);
  });

  test("bölünmeyen sayıda AŞAĞI yuvarlanır (yukarı yuvarlamak LC yaratırdı)", () => {
    // 20/3 = 6.666 → 6 (7 olsaydı 3×7 = 21, yani 1 LC yoktan)
    const p = pay(3);
    assert.ok(p * 3 <= TOPLAM, "asagi yuvarlanmamis");
    assert.equal(p, Math.floor(TOPLAM / 3));
  });

  test("pay TAM SAYI — kesirli ödül cüzdanda artık biriktiriyordu", () => {
    /**
     * ⚠️ 2026-08-05'te 0.1 adımdan tam sayıya çevrildi. Kesirli pay
     * `lib/wallet-credit.cjs`in toplamasında kayan nokta artığı biriktiriyordu
     * — ÖLÇÜLDÜ: 6.6 × 50 kredi → 330.0000000000001. Cüzdan artık her yazımda
     * yuvarlıyor, ama kirli tutarı hiç ÜRETMEMEK daha iyi: defter, ekonomi
     * raporu ve ekranlar da temiz kalıyor.
     *
     * Ölçüm: n=1..50 aralığında eskiden 43 senaryo kesirli pay üretiyordu.
     */
    const kesirli = [];
    for (let n = 1; n <= 50; n++) {
      if (!Number.isInteger(pay(n))) kesirli.push(`${n} → ${pay(n)}`);
    }
    assert.deepEqual(kesirli, [],
      "kesirli pay uretiliyor — cuzdanda ve defterde artik birikir: " + kesirli.join(", "));
  });

  test("EŞİT pay veriliyor (en büyük kalan yöntemi burada KULLANILMAZ)", () => {
    /**
     * ⚠️ TERS RİSK. Toplamı kuruşuna eşitlemek için en büyük kalan yöntemi
     * (lib/pay-dagitim.cjs) uygulansaydı bir kazanan 7, diğeri 6 LC alırdı.
     * Orada korunacak bir HAVUZ var; burada ödül ÜRETİLİYOR — aynı tahmini
     * yapan iki kişiye farklı para vermeyi haklı çıkaracak bir kısıt yok.
     * Ölçüldü: en kötü durumda dağıtılmayan 6 LC (n=7 → 14/20).
     */
    const src = fs.readFileSync(
      nodePath.join(__dirname, "..", "routes", "mini.cjs"), "utf8"
    );
    assert.ok(!/odemeDagit\s*\(/.test(src),
      "mini havuz kuralina gecmis — kazananlar esitsiz odul alir");
  });

  test("pay 0'a düşen kalabalık beraberlikte KİMSEYE yazılmıyor", () => {
    /**
     * ⚠️ TAM SAYIYA GEÇMENİN AÇIK BEDELİ, gizlenmiyor: kazanan sayısı
     * MINI_WIN_LC'yi (20) aşarsa pay 0 olur ve ödül hiç dağıtılmaz —
     * n=21..50 arası 30 senaryo, eskiden 0.4..0.9 LC alıyorlardı.
     *
     * Herkese en az 1 LC vermek bunu çözerdi ama yukarıdaki "toplam TOPLAM'ı
     * aşamaz" değişmezini bozardı (30 kazanan × 1 = 30 > 20). O değişmez
     * karşılıksız LC musluğunu kapatmak için konmuştu.
     */
    assert.equal(pay(TOPLAM), 1, "tavandaki kazanan sayisinda 1 LC verilmeli");
    assert.equal(pay(TOPLAM + 1), 0, "tavani asinca pay 0 olmali");
  });

  test("geçersiz kazanan sayısı 0 döner (para yazılmaz)", () => {
    assert.equal(pay(0), 0);
    assert.equal(pay(-3), 0);
    assert.equal(pay(NaN), 0);
  });
});

describe("ekonomi raporu — bir kerelik girişler oranı bozmamalı", () => {
  /**
   * Rapor tüm girişleri tek torbaya koyuyordu. Açılış bakiyesi (hesap başına
   * bir kez, 30 LC) tekrarlayan bir musluk değil ama girişe yazılınca oranı
   * şişiriyordu.
   *
   * Bu tam YAYINDA yanıltır: 1000 kayıt = 30.000 LC bir kerelik giriş; ekonomi
   * kusursuz dengede olsa bile rapor haftalarca "ENFLASYONIST" gösterir ve
   * yanlış muslukları kısmaya iter.
   *
   * Ölçülmüştü (üretim, 30 gün): 69 LC girişin 60'ı `initial_default`.
   * Oran 3.3:1 "enflasyonist" görünüyordu; ayrıştırınca 0.3:1 deflasyonist.
   */
  const { _akis: akis } = require("../lib/economy-report.cjs");

  const defter = [
    { reason: "initial_default", amount: 30, createdAt: "2026-07-30T10:00:00Z" },
    { reason: "initial_default", amount: 30, createdAt: "2026-07-30T10:01:00Z" },
    { reason: "match_reward",    amount: 6,  createdAt: "2026-07-30T10:02:00Z" },
    { reason: "match_pred",      amount: -18, createdAt: "2026-07-30T10:03:00Z" },
    { reason: "duel_create",     amount: -3, createdAt: "2026-07-30T10:04:00Z" },
    { reason: "entry_refund",    amount: 3,  createdAt: "2026-07-30T10:05:00Z" },
  ];

  test("açılış bakiyesi orandan hariç tutulur", () => {
    const a = akis(defter, null);
    assert.equal(a.toplamBirKerelik, 60);
    assert.equal(a.toplamGiris, 6, "bir kerelikler tekrarlayan girise sizmis");
    assert.equal(a.girisCikisOrani, 0.3);
    assert.equal(a.durum, "deflasyonist");
  });

  test("iade ne girişe ne çıkışa yazılır", () => {
    const a = akis(defter, null);
    assert.equal(a.toplamIade, 3);
    assert.ok(!("entry_refund" in a.giris), "iade girise yazilmis");
    assert.ok(!("entry_refund" in a.cikis), "iade cikisa yazilmis");
  });

  test("net arz değişimi bir kerelikleri DAHİL eder (büyüme görünür kalsın)", () => {
    const a = akis(defter, null);
    // 6 tekrarlayan + 60 bir kerelik - 21 cikis = 45
    assert.equal(a.netArzDegisimi, 45);
  });

  test("yalnızca açılış bakiyesi varken sahte enflasyon uyarısı üretilmez", () => {
    const a = akis(defter.filter((k) => k.reason === "initial_default"), null);
    assert.equal(a.toplamGiris, 0, "tekrarlayan giris olmamali");
    assert.equal(a.girisCikisOrani, null, "cikis yokken oran hesaplanmamali");
  });
});

describe("mağaza modu — varsayılan KAPALI olmalı", () => {
  /**
   * `SKORLIG_STORE_MODE` varsayılanı `mock`tu: değişkeni ayarlamayı unutmak
   * üretimde "herkese bedava LC" demekti. Kimliği olan her kullanıcı
   * /lc-wallet/purchase çağırıp lc_200 paketini (200 LC / 99,99 TL) ödemesiz
   * alabilirdi; hız sınırı 5/dk olduğu için dakikada 1000 LC.
   *
   * Aynı gün iki yerde daha çıkan desen (yönetici token'ı, 1987 grup kodu):
   * yapılandırma eksikse KAPALI kal, zayıf varsayılana düşme.
   */
  function modOku(deger) {
    const onceki = process.env.SKORLIG_STORE_MODE;
    if (deger === null) delete process.env.SKORLIG_STORE_MODE;
    else process.env.SKORLIG_STORE_MODE = deger;
    delete require.cache[require.resolve("../routes/lc-wallet.cjs")];
    const m = require("../routes/lc-wallet.cjs")._STORE_MODE;
    if (onceki === undefined) delete process.env.SKORLIG_STORE_MODE;
    else process.env.SKORLIG_STORE_MODE = onceki;
    delete require.cache[require.resolve("../routes/lc-wallet.cjs")];
    return m;
  }

  test("değişken tanımsızken mod 'disabled' olur (asla 'mock' değil)", () => {
    assert.equal(modOku(null), "disabled");
  });

  test("mock yalnızca AÇIKÇA istendiğinde açılır", () => {
    assert.equal(modOku("mock"), "mock");
    assert.equal(modOku("disabled"), "disabled");
  });

  test("tanınmayan değer mock'a düşmez", () => {
    // Bilinmeyen mod purchase'ta 501 döner; sessizce ödemesiz yüklemez.
    assert.notEqual(modOku("gogglepay"), "mock");
  });
});

describe("gün sınırı — UTC değil Europe/Istanbul", () => {
  /**
   * Günlük hak ve seri hesabı `toISOString().slice(0,10)` kullanıyordu, yani
   * UTC. Sunucu UTC çalışıyor (Render) ama kullanıcılar UTC+3'te: "gün" yerel
   * saatle 00:00'da değil 03:00'te dönüyordu.
   *
   *   1) 00:00–03:00 arasında kullanıcı yeni güne girmiş olmasına rağmen
   *      "bugün hakkını zaten aldın" cevabı alıyordu.
   *   2) Seri HAKSIZ YERE kırılıyordu: Salı 01:00 ve Çarşamba 23:00'te alan
   *      biri yerel olarak ardışık iki gün almış olur ama UTC anahtarları
   *      07-27 ve 07-29 çıkar. Seri kademeleri (3/5/7 LC) buna dayanıyor.
   */
  const Season = require("../lib/season.cjs");

  test("yerel gün 00:00'da döner (23:00 ile ertesi 01:00 farklı gün)", () => {
    const sali23 = Season.dayKey(new Date("2026-07-28T20:00:00Z"));   // Salı 23:00 IST
    const carsamba01 = Season.dayKey(new Date("2026-07-28T22:00:00Z")); // Çarşamba 01:00 IST
    assert.notEqual(sali23, carsamba01, "yerel gun donmemis sayiliyor");
    assert.equal(sali23, "2026-07-28");
    assert.equal(carsamba01, "2026-07-29");
  });

  test("UTC dilimlemesi bu ayrımı KAÇIRIR (gerileme koruması)", () => {
    const utcSali23 = new Date("2026-07-28T20:00:00Z").toISOString().slice(0, 10);
    const utcCarsamba01 = new Date("2026-07-28T22:00:00Z").toISOString().slice(0, 10);
    // Eski davranışın neden yanlış olduğunu belgeler: ikisi de aynı UTC günü.
    assert.equal(utcSali23, utcCarsamba01);
  });

  test("yerel olarak ardışık günlerde seri sürer", () => {
    const oncekiAlis = Season.dayKey(new Date("2026-07-27T22:00:00Z")); // Salı 01:00 IST
    const bugun = Season.dayKey(new Date("2026-07-29T20:00:00Z"));      // Çarşamba 23:00 IST
    assert.equal(oncekiAlis, "2026-07-28");
    assert.equal(bugun, "2026-07-29");
    assert.equal(Season.previousDayKey(new Date(bugun + "T12:00:00Z")), oncekiAlis);
  });

  test("gerçekten atlanan gün seriyi kırar", () => {
    const bugun = "2026-07-30";
    assert.notEqual(Season.previousDayKey(new Date(bugun + "T12:00:00Z")), "2026-07-28");
    assert.equal(Season.previousDayKey(new Date(bugun + "T12:00:00Z")), "2026-07-29");
  });

  test("ay ve yıl sınırında doğru komşu gün", () => {
    assert.equal(Season.previousDayKey(new Date("2026-08-01T12:00:00Z")), "2026-07-31");
    assert.equal(Season.previousDayKey(new Date("2026-01-01T12:00:00Z")), "2025-12-31");
  });
});
