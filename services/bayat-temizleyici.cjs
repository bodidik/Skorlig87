"use strict";

/**
 * BAYAT MAÇ TEMİZLEYİCİ — sonucu gelmeyen maçlarda kilitli parayı iade eder.
 *
 * ⚠️ NEDEN VAR: bu oyunda para bir maçın sonucuna bağlı ve sonuç gelmezse
 * KENDİLİĞİNDEN ÇÖZÜLMÜYORDU. Kabul edilmiş düello iptal edilemiyor
 * (`claimDuelCancel` yalnizca `status: "open"` kabul ediyor; kabul edilen duello "active" olur), havuz yalnızca
 * settle2 sonuç getirince dağıtılıyor. Yani ertelenen/iptal olan bir maçta
 * oyuncuların LC'si KALICI olarak kilitliydi.
 *
 * Erteleme nadir değil (hava, kupa takvimi) ve skor kaynakları fiilen tek
 * şelaleye düşmüş durumda — maç oynansa bile sonucu hiç gelmeyebiliyor.
 *
 * ⚠️ MÜHÜR ÖNCE, ÖDEME SONRA. Aynı sıra düello/havuz/kupon sonuçlandırmasında
 * da var: mühür alınamazsa başka bir çağrı zaten ilgileniyor demektir. Önce
 * ödeyip sonra mühürlemek çift iade üretirdi.
 *
 * ⚠️ TEK YÖNLÜ: yalnızca İADE eder, asla ödül dağıtmaz. Sonuç sonradan
 * gelirse settle2 mühürlü kaydı atlar — çünkü durum artık "voided"/"settledAt
 * dolu". Yani geç gelen sonuç ikinci bir ödeme yapamaz.
 */

const { bayatMi } = require("../lib/bayat-mac.cjs");
const { ensurePredIndexes } = require("../lib/preds-index.cjs");
const { creditLc, kayipOdulKaydet } = require("../lib/wallet-credit.cjs");
const { kritikIs } = require("../lib/kritik-is.cjs");
const { DURUM, PARA_TUTAN } = require("../lib/duel-durum.cjs");

const { MAC_GIRIS_BEDELI } = require("../lib/ekonomi.cjs");
const COLL_DUELS = "duels";
const COLL_POOLS = "pools";
const COLL_BETS = "pool_bets";
const COLL_FIXTURES = "fixtures";

let _timer = null;
let _sonTur = null;

async function getDbSafe() {
  try {
    const { getDb } = require("../lib/mongo.cjs");
    return await getDb();
  } catch {
    return null;
  }
}

/**
 * Tahmin, başlamasına en fazla bu kadar kalan maça girilebiliyor.
 *
 * ⚠️ İKİNCİ KOPYA, VE BİLEREK: kaynak `routes/live2.cjs` içindeki
 * `PREDICT_OPEN_AHEAD_HOURS` (96). Bir servisin route dosyasını require
 * etmesi döngüsel bağımlılık riski taşıyor, o yüzden değer burada duruyor —
 * ama `tests/bayat-fikstursuz-mac.test.cjs` iki sayının EŞİT kaldığını
 * doğruluyor. Bu depoda kopyaların sessizce ayrışması en sık kusur şekli;
 * kopya kaçınılmazsa en azından ölçülür.
 */
const TAHMIN_PENCERE_SAAT = Number(process.env.SKORLIG_PRED_AHEAD_SAAT || 96);

/**
 * fixtureId → kickoffISO. Bulunamazsa null.
 *
 * ⚠️ FİKSTÜR SİLİNİNCE PARA KİLİTLİ KALIYORDU. Bu harita yalnızca `fixtures`
 * koleksiyonunu okuyordu; fikstür deposu TAM DEĞİŞTİRME semantiğinde
 * (`saveAll` listede olmayanı siler) ve eski maçlar listeden düşüyor.
 * Kayıt silinince saat `null` dönüyor, `bayatMi` ise FAIL-CLOSED — "başlama
 * saati okunamıyorsa maç BAYAT SAYILMAZ" — yani iade HİÇ tetiklenmiyordu.
 * Sonuç: sonucu hiç gelmemiş bir maçta oyuncunun LC'si KALICI kilitli.
 *
 * ÖLÇÜLDÜ (üretim, 2026-08-02): tahmin almış 242 maçın 168'inin fikstür
 * kaydı yok. Şu an insan parası açısından maruziyet SIFIR (iade edilmemiş
 * insan tahmini olan 6 maçtan fikstürsüz 3'ü de uzlaşmış), ama yol açık ve
 * fikstürler sürekli düşüyor.
 *
 * ⚠️ DÜELLOLAR ETKİLENMİYOR: `duels` belgesi kendi `kickoffISO`sunu taşıyor
 * ve fikstür silinse de duruyor. Açık kalan tahmin ve havuz yollarıydı.
 *
 * ÜÇ KADEMELİ ZİNCİR — hepsi ÜST SINIR yönünde, yani asla ERKEN iade yok:
 *   1) `fixtures` kaydı (yetkili kaynak)
 *   2) `match_results.meta.kickoffISO` — fikstür silinse de sonuç kaydı kalır
 *   3) Son çare: `max(predictions.at) + 96 saat`. Tahmin yalnızca başlamasına
 *      96 saatten az kalan maça girilebildiği için (`PREDICT_OPEN_AHEAD_HOURS`)
 *      bu, kickoff için GEÇERLİ BİR ÜST SINIRDIR. Üst sınır kullanmak
 *      bekleme süresini uzatır, kısaltmaz — erken iade edip gerçek sonuç
 *      gelince ikinci kez ödeme yapma riski YOK.
 */
async function kickoffHaritasi(db, ids) {
  const harita = new Map();
  if (!ids.length) return harita;
  const hepsi = ids.map(String);

  // 1) Yetkili kaynak: fikstür deposu
  try {
    const docs = await db
      .collection(COLL_FIXTURES)
      .find({ fixtureId: { $in: hepsi } }, { projection: { fixtureId: 1, kickoffISO: 1, kickoff: 1, _id: 0 } })
      .toArray();
    for (const d of docs) {
      const v = d.kickoffISO || d.kickoff || null;
      if (v) harita.set(String(d.fixtureId), v);
    }
  } catch (e) {
    console.error("[bayat-temizleyici] fikstur saatleri okunamadi:", e?.message || e);
  }

  const eksik = () => hepsi.filter((id) => !harita.get(id));

  // 2) Sonuç kaydının meta'sı — fikstür silinse de kalıyor
  let kalan = eksik();
  if (kalan.length) {
    try {
      const docs = await db
        .collection("match_results")
        .find({ fixtureId: { $in: kalan } }, { projection: { fixtureId: 1, "meta.kickoffISO": 1, _id: 0 } })
        .toArray();
      for (const d of docs) {
        if (d?.meta?.kickoffISO) harita.set(String(d.fixtureId), d.meta.kickoffISO);
      }
    } catch (e) {
      console.error("[bayat-temizleyici] sonuc meta saatleri okunamadi:", e?.message || e);
    }
  }

  // 3) Son çare: en geç tahminin zamanı + tahmin penceresi (üst sınır)
  kalan = eksik();
  if (kalan.length) {
    try {
      const grup = await db.collection("predictions").aggregate([
        { $match: { fixtureId: { $in: kalan } } },
        { $group: { _id: "$fixtureId", sonAt: { $max: "$at" } } },
      ]).toArray();
      for (const g of grup) {
        const t = Date.parse(g?.sonAt || "");
        if (!Number.isFinite(t)) continue;
        harita.set(String(g._id), new Date(t + TAHMIN_PENCERE_SAAT * 3600 * 1000).toISOString());
      }
      if (grup.length) {
        console.warn(
          `[bayat-temizleyici] ${grup.length} macin fikstur kaydi YOK — ` +
          `kickoff, son tahmin + ${TAHMIN_PENCERE_SAAT}sa ust siniriyla tahmin edildi`
        );
      }
    } catch (e) {
      console.error("[bayat-temizleyici] tahmin zamanlari okunamadi:", e?.message || e);
    }
  }

  return harita;
}

/* ── Düellolar ───────────────────────────────────────────────────────────── */

/**
 * Bayat maçtaki düelloları geçersiz kılar ve bahisleri iade eder.
 *
 * `open`   → yalnızca kurucunun bahsi düşülmüştü, o iade edilir.
 * `accepted` → iki tarafın da bahsi düşülmüştü, ikisi de iade edilir.
 */
async function duellolariTemizle(db, simdi = null) {
  const bekleyen = await db
    .collection(COLL_DUELS)
    .find({ status: { $in: PARA_TUTAN } })
    .toArray();
  if (!bekleyen.length) return { bakilan: 0, iptal: 0, iadeLc: 0 };

  let iptal = 0, iadeLc = 0;
  const odenemeyen = [];

  for (const d of bekleyen) {
    const durum = await bayatMi({
      fixtureId: d.fixtureId,
      kickoffISO: d.kickoffISO,
      db,
      simdi,
    });
    if (!durum.bayat) continue;

    // ⚠️ MÜHÜR: koşul yazmanın İÇİNDE. İki tur aynı anda çalışırsa yalnızca
    // biri modifiedCount alır, iade bir kez yapılır.
    const nowISO = new Date().toISOString();
    const m = await db.collection(COLL_DUELS).updateOne(
      { id: d.id, status: d.status },
      {
        $set: {
          status: DURUM.GECERSIZ,
          voidedAt: nowISO,
          voidReason: "SONUC_GELMEDI",
          settledAt: nowISO,
        },
      }
    );
    if (!m.modifiedCount) continue;
    iptal++;

    const bahis = Number(d.stake || 0);
    if (bahis <= 0) continue;

    // ⚠️ "active" = kabul edilmiş. İlk yazımda "accepted" sanıldı ve
    // temizleyici kabul edilmiş düelloları HİÇ görmüyordu (bkz. lib/duel-durum.cjs).
    const alacaklilar = [d.creatorId];
    if (d.status === DURUM.AKTIF && d.acceptorId) alacaklilar.push(d.acceptorId);

    for (const uid of alacaklilar) {
      if (!uid) continue;
      const ok = await creditLc(db, uid, bahis, "duel_void_refund", {
        duelId: d.id, fixtureId: d.fixtureId, sebep: "SONUC_GELMEDI",
      });
      if (ok) iadeLc += bahis;
      else odenemeyen.push({ userIdLower: String(uid).toLowerCase(), tutar: bahis, duelId: d.id });
    }
  }

  if (odenemeyen.length) {
    console.error(`[bayat-temizleyici] ⛔ DUELLO IADESI ODENEMEDI: ${odenemeyen.length} kayit`);
    await kayipOdulKaydet(db, {
      kaynak: "duel_void_refund", odemeler: odenemeyen,
      beklenen: odenemeyen.length, eksik: odenemeyen.length,
    });
  }

  return { bakilan: bekleyen.length, iptal, iadeLc };
}

/* ── Havuzlar ────────────────────────────────────────────────────────────── */

/** Bayat maçtaki havuz bahislerini iade eder ve havuzu mühürler. */
/**
 * BAYAT MACTA KALAN TAHMIN BEDELLERINI IADE EDER.
 *
 * UYARI: DUELLO VE HAVUZ IADE EDILIYORDU, TAHMIN EDILMIYORDU. Tahmin gonderimi
 * MAC_GIRIS_BEDELI (3 LC) dusuyor; settle2 bu bedeli yalnizca oyuncu
 * base >= REFUND_MIN_BASE puan aldiysa geri veriyor. Mac HIC sonuclanmazsa
 * puanlama da olmuyor — yani oyuncu oynanmamis bir oyun icin odemis oluyor ve
 * parasi kaliciolarak kayboluyor.
 *
 * Ayni maca duello acan ya da havuza giren oyuncunun parasi iade ediliyordu;
 * tahmin yapanin ki edilmiyordu. Tutarsizlik buradaydi.
 *
 * OLCULDU (2026-07-31, uretim verisi): 4 bayat macta 160 tahmin var ama
 * HEPSI BOT — su an kilitli insan parasi YOK. Yapisal bosluk gercek kullanici
 * gelince isirir.
 *
 * UYARI: MUHUR TAHMIN BELGESINDE. `iadeEdildi` alanini kosullu yazip
 * modifiedCount kontrol ediyoruz; iki tur ust uste calissa bile ikinci tur
 * hicbir sey odemez. Ayri bir muhur koleksiyonu, tahminle ayrisabilecek ikinci
 * bir dogruluk kaynagi olurdu.
 *
 * UYARI: BOTLARA IADE YOK. Botlar LC harcamiyor (settle2 onlari suzuyor), yani
 * iade etmek karsiliksiz LC basmak olurdu.
 */
async function tahminleriTemizle(db, simdi = null) {
// ⚠️ İNDEKS ONARIMI: bu yol `models/preds.cjs`'i kullanmıyor, yani
// oradaki kendi kendini onarma hiç çalışmıyordu (bkz. lib/preds-index.cjs).
await ensurePredIndexes(db);
  const col = db.collection("predictions");

  // Iadesi yapilmamis, bot olmayan tahminlerin maclari
  const fidler = await col.distinct("fixtureId", {
    isBot: { $ne: true },
    iadeEdildi: { $ne: true },
  });
  if (!fidler.length) return { bakilan: 0, iade: 0, iadeLc: 0 };

  const saatler = await kickoffHaritasi(db, fidler);
  let iade = 0, iadeLc = 0;
  const odenemeyen = [];

  for (const fid of fidler) {
    const durum = await bayatMi({
      fixtureId: String(fid),
      kickoffISO: saatler.get(String(fid)) || null,
      db,
      simdi,
    });
    if (!durum.bayat) continue;

    const tahminler = await col
      .find({ fixtureId: fid, isBot: { $ne: true }, iadeEdildi: { $ne: true } })
      .toArray();

    for (const t of tahminler) {
      const nowISO = new Date().toISOString();
      // Muhur ODEMEDEN once, kosul yazmanin icinde.
      const m = await col.updateOne(
        { _id: t._id, iadeEdildi: { $ne: true } },
        { $set: { iadeEdildi: true, iadeSebebi: "SONUC_GELMEDI", iadeAt: nowISO } }
      );
      if (!m.modifiedCount) continue;

      const ok = await creditLc(db, t.userId, MAC_GIRIS_BEDELI, "pred_void_refund", {
        fixtureId: String(fid), sebep: "SONUC_GELMEDI",
      });
      if (ok) { iade++; iadeLc += MAC_GIRIS_BEDELI; }
      else odenemeyen.push({ userIdLower: String(t.userId).toLowerCase(), tutar: MAC_GIRIS_BEDELI, fixtureId: String(fid) });
    }
  }

  if (odenemeyen.length) {
    console.error(`[bayat-temizleyici] TAHMIN IADESI ODENEMEDI: ${odenemeyen.length} kayit`);
    await kayipOdulKaydet(db, {
      kaynak: "pred_void_refund", odemeler: odenemeyen,
      beklenen: odenemeyen.length, eksik: odenemeyen.length,
    });
  }

  return { bakilan: fidler.length, iade, iadeLc };
}

async function havuzlariTemizle(db, simdi = null) {
  const acikHavuzlar = await db
    .collection(COLL_POOLS)
    .find({ $or: [{ settledAt: null }, { settledAt: { $exists: false } }] })
    .toArray();
  if (!acikHavuzlar.length) return { bakilan: 0, iptal: 0, iadeLc: 0 };

  const saatler = await kickoffHaritasi(db, acikHavuzlar.map((h) => h.fixtureId));
  let iptal = 0, iadeLc = 0;
  const odenemeyen = [];

  for (const h of acikHavuzlar) {
    const fid = String(h.fixtureId);
    const durum = await bayatMi({
      fixtureId: fid,
      kickoffISO: saatler.get(fid) || null,
      db,
      simdi,
    });
    if (!durum.bayat) continue;

    const nowISO = new Date().toISOString();
    const m = await db.collection(COLL_POOLS).updateOne(
      { fixtureId: fid, $or: [{ settledAt: null }, { settledAt: { $exists: false } }] },
      { $set: { settledAt: nowISO, iadeEdildi: true, iadeSebebi: "SONUC_GELMEDI" } }
    );
    if (!m.modifiedCount) continue;
    iptal++;

    const bahisler = await db.collection(COLL_BETS).find({ fixtureId: fid }).toArray();
    for (const b of bahisler) {
      const t = Number(b.amount || 0);
      if (t <= 0) continue;
      const ok = await creditLc(db, b.userId, t, "pool_void_refund", {
        fixtureId: fid, sebep: "SONUC_GELMEDI",
      });
      if (ok) iadeLc += t;
      else odenemeyen.push({ userIdLower: String(b.userId).toLowerCase(), tutar: t, fixtureId: fid });
    }
  }

  if (odenemeyen.length) {
    console.error(`[bayat-temizleyici] ⛔ HAVUZ IADESI ODENEMEDI: ${odenemeyen.length} kayit`);
    await kayipOdulKaydet(db, {
      kaynak: "pool_void_refund", odemeler: odenemeyen,
      beklenen: odenemeyen.length, eksik: odenemeyen.length,
    });
  }

  return { bakilan: acikHavuzlar.length, iptal, iadeLc };
}

/* ── Tur ─────────────────────────────────────────────────────────────────── */

/**
 * ⚠️ KRİTİK İŞ SAYACINA DAHİL — EKSİKTİ.
 *
 * BULUNAN: `lib/kritik-is.cjs` tam bu durum için yazılmış; kendi başlığı
 * "sorun ARKA PLAN servislerinde: zamanlayıcıyla çalışır, hiçbir isteğe bağlı
 * değildir" diyor. Ama sayacı yalnızca `routes/settle2.cjs` kullanıyordu.
 * Bu servis de zamanlayıcıyla çalışıyor (6 saatte bir) ve ÜÇ yerde LC iade
 * ediyor (`duel_void_refund`, `pool_void_refund`, `pred_void_refund`).
 *
 * ÖLÇÜLDÜ (tur çalışırken sayaç örneklendi):
 *     önce : aktifKritikIs() = 0  → kapanış beklemeden çıkardı
 *     sonra: aktifKritikIs() = 1
 *
 * ⚠️ NEDEN ÖNEMLİ: bu servis de "MÜHÜR ÖNCE, ÖDEME SONRA" sırasını kullanıyor
 * (dosya başlığı). SIGTERM ödeme sırasında düşerse düello/havuz iptal
 * MÜHÜRLÜ kalır ama iade yatmaz — mühür yüzünden tekrar da denenmez.
 * Render ücretsiz katmanda SIGTERM her deploy'da ve boşta uyutmada geliyor,
 * yani çakışma kuramsal değil.
 */
async function tur(dbDisaridan = null, simdi = null) {
  return kritikIs("bayat-temizleyici", () => _tur(dbDisaridan, simdi));
}

async function _tur(dbDisaridan = null, simdi = null) {
  const db = dbDisaridan || (await getDbSafe());
  if (!db) return { ok: false, reason: "NO_DB" };

  const duello = await duellolariTemizle(db, simdi);
  const havuz = await havuzlariTemizle(db, simdi);
  const tahmin = await tahminleriTemizle(db, simdi);

  _sonTur = { at: new Date().toISOString(), duello, havuz, tahmin };
  if (duello.iptal || havuz.iptal || tahmin.iade) {
    console.warn(
      `[bayat-temizleyici] ${duello.iptal} duello + ${havuz.iptal} havuz iptal, ` +
      `${tahmin.iade} tahmin iadesi · ` +
      `${duello.iadeLc + havuz.iadeLc + tahmin.iadeLc} LC iade`
    );
  }
  return { ok: true, ..._sonTur };
}

function start(intervalMs = 6 * 3600 * 1000) {
  if (_timer) return;
  // İlk tur hemen değil: fikstür/sonuç senkronlarının ilk turunu bitirmesine
  // fırsat ver, yoksa henüz gelmemiş sonuçları "gelmedi" sayar.
  setTimeout(() => { tur().catch(() => {}); }, 5 * 60 * 1000);
  _timer = setInterval(() => { tur().catch(() => {}); }, intervalMs);
  if (typeof _timer.unref === "function") _timer.unref();
  console.log(`[bayat-temizleyici] basladi · her ${Math.round(intervalMs / 3600000)} saatte`);
}

function stop() {
  if (_timer) clearInterval(_timer);
  _timer = null;
}

module.exports = { start, stop, tur, sonTur: () => _sonTur,
  _duellolariTemizle: duellolariTemizle, _havuzlariTemizle: havuzlariTemizle,
  _tahminleriTemizle: tahminleriTemizle,
  // Fikstursuz macta parayi kilitleyen yol — dogrudan sinanabilsin diye acik.
  _kickoffHaritasi: kickoffHaritasi, TAHMIN_PENCERE_SAAT };
