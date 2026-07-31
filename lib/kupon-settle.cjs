"use strict";

/**
 * HAFTALIK KUPON — SONUÇLANDIRMA.
 *
 * Kuponun TÜM maçları sonuçlandığında: doğru sayısı → puan + LC ödülü.
 *
 * ⚠️ MÜHÜR ÖDEMEDEN ÖNCE. Tarama hem settle2'den (her maç sonuçlandığında)
 * hem yönetici ucundan tetiklenebiliyor; koşul (`durum != settled`) yazmanın
 * içinde tutuluyor, yalnızca tek çağrı ödemeye geçer. Aynı ilke claimAward,
 * claimTournamentSettle ve finishMini'de.
 *
 * ⚠️ ÖDÜL ÜRETİLİR (havuzdan değil). Giriş bedelleri yakılıyor; kademeler
 * ortalama oyuncu için giriş bedelinin altında kalacak şekilde ölçüldü —
 * bkz. lib/kupon.cjs `beklenenOdul` ve tests/kupon.test.cjs.
 */

const Kupon = require("./kupon.cjs");
const Store = require("./kupon-store.cjs");
const MatchResults = require("./match-results.cjs");
const WalletCredit = require("./wallet-credit.cjs");
const Season = require("./season.cjs");

/** Skordan 1X2 sonucu. */
function sonucBul(finalScore) {
  if (!finalScore) return null;
  const h = Number(finalScore.home);
  const a = Number(finalScore.away);
  if (!Number.isFinite(h) || !Number.isFinite(a)) return null;
  return h > a ? "H" : a > h ? "A" : "D";
}

/**
 * Kuponun maç sonuçlarını toplar.
 * @returns {{tamam:boolean, sonuclar:Object}} tamam=false ise henüz erken
 */
/**
 * KUPONUN BİTMESİNİ NE KADAR BEKLERİZ (saat, son maçın başlama saatinden itibaren).
 *
 * ⚠️ NEDEN VAR: eskiden kupon TÜM maçların sonucunu şart koşuyordu. Tek
 * maç ertelenirse kupon SONSUZA KADAR askıda kalıyordu: oyuncunun giriş
 * bedeli yanmış, ödülü ve puanı hiç gelmiyordu. Futbolda erteleme rutin
 * (hava, kupa takvimi); üstelik skor kaynakları fiilen tek şelaleye düşmüş
 * durumda, yani bir sonuç hiç gelmeyebilir de. Sezon boyunca bu neredeyse
 * kesindi.
 */
const BEKLEME_SAAT = Number(process.env.SKORLIG_KUPON_BEKLEME_SAAT || 48);

/**
 * Kısmi sonuçla puanlamak için en az kaç maç çözülmüş olmalı (oran).
 * Altında kalırsa kupon puanlanmaz, giriş bedeli İADE edİlİr — yarım veriyle
 * sıralama yazmak, hiç yazmamaktan kötüdür.
 */
const ASGARI_COZULEN_ORAN = Number(process.env.SKORLIG_KUPON_ASGARI_ORAN || 0.5);

/** Kupondaki en geç başlayan maçın saati (ms). Bulunamazsa null. */
function sonKickoffMs(kupon) {
  const saatler = (kupon?.maclar || [])
    .map((m) => new Date(String(m?.kickoffISO || "")).getTime())
    .filter((n) => Number.isFinite(n));
  return saatler.length ? Math.max(...saatler) : null;
}

/**
 * Çözülebilen sonuçları toplar.
 *
 * Artık EKSİK sonuçta erken çıkmıyor: hangilerinin çözüldüğünü de dönüyor ki
 * bekleme süresi dolduktan sonra kısmi puanlama yapılabilsin.
 */
async function sonuclariTopla(kupon, db) {
  const sonuclar = {};
  let eksik = 0;
  for (const fid of kupon.fixtureIds || []) {
    const snap = await MatchResults.getSnapshot(String(fid), db).catch(() => null);
    const s = sonucBul(snap?.finalScore);
    if (!s) { eksik++; continue; }
    sonuclar[String(fid)] = s;
  }
  return { tamam: eksik === 0, eksik, sonuclar };
}

/**
 * Tek kuponu sonuçlandırır.
 * @returns {{ok:boolean, reason?:string, odenen?:number, katilimci?:number}}
 */
/**
 * GİRİŞ BEDELİ İADESİ — çözülen maç sayısı puanlamaya yetmeyince.
 *
 * ⚠️ MÜHÜR ÖNCE, ÖDEME SONRA. Aynı sıra normal sonuçlandırmada da var:
 * mühür alınamazsa başka bir çağrı zaten ödüyor demektir; önce ödeyip sonra
 * mühürlemek çift iade üretirdi.
 *
 * ⚠️ PUAN YAZILMAZ. Yarım veriyle sezon tablosuna puan işlemek, oyuncunun
 * sıralamasını kalıcı olarak bozardı ve geri alınamıyordu.
 */
async function iadeEt(kupon, db, nowISO, bilgi) {
  const bizimki = await Store.kuponMuhurle(
    kupon.id,
    { settledAt: nowISO, iadeEdildi: true, iadeSebebi: "YETERSIZ_SONUC", ...bilgi },
    db
  );
  if (!bizimki) return { ok: false, reason: "ALREADY_SETTLED" };

  const katilimlar = await Store.katilimlar(kupon.id, db);
  const bedel = Number(kupon.girisBedeli || 0);
  const odenemeyen = [];
  let iadeToplam = 0;

  for (const k of katilimlar) {
    if (bedel <= 0) break;
    const ok = await WalletCredit.creditLc(db, k.userId, bedel, "kupon_iade", {
      kuponId: kupon.id, sebep: "YETERSIZ_SONUC", ...bilgi,
    });
    if (ok) iadeToplam += bedel;
    else odenemeyen.push({ userIdLower: String(k.userId).toLowerCase(), tutar: bedel });

    await Store.katilimSonucYaz(kupon.id, k.userId, {
      dogru: 0, toplam: 0, puan: 0, ceza: 0, bonus: 0,
      odulLc: 0, iadeLc: bedel, sonuclandiAt: nowISO,
    }, db);
  }

  if (odenemeyen.length) {
    console.error(`[kupon-settle] ⛔ IADE ODENEMEDI kupon=${kupon.id} kisi=${odenemeyen.length}`);
    await WalletCredit.kayipOdulKaydet(db, {
      kaynak: "kupon_iade", kuponId: kupon.id,
      odemeler: odenemeyen, beklenen: katilimlar.length, eksik: odenemeyen.length,
    });
  }

  console.warn(
    `[kupon-settle] kupon=${kupon.id} yetersiz sonuc (${bilgi.cozulen}/${bilgi.toplamMac}) → ${iadeToplam} LC iade`
  );
  return { ok: true, iade: true, katilimci: katilimlar.length, iadeEdilen: iadeToplam };
}

async function kuponuSonuclandir(kupon, db) {
  if (!db) return { ok: false, reason: "NO_DB" };
  if (!kupon || kupon.durum === "settled") return { ok: false, reason: "ALREADY_SETTLED" };

  const { tamam, eksik, sonuclar } = await sonuclariTopla(kupon, db);
  const toplamMac = (kupon.fixtureIds || []).length;
  const cozulen = Object.keys(sonuclar).length;

  /* ⚠️ ERTELENEN MAÇ KUPONU KİLİTLEMESİN.
   *
   * Eskiden burada "tüm maçlar bitmediyse hiç sonuçlandırma" vardı ve tek
   * ertelenen maç kuponu sonsuza kadar askıda bırakıyordu — giriş bedeli
   * yanmış, ödül yok, puan yok.
   *
   * Sıra bilinçli: önce normal yol (hepsi bitti), sonra bekleme süresi.
   * Süre dolmadan kısmi puanlamaya geçmek, sonucu geç gelen maçı haksız
   * yere yok saymak olurdu. */
  if (!tamam) {
    const sonKO = sonKickoffMs(kupon);
    // Başlama saati okunamıyorsa bekleme süresini hesaplayamayız → BEKLE.
    // (Ters varsayım, veri bozukken erken ödeme yapardı.)
    if (sonKO === null) return { ok: false, reason: "MACLAR_BITMEDI", eksik };
    const sinir = sonKO + BEKLEME_SAAT * 3600 * 1000;
    if (Date.now() < sinir) return { ok: false, reason: "MACLAR_BITMEDI", eksik };
  }

  const nowISO = new Date().toISOString();

  /* Bekleme doldu ve çözülen maç sayısı eşiğin altında → PUANLAMA YOK, İADE.
   * Yarım veriyle sıralama yazmak, hiç yazmamaktan kötüdür. */
  if (!tamam && cozulen < Math.ceil(toplamMac * ASGARI_COZULEN_ORAN)) {
    return iadeEt(kupon, db, nowISO, { cozulen, toplamMac, eksik });
  }

  // ⚠️ MÜHÜR ÖNCE — buradan sonrası yalnızca tek çağrıda çalışır.
  // Kısmi sonuçlandysa iz bırakılır: "neden 8 maçlık kupon 6 üzerinden
  // puanlandı" sorusunun cevabı belgede dursun.
  const bizimki = await Store.kuponMuhurle(
    kupon.id,
    { settledAt: nowISO, sonuclar, kismi: !tamam, cozulen, toplamMac, eksik },
    db
  );
  if (!bizimki) return { ok: false, reason: "ALREADY_SETTLED" };

  const katilimlar = await Store.katilimlar(kupon.id, db);
  /* ⚠️ PUANLAMA TABANI ÇÖZÜLEN MAÇ SAYISI, kupondaki tüm maçlar değil.
   * Sonucu hiç gelmeyen maç oyuncunun aleyhine sayılmamalı: puan ve ödül
   * zaten ORAN tabanlı (bkz. lib/kupon.cjs), yani taban küçülünce
   * hesap kendiliğinden doğrulanır. */
  const toplam = cozulen;
  const sezon = Season.seasonKey();
  const odenemeyen = [];
  const totalsOps = [];
  let odenenToplam = 0;

  for (const k of katilimlar) {
    const tahminler = k.tahminler || {};
    let dogru = 0;
    for (const [fid, gercek] of Object.entries(sonuclar)) {
      if (String(tahminler[fid] || "") === gercek) dogru++;
    }

    const p = Kupon.puanla(dogru, toplam);
    const lc = Kupon.odul(dogru, toplam, kupon.tur);

    if (lc > 0) {
      const ok = await WalletCredit.creditLc(db, k.userId, lc, "kupon_odul", {
        kuponId: kupon.id, tur: kupon.tur, dogru, toplam,
      });
      if (ok) odenenToplam += lc;
      else odenemeyen.push({ userIdLower: String(k.userId).toLowerCase(), tutar: lc });
    }

    await Store.katilimSonucYaz(kupon.id, k.userId, {
      dogru, toplam, puan: p.puan, ceza: p.ceza, bonus: p.bonus,
      odulLc: lc, sonuclandiAt: nowISO,
    }, db);

    /* ⚠️ PUANLAR SEZON TOPLAMINA İŞLENİR. Kupon puanı ayrı bir yerde dursa
     * oyuncu için anlamsız olurdu — sezon tablosu tek sıralama. `matches`
     * kupondaki maç sayısı kadar artıyor: sıralama maç-başı ortalamaya göre
     * (bkz. lib/ranking.cjs), yani kupon oynayan haksız avantaj kazanmasın. */
    totalsOps.push({
      updateOne: {
        filter: { season: sezon, userIdLower: String(k.userId).toLowerCase() },
        update: {
          $inc: { totalPoints: p.puan, totalPenalty: p.ceza, matches: toplam },
          $set: { userId: k.userId, lastAt: nowISO, updatedAt: nowISO },
          $setOnInsert: { season: sezon, userIdLower: String(k.userId).toLowerCase(), createdAt: nowISO },
        },
        upsert: true,
      },
    });
  }

  if (totalsOps.length) {
    try {
      await db.collection("season_totals").bulkWrite(totalsOps, { ordered: false });
    } catch (e) {
      console.error("[kupon-settle] sezon toplami yazilamadi:", e?.message || e);
    }
  }

  if (odenemeyen.length) {
    // Mühür atıldı, tekrar denenmez → kalıcı iz (GET /api/health sayıyor).
    console.error(`[kupon-settle] ⛔ ODUL ODENEMEDI kupon=${kupon.id} kisi=${odenemeyen.length}`);
    await WalletCredit.kayipOdulKaydet(db, {
      kaynak: "kupon_odul", kuponId: kupon.id,
      odemeler: odenemeyen, beklenen: katilimlar.length, eksik: odenemeyen.length,
    });
  }

  return { ok: true, katilimci: katilimlar.length, odenen: odenenToplam };
}

/**
 * Bekleyen tüm kuponları tarar. settle2 her maç sonuçlandığında çağırır;
 * maçları bitmemiş kupona dokunmaz.
 */
async function bekleyenleriSonuclandir(db) {
  if (!db) return { ok: false, reason: "NO_DB" };
  const bekleyen = await Store.bekleyenKuponlar(db);
  const sonuc = [];
  for (const k of bekleyen) {
    const r = await kuponuSonuclandir(k, db);
    if (r.ok) sonuc.push({ kuponId: k.id, ...r });
  }
  return { ok: true, sonuclandirilan: sonuc.length, detay: sonuc };
}

module.exports = { kuponuSonuclandir, bekleyenleriSonuclandir, _sonucBul: sonucBul };
