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
async function sonuclariTopla(kupon, db) {
  const sonuclar = {};
  for (const fid of kupon.fixtureIds || []) {
    const snap = await MatchResults.getSnapshot(String(fid), db).catch(() => null);
    const s = sonucBul(snap?.finalScore);
    if (!s) return { tamam: false, sonuclar };
    sonuclar[String(fid)] = s;
  }
  return { tamam: true, sonuclar };
}

/**
 * Tek kuponu sonuçlandırır.
 * @returns {{ok:boolean, reason?:string, odenen?:number, katilimci?:number}}
 */
async function kuponuSonuclandir(kupon, db) {
  if (!db) return { ok: false, reason: "NO_DB" };
  if (!kupon || kupon.durum === "settled") return { ok: false, reason: "ALREADY_SETTLED" };

  const { tamam, sonuclar } = await sonuclariTopla(kupon, db);
  if (!tamam) return { ok: false, reason: "MACLAR_BITMEDI" };

  const nowISO = new Date().toISOString();

  // ⚠️ MÜHÜR ÖNCE — buradan sonrası yalnızca tek çağrıda çalışır.
  const bizimki = await Store.kuponMuhurle(kupon.id, { settledAt: nowISO, sonuclar }, db);
  if (!bizimki) return { ok: false, reason: "ALREADY_SETTLED" };

  const katilimlar = await Store.katilimlar(kupon.id, db);
  const toplam = (kupon.fixtureIds || []).length;
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
