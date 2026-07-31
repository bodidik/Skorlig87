"use strict";

/**
 * BAYAT MAÇ TEMİZLEYİCİ — sonucu gelmeyen maçlarda kilitli parayı iade eder.
 *
 * ⚠️ NEDEN VAR: bu oyunda para bir maçın sonucuna bağlı ve sonuç gelmezse
 * KENDİLİĞİNDEN ÇÖZÜLMÜYORDU. Kabul edilmiş düello iptal edilemiyor
 * (`claimDuelCancel` yalnızca `status: "open"` kabul ediyor), havuz yalnızca
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
const { creditLc, kayipOdulKaydet } = require("../lib/wallet-credit.cjs");

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

/** fixtureId → kickoffISO (fikstür deposundan). Bulunamazsa null. */
async function kickoffHaritasi(db, ids) {
  const harita = new Map();
  if (!ids.length) return harita;
  try {
    const docs = await db
      .collection(COLL_FIXTURES)
      .find({ fixtureId: { $in: ids.map(String) } }, { projection: { fixtureId: 1, kickoffISO: 1, kickoff: 1, _id: 0 } })
      .toArray();
    for (const d of docs) {
      harita.set(String(d.fixtureId), d.kickoffISO || d.kickoff || null);
    }
  } catch (e) {
    console.error("[bayat-temizleyici] fikstur saatleri okunamadi:", e?.message || e);
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
    .find({ status: { $in: ["open", "accepted"] } })
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
          status: "voided",
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

    const alacaklilar = [d.creatorId];
    if (d.status === "accepted" && d.acceptorId) alacaklilar.push(d.acceptorId);

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

async function tur(dbDisaridan = null, simdi = null) {
  const db = dbDisaridan || (await getDbSafe());
  if (!db) return { ok: false, reason: "NO_DB" };

  const duello = await duellolariTemizle(db, simdi);
  const havuz = await havuzlariTemizle(db, simdi);

  _sonTur = { at: new Date().toISOString(), duello, havuz };
  if (duello.iptal || havuz.iptal) {
    console.warn(
      `[bayat-temizleyici] ${duello.iptal} duello + ${havuz.iptal} havuz iptal edildi · ` +
      `${duello.iadeLc + havuz.iadeLc} LC iade`
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

module.exports = { start, stop, tur, sonTur: () => _sonTur, _duellolariTemizle: duellolariTemizle, _havuzlariTemizle: havuzlariTemizle };
