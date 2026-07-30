"use strict";

/**
 * MAÇ HAVUZU — pari-mutuel bahis (bkz. docs/ekonomi-tasarim.md §4).
 *
 * NEDEN VAR: düellonun sorunu, odds'un kimin KAZANDIĞINI belirleyip ÖDEMEYİ
 * belirlememesi. Sürprizi bilmekle favoriyi bilmek aynı parayı kazandırıyordu.
 * Havuz bu bağı kurar:
 *
 *     çarpan = (toplam havuz − kesinti) / kazanan tarafın toplam bahsi
 *     kazanç = kendi bahsi × çarpan
 *
 * Kalabalıkla gitmek az kazandırır — mekaniğin kendisi bu. Uygulamanın
 * onboarding metni zaten "az kişinin tuttuğunu bilirsen daha fazla puan"
 * diyor; ilke puanlamada vardı, parada yoktu.
 *
 * ── KARARLAR (belgede verildi) ──────────────────────────────────────────
 * • Kesinti %5, YAKILIR (kasaya birikmez). Yalnızca kaybeden taraf varsa
 *   alınır: herkes bildiyse kesinti yok, herkes bahsini geri alır.
 * • Havuz SIRALAMAYI ETKİLEMEZ. Puan = beceri, LC = para. Havuz kazancını
 *   sıralamaya katmak, çok parası olanı üste taşırdı.
 * • Girdi yalnızca Ev/Beraberlik/Deplasman. Skor/ilk gol tahmin modunun işi.
 *
 * ── BAHİS TAVANI ────────────────────────────────────────────────────────
 * Açık soruydu; karar: max(TABAN, havuzun %25'i). Sabit tavan keyfi
 * ("adam 120 kazanmalı, biz 100 mü diyeceğiz?"); tavansız ise tek kişi
 * çarpanı domine eder. Oransal tavan kendiliğinden ölçeklenir ve zenginin
 * parası ancak BAŞKALARI da oynarsa işe yarar.
 * ⚠️ Tavan eşitsizliği önlemez, GİDER önler — asıl denge iade eşiği ve
 *    günlük tabanla kuruldu (bkz. §2).
 *
 * ── BOTLAR ──────────────────────────────────────────────────────────────
 * Botlar DAĞILIMI oluşturur, PARAYI oluşturmaz. Havuza bot parası girerse ya
 * gerçek kullanıcının parası sistemden çıkar ya da LC enflasyonu olur.
 * Bu depo yalnızca gerçek kullanıcı bahsi tutar; bot dağılımı ekranda ayrı
 * gösterilir (bkz. routes/pool.cjs).
 */

const Wallet = require("./wallet-credit.cjs");

const COLL_BETS = "pool_bets";
const COLL_POOLS = "pools";

const SIDES = ["H", "D", "A"];

/** Kesinti oranı — yakılır, kasaya birikmez. */
const CUT_PCT = Number(process.env.SKORLIG_POOL_CUT_PCT || 0.05);
/** Bahis alt sınırı. */
const MIN_BET = Number(process.env.SKORLIG_POOL_MIN_BET || 5);
/** Tavanın taban değeri: havuz küçükken de anlamlı bir bahis yapılabilsin. */
const CAP_FLOOR = Number(process.env.SKORLIG_POOL_CAP_FLOOR || 20);
/** Tavanın havuza oranı. */
const CAP_PCT = Number(process.env.SKORLIG_POOL_CAP_PCT || 0.25);

let _indexPromise = null;
function ensureIndexes(db) {
  if (!db) return Promise.resolve();
  if (_indexPromise) return _indexPromise;
  _indexPromise = (async () => {
    try {
      // Bir oyuncu bir maçta TEK bahis tutar (aynı tarafa ekleme yapılabilir).
      await db.collection(COLL_BETS).createIndex(
        { fixtureId: 1, userIdLower: 1 }, { unique: true, background: true }
      );
      await db.collection(COLL_BETS).createIndex({ fixtureId: 1 }, { background: true });
      await db.collection(COLL_BETS).createIndex({ userIdLower: 1 }, { background: true });
      await db.collection(COLL_POOLS).createIndex({ fixtureId: 1 }, { unique: true, background: true });
    } catch (e) {
      console.error("[pool-store] indeks kurulamadi:", e?.message || e);
    }
  })();
  return _indexPromise;
}

const lower = (x) => String(x || "").trim().toLowerCase();
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;

/**
 * Bir taraf tutarsa çarpan ne olur.
 * `null` → o tarafa hiç bahis yok (çarpan tanımsız).
 * Kaybeden taraf YOKSA kesinti alınmaz: herkes bahsini geri alır (1.0×).
 */
function multiplierFor(totals, side) {
  const kazanan = Number(totals[side] || 0);
  if (kazanan <= 0) return null;
  const toplam = Number(totals.H || 0) + Number(totals.D || 0) + Number(totals.A || 0);
  if (toplam <= kazanan) return 1; // tek taraf var → iade
  return r2((toplam * (1 - CUT_PCT)) / kazanan);
}

/** Bahis tavanı: max(CAP_FLOOR, havuz × CAP_PCT). */
function betCap(pool) {
  return Math.max(CAP_FLOOR, Math.round(Number(pool || 0) * CAP_PCT));
}

/**
 * Maçın havuz özeti: taraf bazlı toplamlar, oyuncu sayısı, canlı çarpanlar.
 *
 * Çarpanlar CANLI gösterilir (belgede karar verildi): sürü davranışı oyunun
 * konusu — kalabalığa gitmenin bedeli düşük çarpan. Bu bir kusur değil.
 */
async function summary(fixtureId, db) {
  const fid = String(fixtureId || "");
  const bos = {
    fixtureId: fid,
    totals: { H: 0, D: 0, A: 0 },
    counts: { H: 0, D: 0, A: 0 },
    pool: 0,
    players: 0,
    multipliers: { H: null, D: null, A: null },
    cutPct: CUT_PCT,
    minBet: MIN_BET,
    cap: CAP_FLOOR,
    settledAt: null,
    outcome: null,
  };
  if (!fid || !db) return bos;

  await ensureIndexes(db);
  const bets = await db.collection(COLL_BETS).find({ fixtureId: fid }).toArray();
  const doc = await db.collection(COLL_POOLS).findOne({ fixtureId: fid });

  const totals = { H: 0, D: 0, A: 0 };
  const counts = { H: 0, D: 0, A: 0 };
  for (const b of bets) {
    if (!SIDES.includes(b.side)) continue;
    totals[b.side] = r2(totals[b.side] + Number(b.amount || 0));
    counts[b.side] += 1;
  }
  const pool = r2(totals.H + totals.D + totals.A);

  return {
    fixtureId: fid,
    totals,
    counts,
    pool,
    players: bets.length,
    multipliers: {
      H: multiplierFor(totals, "H"),
      D: multiplierFor(totals, "D"),
      A: multiplierFor(totals, "A"),
    },
    cutPct: CUT_PCT,
    minBet: MIN_BET,
    cap: betCap(pool),
    settledAt: doc?.settledAt || null,
    outcome: doc?.outcome || null,
  };
}

/**
 * Bahis koyar (ya da mevcut bahsi artırır).
 *
 * ⚠️ SIRA: önce LC düşülür, sonra bahis yazılır. Tersi olsaydı yazma başarılı
 * olup düşme başarısız olduğunda oyuncu BEDAVA bahis yapmış olurdu. Bu sırada
 * ise düşme başarılı olup yazma başarısız olursa oyuncu LC kaybeder — o yüzden
 * yazma hatasında LC İADE edilir.
 */
async function placeBet({ fixtureId, userId, side, amount, isBot }, db) {
  const fid = String(fixtureId || "");
  const uid = String(userId || "").trim();
  const tutar = Math.round(Number(amount || 0));

  if (!fid || !uid) return { ok: false, reason: "REQ" };
  if (!SIDES.includes(side)) return { ok: false, reason: "INVALID_SIDE" };
  if (!Number.isFinite(tutar) || tutar < MIN_BET) {
    return { ok: false, reason: "MIN_BET", minBet: MIN_BET };
  }
  // Botlar dağılımı oluşturur, parayı oluşturmaz — havuza giremezler.
  if (isBot) return { ok: false, reason: "BOT_NOT_ALLOWED" };
  if (!db) return { ok: false, reason: "NO_DB" };

  await ensureIndexes(db);

  const havuz = await db.collection(COLL_POOLS).findOne({ fixtureId: fid });
  if (havuz?.settledAt) return { ok: false, reason: "POOL_SETTLED" };

  const ozet = await summary(fid, db);
  const mevcut = await db.collection(COLL_BETS).findOne({ fixtureId: fid, userIdLower: lower(uid) });

  // Taraf değiştirmek yok: karar bir kez verilir, üstüne eklenir.
  if (mevcut && mevcut.side !== side) {
    return { ok: false, reason: "SIDE_LOCKED", side: mevcut.side };
  }

  const yeniToplam = Number(mevcut?.amount || 0) + tutar;
  // ⚠️ TAVAN, ÖZETTEKİYLE AYNI TABANDAN hesaplanır (`ozet.pool`, gelen bahis
  // HARİÇ). Gelen bahsi tabana katmak tavanı kendi kendine büyütüyordu:
  // arayüz "tavan 20" gösterirken 26 kabul ediliyordu. Kullanıcıya gösterilen
  // sınır ile uygulanan sınır ayrışmamalı.
  const tavan = betCap(ozet.pool);
  if (yeniToplam > tavan) {
    return { ok: false, reason: "OVER_CAP", cap: tavan, current: Number(mevcut?.amount || 0) };
  }

  const harcama = await Wallet.spendLc(db, uid, tutar, "pool_bet", { fixtureId: fid, side });
  if (!harcama.ok) {
    return harcama.reason === "INSUFFICIENT"
      ? { ok: false, reason: "LC_NOT_ENOUGH", lc: harcama.lc, needed: tutar }
      : { ok: false, reason: "LC_SPEND_FAILED" };
  }

  try {
    const nowISO = new Date().toISOString();
    await db.collection(COLL_BETS).updateOne(
      { fixtureId: fid, userIdLower: lower(uid) },
      {
        $inc: { amount: tutar },
        $set: { userId: uid, side, updatedAt: nowISO },
        $setOnInsert: { fixtureId: fid, userIdLower: lower(uid), createdAt: nowISO },
      },
      { upsert: true }
    );
  } catch (e) {
    // Yazma başarısız → düşülen LC'yi GERİ VER, yoksa para buharlaşır.
    console.error("[pool-store] bahis yazilamadi, LC iade ediliyor:", e?.message || e);
    await Wallet.creditLc(db, uid, tutar, "pool_bet_refund", { fixtureId: fid, reason: "write_failed" });
    return { ok: false, reason: "BET_WRITE_FAILED" };
  }

  return {
    ok: true,
    lc: harcama.lc,
    bet: { side, amount: yeniToplam },
    summary: await summary(fid, db),
  };
}

/**
 * Havuzu sonuçlandırır ve ödemeleri dağıtır.
 *
 * ⚠️ PARA KORUMASI: `settledAt` mührü ödemeden ÖNCE, koşullu olarak alınır —
 * settle2 aynı fixture'ı livescore-sync/af-sync/manuel yollardan defalarca
 * gönderebiliyor. Aynı desen maç ödülü, turnuva ve düelloda da kullanıldı.
 */
async function settlePool(fixtureId, outcome, db) {
  const fid = String(fixtureId || "");
  if (!fid || !SIDES.includes(outcome) || !db) return { ok: false, reason: "REQ" };

  await ensureIndexes(db);
  const nowISO = new Date().toISOString();

  // ⚠️ İKİ ADIM. `upsert: true` ile KOŞULLU filtreyi birlikte kullanmak,
  // filtre eşleşmediğinde YENİ BELGE ekliyor — o zaman her çağrı "mührü aldım"
  // sanıyor (match-results.claimAward'da tam bu hata yakalandı).
  await db.collection(COLL_POOLS).updateOne(
    { fixtureId: fid },
    { $setOnInsert: { fixtureId: fid, settledAt: null } },
    { upsert: true }
  );
  const muhur = await db.collection(COLL_POOLS).updateOne(
    { fixtureId: fid, $or: [{ settledAt: null }, { settledAt: { $exists: false } }] },
    { $set: { settledAt: nowISO, outcome } }
  );
  if (!(muhur.modifiedCount > 0)) return { ok: false, reason: "ALREADY_SETTLED" };

  const bets = await db.collection(COLL_BETS).find({ fixtureId: fid }).toArray();
  if (!bets.length) return { ok: true, paid: 0, burned: 0, players: 0 };

  const totals = { H: 0, D: 0, A: 0 };
  for (const b of bets) if (SIDES.includes(b.side)) totals[b.side] += Number(b.amount || 0);
  const toplam = totals.H + totals.D + totals.A;
  const kazananToplam = totals[outcome];

  // Kimse bilemediyse: havuz tamamen iade. Kesinti YALNIZCA kaybeden taraf
  // varken alınır; burada kazanan yok, yani kimseden kesinti alınmaz.
  if (kazananToplam <= 0) {
    let iade = 0;
    for (const b of bets) {
      const t = Number(b.amount || 0);
      if (t > 0 && (await Wallet.creditLc(db, b.userId, t, "pool_refund_no_winner", { fixtureId: fid }))) {
        iade += t;
      }
    }
    return { ok: true, paid: r2(iade), burned: 0, players: bets.length, reason: "NO_WINNER_REFUND" };
  }

  // Herkes bildiyse: kaybeden taraf yok → kesinti yok, herkes bahsini geri alır.
  const kaybedenVar = toplam > kazananToplam;
  const carpan = kaybedenVar ? (toplam * (1 - CUT_PCT)) / kazananToplam : 1;
  const yakilan = kaybedenVar ? r2(toplam * CUT_PCT) : 0;

  let odenen = 0;
  for (const b of bets) {
    if (b.side !== outcome) continue;
    const kazanc = Math.round(Number(b.amount || 0) * carpan);
    if (kazanc > 0) {
      const yatti = await Wallet.creditLc(db, b.userId, kazanc, "pool_win", {
        fixtureId: fid, side: outcome, multiplier: r2(carpan),
      });
      if (yatti) odenen += kazanc;
    }
  }

  await db.collection(COLL_POOLS).updateOne(
    { fixtureId: fid },
    { $set: { multiplier: r2(carpan), paid: odenen, burned: yakilan, pool: r2(toplam) } }
  );

  return {
    ok: true,
    paid: odenen,
    burned: yakilan,
    players: bets.length,
    multiplier: r2(carpan),
    pool: r2(toplam),
  };
}

/** Oyuncunun bir maçtaki bahsi (yoksa null). */
async function myBet(fixtureId, userId, db) {
  if (!db) return null;
  await ensureIndexes(db);
  const d = await db.collection(COLL_BETS).findOne({
    fixtureId: String(fixtureId || ""),
    userIdLower: lower(userId),
  });
  if (!d) return null;
  const { _id, userIdLower: _uidLower, ...rest } = d;
  return rest;
}

module.exports = {
  summary, placeBet, settlePool, myBet,
  multiplierFor, betCap,
  COLL_BETS, COLL_POOLS, SIDES, CUT_PCT, MIN_BET, CAP_FLOOR, CAP_PCT,
};
