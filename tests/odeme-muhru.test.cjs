"use strict";

/**
 * ÖDEMEDEN ÖNCE MÜHÜR — bu oyunun en kritik para değişmezi.
 *
 * Kural: bir kazancı dağıtan kod, dağıtımdan ÖNCE atomik bir mühür almalı.
 * Mühür "koşul yazmanın İÇİNDE" biçiminde olmalı (`updateOne({id, durum:açık},
 * {$set:...})` sonra `modifiedCount` kontrolü). Yalnızca tek çağrı mührü alır;
 * geri kalanı hiçbir şey ödemez.
 *
 * ⚠️ NEDEN TEST GEREKİYOR: bu kural kod tabanında ALTI ayrı yerde uygulandı
 * (maç ödülü, düello, turnuva, mini turnuva, kupon, tr-lig haftası) ve her
 * biri ayrı ayrı yazıldı. Bu oturumun tekrar eden dersi şu: aynı savunmanın
 * altı kopyası varsa, yedincisinde unutulur. Unutulduğunda belirti "hata"
 * olmaz — settle iki kez çalışır ve ÖDÜL İKİ KEZ DAĞITILIR. Kimse fark etmez.
 *
 * ⚠️ SINIFLANDIRMA ZORUNLU. Yeni bir `creditLc` sebebi eklenirse test kırılır
 * ve yazarı "bu bir ödül mü, iade mi" sorusuna cevap vermeye zorlar. Sessizce
 * geçmesine izin vermek, nöbetçiyi zamanla işe yaramaz hâle getirirdi.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const KOK = path.join(__dirname, "..");
const DIZINLER = ["routes", "lib", "services"];

/**
 * ÖDÜL: tekrar çalışabilen bir sonuçlandırmadan doğar → MÜHÜR ŞART.
 * Mühür yoksa aynı maç/turnuva iki kez sonuçlanınca ödül iki kez dağıtılır.
 */
const ODUL = new Set([
  "duel_win",
  "pool_win",
  "mini_tournament_win",
  "tournament_payout",
  "kupon_odul",
  "tr_league_weekly",
  // Davet odulu: "zaten arkadas" kontrolu atomik degildi, iki eszamanli
  // istek 30 yerine 60 LC bastirabilirdi. Muhur: lib/davet-odul-store.cjs
  "invite_referral",
  "invite_welcome",
]);

/**
 * İADE: başarısız ya da geçersiz kılınan TEK bir işlemin geri alınması.
 * Mühür ihtiyacı işlemin kendisindedir (ör. bahis yazımı başarısız oldu,
 * düello iptal edildi) — burada ayrıca mühür aranmaz.
 */
const IADE = new Set([
  "duel_accept_refund",
  "duel_cancel_refund",
  "duel_tie_refund",
  "duel_void_refund",
  /* Maç bitti ama düelloyu kimse kabul etmedi → kurucunun bahsi geri.
   * MÜHÜR GEREKMEZ değil, GEREKİYOR ve var: iade `settleDuelsForFixture`
   * içinde atomik durum yazımından (open→voided) SONRA yapılıyor. İADE
   * sayılmasının sebebi ekonomiye giriş yazılmaması. */
  "duel_unmatched_refund",
  "kupon_giris_iade",
  "kupon_iade",
  "pool_bet_refund",
  "pool_refund_no_winner",
  "pool_void_refund",
  "tournament_entry_refund",
  // Mac hic sonuclanmazsa tahmin giris bedeli iade edilir; muhur
  // tahmin belgesindeki `iadeEdildi` alani (bkz. bayat-temizleyici).
  "pred_void_refund",
]);

/**
 * Kabul edilen atomik mühür izleri.
 *
 * ⚠️ İLK SÜRÜM `muhur` ve `bizimki` gibi ÇIPLAK DEĞİŞKEN ADLARINI da kabul
 * ediyordu. Negatif kontrol bunu yakaladı: havuzun `modifiedCount` kontrolünü
 * sildim, `const muhur = ...` satırı kaldığı için test yine GEÇTİ. Yani
 * nöbetçi "biri mühür adında bir değişken yazmış" ile "atomik mühür var"
 * arasındaki farkı görmüyordu.
 *
 * Artık yalnızca GERÇEK kanıt sayılıyor: bir claim ÇAĞRISI ya da koşullu
 * yazmanın sonucunu denetleyen `modifiedCount`.
 */
/**
 * ⚠️ `matchedCount` DE GEÇERLİ. Günlük LC talebi kilidi "karşılaştır-ve-değiştir"
 * biçiminde kuruyor: süzgeçte `lastDailyAt: <okunan değer>` var ve sonuç
 * `matchedCount` ile denetleniyor. İlk sürüm yalnızca `modifiedCount` kabul
 * ediyordu ve bu meşru mührü YANLIŞ ALARM olarak işaretledi.
 */
const MUHUR = /(claimAward|claimDuelSettle|claimTournamentSettle|claimWeek|kuponMuhurle|finishMini|odulMuhurle)\s*\(|modifiedCount|matchedCount/;

/** Bir kaynağı üst düzey bloklara böler (fonksiyon ya da router bildirimi). */
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

/** Kaynak dosyalarda geçen tüm creditLc çağrılarını sebebiyle birlikte bulur. */
function odemeler() {
  const out = [];
  for (const d of DIZINLER) {
    const dizin = path.join(KOK, d);
    if (!fs.existsSync(dizin)) continue;
    for (const dosya of fs.readdirSync(dizin)) {
      if (!dosya.endsWith(".cjs")) continue;
      const kaynak = fs.readFileSync(path.join(dizin, dosya), "utf8");
      for (const blok of bloklaraBol(kaynak)) {
        /* ⚠️ SARMALAYICI BU NÖBETÇİYİ KÖRLEŞTİRMİŞTİ. `duels.cjs` ödemeleri
         * `ode(db, uid, tutar, sebep, ...)` yardımcısına taşınınca `creditLc`
         * kalıbı DÖRT sebebi birden görmez oldu. Ödeme sayısı sağlık denetimi
         * (`>= 10`) bunu yakalayamadı — başka dosyalar sayıyı dolduruyordu;
         * yakalayan "listeler bayat değil" testi oldu: kodda kalmayan sebepler
         * listede öksüz kaldı. Sarmalayıcı da taranıyor.
         *
         * `\bode` sınırı `decode(`/`explode(` gibi adları dışarıda tutar:
         * 'c' ile 'o' arasında kelime sınırı yoktur. */
        const re = /(?:creditLc|\bode)\([^,]+,[^,]+,[^,]+,\s*"([a-z_0-9]+)"/g;
        let m;
        while ((m = re.exec(blok.metin))) {
          out.push({ dosya: `${d}/${dosya}`, sebep: m[1], blok: blok.metin, satir: blok.bas + 1 });
        }
      }
    }
  }
  return out;
}

test("her LC ödemesi ÖDÜL ya da İADE olarak sınıflandırılmış", () => {
  const hepsi = odemeler();
  assert.ok(hepsi.length >= 10, `cok az odeme bulundu (${hepsi.length}) — tarama kalibi bozulmus olabilir`);

  const bilinmeyen = [...new Set(
    hepsi.filter((o) => !ODUL.has(o.sebep) && !IADE.has(o.sebep)).map((o) => `${o.sebep} (${o.dosya})`)
  )];
  assert.deepStrictEqual(
    bilinmeyen,
    [],
    "Siniflandirilmamis LC odeme sebebi. ODUL ise muhur sart, IADE ise degil —\n" +
      "karari verip bu dosyadaki listeye ekle:\n" + bilinmeyen.join("\n")
  );
});

/** Bir bloğun başındaki fonksiyon adı (varsa). */
function blokAdi(metin) {
  const m = /^(?:async\s+)?function\s+([A-Za-z0-9_$]+)/.exec(metin);
  return m ? m[1] : null;
}

/**
 * Ödemenin bulunduğu blokta mühür yoksa, o blok bir YARDIMCI olabilir ve mühür
 * ÇAĞIRANDA duruyor olabilir — tr-lig'de tam olarak böyle: `claimWeek` alınıyor,
 * sonra `awardWeeklyLc(...)` çağrılıyor.
 *
 * ⚠️ İLK SÜRÜM BUNU KAÇIRMIŞTI ve tr-lig'i "mühürsüz" diye işaretledi. Yanlış
 * pozitif üreten bir nöbetçi, zamanla kapatılan bir nöbetçidir; o yüzden kural
 * gerçeği modellemeli: mühür ya ödemenin bloğunda ya da o bloğu çağıran her
 * yerde olmalı.
 */
/**
 * Mührü ÇAĞIRANINDA olmasına izin verilen yardımcılar — açık ve dar liste.
 *
 * ⚠️ İLK SÜRÜM HER yardımcıya bu izni veriyordu ve negatif kontrol bunun
 * fazla cömert olduğunu gösterdi: `settlePool`un mührünü sildim, test yine
 * geçti — çünkü çağıranı (settle2) `claimAward` alıyor. Ama o mühür MAÇ ÖDÜLÜ
 * içindir, havuz ödemesi için değil. Başka bir kaynağın mührü bu ödemeyi
 * korumaz.
 *
 * Bu yüzden kural varsayılan olarak KATI: ödeme kendi bloğunda mühürlenmeli.
 * İstisna tek tek gerekçelenir.
 */
const CAGIRAN_MUHURU_SERBEST = new Set([
  // tr-lig: `claimWeek(weekKey)` haftayı mühürler ve HEMEN ardından bu
  // yardımcı çağrılır; mühür tam da bu ödemenin kaynağı içindir.
  "awardWeeklyLc",
  // mini turnuva: `finishMini(t.id)` turnuvayı mühürler, dönüş değeri
  // kontrol edilir, sonra bu yardımcı çağrılır. Aynı kaynak, aynı biçim.
  "awardMiniWinLc",
  // düello: `claimDuelSettle` mührü alınır, sonra bu yardımcı ödemeyi yazar.
  "creditLcMongo",
  // seri bonusu: `claimAward` mührü settle2'de alınır, bu yardımcı sonra çağrılır.
  "awardStreakBonuses",
  "_awardStreakBonusesUnlocked",
]);

/**
 * ⚠️ LİSTEYE EKLEME ÖLÇÜTÜ: mühür, ödemenin KENDİ kaynağı için alınmış
 * olmalı. `settlePool` bu listeye giremez — çağıranı (settle2) `claimAward`
 * alıyor ama o mühür MAÇ ÖDÜLÜ içindir, havuz ödemesi için değil. Başka bir
 * kaynağın mührü bu ödemeyi çift dağıtımdan korumaz.
 */

/**
 * ⚠️ DENETİM GEÇİŞLİ OLMALI. İlk sürüm yalnızca BİR seviye yukarı bakıyordu ve
 * iki katmanlı zincirleri kaçırdı:
 *
 *     _awardStreakBonusesUnlocked ← awardStreakBonuses ← settle2 (claimAward)
 *     creditLcMongo               ← creditLc (duels)   ← settleDuelsForFixture
 *
 * Ortadaki sarmalayıcıda mühür yok — mühür bir üstte. Tek seviyeli denetim
 * ikisini de "mühürsüz" işaretledi; oysa ikisi de korumalı.
 */
function cagiranlardaMuhurVar(ad, tumBloklar, derinlik = 0, gorulen = new Set()) {
  if (!ad || derinlik > 3 || gorulen.has(ad)) return false;
  if (derinlik === 0 && !CAGIRAN_MUHURU_SERBEST.has(ad)) return false;
  gorulen.add(ad);

  const cagri = new RegExp("\\b" + ad + "\\s*\\(");
  const cagiranlar = tumBloklar.filter((b) => blokAdi(b.metin) !== ad && cagri.test(b.metin));
  if (!cagiranlar.length) return false;

  // "Hepsi" şartı bilinçli: tek bir mühürsüz çağıran korumayı geçersiz kılar.
  return cagiranlar.every(
    (b) =>
      MUHUR.test(b.metin) ||
      cagiranlardaMuhurVar(blokAdi(b.metin), tumBloklar, derinlik + 1, gorulen)
  );
}

test("ÖDÜL dağıtan her yerde ödemeden ÖNCE atomik mühür var", () => {
  const tumBloklar = [];
  for (const d of DIZINLER) {
    const dizin = path.join(KOK, d);
    if (!fs.existsSync(dizin)) continue;
    for (const dosya of fs.readdirSync(dizin)) {
      if (dosya.endsWith(".cjs")) {
        tumBloklar.push(...bloklaraBol(fs.readFileSync(path.join(dizin, dosya), "utf8")));
      }
    }
  }

  const kusurlu = [];
  for (const o of odemeler()) {
    if (!ODUL.has(o.sebep)) continue;
    if (MUHUR.test(o.blok)) continue;
    if (cagiranlardaMuhurVar(blokAdi(o.blok), tumBloklar)) continue;
    kusurlu.push(`${o.dosya}:${o.satir} — "${o.sebep}" muhursuz odeniyor`);
  }
  assert.deepStrictEqual(
    kusurlu,
    [],
    "Muhursuz odul dagitimi: settle iki kez calisirsa odul IKI KEZ dagitilir:\n" +
      kusurlu.join("\n")
  );
});

test("sınıflandırma listeleri bayat değil", () => {
  // Listede olup kodda hiç kullanılmayan sebep, listeyi güvenilmez yapar.
  const kullanilan = new Set(odemeler().map((o) => o.sebep));
  const artikYok = [...ODUL, ...IADE].filter((s) => !kullanilan.has(s));
  assert.deepStrictEqual(
    artikYok,
    [],
    "Bu sebepler kodda yok, listeden cikarilmali:\n" + artikYok.join("\n")
  );
});

/* ── Doğrudan bakiye yazmaları ──────────────────────────────────────────── */

/**
 * ⚠️ NÖBETÇİNİN KENDİ KÖR NOKTASI. Yukarıdaki testler yalnızca `creditLc`
 * çağrılarını tarıyor. Ama kod tabanında LC'yi `creditLc`'den GEÇMEDEN,
 * doğrudan `$inc: { balance: +N }` ile veren YEDİ yer var:
 *
 *   settle2  — maç ödülü, seri (streak) bonusu, turnuva ödemesi
 *   duels    — düello ödemesi (kendi creditLcMongo yardımcısı üzerinden)
 *   lc-wallet — mağaza satın alımı, premium aylık kasa
 *
 * Hepsi denetlendi ve MÜHÜRLÜ. Ama nöbetçi onları görmüyordu: yeni bir
 * doğrudan yazma mühürsüz eklenirse sessiz kalırdı. En kritik para
 * değişmezini koruyan testin, korumanın atlanabildiği bir yolu görmemesi
 * tam da bu oturumda tekrar tekrar bulduğum hata biçimi.
 */
/**
 * Mağaza satın alımı: mühür YOK ama uç ÜRETİMDE KAPALI.
 * `STORE_MODE === "disabled"` erken dönüyor; gerçek sağlayıcılar 501 alıyor,
 * yalnızca `mock` modu LC yüklüyor. Makbuz doğrulaması zaten bilinen bir
 * lansman maddesi. Muafiyet GEREKÇEYE BAĞLI: aşağıdaki test kapının hâlâ
 * yerinde olduğunu doğruluyor — mağaza açılırsa muafiyet düşer.
 */
const MAGAZA_MUAF = "routes/lc-wallet.cjs";

/** Bakiyeyi yazan ALT SEVİYE yardımcılar — çağrı yerleri ayrıca denetleniyor. */
const ILKELLER = new Set(["creditLcMongo", "deductLcMongo"]);

test("mağaza ucu hâlâ kapalı — muafiyetin dayanağı", () => {
  const src = fs.readFileSync(path.join(KOK, "routes", "lc-wallet.cjs"), "utf8");
  const i = src.indexOf('router.post("/lc-wallet/purchase"');
  assert.ok(i > 0, "purchase ucu bulunamadi");
  const govde = src.slice(i, i + 3000);
  assert.ok(
    /STORE_MODE\s*===\s*"disabled"/.test(govde),
    "magaza ucu artik kapali degil — idempotans (makbuz) muhru gerekiyor"
  );
});

test("doğrudan bakiye ARTIRAN her yazma mühürlü", () => {
  const kusurlu = [];
  let bakilan = 0;

  // Yardımcı fonksiyonların çağıranını bulabilmek için TÜM blokları topla.
  // (İlk sürümde boş dizi geçiliyordu; çağıran hiç aranamıyordu.)
  const tumBloklar = [];
  for (const d of DIZINLER) {
    const dz = path.join(KOK, d);
    if (!fs.existsSync(dz)) continue;
    for (const f of fs.readdirSync(dz)) {
      if (f.endsWith(".cjs")) {
        tumBloklar.push(...bloklaraBol(fs.readFileSync(path.join(dz, f), "utf8")));
      }
    }
  }

  for (const d of DIZINLER) {
    const dizin = path.join(KOK, d);
    if (!fs.existsSync(dizin)) continue;
    for (const dosya of fs.readdirSync(dizin)) {
      if (!dosya.endsWith(".cjs")) continue;
      // Para ilkelinin kendisi: bakiyeyi o yazacak.
      if (dosya === "wallet-credit.cjs") continue;

      const kaynak = fs.readFileSync(path.join(dizin, dosya), "utf8");
      for (const blok of bloklaraBol(kaynak)) {
        // `$inc: { balance: X` — X eksiyle başlıyorsa HARCAMA, atla.
        const re = /\$inc:\s*\{\s*balance:\s*(-?)\s*([A-Za-z0-9_.]+)/g;
        let m;
        while ((m = re.exec(blok.metin))) {
          if (m[1] === "-") continue;               // harcama
          bakilan++;
          if (MUHUR.test(blok.metin)) continue;
          if (cagiranlardaMuhurVar(blokAdi(blok.metin), tumBloklar)) continue;
          // ⚠️ İLKELİN TANIMI DEĞİL, ÇAĞRI YERİ DENETLENİR. `creditLcMongo`
          // düellonun para ilkeli: hem mühürlü sonuçlandırma hem de mühür
          // gerektirmeyen İADE yolları onu kullanıyor. Tanımına mühür şartı
          // koymak, iade yollarını da mühürlü olmaya zorlardı. Çağrı yerleri
          // zaten yukarıdaki `creditLc(` taramasıyla kapsanıyor —
          // `wallet-credit.cjs` de aynı gerekçeyle dışarıda.
          if (ILKELLER.has(blokAdi(blok.metin))) continue;
          if (`${d}/${dosya}` === MAGAZA_MUAF && m[2] === "totalLc") continue;
          kusurlu.push(`${d}/${dosya}:${blok.bas + 1} — "${m[2]}" muhursuz bakiye artiriyor`);
        }
      }
    }
  }

  assert.ok(bakilan >= 5, `cok az dogrudan yazma bulundu (${bakilan}) — tarama kalibi bozulmus olabilir`);
  assert.deepStrictEqual(
    kusurlu,
    [],
    "creditLc'den GECMEDEN bakiye artiran ve muhursuz olan yazmalar:\n" + kusurlu.join("\n")
  );
});
