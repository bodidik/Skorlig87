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
const MUHUR = /(claimAward|claimDuelSettle|claimTournamentSettle|claimWeek|kuponMuhurle|finishMini|odulMuhurle)\s*\(|modifiedCount/;

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
        const re = /creditLc\([^,]+,[^,]+,[^,]+,\s*"([a-z_0-9]+)"/g;
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
]);

/**
 * ⚠️ LİSTEYE EKLEME ÖLÇÜTÜ: mühür, ödemenin KENDİ kaynağı için alınmış
 * olmalı. `settlePool` bu listeye giremez — çağıranı (settle2) `claimAward`
 * alıyor ama o mühür MAÇ ÖDÜLÜ içindir, havuz ödemesi için değil. Başka bir
 * kaynağın mührü bu ödemeyi çift dağıtımdan korumaz.
 */

function cagiranlardaMuhurVar(ad, tumBloklar) {
  if (!ad || !CAGIRAN_MUHURU_SERBEST.has(ad)) return false;
  const cagri = new RegExp("\\b" + ad + "\\s*\\(");
  const cagiranlar = tumBloklar.filter((b) => blokAdi(b.metin) !== ad && cagri.test(b.metin));
  return cagiranlar.length > 0 && cagiranlar.every((b) => MUHUR.test(b.metin));
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
