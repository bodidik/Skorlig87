"use strict";

/**
 * GİRİŞ ÜCRETLİ TURNUVALAR.
 *
 * ⚠️ 2026-07-30'da bulunan PARA YARATMA açığı: `create` ve `join` havuzu
 * büyütüyordu ama giriş ücretini KİMSEDEN TAHSİL ETMİYORDU. Dosyada tek bir
 * `spendLc` çağrısı yoktu; `entryLC` yalnızca okunuyor, sınırlanıyor ve
 * `t.pool`'a ekleniyordu.
 *
 * Havuz karşılıksız değildi — settle2 onu GERÇEK LC olarak dağıtıyor
 * (routes/settle2.cjs, `lc_wallet_users` üzerinde `$inc: {balance}`).
 *
 * Ölçüldü: entryLC=100 ile 1 kurucu + 7 katılımcı → havuz 800 LC, hiçbir
 * bakiye değişmeden. 8+ katılımcı ödeme tablosu (50/25/15/10) havuzun
 * %100'ünü dağıtır, yani 800 LC yoktan yaratılırdı. Günlük LC hakkı 3-7 LC;
 * yani tek turnuva 100+ günlük gelire denk ve tekrarlanabilirdi.
 *
 * Artık ücret turnuvaya YAZILMADAN ÖNCE tahsil ediliyor; yazma başarısız
 * olursa iade ediliyor (aşağıdaki notlara bak).
 */

const SocialStore = require("../lib/social-store.cjs");
const path = require("path");
const { guvenliYol } = require("../lib/guvenli-dosya.cjs");
const fsp = require("fs").promises;
// Maç kilidi için: durum dosyası Render'da kalıcı değil, depo yetkili kaynak.
const FixturesStore = require("../lib/fixtures-store.cjs");
const DATA_DIR = process.env.SKORLIG_DATA_DIR || path.join(__dirname, "..", "data");
const LIVE_DIR = path.join(DATA_DIR, "live");
const { spendLc, creditLc } = require("../lib/wallet-credit.cjs");

/** Rotalar db'yi geçmiyorsa depoların yaptığı gibi kendimiz çözelim. */
async function dbAl(db) {
  if (db) return db;
  try {
    const { getDb } = require("../lib/mongo.cjs");
    return await getDb();
  } catch {
    return null;
  }
}

/**
 * Giriş ücretini tahsil eder. Bakiye yetmezse THROW eder — çağıran turnuvaya
 * hiçbir şey yazmamalı.
 *
 * ⚠️ `spendLc` koşulu sorgunun içinde tutuyor (`balance: {$gte: tutar}`),
 * yani okunan bir değere dayanmıyor ve bakiyeyi eksiye düşüremez.
 */
async function ucretTahsilEt(db, userId, tutar) {
  const conn = await dbAl(db);
  if (!conn) {
    // Cüzdan yoksa ücret alınamaz. Bedava katılım = para yaratmak, o yüzden
    // sessizce geçmiyoruz.
    const e = new Error("WALLET_UNAVAILABLE");
    throw e;
  }
  const r = await spendLc(conn, userId, tutar, "tournament_entry");
  if (!r?.ok) {
    const e = new Error(r?.reason === "INSUFFICIENT" ? "INSUFFICIENT_LC" : "ENTRY_CHARGE_FAILED");
    e.balance = r?.lc ?? null;
    throw e;
  }
  return conn;
}

/** Turnuvaya yazma başarısız olursa ücreti geri ver. */
async function ucretIadeEt(conn, userId, tutar, neden) {
  try {
    await creditLc(conn, userId, tutar, "tournament_entry_refund", { neden });
  } catch (e) {
    // İade edilemezse KAYBOLMASIN: log'a düşsün, elle telafi edilebilsin.
    console.error(`[tournament] IADE EDILEMEDI ${userId} ${tutar} LC (${neden}):`, e?.message || e);
  }
}

const PAYOUT_TABLE = {
  2: [0.70, 0.30],
  3: [0.70, 0.30],
  4: [0.60, 0.25, 0.15],
  5: [0.60, 0.25, 0.15],
  6: [0.60, 0.25, 0.15],
  7: [0.60, 0.25, 0.15],
};
const PAYOUT_8PLUS = [0.50, 0.25, 0.15, 0.10];

const MIN_ENTRY = 5;
const MAX_ENTRY = 100;
const MAX_MATCHES = 6;
const MIN_MATCHES = 2;

function genCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// Turnuvalar Mongo birincil — bkz. lib/social-store.cjs. Dosyada tutulurken
// Render'da her deploy siliyordu: giriş ücreti ödenmiş, havuzu birikmiş
// turnuvalar yok oluyordu ve LC hiçbir yere iade edilmiyordu.
// Sarmal ({tournaments:[...]}) çağıranlar için korunuyor.
async function loadAll() {
  return { tournaments: await SocialStore.loadTournaments() };
}

async function saveAll(data) {
  await SocialStore.saveTournaments(data?.tournaments || [], null);
}

async function create({ creatorId, name, entryLC, fixtureIds, fixtures, db = null }) {
  const entry = Math.max(MIN_ENTRY, Math.min(MAX_ENTRY, Number(entryLC) || 10));
  const matchIds = (fixtureIds || []).slice(0, MAX_MATCHES);
  if (matchIds.length < MIN_MATCHES) throw new Error("MIN_2_MATCHES");

  // ⚠️ Kurucu da KATILIMCI olarak ekleniyor ve havuz `entry` ile başlıyor —
  // yani onun da ücreti alınmalı. Doğrulamalar bittikten SONRA tahsil et ki
  // "MIN_2_MATCHES" hatasında boşuna para gitmesin.
  const conn = await ucretTahsilEt(db, creatorId, entry);

  const data = await loadAll();
  const code = genCode();
  const now = new Date().toISOString();

  const t = {
    id: "t_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6),
    code,
    name: String(name || "Turnuva").slice(0, 40),
    creatorId,
    entryLC: entry,
    fixtureIds: matchIds,
    fixtures: (fixtures || []).slice(0, MAX_MATCHES),
    participants: [{
      userId: creatorId,
      joinedAt: now,
      predictions: {},
      totalScore: 0,
    }],
    pool: entry,
    status: "open",
    createdAt: now,
    settledAt: null,
    payouts: [],
  };

  data.tournaments.push(t);
  try {
    await saveAll(data);
  } catch (e) {
    // Ücret alındı ama turnuva yazılamadı — parayı kullanıcıda bırakma.
    await ucretIadeEt(conn, creatorId, entry, "create_save_failed");
    throw e;
  }
  return t;
}

async function join(code, userId, db = null) {
  const data = await loadAll();
  const t = data.tournaments.find(x => x.code === code.toUpperCase());
  if (!t) throw new Error("NOT_FOUND");
  if (t.status !== "open") throw new Error("CLOSED");
  if (t.participants.some(p => p.userId.toLowerCase() === userId.toLowerCase())) {
    throw new Error("ALREADY_JOINED");
  }

  // ⚠️ Ucuz kontroller (bulundu mu / açık mı / zaten katıldı mı) BİTTİKTEN
  // sonra tahsil et — reddedilecek bir katılım için para alınmasın.
  const conn = await ucretTahsilEt(db, userId, t.entryLC);

  t.participants.push({
    userId,
    joinedAt: new Date().toISOString(),
    predictions: {},
    totalScore: 0,
  });
  t.pool += t.entryLC;

  try {
    await saveAll(data);
  } catch (e) {
    await ucretIadeEt(conn, userId, t.entryLC, "join_save_failed");
    throw e;
  }
  return t;
}

/**
 * ⚠️ MAÇ KİLİDİ EKLENDİ. Önceki hâli YALNIZCA `status === "settled"` bakıyordu:
 * maçın başlayıp başlamadığına HİÇ bakmıyordu. Yani oynanmış, sonucu bilinen
 * bir maça turnuva içinde tahmin girilebiliyordu — turnuva kapanana kadar.
 *
 * Ana oyunda bu kilit iki kez sertleştirildi (routes/pred.cjs computePredLock,
 * routes/duels.cjs isFixtureLocked) ama turnuva o işten habersizdi.
 *
 * Aynı kapalı-başarısızlık ilkesi: durum dosyası yoksa FİKSTÜR DEPOSUNA
 * bakılır; maç orada da yoksa KİLİTLİ sayılır.
 */
async function macKilitliMi(fixtureId, db) {
  const fid = String(fixtureId || "").trim();
  if (!fid) return { kilitli: true, sebep: "FIXTURE_ID_REQUIRED" };

  let st = null;
  try {
    st = JSON.parse(await fsp.readFile(guvenliYol(LIVE_DIR, fid, ".json"), "utf8"));
  } catch { st = null; }

  if (!st || typeof st !== "object") {
    try {
      const hepsi = await FixturesStore.loadAll(db);
      const fx = (hepsi || []).find((f) => String(f?.fixtureId || "") === fid);
      if (!fx) return { kilitli: true, sebep: "FIXTURE_NOT_FOUND" };
      st = { status: fx.status || "NS", kickoffISO: fx.kickoffISO || fx.kickoff || null };
    } catch (e) {
      console.error("[tournament] fikstur dogrulanamadi, kilitli sayiliyor:", e?.message || e);
      return { kilitli: true, sebep: "FIXTURE_CHECK_FAILED" };
    }
  }

  const durum = String(st.status || "").toUpperCase();
  if (durum && durum !== "NS") return { kilitli: true, sebep: "MATCH_ALREADY_STARTED" };

  const ko = st.kickoffISO || st.kickoff || null;
  if (!ko) return { kilitli: true, sebep: "NO_KICKOFF" };
  const koMs = new Date(String(ko)).getTime();
  if (!Number.isFinite(koMs)) return { kilitli: true, sebep: "BAD_KICKOFF" };
  if (Date.now() >= koMs) return { kilitli: true, sebep: "MATCH_ALREADY_STARTED" };

  return { kilitli: false, sebep: null };
}

async function predict(code, userId, fixtureId, outcome, db = null) {
  const data = await loadAll();
  const t = data.tournaments.find(x => x.code === code.toUpperCase());
  if (!t) throw new Error("NOT_FOUND");
  if (t.status === "settled") throw new Error("SETTLED");

  const p = t.participants.find(x => x.userId.toLowerCase() === userId.toLowerCase());
  if (!p) throw new Error("NOT_JOINED");
  if (!t.fixtureIds.includes(fixtureId)) throw new Error("INVALID_FIXTURE");

  // ⚠️ Maç başladıysa tahmin alınmaz — bkz. macKilitliMi notu.
  const kilit = await macKilitliMi(fixtureId, db);
  if (kilit.kilitli) throw new Error(kilit.sebep);

  p.predictions[fixtureId] = { outcome, at: new Date().toISOString() };
  await saveAll(data);
  return { ok: true };
}

/**
 * ⚠️ ÖDEME YOLU BAĞLANDI. Önceki hâli `payouts` dizisini HESAPLAYIP YAZIYOR
 * ama cüzdana TEK SATIR yazmıyordu. Gerçek ödemeyi settle2 yapıyor, o da
 * yalnızca `status === "open"` turnuvaları tarıyor — yani bu fonksiyon
 * çağrıldığı anda turnuva "settled" oluyor, settle2 bir daha bakmıyordu ve
 * TOPLANAN GİRİŞ ÜCRETLERİ KİMSEYE ÖDENMİYORDU. Giriş ücreti gerçekten
 * tahsil edildiği için bu doğrudan para yakıyordu.
 *
 * ⚠️ MÜHÜR settle2 İLE AYNI (`claimTournamentSettle`): iki ödeme yolu var ve
 * hangisi önce mührü alırsa diğeri atlar. Ayrı mühür kullanmak çift ödeme
 * demek olurdu.
 */
async function settle(code, results, db = null) {
  const { calcOdds } = require("./odds-engine.cjs");
  const data = await loadAll();
  const t = data.tournaments.find(x => x.code === code.toUpperCase());
  if (!t) throw new Error("NOT_FOUND");
  if (t.status === "settled") throw new Error("ALREADY_SETTLED");

  for (const p of t.participants) {
    let score = 0;
    for (const fid of t.fixtureIds) {
      const pred = p.predictions[fid];
      const result = results[fid];
      if (!pred || !result) continue;

      const fx = t.fixtures.find(f => f.fixtureId === fid);
      const odds = fx ? calcOdds(fx.home, fx.away) : { home: 2, draw: 3, away: 2 };
      const outcomeOdd = pred.outcome === "H" ? odds.home : pred.outcome === "D" ? odds.draw : odds.away;

      if (pred.outcome === result.outcome) {
        score += Math.round(10 * outcomeOdd);
      }
    }
    p.totalScore = score;
  }

  const sorted = [...t.participants].sort((a, b) => b.totalScore - a.totalScore);
  const n = sorted.length;
  const table = n >= 8 ? PAYOUT_8PLUS : (PAYOUT_TABLE[n] || PAYOUT_TABLE[2]);

  t.payouts = table.map((pct, i) => {
    const user = sorted[i];
    if (!user) return null;
    return {
      rank: i + 1,
      userId: user.userId,
      score: user.totalScore,
      lcWon: Math.round(t.pool * pct),
      pct: Math.round(pct * 100),
    };
  }).filter(Boolean);

  const nowISO = new Date().toISOString();

  // ⚠️ MÜHÜR ÖDEMEDEN ÖNCE, ATOMİK. Koşul (`status:"open"`) yazmanın içinde;
  // yalnızca tek çağrı true alır. settle2 de aynı mührü kullanıyor.
  const conn = await dbAl(db);
  const bizimki = await SocialStore.claimTournamentSettle(t.id, nowISO, conn);
  if (!bizimki) throw new Error("ALREADY_SETTLED");

  t.status = "settled";
  t.settledAt = nowISO;
  await saveAll(data);

  // Mühür alındı → ödemeyi BİZ yapmalıyız; settle2 artık bu turnuvayı görmez.
  const odenemeyen = [];
  for (const odeme of t.payouts) {
    const tutar = Number(odeme?.lcWon || 0);
    if (!odeme?.userId || tutar <= 0) continue;
    const ok = await creditLc(conn, odeme.userId, tutar, "tournament_payout", {
      tournamentId: t.id, tournamentCode: t.code, rank: odeme.rank,
    });
    if (!ok) odenemeyen.push({ userIdLower: String(odeme.userId).toLowerCase(), tutar });
  }
  if (odenemeyen.length) {
    // Mühür atıldı, tekrar denenmez → kalıcı iz bırak (bkz. lib/wallet-credit).
    console.error(`[tournament] ⛔ ODEME YAPILAMADI: ${t.code} — ${odenemeyen.length} kisi`);
    const { kayipOdulKaydet } = require("../lib/wallet-credit.cjs");
    await kayipOdulKaydet(conn, {
      kaynak: "tournament_payout", tournamentCode: t.code,
      odemeler: odenemeyen, beklenen: t.payouts.length, eksik: odenemeyen.length,
    });
  }

  return t;
}

async function getByCode(code) {
  const data = await loadAll();
  return data.tournaments.find(x => x.code === code.toUpperCase()) || null;
}

async function listByUser(userId) {
  const data = await loadAll();
  const uid = userId.toLowerCase();
  return data.tournaments.filter(t =>
    t.creatorId.toLowerCase() === uid ||
    t.participants.some(p => p.userId.toLowerCase() === uid)
  );
}

module.exports = { create, join, predict, settle, getByCode, listByUser, MIN_ENTRY, MAX_ENTRY, MAX_MATCHES };
