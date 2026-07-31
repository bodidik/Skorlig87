"use strict";

const express = require("express");
const router = express.Router();
const path = require("path");
const { fiksturKilidi } = require("../lib/fikstur-kilit.cjs");
const MacDenge = require("../lib/mac-denge.cjs");
const { duelloyaUygunMu } = MacDenge;
const fsp = require("fs").promises;
const { withFileLock, writeJsonAtomic } = require("../lib/fileLock.cjs");
const { verifyToken } = require("../middleware/verifyToken.cjs");
const { kimlikVeyaHata } = require("../lib/kimlik-kontrol.cjs");

// settle2 ile aynı env: düello sonuçlandırma settle akışının içinden çağrılır,
// testlerde izole veri dizinine yönlendirilebilmesi gerekir.
const DATA_DIR = process.env.SKORLIG_DATA_DIR || path.join(__dirname, "..", "data");
const DUELS_FILE = path.join(DATA_DIR, "duels.json");
const SocialStore = require("../lib/social-store.cjs");
// Fikstur dogrulamasi icin (bkz. isFixtureLocked): durum dosyasi Render'da
// kalici degil, deposu yetkili kaynak.
const premium = require("../lib/premium.cjs");
const WALLET_FILE = path.join(DATA_DIR, "lc-wallet.json");
const PREDS_FILE = path.join(DATA_DIR, "preds.json");

const { calcOdds } = require("../services/odds-engine.cjs");

const MIN_STAKE = 1;
const MAX_STAKE = 12;
const HOUSE_CUT_PCT = 0.05;

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function readJson(file, fb) {
  try { return JSON.parse(await fsp.readFile(file, "utf8")); }
  catch { return fb; }
}

/**
 * Düellolar. Mongo varsa YETKİLİ KAYNAK ODUR.
 *
 * ⚠️ NEDEN (para kaybı, sessiz): Eskiden yalnızca dosyadan okunuyordu ve Mongo
 * salt yazma aynasıydı. Render'da kalıcı disk YOK — `data/duels.json` her
 * deploy'da siliniyor. Akış şuydu:
 *
 *   kullanıcı LC yatırır (deductLc) → düello dosyaya yazılır → deploy →
 *   dosya silinir → düello yok, LC de yok
 *
 * Hata üretilmiyordu; ne kullanıcı ne biz fark ediyorduk. Bugün ~10 deploy
 * yapıldı, yani bu pencere sık açılıyor.
 *
 * Mongo yoksa dosya tek kaynaktır (yerel geliştirme) — davranış korunur.
 */
// Düellolar Mongo birincil, dosya ayna — bkz. lib/social-store.cjs.
//
// ⚠️ ÖNCEKİ HÂL YARIM TAŞIMAYDI: loadDuels Mongo'dan okuyor, saveDuels
// YALNIZCA dosyaya yazıyordu. Mongo'da kayıt varken yeni kurulan düello
// görünmez oluyordu — oyuncu bahsini yatırıp düellosunu kaybediyordu.
// Ayrıca Mongo boş dönünce dosyaya da düşülmüyordu (docs.length kontrolü
// yoktu), yani boş koleksiyon "hiç düello yok" demek oluyordu.
async function loadDuels(db) {
  return SocialStore.loadDuels(db || null);
}

async function saveDuels(list, db) {
  await SocialStore.saveDuels(list, db || null);
}

function genId() {
  return "duel_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

/**
 * Ateşle-unut bildirim. Düello akışını ASLA bloklamaz veya bozmaz:
 * push servisi çökse/yavaşlasa bile LC işlemi ve yanıt etkilenmez.
 */
function notify(userIds, payload) {
  try {
    const ids = (Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean);
    if (!ids.length) return;
    require("../services/push.cjs")
      .sendToUsers(ids, { type: "duel", ...payload })
      .catch((e) => console.warn("[duels] bildirim hatası:", e.message));
  } catch (e) {
    console.warn("[duels] bildirim atlandı:", e.message);
  }
}

function duelMatchLabel(d) {
  return d.home && d.away ? `${d.home} – ${d.away}` : "maç";
}

function getDb(req) {
  return req?.app?.locals?.db || null;
}

// 🔒 Kickoff kilidi: maç başladıysa düello kurulamaz / kabul edilemez.
// (aksi halde skoru görüp bahse girmek mümkün olur)
const DUEL_LOCK_BEFORE_MIN = 10;

/**
 * ⚠️ ARTIK KAPALI BAŞARISIZLIK. Önceki hâli ÜÇ yerde açık bırakıyordu:
 * durum dosyası yoksa, başlama saati yoksa, başlama saati bozuksa → "kilitli
 * değil". Yani bilinmeyen bir maç sonsuza kadar bahse açıktı.
 *
 * Bu kuramsal değildi: `data/live/*.json` Render'da KALICI DEĞİL, her deploy
 * siliniyor. Deploy sonrası geçmiş maçların durum dosyası yok, yani hepsi
 * "kilitli değil" görünüyordu. Üstelik `/duels/create` maç bilgisini
 * (home/away/kickoffISO) İSTEMCİ GÖVDESİNDEN alıyor — yani sonucu bilinen bir
 * maç için düello açıp habersiz birine kabul ettirmek mümkündü.
 *
 * Artık durum dosyası yoksa FİKSTÜR DEPOSUNA bakılıyor (Mongo birincil,
 * deploy'dan etkilenmez) ve maç orada da yoksa KİLİTLİ sayılıyor.
 */
/**
 * Duello icin fikstur kilidi.
 *
 * ⚠️ GOVDE lib/fikstur-kilit.cjs'E TASINDI. Ayni mantik duelloda,
 * tahminde ve kuponda ayri ayri yazilmisti; HAVUZDA ISE HIC YOKTU ve oyuncu
 * baslamis maca bahis koyabiliyordu. Kopyalanan savunma, kopyalanmayan yerde
 * yok demektir.
 *
 * ⚠️ SEBEP KODU KORUNUYOR: istemci `DUEL_LOCKED_BEFORE_KICKOFF` kodunu
 * metne cevirmek icin kullaniyor (mobile/lib/hataMesaji.ts). Ortak yardimci
 * genel kodu donuyor, burada duelloya ozel koda geri cevriliyor.
 */
async function isFixtureLocked(fixtureId, db = null) {
  const s = await fiksturKilidi(fixtureId, { oncekiDk: DUEL_LOCK_BEFORE_MIN, db });
  if (s.locked && s.reason === "LOCKED_BEFORE_KICKOFF") {
    return { ...s, reason: "DUEL_LOCKED_BEFORE_KICKOFF" };
  }
  return s;
}

// ─── File-based LC helpers ────────────────────────────────────────────────────

async function loadWallet() {
  const fb = { users: [], ledger: [], updatedAt: null };
  const w = (await readJson(WALLET_FILE, fb)) || fb;
  if (!Array.isArray(w.users)) w.users = [];
  if (!Array.isArray(w.ledger)) w.ledger = [];
  return w;
}

async function saveWallet(state) {
  state.updatedAt = new Date().toISOString();
  await writeJsonAtomic(WALLET_FILE, state);
}

function walletUser(state, uid) {
  const u = uid.toLowerCase();
  return state.users.find(x => String(x.userId || "").toLowerCase() === u) || null;
}

function addLedger(state, { userId, kind, amount, reason, duelId }) {
  state.ledger.push({
    id: "tx_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8),
    userId, kind, amount,
    reason: reason || null,
    duelId: duelId || null,
    createdAt: new Date().toISOString(),
  });
}

async function deductLcFile(uid, amount, reason, duelId) {
  return withFileLock(WALLET_FILE, async () => {
    const state = await loadWallet();
    const u = walletUser(state, uid);
    if (!u) return { ok: false, error: "WALLET_NOT_FOUND" };
    const bal = Number(u.balance || 0);
    if (bal < amount) return { ok: false, error: "LC_NOT_ENOUGH", lc: bal, needed: amount };
    u.balance = bal - amount;
    u.totalSpent = (u.totalSpent || 0) + amount;
    u.updatedAt = new Date().toISOString();
    addLedger(state, { userId: uid, kind: "spend", amount: -amount, reason, duelId });
    await saveWallet(state);
    return { ok: true, lc: u.balance };
  });
}

async function creditLcFile(uid, amount, reason, duelId) {
  return withFileLock(WALLET_FILE, async () => {
    const state = await loadWallet();
    let u = walletUser(state, uid);
    if (!u) {
      const now = new Date().toISOString();
      u = { userId: uid, balance: 0, createdAt: now, updatedAt: now, totalEarned: 0, totalSpent: 0, lastDailyAt: null };
      state.users.push(u);
    }
    u.balance = Number(u.balance || 0) + amount;
    u.totalEarned = (u.totalEarned || 0) + amount;
    u.updatedAt = new Date().toISOString();
    addLedger(state, { userId: uid, kind: "earn", amount, reason, duelId });
    await saveWallet(state);
    return { ok: true, lc: u.balance };
  });
}

// ─── Mongo LC helpers ─────────────────────────────────────────────────────────

async function deductLcMongo(db, uid, amount, reason, duelId) {
  const col = db.collection("lc_wallet_users");
  const ledger = db.collection("lc_wallet_ledger");
  const uidL = uid.toLowerCase();
  const user = await col.findOne({ userIdLower: uidL });
  if (!user) return { ok: false, error: "WALLET_NOT_FOUND" };
  const bal = Number(user.balance || 0);
  if (bal < amount) return { ok: false, error: "LC_NOT_ENOUGH", lc: bal, needed: amount };
  const r = await col.updateOne(
    { userIdLower: uidL, balance: bal },
    { $inc: { balance: -amount, totalSpent: amount }, $set: { updatedAt: new Date().toISOString() } }
  );
  if (!r.matchedCount) return { ok: false, error: "CONCURRENT_WRITE" };
  await ledger.insertOne({
    id: "tx_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8),
    userId: uid, userIdLower: uidL, kind: "spend", amount: -amount,
    reason: reason || null, duelId: duelId || null, createdAt: new Date().toISOString(),
  });
  return { ok: true, lc: bal - amount };
}

async function creditLcMongo(db, uid, amount, reason, duelId) {
  const col = db.collection("lc_wallet_users");
  const ledger = db.collection("lc_wallet_ledger");
  const uidL = uid.toLowerCase();
  await col.updateOne(
    { userIdLower: uidL },
    { $inc: { balance: amount, totalEarned: amount }, $set: { updatedAt: new Date().toISOString() } },
    { upsert: true }
  );
  await ledger.insertOne({
    id: "tx_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8),
    userId: uid, userIdLower: uidL, kind: "earn", amount,
    reason: reason || null, duelId: duelId || null, createdAt: new Date().toISOString(),
  });
  return { ok: true };
}

async function deductLc(db, uid, amount, reason, duelId) {
  return db ? deductLcMongo(db, uid, amount, reason, duelId) : deductLcFile(uid, amount, reason, duelId);
}

async function creditLc(db, uid, amount, reason, duelId) {
  return db ? creditLcMongo(db, uid, amount, reason, duelId) : creditLcFile(uid, amount, reason, duelId);
}

/**
 * TEK BİR ÖDEMEYİ YALITARAK YAPAR; başarısızsa `odenemeyen`e yazar.
 *
 * ⚠️ İKİ AYRI HATA VARDI, İKİSİ DE PARA.
 *
 * 1) Ödemeler `claimDuelSettle` MÜHRÜNDEN SONRA yapılıyor (doğru sıra: çifte
 *    ödeme olmasın). Ama dönüş değeri okunmuyor ve tüm blok tek bir
 *    `catch { console.error }` ile sarılıydı. Mongo bir an tökezlerse kazanan
 *    ÖDENMEZ, düello kalıcı olarak "settled" kalır, tek iz Render'da akıp
 *    giden bir log satırıdır. Diğer dokuz ödeme noktası bu durumu
 *    `failed_awards`e yazıyor ve `GET /api/health` onu sayıyor — düello,
 *    uygulamanın amiral para modu, o sayaçta HİÇ görünmüyordu.
 *
 * 2) BERABERLİKTE HATA ZİNCİRLEME KESİYORDU: kurucunun iadesi patlarsa
 *    `await` fırlıyor, karşı tarafın iadesi HİÇ denenmiyordu. Tek arıza iki
 *    kişinin parasını götürüyordu. Artık her ödeme kendi başına yalıtık.
 */
async function ode(db, uid, tutar, sebep, duelId, odenemeyen) {
  const miktar = Number(tutar || 0);
  if (!uid || !(miktar > 0)) return;
  try {
    const r = await creditLc(db, uid, miktar, sebep, duelId);
    if (r && r.ok === false) throw new Error(r.error || "CREDIT_FAILED");
  } catch (e) {
    console.error(`[duels] ⛔ ODEME YAPILAMADI ${sebep} ${uid} ${miktar} LC:`, e?.message || e);
    odenemeyen.push({ userIdLower: String(uid).toLowerCase(), tutar: miktar, sebep });
  }
}

/** Ödenemeyen düello parasını kalıcı ize yaz (bkz. lib/wallet-credit.cjs). */
async function duelloBorcKaydet(db, { kaynak, duelId, fixtureId, beklenen }, odenemeyen) {
  const { kayipOdulKaydet } = require("../lib/wallet-credit.cjs");
  await kayipOdulKaydet(db, {
    kaynak,
    duelId: duelId || null,
    fixtureId: fixtureId || null,
    odemeler: odenemeyen,
    beklenen,
    eksik: odenemeyen.length,
  });
}

// ─── Exported: settle duels for a fixture (called from settle2.cjs) ──────────
// scoresMap: { [userId]: points }
// Düello puanı = kazanan tahminin decimal odds'ı (bilyoner tarzı)
// Örnek: Barcelona (1.05) doğru → 1.05p · Inter Turku (8.0) doğru → 8.0p

/**
 * @param {string} fixtureId
 * @param {Record<string,number>} scoresMap  { userId: toplam maç puanı }
 * @param {*} db
 * @param {"H"|"D"|"A"|null} actualOutcome  gerçek maç sonucu (settle2'den)
 *
 * DİKKAT: actualOutcome ZORUNLUDUR. Bir dönem "scoresMap puanı > 0 ise tahmin
 * doğrudur" varsayımı kullanılıyordu — bu HATALIYDI: scoresMap toplam maç
 * puanıdır (ilk gol, kırmızı, penaltı dahil). Sonucu YANLIŞ bilen ama yan
 * kalemleri tutturan oyuncunun puanı pozitif çıkıyor ve kod ona sonucu doğru
 * bilmiş gibi tam odds veriyordu.
 */
async function settleDuelsForFixture(fixtureId, scoresMap, db, actualOutcome = null) {
  const fid = String(fixtureId || "").trim();
  if (!fid || !scoresMap) return { settled: 0 };

  const actual = actualOutcome ? String(actualOutcome).toUpperCase() : null;
  if (!actual) {
    console.warn(`[duels] ${fid}: actualOutcome verilmedi — düello puanı scoreFixture toplamına düşüyor`);
  }

  // Her duelistin bu maçtaki tahmini (odds puanı için outcome gerekli).
  //
  // ⚠️ MONGO YOLU ŞART — iki nedenle:
  //  1) MALİYET: dosya yolu TÜM preds.json'ı okuyup belleğe alıyordu. Bugün
  //     17 MB; tek bir settle'ın en pahalı I/O'su buydu (diğer her şeyin
  //     toplamından büyük) ve kullanıcı sayısıyla büyüyor.
  //  2) MIGRATION TUZAĞI: SKORLIG_PREDS_FILE_MIRROR=0 yapıldığında preds.json
  //     artık YAZILMAZ. Yalnızca dosyayı okusaydık düellolar donmuş veriyle
  //     sonuçlanır, tahmin bulunamadığı için sessizce odds tabanlı puanlama
  //     yerine scoreFixture toplamına düşerdi — çökme yok, sessiz yanlış sonuç.
  //
  // settle2.loadFixturePreds ile AYNI kaynak kullanılır (tek doğruluk).
  let fixPreds = [];
  try {
    if (db) {
      fixPreds = await db.collection("predictions").find({ fixtureId: fid }).toArray();
    } else {
      const raw = JSON.parse(await fsp.readFile(PREDS_FILE, "utf8"));
      const predsAll = Array.isArray(raw) ? raw : raw?.items || [];
      fixPreds = predsAll.filter(p => String(p.fixtureId) === fid);
    }
  } catch (e) {
    console.warn(`[duels] ${fid}: tahminler okunamadi:`, e.message);
  }

  // Mükerrer kayıt olursa EN SON tahmin geçerli (settle2 ile aynı kural)
  function getUserPred(uid) {
    if (!uid) return null;
    const u = String(uid).toLowerCase();
    const mine = fixPreds.filter(p => String(p.userId || p.user || "").toLowerCase() === u);
    if (!mine.length) return null;
    return mine.reduce((best, cur) => {
      const tb = new Date(best.at || best.createdAt || 0).getTime() || 0;
      const tc = new Date(cur.at || cur.createdAt || 0).getTime() || 0;
      return tc >= tb ? cur : best;
    });
  }

  const settled = [];

  await withFileLock(DUELS_FILE, async () => {
    const list = await loadDuels(db);
    const nowISO = new Date().toISOString();
    let changed = false;

    for (const duel of list) {
      if (duel.fixtureId !== fid || duel.status !== "active") continue;

      // Maç odds'ı (oluşturulurken home/away kaydedildi)
      const odds = duel.home && duel.away
        ? calcOdds(duel.home, duel.away)
        : { home: 2.0, draw: 3.2, away: 2.0 };

      // Düello puanı = tahmin edilen sonucun odds'ı — SADECE sonuç doğruysa.
      // Doğruluk gerçek sonuçla karşılaştırılır (scoresMap puanıyla DEĞİL;
      // o toplam puandır, yan kalemlerden pozitif olabilir).
      function getOddsPoints(uid) {
        if (!uid) return 0;
        const pred = getUserPred(uid);
        const oc = pred?.outcome ? String(pred.outcome).toUpperCase() : null;

        // Sonuç tahmini yok VEYA gerçek sonuç bilinmiyor → scoreFixture toplamı
        if (!oc || !actual) {
          const k = Object.keys(scoresMap).find(
            k2 => k2.toLowerCase() === String(uid).toLowerCase()
          );
          return k != null ? Number(scoresMap[k] || 0) : 0;
        }

        if (oc !== actual) return 0; // sonucu yanlış bildi
        if (oc === "H") return odds.home;
        if (oc === "D") return odds.draw;
        return odds.away;
      }

      const cp = getOddsPoints(duel.creatorId);
      const ap = getOddsPoints(duel.acceptorId);

      const alanlar = {
        creatorPoints: Math.round(cp * 100) / 100,
        acceptorPoints: Math.round(ap * 100) / 100,
        settledAt: nowISO,
        winnerId: cp > ap ? duel.creatorId : ap > cp ? duel.acceptorId : null,
      };

      // ⚠️ PARA KORUMASI — MÜHÜR ÖDEMEDEN ÖNCE, ATOMİK.
      // Buradaki `withFileLock` yalnızca TEK SÜRECİ korur; depo Mongo'ya
      // taşındığı için çok instance'lı ortamda hiçbir şey yapmıyordu. Ödeme
      // de kilidin DIŞINDA, Mongo'ya durum yazımı ödemeden SONRA idi: ikinci
      // bir tarama düelloyu hâlâ "accepted" görüp ödülü TEKRAR yatırabilirdi.
      const bizimki = await SocialStore.claimDuelSettle(duel.id, alanlar, db);
      if (!bizimki) continue;

      Object.assign(duel, alanlar, { status: "settled" });
      settled.push({ ...duel });
      changed = true;
    }

    if (changed) await saveDuels(list, db);
  });

  // Credit winners outside lock (different file = safe)
  for (const duel of settled) {
    const odenemeyen = [];
    try {
      if (duel.winnerId) {
        const prize = duel.winAmount ?? duel.pot;
        await ode(db, duel.winnerId, prize, "duel_win", duel.id, odenemeyen);
      } else {
        // Tie: full refund, no house cut
        await ode(db, duel.creatorId, duel.stake, "duel_tie_refund", duel.id, odenemeyen);
        await ode(db, duel.acceptorId, duel.stake, "duel_tie_refund", duel.id, odenemeyen);
      }
      if (odenemeyen.length) {
        await duelloBorcKaydet(db, {
          kaynak: duel.winnerId ? "duel_win" : "duel_tie_refund",
          duelId: duel.id,
          fixtureId: duel.fixtureId,
          beklenen: duel.winnerId ? 1 : 2,
        }, odenemeyen);
      }
      if (db) {
        try { await db.collection("duels").updateOne({ id: duel.id }, { $set: duel }); } catch {}
      }

      // Sonucu iki tarafa da bildir — kaybeden de ne olduğunu görmeli.
      const label = duelMatchLabel(duel);
      const cp = duel.creatorPoints ?? 0;
      const ap = duel.acceptorPoints ?? 0;
      const data = { screen: "duel", duelId: duel.id, fixtureId: duel.fixtureId };

      if (!duel.winnerId) {
        const body = `${label} — ${cp} / ${ap}. Berabere, ${duel.stake} LC iade edildi.`;
        notify([duel.creatorId, duel.acceptorId], { title: "🤝 Düello berabere", body, data });
      } else {
        const winnerIsCreator = duel.winnerId === duel.creatorId;
        const loserId  = winnerIsCreator ? duel.acceptorId : duel.creatorId;
        const winPts   = winnerIsCreator ? cp : ap;
        const losePts  = winnerIsCreator ? ap : cp;

        notify(duel.winnerId, {
          title: "🏆 Düelloyu kazandın",
          body: `${label} — ${winPts} / ${losePts}. ${duel.winAmount ?? duel.pot} LC hesabına geçti.`,
          data,
        });
        notify(loserId, {
          title: "⚔️ Düelloyu kaybettin",
          body: `${label} — ${losePts} / ${winPts}. Bir sonrakinde revanş al.`,
          data,
        });
      }
    } catch (e) {
      console.error("[duels] settle credit failed for", duel.id, e);
    }
  }

  return { settled: settled.length, items: settled };
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// POST /api/duels/create
router.post("/duels/create", verifyToken, async (req, res) => {
  try {
    const db = getDb(req);
    const { fixtureId, stake, challengedId, creatorName, home, away, league, kickoffISO } = req.body || {};
    const creatorId = req.uid;
    const fx = String(fixtureId || "").trim();
    if (!fx) return res.status(400).json({ ok: false, error: "FIXTURE_ID_REQUIRED" });

    const s = Math.floor(Number(stake));
    if (!Number.isFinite(s) || s < MIN_STAKE || s > MAX_STAKE) {
      return res.status(400).json({ ok: false, error: "INVALID_STAKE", min: MIN_STAKE, max: MAX_STAKE });
    }

    const targetId = challengedId ? String(challengedId).trim() : null;
    if (targetId && targetId.toLowerCase() === creatorId.toLowerCase()) {
      return res.status(400).json({ ok: false, error: "CANNOT_CHALLENGE_YOURSELF" });
    }

    // 🔒 Maç başladıysa düello kurulamaz
    const lock = await isFixtureLocked(fx, db);
    if (lock.locked) {
      return res.status(409).json({ ok: false, error: lock.reason, fixtureId: fx, lockAtISO: lock.lockAtISO || null });
    }

    /* ⚠️ TEK TARAFLI MAÇA DÜELLO YOK.
     *
     * "Real Madrid – Erokspor" gibi maçlarda sonuç zaten büyük ölçüde belli.
     * Sürprizi ödüllendirme işini TEK MAÇ TAHMİNİ yapıyor (düşük ihtimalli
     * sonuç daha çok LC getiriyor); aynı maça düello açmak yeni bir oyun
     * kurmuyor, yalnızca kayıt/eşleşme/sonuçlandırma yükü ekliyor.
     *
     * ⚠️ LC DÜŞÜLMEDEN ÖNCE: aşağıda `deductLc` var. Kapıyı ondan sonra
     * koysaydık reddedilen düello yine de para götürürdü. bkz. lib/mac-denge.cjs */
    const denge = await duelloyaUygunMu(fx, db);
    if (!denge.uygun) {
      return res.status(400).json({
        ok: false, error: "MATCH_TOO_LOPSIDED",
        fixtureId: fx, olasilik: denge.olasilik, esik: MacDenge.ESIK,
      });
    }

    // 🔒 Açık düello sınırı — premium ayrıcalığı (erişim/kapasite grubu).
    //
    // LC AKIŞINA DOKUNMAZ: bahis yine tam ödeniyor, kesinti aynı. Premium'un
    // değeri "daha çok LC" değil "daha çok oynayabilme" olsun diye buradan
    // veriliyor. bkz. lib/premium.cjs — PERKS'in iki grubu.
    const isPrem = await premium.isPremium(creatorId, db);
    const acikSinir = premium.maxOpenDuels(isPrem);
    // Sayim icin TUM duellolari cekmeye gerek yok; countDocuments belge tasimaz.
    const mevcutAcik = await SocialStore.acikDuelloSayisi(creatorId, db);
    if (mevcutAcik >= acikSinir) {
      return res.status(400).json({
        ok: false, error: "TOO_MANY_OPEN_DUELS",
        open: mevcutAcik, limit: acikSinir, isPremium: isPrem,
      });
    }

    // Deduct stake from creator
    const spend = await deductLc(db, creatorId, s, "duel_create", null);
    if (!spend.ok) {
      return res.status(400).json({ ok: false, error: spend.error || "LC_NOT_ENOUGH", lc: spend.lc, needed: s });
    }

    const nowISO = new Date().toISOString();
    const id = genId();
    const pot = s * 2;
    const houseCut = Math.round(pot * HOUSE_CUT_PCT * 10) / 10;
    const winAmount = Math.round((pot - houseCut) * 10) / 10;
    const duel = {
      id, fixtureId: fx, stake: s,
      creatorId, creatorName: String(creatorName || "").trim() || null,
      challengedId: targetId, acceptorId: null, acceptorName: null,
      status: "open",
      home: String(home || "").trim() || null,
      away: String(away || "").trim() || null,
      league: String(league || "").trim() || null,
      kickoffISO: kickoffISO || null,
      creatorPoints: null, acceptorPoints: null, winnerId: null,
      pot, houseCut, winAmount,
      createdAt: nowISO, acceptedAt: null, settledAt: null,
    };

    await withFileLock(DUELS_FILE, async () => {
      const list = await loadDuels(db);
      list.push(duel);
      await saveDuels(list, db);
    });

    if (db) {
      try { await db.collection("duels").insertOne(duel); } catch (e) { console.error("[duels] mongo create:", e); }
    }

    // Hedefi olan düello → meydan okunana haber ver. Açık düelloda alıcı yok.
    if (targetId) {
      notify(targetId, {
        title: "⚔️ Sana meydan okundu",
        body: `${duel.creatorName || "Bir rakip"} ${duelMatchLabel(duel)} maçında ${s} LC'lik düello açtı.`,
        data: { screen: "duel", duelId: id, fixtureId: fx },
      });
    }

    return res.json({ ok: true, duel });
  } catch (e) {
    console.error("[duels] create failed:", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// POST /api/duels/accept
router.post("/duels/accept", verifyToken, async (req, res) => {
  try {
    const db = getDb(req);
    const acceptorId = req.uid;
    const did = String(req.body?.duelId || "").trim();
    const acceptorName = String(req.body?.acceptorName || "").trim() || null;
    if (!did) return res.status(400).json({ ok: false, error: "DUEL_ID_REQUIRED" });

    let result = null;

    await withFileLock(DUELS_FILE, async () => {
      const list = await loadDuels(db);
      const duel = list.find(d => d.id === did);

      if (!duel) { result = { err: "DUEL_NOT_FOUND" }; return; }
      if (duel.status !== "open") { result = { err: "NOT_OPEN" }; return; }
      if (duel.creatorId.toLowerCase() === acceptorId.toLowerCase()) { result = { err: "CANNOT_ACCEPT_OWN" }; return; }
      if (duel.challengedId && duel.challengedId.toLowerCase() !== acceptorId.toLowerCase()) {
        result = { err: "NOT_YOUR_CHALLENGE" }; return;
      }

      // 🔒 Maç başladıysa düello kabul edilemez
      const lock = await isFixtureLocked(duel.fixtureId, db);
      if (lock.locked) { result = { err: lock.reason }; return; }

      // Bahsi burada tahsil ediyoruz; kabulün KENDİSİ kilidin dışında
      // ATOMİK olarak mühürleniyor (aşağıya bak). Tahsilat başarılı olup
      // mühür alınamazsa iade ediliyor.
      const spend = await deductLc(db, acceptorId, duel.stake, "duel_accept", did);
      if (!spend.ok) { result = { err: spend.error || "LC_NOT_ENOUGH", lc: spend.lc, needed: duel.stake }; return; }

      result = { duel: { ...duel }, tahsilEdildi: true };
    });

    if (!result) return res.status(500).json({ ok: false, error: "UNKNOWN" });
    if (result.err === "DUEL_NOT_FOUND") return res.status(404).json({ ok: false, error: result.err });
    if (result.err) return res.status(400).json({ ok: false, error: result.err, lc: result.lc, needed: result.needed });

    /* ⚠️ PARA KORUMASI — KABUL ATOMİK MÜHÜRLE ALINIR.
     *
     * Eskiden: listeyi oku → "open" mu diye BAK → bahsi TAHSİL ET → yaz.
     * `withFileLock` yalnızca tek süreci korur; depo Mongo'ya taşındığı için
     * çok instance'lı ortamda hiçbir şey yapmıyordu. İki eşzamanlı kabul de
     * kontrolü geçiyor, İKİSİNDEN DE bahis alınıyor, son yazan kazanıyordu —
     * biri parasını verip düelloya girememiş oluyordu.
     *
     * Sıra bilinçli: TAHSİLAT ÖNCE, MÜHÜR SONRA. Mühür alınamazsa (başkası
     * kabul etti) para hemen iade edilir. Tersi sırada mühür alınıp tahsilat
     * başarısız olsa düello "aktif" ama ödenmemiş kalırdı.
     */
    const acceptedAt = new Date().toISOString();
    const bizimki = await SocialStore.claimDuelAccept(
      did,
      { acceptorId, acceptorName, acceptedAt },
      db
    );
    if (!bizimki) {
      /* Başkası önce kabul etti — aldığımız bahsi GERİ VER.
       *
       * ⚠️ ESKİ KORUMA ÇALIŞMIYORDU: `if (!iade)` yazıyordu ama buradaki yerel
       * `creditLc` BAŞARIDA DA NESNE (`{ok:true}`) döner, yani koşul hiçbir
       * zaman doğru olamazdı; başarısızlıkta ise dönmüyor, FIRLATIYOR — o da
       * dıştaki catch'e gidip 500 oluyordu. Kısacası güvenlik ağı gibi duran
       * bu blok hiçbir durumda çalışmıyordu. */
      const odenemeyen = [];
      await ode(db, acceptorId, result.duel.stake, "duel_accept_refund", did, odenemeyen);
      if (odenemeyen.length) {
        await duelloBorcKaydet(db, {
          kaynak: "duel_accept_refund",
          duelId: did,
          fixtureId: result.duel.fixtureId,
          beklenen: 1,
        }, odenemeyen);
      }
      return res.status(400).json({ ok: false, error: "NOT_OPEN" });
    }

    Object.assign(result.duel, { acceptorId, acceptorName, acceptedAt, status: "active" });

    // Kuran kişi rakibinin belli olduğunu bilmeli — açık düelloda bunu
    // başka türlü fark etmesi mümkün değil.
    notify(result.duel.creatorId, {
      title: "⚔️ Düellon kabul edildi",
      body: `${acceptorName || "Bir rakip"} ${duelMatchLabel(result.duel)} düellonu kabul etti. Ödül: ${result.duel.winAmount} LC.`,
      data: { screen: "duel", duelId: did, fixtureId: result.duel.fixtureId },
    });

    return res.json({ ok: true, duel: result.duel });
  } catch (e) {
    console.error("[duels] accept failed:", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// POST /api/duels/cancel
router.post("/duels/cancel", verifyToken, async (req, res) => {
  try {
    const db = getDb(req);
    const uid = req.uid;
    const did = String(req.body?.duelId || "").trim();
    if (!did) return res.status(400).json({ ok: false, error: "DUEL_ID_REQUIRED" });

    let result = null;

    await withFileLock(DUELS_FILE, async () => {
      const list = await loadDuels(db);
      const duel = list.find(d => d.id === did);
      if (!duel) { result = { err: "DUEL_NOT_FOUND" }; return; }
      if (duel.status !== "open") { result = { err: "NOT_OPEN" }; return; }
      if (duel.creatorId.toLowerCase() !== uid.toLowerCase()) { result = { err: "NOT_YOUR_DUEL" }; return; }
      // Yalnızca ön kontrol (hızlı ve anlamlı hata mesajı için). Gerçek karar
      // aşağıdaki ATOMİK mühürde veriliyor — bkz. yorum.
      result = { duel: { ...duel } };
    });

    if (!result || result.err === "DUEL_NOT_FOUND") return res.status(404).json({ ok: false, error: "DUEL_NOT_FOUND" });
    if (result.err) return res.status(400).json({ ok: false, error: result.err });

    /* ⚠️ PARA KORUMASI — MÜHÜR İADEDEN ÖNCE, ATOMİK.
     *
     * Eskiden akış şöyleydi: durumu oku → "open" mu diye BAK → kilidi bırak →
     * İADE ET. `withFileLock` yalnızca tek süreci korur ve depo Mongo'ya
     * taşındığı için çok instance'lı ortamda hiçbir şey yapmıyordu. Aradaki
     * pencerede ikinci bir istek de kontrolü geçip İADEYİ TEKRAR alabilirdi:
     * bahis bir kez yatırılmışken iki kez geri ödenirdi.
     *
     * claimDuelCancel koşulu (status:"open" + kurucu eşleşmesi) yazmanın
     * İÇİNDE tutuyor; yalnızca tek çağrı true alır. Aynı düzeltme settle
     * yolunda zaten yapılmıştı, iptal atlanmış.
     */
    const nowISO = new Date().toISOString();
    const bizimki = await SocialStore.claimDuelCancel(did, uid, { settledAt: nowISO }, db);
    if (!bizimki) {
      return res.status(400).json({ ok: false, error: "NOT_OPEN" });
    }

    /* İade mühürden SONRA: bu noktaya yalnızca bir çağrı gelebilir.
     *
     * ⚠️ ESKİ KORUMA ÇALIŞMIYORDU: `if (!iade)` — yerel `creditLc` başarıda
     * `{ok:true}` NESNESİ döndüğü için koşul hiçbir zaman doğru olamaz;
     * başarısızlıkta ise fırlatır ve dıştaki catch 500 üretir. Mühür atılmış
     * olduğu için iade TEKRAR DENENMEZ: kurucunun bahsi buharlaşır. */
    const odenemeyen = [];
    await ode(db, result.duel.creatorId, result.duel.stake, "duel_cancel_refund", did, odenemeyen);
    if (odenemeyen.length) {
      await duelloBorcKaydet(db, {
        kaynak: "duel_cancel_refund",
        duelId: did,
        fixtureId: result.duel.fixtureId,
        beklenen: 1,
      }, odenemeyen);
    }

    const cikti = { ...result.duel, status: "cancelled", settledAt: nowISO };
    return res.json({ ok: true, duel: cikti });
  } catch (e) {
    console.error("[duels] cancel failed:", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// GET /api/duels/open?fixtureId=&userId=
router.get("/duels/open", async (req, res) => {
  try {
    const fx = String(req.query.fixtureId || "").trim();
    const uid = String(req.query.userId || "").trim();
    if (!fx) return res.status(400).json({ ok: false, error: "FIXTURE_ID_REQUIRED" });

    // Hedefli sorgu: yalnizca BU macin ACIK duellolari (ikisi de indeksli).
    const list = await SocialStore.duelsBul({ fixtureId: fx, status: "open" }, getDb(req));
    const uidL = uid.toLowerCase();
    const open = list.filter(d => {
      if (uid && d.creatorId.toLowerCase() === uidL) return false; // own duel
      if (d.challengedId && uid && d.challengedId.toLowerCase() !== uidL) return false; // targeted at another
      return true;
    });

    /* Bu maça düello kurulabilir mi? Ekran açılışında zaten burası
     * çağrılıyor; bayrağı buradan vermek, kullanıcının butona basıp hata
     * almasını önlüyor. Karar yine SUNUCUDA (bkz. lib/mac-denge.cjs) — bu
     * yalnızca arayüz ipucu, kapının kendisi /duels/create içinde. */
    const denge = await duelloyaUygunMu(fx, getDb(req));

    return res.json({
      ok: true, count: open.length, items: open,
      duelloyaUygun: denge.uygun,
      dengeOlasilik: denge.olasilik,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// GET /api/duels/my?userId=&fixtureId=
router.get("/duels/my", verifyToken, async (req, res) => {
  try {
    // ⚠️ SAHIPLİK: kimlik sorgudan geliyordu; denetim yoktu.
    // bkz. lib/kimlik-kontrol.cjs
    const _k = kimlikVeyaHata(req, res, req.query.userId);
    if (!_k) return;
    const uid = _k.uid;
    const fx = String(req.query.fixtureId || "").trim();
    if (!uid) return res.status(400).json({ ok: false, error: "USER_ID_REQUIRED" });

    // Hedefli sorgu: kurucu ya da kabul eden BEN olan duellolar.
    // (Kimlik alanlarinda *Lower yok, esitlik $expr ile — bkz. social-store.)
    const mine = (await SocialStore.duelsKullanici(uid, getDb(req), { fixtureId: fx || null }))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return res.json({ ok: true, count: mine.length, items: mine });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// GET /api/duels/arena?userId= — genel arena: açık duellolar maça göre gruplanmış
router.get("/duels/arena", async (req, res) => {
  try {
    const uid = String(req.query.userId || "").trim();
    const uidL = uid.toLowerCase();
    // Arena yalnizca ACIK duellolari gosteriyor; sonuclanmislari cekmek bosuna.
    const list = await SocialStore.duelsBul({ status: "open" }, getDb(req));

    const matchMap = new Map();
    for (const d of list) {
      if (uid && d.creatorId.toLowerCase() === uidL) continue; // kendi duellonu gösterme
      if (d.challengedId && uid && d.challengedId.toLowerCase() !== uidL) continue; // başkasına özel

      if (!matchMap.has(d.fixtureId)) {
        matchMap.set(d.fixtureId, {
          fixtureId: d.fixtureId,
          home: d.home || "?",
          away: d.away || "?",
          league: d.league || null,
          kickoffISO: d.kickoffISO || null,
          openDuels: [],
          minStake: Infinity,
          maxStake: 0,
        });
      }
      const m = matchMap.get(d.fixtureId);
      m.openDuels.push(d);
      if (d.stake < m.minStake) m.minStake = d.stake;
      if (d.stake > m.maxStake) m.maxStake = d.stake;
    }

    const matches = Array.from(matchMap.values())
      .sort((a, b) => b.openDuels.length - a.openDuels.length)
      .slice(0, 20)
      .map(m => ({
        fixtureId: m.fixtureId,
        home: m.home,
        away: m.away,
        league: m.league,
        kickoffISO: m.kickoffISO,
        openCount: m.openDuels.length,
        minStake: m.minStake === Infinity ? 0 : m.minStake,
        maxStake: m.maxStake,
        preview: m.openDuels.slice(0, 4),
      }));

    return res.json({ ok: true, count: matches.length, matches });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// GET /api/duels/fixture-board?fixtureId= — tüm duellolar (settle sonrası skor karşılaştırması için)
router.get("/duels/fixture-board", async (req, res) => {
  try {
    const fx = String(req.query.fixtureId || "").trim();
    if (!fx) return res.status(400).json({ ok: false, error: "FIXTURE_ID_REQUIRED" });
    const list = await loadDuels(getDb(req));
    const items = list.filter(d => d.fixtureId === fx);
    return res.json({ ok: true, count: items.length, items });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

module.exports = router;
// Kalıcılık testi için: düello kaybı PARA kaybı demek, testsiz bırakılamaz.
module.exports._loadDuels = loadDuels;
module.exports.settleDuelsForFixture = settleDuelsForFixture;
