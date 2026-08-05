"use strict";

const express = require("express");
const { ensurePredIndexes } = require("../lib/preds-index.cjs");
const router = express.Router();
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { guvenliYol } = require("../lib/guvenli-dosya.cjs");

// Dosya kilidi + atomik yazma.
// settle2 cüzdana/kullanıcı dosyasına yazan en ağır modül; pred.cjs ve
// lc-wallet.cjs aynı dosyalara kilitle yazıyor. Buradan kilitsiz yazılırsa
// onların kilidi anlamsızlaşır (lost update → LC kaybı).
// Global kilit sırası: PREDS → WALLET → USERS (döngü yok).
const { withFileLock, writeJsonAtomic } = require("../lib/fileLock.cjs");
const MatchResults = require("../lib/match-results.cjs");
const UsersStore = require("../lib/users-store.cjs");

const BUILD = "settle2-2026-07-16-penalty20pct"; // ✅ ceza %20 orantılı
// NOT: Puanlama/ödül herkes için eşittir — premium'un maç başı avantajı YOK
// (rekabet adaleti). Premium avantajları LC ekonomisinde: bedava giriş +
// aylık kasa (bkz. lib/premium.cjs).

// Veri kökü testlerde değiştirilebilir (SKORLIG_DATA_DIR). Bu modül puan ve
// LC dağıttığı için testlerin gerçek kullanıcı verisine dokunmaması şart;
// izole bir dizine yönlendirilebilmesi bunu sağlar. Üretimde tanımsızdır ve
// davranış birebir aynıdır.
const DATA_DIR = process.env.SKORLIG_DATA_DIR || path.join(__dirname, "..", "data");

/**
 * Cüzdan/kullanıcı dosya aynası.
 *
 * Ödül dağıtımı bugüne kadar lc-wallet.json ve users.json'ı KOŞULSUZ baştan
 * yazıyordu — Mongo kurulu olsa bile. Bu iki dosya kullanıcı sayısıyla
 * doğrusal büyür ve her settle tam dosyayı okuyup yazar:
 *
 *   500k kullanıcıda tek settle ≈ 1.5 GB dosya I/O
 *   JSON.parse + stringify SENKRON → olay döngüsü ~2.2 sn TAMAMEN bloke
 *
 * Mongo yazımları dosyadan bağımsızdır (`$inc` ile göreli artış + upsert),
 * bu yüzden ayna kapatıldığında ödüller eksiksiz Mongo'ya işlenmeye devam eder.
 *
 * Geçiş: bir süre 1'de izleyip Mongo'nun doğru yazdığından emin olduktan sonra 0.
 * Bkz. preds tarafındaki eşdeğeri: SKORLIG_PREDS_FILE_MIRROR
 */
const WALLET_FILE_MIRROR = String(process.env.SKORLIG_WALLET_FILE_MIRROR ?? "1") !== "0";

/**
 * Sezon toplamları (totals.json) dosya aynası.
 *
 * Sezon toplamları artık `season_totals` koleksiyonuna $inc ile yazılıyor —
 * bkz. aşağıdaki blok ve lib/season-totals.cjs. Dosya yazımı read-modify-write
 * olduğu için kullanıcı sayısıyla büyür ve kilit gerektirir; Mongo tarafı
 * göreli çalıştığı için ikisine de ihtiyaç duymaz.
 *
 * Kapatmadan ÖNCE: node scripts/migrate-season-totals.cjs çalıştırılmalı,
 * sonra GET /api/leaderboard → source "mongo_season_totals" dönmeli.
 * ⚠️ MONGODB_URI yoksa bu bayrak YOK SAYILIR (dosya tek kaynaktır).
 */
const TOTALS_FILE_MIRROR = String(process.env.SKORLIG_TOTALS_FILE_MIRROR ?? "1") !== "0";
const LIVE_DIR = path.join(DATA_DIR, "live");
const PREDS_FILE = path.join(DATA_DIR, "preds.json");
const TOTALS_FILE = path.join(DATA_DIR, "totals.json");
const LEADERBOARD_FILE = path.join(DATA_DIR, "leaderboard.json");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const WALLET_FILE = path.join(DATA_DIR, "lc-wallet.json");
const RESULTS_FILE = path.join(DATA_DIR, "results.json");
const FIXTURES_FILE = path.join(DATA_DIR, "fixtures.json");
const FixturesStore = require("../lib/fixtures-store.cjs");
// ⚠️ Bu iki import BİR TUR ATLANMIŞTI: koşullu ekleme kullanılmıştı
// ("dosyada 'social-store' geçmiyorsa ekle") ama eklediğim YORUM satırı o
// metni zaten içerdiği için koşul yanlış çalıştı. Sonuç: turnuva
// sonuçlandırmada ReferenceError — testler o yolu hiç çalıştırmadığı için
// sessiz kaldı. Ders: import eklemeyi metin varlığına bağlama.
const SocialStore = require("../lib/social-store.cjs");
const Season = require("../lib/season.cjs");
const { ilkGolTuret } = require("../lib/ilk-gol.cjs");
/* ⚠️ Mini profil BAKIYE donduruyordu — sahiplik icin kimlik gerekli.
 * bkz. GET /user-profile notu. */
const { optionalToken } = require("../middleware/verifyToken.cjs");
const PoolStore = require("../lib/pool-store.cjs");
// Odenemeyen odulu kalici olarak kaydetmek icin (bkz. kayipOdulKaydet).
const WalletCredit = require("../lib/wallet-credit.cjs");
const { kritikIs } = require("../lib/kritik-is.cjs");
const RT_LIVE_GS_FILE = path.join(DATA_DIR, "rt-live-gs.json");

// ✅ maç bazlı puan defteri (kalıcı history)
const MATCH_RESULTS_FILE = path.join(DATA_DIR, "match-results.json");

// 🔹 LigCoin parametreleri
// ⚠️ Tek kaynak: lib/ekonomi.cjs. Bu değer DÖRT dosyada İKİ AYRI ADLA
// (LC_START / INITIAL_DEFAULT) tanımlıydı; birini değiştiren diğerini
// aramazdı ve açılış bakiyesi kod yoluna göre değişebilirdi.
const { LC_START } = require("../lib/ekonomi.cjs");
const Ekonomi = require("../lib/ekonomi.cjs");
/**
 * ⚠️ MAÇ GİRİŞ BEDELİ TEK KAYNAKTAN — BURADA SABİT KODLUYDU.
 *
 * Bu değer İADE hesabında kullanılıyor (aşağıda `refund`). Tahsilat ise
 * `routes/pred.cjs` üzerinden `lib/ekonomi.cjs`in `LC_MATCH_COST`unu
 * kullanıyor ve o `SKORLIG_MATCH_COST` ile yapılandırılabiliyor.
 *
 * Yani operatör bedeli 5 yaparsa:
 *     tahsilat  : 5 LC  (ekonomi.cjs)
 *     iade      : 3 LC  (buradaki sabit)
 * ve her iadede 2 LC sessizce kaybolurdu. Kusur yalnızca varsayılan
 * DIŞINDA bir yapılandırmada ortaya çıkar — aynı biçim bugün
 * `SKORLIG_DAILY_FLOOR` için de bulundu (ödeme yolu 3, satış ekranı 6).
 *
 * `routes/weekly-picks.cjs` bu sabitin DÖRDÜNCÜ adını taşıdığını zaten
 * not etmiş; tek kaynağa bağlamak o zincirin son halkası.
 */
const { MAC_GIRIS_BEDELI: LC_ENTRY_COST } = require("../lib/ekonomi.cjs");

/**
 * Giriş bedelinin İADE eşiği (tahmin puanı `base` bunun altındaysa iade yok).
 *
 * NEDEN VAR (ölçüldü 2026-07-29): Eşik `base > 0` idi, yani "kıl payı bildim"
 * bile kârlıydı ve kullanıcı YALNIZCA tamamen yanıldığında kaybediyordu.
 * 1291 gerçek oyuncunun performansıyla simülasyon:
 *
 *     iade base>0  (eski) → maç başına ortalama +2.21 LC · oyuncuların %100'ü kârda
 *     iade base>=6 (yeni) → maç başına ortalama −0.23 LC · %19 kârda
 *
 * Eski hâliyle her maç sisteme net LC basıyordu; LC arzının giriş/çıkış oranı
 * 145:1 ölçüldü. İade "oynadığın bedeli HAK ETTİN" demek olmalı, "bir şey
 * bildin" değil — base>=6 gerçek bir isabet eşiği (sonuç + en az bir yan kalem).
 *
 * Env ile ayarlanabilir: denge ayarı deploy gerektirmemeli.
 */
const REFUND_MIN_BASE = Number(process.env.SKORLIG_REFUND_MIN_BASE || 6);

// 🔹 Puanlama sabitleri
// Bahisçi marjı artık services/match-weights.cjs'te (MW.BOOKMAKER_MARGIN).
// İma edilen olasılık hesabı da orada — burada kopyası tutulmuyor.
// Yanlış 1X2 tahmininin ceza tabanı: ceza = BASE / odds
// (bölme — çarpma değil; gerekçe puanlama bloğunda açıklandı)
// odds 1.05 favori kaçtı → -2.1 · odds 2.4 → -0.9 · odds 4.0 underdog → -0.5
const OUTCOME_PENALTY_BASE = 2.16;

// Bot kimlikleri — tek kaynak (aktif kadro + emekli botlar).
// LC ödülü, topluluk çarpanı ve seri hesabı bu kümeyi kullanır.
const { BOT_ID_SET: BOT_USER_ID_SET } = require("../lib/botIds.cjs");

async function readJson(file, fb = null) {
  try {
    const txt = await fsp.readFile(file, "utf8");
    return JSON.parse(txt);
  } catch {
    return fb;
  }
}
async function writeJson(file, data) {
  // Atomik yazma (tmp + rename): süreç yazma ortasında ölse bile dosya
  // ya eski ya yeni tam haliyle kalır — yarım JSON oluşmaz.
  await writeJsonAtomic(file, data);
}
function stateFile(fid) {
  return guvenliYol(LIVE_DIR, String(fid), ".json");
}

// Bir fixture'ın tahminlerini getir. Mongo primary varsa oradan (indeksli
// tek sorgu), yoksa 17MB preds.json'dan filtreleyerek. 500k'da dosya taraması
// her settle'da tüm dosyayı okur — Mongo'da yalnızca ilgili fixture döner.
async function loadFixturePreds(fid, db) {
  if (db) {
    // ⚠️ İNDEKS ONARIMI: bu yol `models/preds.cjs`'i kullanmıyor, yani
    // oradaki kendi kendini onarma hiç çalışmıyordu (bkz. lib/preds-index.cjs).
    await ensurePredIndexes(db);
    return db.collection("predictions").find({ fixtureId: String(fid) }).toArray();
  }
  const predsRaw = await readJson(PREDS_FILE, []);
  const preds = Array.isArray(predsRaw) ? predsRaw : Array.isArray(predsRaw?.items) ? predsRaw.items : [];
  return preds.filter((p) => String(p.fixtureId) === String(fid));
}

async function fileExists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

function normFid(x) {
  return String(x || "").trim();
}

/* ======================
 * ✅ DEBUG ENDPOINTS
 * ====================== */

router.get("/__settle2_version", (req, res) => {
  res.json({
    ok: true,
    build: BUILD,
    dataDir: DATA_DIR,
    resultsFile: RESULTS_FILE,
    fixturesFile: FIXTURES_FILE,
    rtLiveGsFile: RT_LIVE_GS_FILE,
    matchResultsFile: MATCH_RESULTS_FILE,
    liveDir: LIVE_DIR,
    nowISO: new Date().toISOString(),
  });
});

router.get("/__settle2_debug", async (req, res) => {
  const fid = normFid(req.query.fixtureId);
  const out = {
    ok: true,
    build: BUILD,
    fixtureId: fid || null,
    files: {
      resultsExists: await fileExists(RESULTS_FILE),
      fixturesExists: await fileExists(FIXTURES_FILE),
      rtLiveGsExists: await fileExists(RT_LIVE_GS_FILE),
      matchResultsExists: await fileExists(MATCH_RESULTS_FILE),
      liveDirExists: await fileExists(LIVE_DIR),
      stateExists: fid ? await fileExists(stateFile(fid)) : false,
      statePath: fid ? stateFile(fid) : null,
    },
    sample: {},
  };

  // results.json içinde fid var mı?
  if (fid && out.files.resultsExists) {
    const results = await loadResultsList();
    const r = results.find((x) => normFid(x?.fixtureId ?? x?.id) === fid) || null;
    out.sample.resultsMatch = !!r;
    if (r) {
      out.sample.resultsRowKeys = Object.keys(r);
      out.sample.resultsScorePick = pickResultScore(r);
      out.sample.resultsMeta = r.meta || null;
    }
  }

  res.json(out);
});

/* ======================
 * ✅ STATE BOOTSTRAP
 * ====================== */

async function loadResultsList() {
  const raw = await readJson(RESULTS_FILE, null);
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.items)) return raw.items;
  if (raw && Array.isArray(raw.results)) return raw.results;
  return [];
}

// Fikstürler Mongo birincil — bkz. lib/fixtures-store.cjs. Sarmal çözme
// (düz dizi / {fixtures} / {items}) oraya taşındı.
async function loadFixturesList(db) {
  return FixturesStore.loadAll(db || null);
}

/**
 * ✅ results row'dan skoru çek:
 * - score.home/away
 * - scoreHome/scoreAway
 * - homeGoals/awayGoals
 * - goalsHome/goalsAway
 * - ✅ home/away (SENİN results.json formatın)
 */
function pickResultScore(r) {
  const h = r?.score?.home ?? r?.scoreHome ?? r?.homeGoals ?? r?.goalsHome ?? r?.home;
  const a = r?.score?.away ?? r?.scoreAway ?? r?.awayGoals ?? r?.goalsAway ?? r?.away;

  const hn = Number(h);
  const an = Number(a);
  if (Number.isFinite(hn) && Number.isFinite(an)) return { home: hn, away: an };
  return null;
}

function pickMetaFromFixture(fx) {
  return {
    kickoffISO: fx?.kickoffISO ?? fx?.dateISO ?? fx?.kickoff ?? null,
    country: fx?.country ?? null,
    league: fx?.league ?? null,
  };
}

async function bootstrapStateFromRtLiveGs(fid) {
  const fxid = normFid(fid);
  if (!fxid) return { ok: false, reason: "NO_FID" };

  const liveModel = await readJson(RT_LIVE_GS_FILE, null);
  const fx = liveModel && liveModel.fixtures ? liveModel.fixtures[fxid] : null;
  if (!fx) return { ok: false, reason: "NO_FIXTURE_IN_RT_LIVE_GS" };

  const scoreHome = Number(fx.homeGoals ?? fx.scoreHome ?? (fx.score && fx.score.home) ?? 0);
  const scoreAway = Number(fx.awayGoals ?? fx.scoreAway ?? (fx.score && fx.score.away) ?? 0);

  const htHome = fx.htScore?.home ?? fx.htHome ?? null;
  const htAway = fx.htScore?.away ?? fx.htAway ?? null;
  const hasHT = Number.isFinite(Number(htHome)) && Number.isFinite(Number(htAway));

  const st = {
    fixtureId: fxid,
    status: fx.status || "NS",
    minute: fx.minute ?? null,
    kickoffISO: fx.kickoffISO || null,

    country: fx.country || null,
    league: fx.league || null,

    score: {
      home: Number.isFinite(scoreHome) ? scoreHome : 0,
      away: Number.isFinite(scoreAway) ? scoreAway : 0,
    },

    firstGoal: fx.firstGoal || null,

    redHome: typeof fx.redHome === "boolean" ? fx.redHome : false,
    redAway: typeof fx.redAway === "boolean" ? fx.redAway : false,

    penaltyAny: typeof fx.penaltyAny === "boolean" ? fx.penaltyAny : false,
    penaltySide: fx.penaltySide || null,

    redEventAtISO: fx.redEventAtISO || null,
    redEventMinute: fx.redEventMinute ?? null,
    penEventAtISO: fx.penEventAtISO || null,
    penEventMinute: fx.penEventMinute ?? null,

    updatedAt: new Date().toISOString(),
    source: fx.source || "bootstrap_rt_live_gs",
  };

  if (hasHT) st.htScore = { home: Number(htHome), away: Number(htAway) };

  await writeJson(stateFile(fxid), st);
  return { ok: true, reason: "BOOTSTRAP_RT_LIVE_GS_OK" };
}

async function bootstrapStateFromResultsAndFixtures(fid) {
  const fxid = normFid(fid);
  if (!fxid) return { ok: false, reason: "NO_FID" };

  const results = await loadResultsList();
  const fixtures = await loadFixturesList();

  const r = results.find((x) => normFid(x?.fixtureId ?? x?.id) === fxid) || null;
  if (!r) return { ok: false, reason: "NO_FIXTURE_IN_RESULTS" };

  const score = pickResultScore(r);
  if (!score) return { ok: false, reason: "NO_SCORE_IN_RESULTS_ROW" };

  const fx = fixtures.find((x) => normFid(x?.fixtureId ?? x?.id) === fxid) || null;
  const metaFx = fx ? pickMetaFromFixture(fx) : {};

  const kickoffISO = metaFx.kickoffISO || r?.kickoffISO || r?.dateISO || null;
  const country = metaFx.country || r?.country || null;
  const league = metaFx.league || r?.league || null;

  const meta = r?.meta && typeof r.meta === "object" ? r.meta : {};
  const penaltyAny =
    typeof r?.penaltyAny === "boolean"
      ? r.penaltyAny
      : typeof meta.penaltyAny === "boolean"
      ? meta.penaltyAny
      : false;

  // redAny bilgi; taraf bilinmiyorsa redHome/redAway set etmiyoruz
  const redAnyInfo = typeof meta.redAny === "boolean" ? meta.redAny : false;

  const st = {
    fixtureId: fxid,
    status: "FT",
    minute: null,

    kickoffISO,
    country,
    league,

    score,

    htScore: r?.htScore || null,
    firstGoal: r?.firstGoal || null,

    redHome: false,
    redAway: false,

    penaltyAny,
    penaltySide: r?.penaltySide ?? meta.penaltySide ?? null,

    updatedAt: new Date().toISOString(),
    source: "bootstrap_results",
    bootstrapFrom: "results.json",
    resultsUpdatedAt: r?.updatedAt || null,
    resultsUpdatedBy: r?.updatedBy || null,
    resultsMetaRedAny: redAnyInfo,
  };

  await writeJson(stateFile(fxid), st);
  return { ok: true, reason: "BOOTSTRAP_RESULTS_OK" };
}

/* ======================
 * ✅ MATCH-RESULTS (HISTORY DEFTERİ)
 * ====================== */



async function buildFixtureMetaMap() {
  const fixtures = await loadFixturesList();
  const map = new Map();
  for (const fx of fixtures) {
    const fid = normFid(fx?.fixtureId ?? fx?.id);
    if (!fid) continue;
    map.set(fid, {
      fixtureId: fid,
      home: fx?.home ?? fx?.teamHome ?? fx?.homeTeam ?? null,
      away: fx?.away ?? fx?.teamAway ?? fx?.awayTeam ?? null,
      kickoffISO: fx?.kickoffISO ?? fx?.dateISO ?? fx?.kickoff ?? null,
      league: fx?.league ?? null,
      country: fx?.country ?? null,
    });
  }
  return map;
}

// Defter read-modify-write: iki FARKLI maç aynı anda sonuçlanırsa kilitsiz
// hâlde biri diğerinin snapshot'ını (ve awardedAt mührünü) siler.
/**
 * Snapshot yazımı artık lib/match-results.cjs üzerinden: Mongo varsa indeksli
 * upsert, yoksa dosya. Eskiden TÜM kitap her settle'da yeniden yazılıyordu
 * (15 kayıt / 5.3 MB) ve maliyet geçmişteki maç sayısıyla büyüyordu.
 *
 * Kilit ve "oku → karar ver → yaz" bütünlüğü depo tarafında; `awardedAt`
 * mührünün korunması aşağıdaki mutate fonksiyonunda.
 */
async function upsertMatchResultSnapshot({ fixtureId, finalScore, meta, rows, awardedAt, db = null }) {
  const nowISO = new Date().toISOString();
  return MatchResults.upsertSnapshot(
    fixtureId,
    (existing) => ({
      fixtureId: normFid(fixtureId),
      computedAt: nowISO,
      finalScore: finalScore || null,
      meta: meta || null,
      rows: Array.isArray(rows) ? rows : [],
      // awardedAt: bir kez yazılınca sabit kalır (idempotency sentinel)
      awardedAt: existing?.awardedAt || awardedAt || null,
    }),
    db
  );
}


/* ======================
 *  SCORING
 * ====================== */

// Ağırlık/çarpan formülleri services/match-weights.cjs'te — tahmin ekranının
// puan önizlemesi de aynı modülü kullanıyor. Buradaki hesabın kopyasını
// başka yere yazma; ikisi ayrışırsa ekran yanlış puan gösterir.
const MW = require("../services/match-weights.cjs");
const { getScoreWeight } = MW;

// Odds-bazlı sistemde puan yelpazesi genişledi:
// - Favori outcome doğru = ~3p
// - Underdog outcome doğru = ~12p (cap)
// - Exact skor doğru = 7-30p (nadirlik çarpanı)
// - Yan kalemler (FG/HT/red/pen) maç zorluğuyla çarpılı
// Toplam üst sınır ~50p'a çıkabilir. Eşikler bu yeni yelpazeye göre.
/**
 * ⚠️ MERDİVEN `lib/ekonomi.cjs`'E TAŞINDI. Buradayken `routes/daily-picks.cjs`
 * kullanıcıya gösterdiği ödülü bambaşka bir formülle hesaplıyordu ve ekranda
 * yazan sayı cüzdana geçenin 2-200 katıydı. Ödeme ile gösterim artık aynı
 * fonksiyondan geçiyor (bkz. oradaki `macOdulu` notu).
 */
function computeLcRewardFromDetail(detail) {
  return Ekonomi.macOdulu(detail && detail.base != null ? detail.base : 0);
}

/**
 * Maç ödüllerini cüzdana + users.json'a yatırır.
 *
 * Kilitli sarmalayıcı: asıl gövde _awardLcForRowsUnlocked'ta. WALLET ve USERS
 * dosyaları birlikte read-modify-write edildiği için ikisi de tüm işlem
 * boyunca tutulur. Sıra WALLET → USERS (global sırayla uyumlu).
 */
async function awardLcForRows(rows, db) {
  if (!rows || !rows.length) return;

  // Ayna kapalı + Mongo varken hiç dosya açılmaz; kilit tutmak yalnızca tüm
  // settle'ları gereksiz yere seri hale getirir. Mongo tarafında güvenlik
  // zaten `$inc` (atomik göreli artış) ile sağlanır, kilide ihtiyaç yoktur.
  if (db && !WALLET_FILE_MIRROR) {
    return _awardLcForRowsUnlocked(rows, db);
  }

  return withFileLock(WALLET_FILE, () =>
    withFileLock(USERS_FILE, () => _awardLcForRowsUnlocked(rows, db))
  );
}

async function _awardLcForRowsUnlocked(rows, db) {
  const nowISO = new Date().toISOString();

  // Mongo yoksa dosya TEK kaynaktır — ayna bayrağına bakılmaksızın yazılır.
  const needFile = !db || WALLET_FILE_MIRROR;

  const usersDataRaw = needFile
    ? await readJson(USERS_FILE, { users: [], items: [] })
    : { users: [], items: [] };

  // users.json: array | {users:[]} | {items:[]} toleransı
  let usersContainer = usersDataRaw;
  let usersItems = [];

  if (Array.isArray(usersDataRaw)) {
    usersContainer = { users: usersDataRaw, items: [] };
    usersItems = usersContainer.users;
  } else {
    const u1 = Array.isArray(usersDataRaw.users) ? usersDataRaw.users : [];
    const u2 = Array.isArray(usersDataRaw.items) ? usersDataRaw.items : [];
    // Öncelik: users doluysa users; değilse items
    usersItems = u1.length ? u1 : u2;
    // Eğer sadece items vardıysa, users'a da aynısını bağlayalım (tek kaynak)
    if (!u1.length && u2.length) {
      usersContainer.users = u2;
    } else if (u1.length) {
      usersContainer.users = u1;
    }
    usersContainer.items = usersContainer.users;
  }

  const walletState =
    (needFile
      ? await readJson(WALLET_FILE, { users: [], ledger: [], updatedAt: null })
      : { users: [], ledger: [], updatedAt: null }) || {};
  const walletUsers = Array.isArray(walletState.users) ? walletState.users : [];
  if (!Array.isArray(walletState.ledger)) walletState.ledger = [];

  function ensureWalletUserRecord(uid) {
    let wu = walletUsers.find((x) => String(x.userId || "").trim().toLowerCase() === uid.toLowerCase());
    if (!wu) {
      wu = {
        userId: uid,
        balance: 0,
        createdAt: nowISO,
        updatedAt: nowISO,
        lastDailyAt: null,
        totalEarned: 0,
        totalSpent: 0,
      };
      walletUsers.push(wu);
    }
    if (typeof wu.balance !== "number") wu.balance = 0;
    if (typeof wu.totalEarned !== "number") wu.totalEarned = 0;
    if (typeof wu.totalSpent !== "number") wu.totalSpent = 0;
    return wu;
  }

  function addLedgerEntryFile({ userId, amount, reason, fixtureId }) {
    walletState.ledger.push({
      id: "tx_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8),
      userId,
      kind: "reward",
      amount,
      reason: reason || null,
      fixtureId: fixtureId || null,
      meta: null,
      createdAt: nowISO,
    });
  }

  let usersCol = null;
  let ledgerCol = null;
  if (db) {
    usersCol = db.collection("lc_wallet_users");
    ledgerCol = db.collection("lc_wallet_ledger");
  }
  const mongoUserOps = [];
  const mongoLedgerDocs = [];

  for (const r of rows) {
    const uidRaw = r.userId || r.user;
    const uid = String(uidRaw || "").trim();
    if (!uid) continue;

    const uidLower = uid.toLowerCase();
    if (BOT_USER_ID_SET.has(uidLower)) continue;

    const reward = computeLcRewardFromDetail(r.detail);
    const base = Number(r.detail && r.detail.base != null ? r.detail.base : 0);
    const refund = base >= REFUND_MIN_BASE ? LC_ENTRY_COST : 0;
    const totalGain = reward + refund;
    if (totalGain <= 0) continue;

    // Dosya tarafı mutasyonları: ayna kapalıysa hiç kurulmaz (boş yapı
    // üzerinde çalışıp sonucu atmak hem gereksiz hem yanıltıcı olurdu).
    if (needFile) {
      let u = usersItems.find((x) => String(x.userId) === uid);
      if (!u) {
        u = { userId: uid, mainTeam: null, createdAt: nowISO, lc: LC_START + totalGain, lcLastDaily: null };
        usersItems.push(u);
      } else {
        if (typeof u.lc !== "number") u.lc = LC_START;
        u.lc = Number(u.lc || 0) + totalGain;
        u.lcUpdatedAt = nowISO;
        u.lcLastReason = refund > 0 ? "match_reward+entry_refund" : "match_reward";
        u.lcLastAmount = totalGain;
      }

      const wu = ensureWalletUserRecord(uid);
      wu.balance += totalGain;
      wu.totalEarned += totalGain;
      wu.updatedAt = nowISO;

      if (reward > 0) {
        addLedgerEntryFile({ userId: uid, amount: reward, reason: "match_reward", fixtureId: r.fixtureId });
      }
      if (refund > 0) {
        addLedgerEntryFile({ userId: uid, amount: refund, reason: "entry_refund", fixtureId: r.fixtureId });
      }
    }

    if (usersCol) {
      mongoUserOps.push({
        updateOne: {
          filter: { userIdLower: uidLower },
          update: {
            $set: { userId: uid, userIdLower: uidLower, updatedAt: nowISO },
            $setOnInsert: { createdAt: nowISO, lastDailyAt: null, totalSpent: 0, is1987: false },
            $inc: { balance: totalGain, totalEarned: totalGain },
          },
          upsert: true,
        },
      });
    }
    if (ledgerCol) {
      if (reward > 0) {
        mongoLedgerDocs.push({
          id: "tx_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8),
          userId: uid, userIdLower: uidLower, kind: "reward", amount: reward,
          reason: "match_reward", fixtureId: r.fixtureId, meta: null, createdAt: nowISO,
        });
      }
      if (refund > 0) {
        mongoLedgerDocs.push({
          id: "tx_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8),
          userId: uid, userIdLower: uidLower, kind: "reward", amount: refund,
          reason: "entry_refund", fixtureId: r.fixtureId, meta: null, createdAt: nowISO,
        });
      }
    }
  }

  if (needFile) {
    await writeJson(USERS_FILE, {
      ...usersContainer,
      users: usersItems,
      items: usersItems,
    });
    walletState.users = walletUsers;
    walletState.updatedAt = nowISO;
    await writeJson(WALLET_FILE, walletState);
  }

  if (usersCol && mongoUserOps.length) {
    /* ⚠️ ÖDÜL YAZIMI BAŞARISIZ OLURSA ÖDÜL KAYBOLUR — İZ BIRAK.
     *
     * Bu noktaya gelindiğinde `claimAward` mührü ÇOKTAN atılmıştır (çift
     * ödemeyi önlemek için, ve bu doğru sıra). Ama bunun ters riski şu: yazma
     * başarısız olursa settle "başarılı" sayılır, tekrar denemede mühür
     * "zaten ödüllendirilmiş" der ve ödüller KALICI olarak kaybolur.
     *
     * Eskiden burada yalnızca `console.error` vardı. Render'da log akıp gider;
     * kimsenin bakmadığı bir satır, kaybolmuş parayı geri getirmez.
     *
     * ⚠️ KISMİ BAŞARISIZLIK DA YAKALANIYOR: `ordered:false` bulkWrite istisna
     * ATMADAN bazı işlemleri atlayabilir (writeErrors). Sadece try/catch
     * kullanmak bu sessiz eksiği hiç görmezdi.
     *
     * Mührü GERİ ALMIYORUZ: kısmi başarı mümkün olduğu için yeniden denemek
     * bir kısmını ikinci kez öderdi. Doğru çözüm kalıcı iz + elle telafi.
     */
    let hata = null;
    let eksik = 0;
    try {
      const r = await usersCol.bulkWrite(mongoUserOps, { ordered: false });
      const islenen =
        (r?.modifiedCount || 0) + (r?.upsertedCount || 0) + (r?.matchedCount || 0);
      // matchedCount modified'ı da kapsayabilir; en iyimser okumayı alıp
      // yine de eksik varsa şikayet ediyoruz.
      eksik = Math.max(0, mongoUserOps.length - Math.max(islenen, (r?.matchedCount || 0)));
    } catch (e) {
      hata = e;
      eksik = mongoUserOps.length;
    }

    if (hata || eksik > 0) {
      console.error(
        `[settle2] ⛔ ODUL YAZIMI EKSIK — ${eksik}/${mongoUserOps.length} kullanici ` +
        `odenmemis olabilir. Mühür atildigi icin tekrar denenmeyecek.`,
        hata?.message || ""
      );
      try {
        await db.collection("failed_awards").insertOne({
          fixtureId: rows?.[0]?.fixtureId ?? null,
          createdAt: nowISO,
          neden: hata ? String(hata?.message || hata) : "kismi_yazim",
          beklenen: mongoUserOps.length,
          eksik,
          // Elle telafi için gereken asgari bilgi.
          odemeler: mongoUserOps.map((op) => ({
            userIdLower: op.updateOne.filter.userIdLower,
            tutar: op.updateOne.update.$inc.balance,
          })),
        });
      } catch (e2) {
        // Son çare: iz de bırakılamadı. Ayırt edilebilir bir işaretle bas.
        console.error("[settle2] ⛔⛔ FAILED_AWARDS KAYDI DA YAZILAMADI:", e2?.message || e2);
      }
    }
  }
  if (ledgerCol && mongoLedgerDocs.length) {
    try {
      await ledgerCol.insertMany(mongoLedgerDocs, { ordered: false });
    } catch (e) {
      console.error("[settle2] Mongo wallet_ledger insertMany failed:", e);
    }
  }
}

/**
 * Seri (streak) bonuslarını cüzdana yatırır.
 * bonusMap: Map<userId, { bonusLC, tier }>  (streak.recordBatch çıktısı)
 * Sadece bonusLC > 0 olanlara yazar. Bot filtresi çağırandan gelir.
 */
async function awardStreakBonuses(bonusMap, fixtureId, db) {
  if (!bonusMap || bonusMap.size === 0) return [];

  // Ayna kapalı + Mongo varken dosya açılmaz, kilit gereksiz (bkz. awardLcForRows).
  if (db && !WALLET_FILE_MIRROR) {
    return _awardStreakBonusesUnlocked(bonusMap, fixtureId, db);
  }

  return withFileLock(WALLET_FILE, () =>
    withFileLock(USERS_FILE, () =>
      _awardStreakBonusesUnlocked(bonusMap, fixtureId, db)
    )
  );
}

async function _awardStreakBonusesUnlocked(bonusMap, fixtureId, db) {
  const nowISO = new Date().toISOString();
  const awarded = [];

  // Bkz. _awardLcForRowsUnlocked: Mongo tarafı `$inc` + upsert ile dosyadan
  // bağımsız çalışır, ayna kapalıyken dosya hiç açılmaz.
  const needFile = !db || WALLET_FILE_MIRROR;

  const walletState =
    (needFile
      ? await readJson(WALLET_FILE, { users: [], ledger: [], updatedAt: null })
      : { users: [], ledger: [], updatedAt: null }) || {};
  if (!Array.isArray(walletState.users)) walletState.users = [];
  if (!Array.isArray(walletState.ledger)) walletState.ledger = [];

  const usersRaw = needFile
    ? await readJson(USERS_FILE, { users: [], items: [] })
    : { users: [], items: [] };
  const usersItems = Array.isArray(usersRaw)
    ? usersRaw
    : Array.isArray(usersRaw.users) ? usersRaw.users
    : Array.isArray(usersRaw.items) ? usersRaw.items : [];

  for (const [uid, info] of bonusMap.entries()) {
    const bonus = Number(info && info.bonusLC) || 0;
    if (bonus <= 0) continue;

    if (needFile) {
      let wu = walletState.users.find((x) => String(x.userId || "").toLowerCase() === uid.toLowerCase());
      if (!wu) {
        wu = { userId: uid, balance: 0, createdAt: nowISO, updatedAt: nowISO, lastDailyAt: null, totalEarned: 0, totalSpent: 0 };
        walletState.users.push(wu);
      }
      wu.balance = Number(wu.balance || 0) + bonus;
      wu.totalEarned = Number(wu.totalEarned || 0) + bonus;
      wu.updatedAt = nowISO;

      walletState.ledger.push({
        id: "tx_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8),
        userId: uid, kind: "reward", amount: bonus,
        reason: "streak_bonus", fixtureId,
        meta: info.tier ? { tier: info.tier.label } : null,
        createdAt: nowISO,
      });

      let u = usersItems.find((x) => String(x.userId) === uid);
      if (u) { u.lc = Number(u.lc || 0) + bonus; u.lcUpdatedAt = nowISO; u.lcLastReason = "streak_bonus"; u.lcLastAmount = bonus; }
    }

    awarded.push({ userId: uid, bonus, tier: info.tier ? info.tier.label : null });

    if (db) {
      try {
        await db.collection("lc_wallet_users").updateOne(
          { userIdLower: uid.toLowerCase() },
          { $inc: { balance: bonus, totalEarned: bonus }, $set: { updatedAt: nowISO },
            $setOnInsert: { userId: uid, userIdLower: uid.toLowerCase(), createdAt: nowISO, lastDailyAt: null, totalSpent: 0 } },
          { upsert: true }
        );
        await db.collection("lc_wallet_ledger").insertOne({
          id: "tx_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8),
          userId: uid, userIdLower: uid.toLowerCase(), kind: "reward", amount: bonus,
          reason: "streak_bonus", fixtureId, meta: info.tier ? { tier: info.tier.label } : null, createdAt: nowISO,
        });
      } catch (e) {
        /**
         * ⚠️ MÜHÜR ÇOKTAN ATILDI, BONUS TEKRAR DENENMEZ — KALICI İZ ŞART.
         *
         * `services/streak.cjs` eşik bonusunu tek kez vermek için `lastTier`i
         * ilerletiyor ve BUNU ÖDEMEDEN ÖNCE kalıcılaştırıyor. Buradaki yazma
         * patlarsa bonus bir daha hesaplanmaz: kullanıcı eşiği geçti,
         * bakiyesine hiçbir şey yatmadı ve kimse bunu göremiyordu — tek iz
         * bir `console.error` satırıydı, Render'da o da akıp gider.
         *
         * Aynı yapı kupon, havuz, mini turnuva, düello ve maç ödülünde
         * `failed_awards`e yazılıyor ve `GET /api/health` onu sayıyor
         * (`paraUyarisi`). Eksik olan tek yol buydu.
         *
         * ⚠️ NEDEN ÖNCEKİ TARAMAM KAÇIRDI: bugün bu sınıfı `creditLc` çağrı
         * yerlerini tarayarak aramıştım; bu yol cüzdana DOĞRUDAN yazıyor,
         * o yüzden kalıba girmiyordu. Sınıfı fonksiyon adıyla değil
         * DAVRANIŞLA (para yazan her yol) taramak gerekiyormuş.
         */
        console.error("[settle2] ⛔ STREAK BONUSU ODENEMEDI:", e?.message || e);
        try {
          const { kayipOdulKaydet } = require("../lib/wallet-credit.cjs");
          await kayipOdulKaydet(db, {
            kaynak: "streak_bonus",
            fixtureId,
            odemeler: [{ userIdLower: uid.toLowerCase(), tutar: bonus }],
            beklenen: 1,
            eksik: 1,
            tier: info.tier ? info.tier.label : null,
          });
        } catch (e2) {
          console.error("[settle2] streak bonus kayip izi yazilamadi:", e2?.message || e2);
        }
      }
    }
  }

  if (needFile) {
    walletState.updatedAt = nowISO;
    await writeJson(WALLET_FILE, walletState);
    if (Array.isArray(usersRaw)) await writeJson(USERS_FILE, usersItems);
    else await writeJson(USERS_FILE, { ...usersRaw, users: usersItems, items: usersItems });
  }

  return awarded;
}

/**
 * Maç bazlı kilitli sarmalayıcı.
 *
 * İdempotency mührü "oku → kontrol et → ödüllendir → yaz" olarak işler; bu
 * pencere seri hale getirilmezse aynı fixture'a iki eşzamanlı settle mührü
 * ikisi de boş görür ve LC İKİ KEZ yatar (ocak ayı ledger'ında gerçekten
 * yaşandı).
 *
 * ⚠️ KİLİT NEDEN BURADA, ÇAĞIRANDA DEĞİL: eskiden yalnızca POST /settle2
 * route'unu sarıyordu. Test paketi bunu yakaladı — scoreFixture DOĞRUDAN
 * paralel çağrıldığında (5 çağrı) ödül 5 kez yatıyordu. Koruma çağıranda
 * yaşarsa, ileride eklenecek her yeni çağıran (toplu settle, cron, başka
 * servis) hatayı sessizce geri getirir. Artık garanti fonksiyonun kendisinde.
 *
 * withFileLock aynı anahtarla İÇ İÇE çağrılırsa kilitlenir (reentrant değil) —
 * bu yüzden route'daki sarmalayıcı kaldırıldı.
 */
async function scoreFixture(fixtureId, opts = {}) {
  const fid = String(fixtureId || "");
  if (!fid) {
    const err = new Error("FIXTURE_REQUIRED");
    err.code = "FIXTURE_REQUIRED";
    err.httpStatus = 400;
    throw err;
  }
  return withFileLock(`settle:${fid}`, () => _scoreFixtureUnlocked(fixtureId, opts));
}

async function _scoreFixtureUnlocked(fixtureId, { updateTotals = true, db = null, allowLive = false } = {}) {
  const fid = String(fixtureId || "");

  const debug = {
    build: BUILD,
    fid,
    tried: [],
    files: {
      resultsExists: await fileExists(RESULTS_FILE),
      fixturesExists: await fileExists(FIXTURES_FILE),
      rtLiveGsExists: await fileExists(RT_LIVE_GS_FILE),
      matchResultsExists: await fileExists(MATCH_RESULTS_FILE),
      liveDirExists: await fileExists(LIVE_DIR),
      statePath: stateFile(fid),
      stateExistsBefore: await fileExists(stateFile(fid)),
    },
  };

  let st = await readJson(stateFile(fid), null);

  if (!st) {
    const r1 = await bootstrapStateFromRtLiveGs(fid);
    debug.tried.push({ step: "bootstrap_rt_live_gs", ...r1 });
    if (r1.ok) st = await readJson(stateFile(fid), null);
  }
  if (!st) {
    const r2 = await bootstrapStateFromResultsAndFixtures(fid);
    debug.tried.push({ step: "bootstrap_results", ...r2 });
    if (r2.ok) st = await readJson(stateFile(fid), null);
  }

  debug.files.stateExistsAfter = await fileExists(stateFile(fid));

  /* ────────────────────────────────────────────────────────────────────────
   * DURUM DOSYASINDA TAKIM ADI VE ÜLKE YOK — PUANLAMA NÖTR ÇARPANLA
   * YAPILIYORDU. Bu bir MAJÖR puanlama hatasıydı.
   *
   * `services/livescore-sync.cjs writeLiveState` yalnızca şunları yazıyor:
   *     { fixtureId, status, isLive, score, updatedAt, source, htScore }
   * `home`, `away`, `country` YOK. Yukarıdaki bootstrap'lar bu alanları
   * dolduruyor ama SADECE `if (!st)` iken — yani durum dosyası varsa (normal
   * hâl, senkron her maç için yazıyor) hiç çalışmıyorlar.
   *
   * Sonuç: `getScoreWeight(st.country)`, `MW.oddsMultiplier(st.home, st.away)`
   * ve `MW.matchDifficulty(st.home, st.away)` hep `undefined` ile çağrılıyor
   * ve NÖTR değer dönüyor.
   *
   * ÖLÇÜLDÜ (bugün, kuru yeniden hesap):
   *     Arjantin maçı  → uygulanan ülke ağırlığı 1.000, doğrusu 1.03
   *     Real Madrid–Erokspor  ev kazanır çarpanı: 2.4 uygulanıyor, doğrusu 1.4
   *     aynı maç  yan kalem zorluğu: 1.10 uygulanıyor, doğrusu 0.60
   * Yani bariz favoriyi tutmak olması gerekenden **%71 fazla** ödüyordu;
   * uygulamanın kendi vaadi ("az kişinin tuttuğunu bilirsen daha fazla puan")
   * tersine dönmüştü. Üretim verisinde de görüldü: ağırlığı 1.0 olmayan
   * ülkeden gelen 40 satırın 40'ı yanlış, 1.0 olanların 2523'ü doğru —
   * çünkü orada hata görünmüyor.
   *
   * ⚠️ ÇÖZÜM PUANLAMA ANINDA ZENGİNLEŞTİRME. `writeLiveState`'e alan eklemek
   * yalnızca YENİ maçları düzeltirdi; mevcut binlerce durum dosyası eksik
   * kalırdı. Burada doldurmak her iki kümeyi de kapsıyor.
   *
   * ⚠️ MEVCUT DEĞER EZİLMİYOR: bootstrap yolundan gelen `st` bu alanları
   * zaten dolduruyor olabilir; yalnızca EKSİK olanlar tamamlanıyor.
   * ──────────────────────────────────────────────────────────────────────── */
  if (st && (!st.home || !st.away || !st.country)) {
    try {
      const fxKaydi = await FixturesStore.getOne(fid, db || null);
      if (fxKaydi) {
        if (!st.home)    st.home    = fxKaydi.home    || null;
        if (!st.away)    st.away    = fxKaydi.away    || null;
        if (!st.country) st.country = fxKaydi.country || null;
        if (!st.league)  st.league  = fxKaydi.league  || null;
        debug.enriched = { home: !!st.home, away: !!st.away, country: !!st.country };
      } else {
        debug.enriched = { bulunamadi: true };
      }
    } catch (e) {
      /* Zenginleştirme başarısızsa puanlama DURMAZ — nötr çarpanla devam
       * eder (eski davranış). Sessiz kalmıyoruz ki fark edilsin. */
      console.error(`[settle2] ${fid} fikstur meta okunamadi:`, e?.message || e);
    }
  }

  if (!st) {
    const err = new Error("STATE_NOT_FOUND");
    err.code = "STATE_NOT_FOUND";
    err.httpStatus = 404;
    err.detailObj = debug;
    throw err;
  }

  // allowLive: canlı eleme panosu (match-race) maç sürerken de anlık
  // puanlama ister; settle akışı (updateTotals:true) FT şartını korur.
  if (String(st.status) !== "FT" && !(allowLive && !updateTotals)) {
    const err = new Error("NOT_FINISHED");
    err.code = "NOT_FINISHED";
    err.httpStatus = 400;
    throw err;
  }

  // 🔹 Bu fixture'ın bağlı olduğu yarışmalar (competitionId listesi)
  let competitionIds = [];
  if (db) {
    try {
      const fcCol = db.collection("fixture_competitions");
      const fcDoc = await fcCol.findOne({ fixtureId: fid });
      if (fcDoc && Array.isArray(fcDoc.competitions)) {
        competitionIds = fcDoc.competitions
          .filter((c) => c && c.countsForPoints !== false)
          .map((c) => String(c.competitionId || "").trim())
          .filter(Boolean);
      }
    } catch (e) {
      console.error("[settle2] read fixture_competitions failed (will ignore competitions):", e);
    }
  }

  const listRaw = await loadFixturePreds(fid, db);

  // 🔒 Mükerrer tahmin koruması: aynı user+fixture için birden fazla kayıt
  // varsa (eski bot üretimi veya bozuk yazma) EN SON olanı geçerli sayılır.
  // Aksi halde kullanıcı tek settle'da N kere puanlanır.
  const bestByUser = new Map();
  for (const p of listRaw) {
    const uid = String(p.userId || p.user || "anon").trim().toLowerCase();
    const prev = bestByUser.get(uid);
    if (!prev) { bestByUser.set(uid, p); continue; }
    const tNew = new Date(p.at || p.createdAt || 0).getTime() || 0;
    const tOld = new Date(prev.at || prev.createdAt || 0).getTime() || 0;
    if (tNew >= tOld) bestByUser.set(uid, p);
  }
  const list = Array.from(bestByUser.values());
  if (list.length !== listRaw.length) {
    console.warn(`[settle2] ${fid}: ${listRaw.length - list.length} mükerrer tahmin yok sayıldı`);
  }

  const h = Number(st.score?.home || 0);
  const a = Number(st.score?.away || 0);
  const outcome = h > a ? "H" : a > h ? "A" : "D";

  const htH = Number(st.htScore?.home ?? NaN);
  const htA = Number(st.htScore?.away ?? NaN);
  const hasHT = Number.isFinite(htH) && Number.isFinite(htA);
  const htOutcome = hasHT ? (htH > htA ? "H" : htA > htH ? "A" : "D") : null;

  const redHomeActual = !!st.redHome;
  const redAwayActual = !!st.redAway;
  const redAnyActual = redHomeActual || redAwayActual;
  const redSideActual = redHomeActual ? "H" : redAwayActual ? "A" : null;

  /* ⚠️ İLK GOL: kaynak sırası olay (af-sync) → canlı izleme damgası
   * (livescore-sync, skor geçişinden) → FT skorundan KESİN çıkarım.
   * Sonuncusu tek taraf gol attığında tartışmasız (2-0'da ilk gol ev
   * sahibinin) ve uzlaşmış maçların %39.5'ini tek başına kapsıyor; sunucu
   * canlı anı kaçırmış (uyku/yeniden başlatma) olsa bile çalışır.
   * Hiçbiri bilmiyorsa null kalır ve kalem puanlanmaz (hasFG kapısı).
   * bkz. lib/ilk-gol.cjs */
  const fg = st.firstGoal || ilkGolTuret(h, a);

  const penaltyAnyActual = typeof st.penaltyAny === "boolean" ? st.penaltyAny : false;
  const penaltySideActual = st.penaltySide || null;

  const w = getScoreWeight(st.country);

  // ── Maç oddsı + zorluk: match-weights.cjs tek kaynak ─────────────────────
  // Formüllerin gerekçesi ve tarihçesi o dosyada. Tahmin ekranının puan
  // önizlemesi de aynı fonksiyonları kullanıyor.
  const oddsMultiplier = (oc) => MW.oddsMultiplier(st.home, st.away, oc);
  const matchDifficulty = MW.matchDifficulty(st.home, st.away);

  // ── Topluluk çarpanı: skor tahmini için nadir skor daha fazla kazandırır ──
  const humanList = list.filter((p) => {
    const uid = String(p.userId || p.user || "").trim().toLowerCase();
    return !BOT_USER_ID_SET.has(uid);
  });
  const humanTotal = humanList.length;

  // Skor dağılımı (sadece skor çarpanı için)
  const scorePickMap = new Map();
  for (const p of humanList) {
    if (
      p.home != null && p.away != null &&
      Number.isFinite(Number(p.home)) && Number.isFinite(Number(p.away))
    ) {
      const key = `${Number(p.home)}-${Number(p.away)}`;
      scorePickMap.set(key, (scorePickMap.get(key) || 0) + 1);
    }
  }

  const scoreMultiplier = (sh, sa) =>
    MW.scoreMultiplier(humanTotal, scorePickMap, `${sh}-${sa}`);
  // ─────────────────────────────────────────────────────────────────────────

  const rows = [];

  for (const p of list) {
    const u = p.userId || p.user || "anon";
    let pts = 0;
    const detail = {};

    // 1) Sonuç (1X2): doğru = baz(3) × odds, yanlış = -(CEZA_BAZ / odds)
    //
    // CEZA NEDEN ODDS'A BÖLÜNÜYOR (çarpılmıyor):
    //   odds = margin/P olduğundan ödül tarafının beklenen değeri her seçimde
    //   sabittir (P × 3 × margin/P = 3 × margin). Yani tüm strateji cezadan
    //   gelir. Cezayı odds ile ÇARPMAK riskli seçimi iki kez cezalandırır
    //   (hem kazanma şansı düşük, hem ceza büyük) → favori oynamak her zaman
    //   kârlı olur, cesur tahmin ölür. Bölmek bunu tersine çevirir:
    //   favoriyi kaçırmak pahalı, underdog'u kaçırmak ucuz.
    //   (Kullanıcı ilkesi: cesur tahminde "hepsi azar azar kessin".)
    if (p.outcome && typeof p.outcome === "string") {
      const oc = p.outcome.toUpperCase();
      const ok = oc === outcome;
      const mult = oddsMultiplier(oc);
      const earn = Math.round(3 * mult * 10) / 10;
      const penalty = -Math.round((OUTCOME_PENALTY_BASE / mult) * 10) / 10;
      detail.outcome = ok ? earn : penalty;
      detail.outcomeMultiplier = Math.round(mult * 100) / 100;
      pts += detail.outcome;
    }

    // 2) Skor: doğru = baz(12) × skor çarpanı, yanlış -0.1
    const hasScorePred =
      p.home !== null &&
      p.home !== undefined &&
      p.away !== null &&
      p.away !== undefined &&
      Number.isFinite(Number(p.home)) &&
      Number.isFinite(Number(p.away));

    if (hasScorePred) {
      const ph = Number(p.home);
      const pa = Number(p.away);
      const ok = ph === h && pa === a;
      const mult = scoreMultiplier(ph, pa);
      const earn = Math.round(12 * mult * 10) / 10;
      detail.exact = ok ? earn : -0.1;
      detail.scoreMultiplier = Math.round(mult * 100) / 100;
      pts += detail.exact;
    }

    /* 3) İlk gol: doğru = +1 × maç zorluğu, yanlış = -0.2 × maç zorluğu
     *
     * ⚠️ VERİ YOKSA PUANLANMAZ — BU BAHİS KAZANILAMIYORDU.
     *
     * Eski kod veri olup olmadığına BAKMIYORDU: `fg` null iken karşılaştırma
     * `"H" === ""` olup daima yanlış çıkıyor ve oyuncu cezayı yiyordu.
     *
     * ÖLÇÜLDÜ (üretim, 1356 uzlaşmış maçın puan detayları):
     *     ilk gol kalemi yazılan tahmin : 14518
     *     ödül alan (>0)                :     0   ← tek bir tane bile yok
     *     ceza alan (<0)                : 14518 (%100)
     *     toplam kaybedilen puan        : -2891.6
     * Yani beceriyle kazanılması İMKÂNSIZ bir bahisti; girmek her zaman
     * saf kayıptı. Karşılaştırma için aynı ölçümde `firstHalf` %34.6,
     * `outcome` %39.6, `exact` %8.0 ödül alıyor.
     *
     * SEBEP ZİNCİRİ: `st.firstGoal`ü YALNIZCA `services/af-sync.cjs`
     * dolduruyor (API-Football events), o kaynak ise askıda. Üstelik tahmin
     * ekranı bahsi teklif etmeye ve "kazanabileceğin puanı" göstermeye devam
     * ediyor (mobile app/(tabs)/predict.tsx).
     *
     * ⚠️ AYNI SAVUNMA HEMEN ALTINDA VARDI: ilk yarı kalemi `hasHT` ile
     * korunuyor — veri yoksa hiç puanlanmıyor. İlk gol o korumayı almamıştı;
     * bu deponun tekrar eden biçimi: savunma bir kalemde var, komşusunda yok.
     *
     * ⚠️ 0-0 BİTEN MAÇ DA BURAYA DÜŞER (fg null) ve puanlanmaz. Bilinçli:
     * "veri gelmedi" ile "gol olmadı" ayırt EDİLEMİYOR, ve golsüz maçta
     * kimsenin bilemeyeceği bir olayı cezalandırmak yanlış taraf.
     */
    const hasFG = !!fg;
    if (hasFG && p.firstGoal) {
      const ok = String(p.firstGoal).toUpperCase() === String(fg);
      detail.firstGoal = ok
        ? Math.round(1 * matchDifficulty * 10) / 10
        : -Math.round(0.2 * matchDifficulty * 10) / 10;
      pts += detail.firstGoal;
    }

    // 4) İlk yarı: doğru = +2 × maç zorluğu, yanlış = -0.4 × maç zorluğu
    if (hasHT && p.firstHalf) {
      const ok = String(p.firstHalf).toUpperCase() === htOutcome;
      detail.firstHalf = ok
        ? Math.round(2 * matchDifficulty * 10) / 10
        : -Math.round(0.4 * matchDifficulty * 10) / 10;
      pts += detail.firstHalf;
    }

    // 5) Kırmızı kart
    let redAnyPts = 0;
    let redSidePts = 0;
    let redSidePenalty = 0;

    let predRedAny = typeof p.redAny === "boolean" ? p.redAny : null;
    let predRedSide = p.redSide != null ? String(p.redSide).toUpperCase() : null;
    if (predRedSide !== "H" && predRedSide !== "A") predRedSide = null;

    // Eski şema fallback
    if (predRedAny === null && (typeof p.redHome === "boolean" || typeof p.redAway === "boolean")) {
      const legacyRedHome = !!p.redHome;
      const legacyRedAway = !!p.redAway;
      predRedAny = legacyRedHome || legacyRedAway;
      predRedSide = legacyRedHome ? "H" : legacyRedAway ? "A" : null;
    }

    if (predRedAny === true || predRedAny === false) {
      redAnyPts = predRedAny === redAnyActual
        ? Math.round(1.5 * matchDifficulty * 10) / 10
        : -Math.round(0.3 * matchDifficulty * 10) / 10;
    }

    if (predRedAny === true && predRedSide && redAnyActual === true) {
      const act = redSideActual ? String(redSideActual).toUpperCase() : null;
      if (act && predRedSide === act) redSidePts = Math.round(1 * matchDifficulty * 10) / 10;
      else redSidePenalty = -Math.round(0.2 * matchDifficulty * 10) / 10;
    }

    detail.redAny = redAnyPts;
    detail.redSide = redSidePts;
    detail.redSidePenalty = redSidePenalty;
    pts += redAnyPts + redSidePts + redSidePenalty;

    // 6) Penaltı
    let penaltyAnyPts = 0;
    let penaltySidePts = 0;
    let penaltySidePenalty = 0;

    const predPenaltyAny = typeof p.penaltyAny === "boolean" ? p.penaltyAny : null;
    let predPenaltySide = p.penaltySide != null ? String(p.penaltySide).toUpperCase() : null;
    if (predPenaltySide !== "H" && predPenaltySide !== "A") predPenaltySide = null;

    if (predPenaltyAny === true || predPenaltyAny === false) {
      penaltyAnyPts = predPenaltyAny === penaltyAnyActual
        ? Math.round(1.5 * matchDifficulty * 10) / 10
        : -Math.round(0.3 * matchDifficulty * 10) / 10;
    }

    if (predPenaltyAny === true && predPenaltySide && penaltyAnyActual === true) {
      const act = penaltySideActual ? String(penaltySideActual).toUpperCase() : null;
      if (act && predPenaltySide === act) penaltySidePts = Math.round(1 * matchDifficulty * 10) / 10;
      else penaltySidePenalty = -Math.round(0.2 * matchDifficulty * 10) / 10;
    }

    detail.penaltyAny = penaltyAnyPts;
    detail.penaltySide = penaltySidePts;
    detail.penaltySidePenalty = penaltySidePenalty;
    pts += penaltyAnyPts + penaltySidePts + penaltySidePenalty;

    detail.zeroPenalty = 0;

    // base: sadece pozitif puanlardan hesaplanır (LC ödülü için), cezalar ayrı
    const base =
      Math.max(0, Number(detail.outcome || 0)) +
      Math.max(0, Number(detail.exact || 0)) +
      Math.max(0, Number(detail.firstGoal || 0)) +
      Math.max(0, Number(detail.firstHalf || 0)) +
      Math.max(0, Number(detail.redAny || 0)) +
      Math.max(0, Number(detail.redSide || 0)) +
      Math.max(0, Number(detail.penaltyAny || 0)) +
      Math.max(0, Number(detail.penaltySide || 0));

    detail.base = Math.max(0, Number(base || 0)); // üst sınır kalktı: çarpanlar değeri artırabilir

    const weightedPoints = pts * w;

    rows.push({
      fixtureId: fid,
      userId: String(u),
      points: Number.isFinite(weightedPoints) ? weightedPoints : 0,
      /**
       * ⚠️ SNAPSHOT KENDİNİ ANLATMALI — BOT/İNSAN AYRIMI SATIRDA.
       *
       * Bu satırlar sonuç PUSH bildiriminde "N kişi arasında R. sıradasın"
       * için sıralanıyor ve ayrım taşımadığı için N botları da sayıyordu.
       * Ölçüldü (400 uzlaşmış snapshot): 2483 satırın 2477'si bot.
       *
       * Bot kimliğini sonradan `lib/botIds.cjs`ten çözmek kırılgan: o modül
       * `data/bot-profiles.json` okuyor ve Render'da disk kalıcı değil.
       * Tahmin kaydında `isBot` zaten var; yazılan yere de koyuyoruz ki
       * okuyanın ikinci bir kaynağa ihtiyacı olmasın.
       */
      isBot: !!p.isBot,
      detail,
    });
  }

  if (!updateTotals) {
    return {
      fixtureId: fid,
      finalScore: { home: h, away: a },
      outcome,
      firstGoal: fg,
      redAny: redAnyActual,
      redSide: redSideActual,
      penaltyAny: penaltyAnyActual,
      penaltySide: penaltySideActual,
      leaderboard: rows,
      competitionIds,
    };
  }

  // 🔒 Idempotency: aynı fixture için totals/LC ikinci kez yatmasın.
  // livescore-sync + af-sync + manuel çağrılar aynı fixture'ı defalarca
  // settle2'ye gönderebilir. Sentinel: match-results snapshot'ta `awardedAt`.
  //
  // ⚠️ MÜHÜR ÖDÜLDEN ÖNCE ALINIR. Eskiden burada yalnızca OKUMA vardı ve
  // `awardedAt` ~90 satır sonra, tüm ödül dağıtımının ARDINDAN yazılıyordu.
  // Kontrol ile mühür arasındaki pencere dağıtımın tamamı kadar genişti;
  // livescore-sync (30sn), af-sync ve manuel çağrılar aynı fixture'ı
  // gönderdiğinde iki çağrı da kontrolü geçip ödülü İKİ KEZ dağıtabilirdi.
  // claimAward koşulu yazmanın içinde tutuyor — yalnızca kazanan devam eder.
  {
    // ⚠️ `nowISO` bu fonksiyonda AŞAĞIDA tanımlı (const, TDZ) — burada
    // kullanmak ReferenceError verirdi. Mühür kendi damgasını üretir.
    const damga = await MatchResults.claimAward(fid, new Date().toISOString(), db);
    if (!damga) {
      const existing = await MatchResults.getSnapshot(fid, db).catch(() => null);
      console.log(`[settle2] fixture ${fid} zaten ödüllendirilmiş (${existing?.awardedAt || "?"}) — tekrar yatırılmayacak`);
      return {
        fixtureId: fid,
        finalScore: { home: h, away: a },
        outcome,
        firstGoal: fg,
        redAny: redAnyActual,
        redSide: redSideActual,
        penaltyAny: penaltyAnyActual,
        penaltySide: penaltySideActual,
        leaderboard: rows,
        competitionIds,
        alreadySettled: true,
        awardedAt: existing?.awardedAt || null,
      };
    }
  }

  /* Kapanışta yarıda kesilmesin: mühür (claimAward) yukarıda atıldı, bu
   * blok kesilirse ödül kaybolur ve mühür yüzünden tekrar denenmez.
   * HTTP yolu `server.close()` ile zaten korunuyor; bu sayaç arka plan
   * servislerinin doğrudan çağrılarını da kapsıyor. bkz. lib/kritik-is.cjs */
  await kritikIs(`settle:${fid}`, () => awardLcForRows(rows, db));

  /* Haftalık kupon: bu maç bir kuponun parçasıysa ve kuponun TÜM maçları
   * bittiyse kupon da sonuçlanır. Kendi mührü var, tekrar ödemez.
   * bkz. lib/kupon-settle.cjs */
  if (db) {
    try {
      const KuponSettle = require("../lib/kupon-settle.cjs");
      await kritikIs(`kupon:${fid}`, () => KuponSettle.bekleyenleriSonuclandir(db));
    } catch (e) {
      console.error("[settle2] kupon sonuclandirma hatasi:", e?.message || e);
    }
  }

  // ── Maç havuzu ödemesi (bkz. lib/pool-store.cjs) ──────────────────────
  // Kendi `settledAt` mührü var; settle2 defalarca çağrılsa da bir kez öder.
  // Havuz SIRALAMAYI ETKİLEMEZ — burada yalnızca LC dağıtılır, `rows`a
  // dokunulmaz (puan = beceri, LC = para).
  try {
    const havuz = await PoolStore.settlePool(fid, outcome, db);
    if (havuz.ok && havuz.players) {
      console.log(
        `[settle2] havuz ${fid}: ${havuz.players} oyuncu | havuz ${havuz.pool} LC | ` +
        `carpan ${havuz.multiplier}x | odenen ${havuz.paid} | yakilan ${havuz.burned}`
      );
    }
  } catch (e) {
    // Havuz ödemesi maç ödülünü DURDURMAMALI: ikisi ayrı ekonomiler.
    console.error("[settle2] havuz odemesi basarisiz:", e?.message || e);
  }

  // ── Seri (streak) sistemi: 1X2 tahmini olan insan oyuncular için ─────────────
  // Doğru sonuç → seriye eklenir (odds = contrarian çarpan, min 1.0),
  // yanlış → seri kırılır. Tier atlanınca (Isınıyor/Ateşte/Durdurulamıyor)
  // bonus LC cüzdana yatar. Bahis yapmayan seriye dokunmaz.
  let streakAwards = [];
  try {
    const { recordBatch } = require("../services/streak.cjs");
    const streakEntries = [];
    for (const r of rows) {
      const uidLower = String(r.userId || "").trim().toLowerCase();
      if (!uidLower || BOT_USER_ID_SET.has(uidLower)) continue;
      const d = r.detail || {};
      if (d.outcome === undefined) continue; // 1X2 bahsi yoksa seriye dahil değil
      const correct = Number(d.outcome) > 0;
      const odds = Math.max(1.0, Number(d.outcomeMultiplier) || 1.0);
      streakEntries.push({ userId: r.userId, fixtureId: fid, correct, odds });
    }
    if (streakEntries.length) {
      const bonusMap = await recordBatch(streakEntries);
      streakAwards = await awardStreakBonuses(bonusMap, fid, db);
      if (streakAwards.length) {
        console.log(`[settle2] ${streakAwards.length} seri bonusu verildi — fixture ${fid}`);
      }
    }
  } catch (e) {
    console.error("[settle2] streak processing failed:", e);
  }

  // ── Duello settlement: maç puanları belli olunca düellolar otomatik kapanır ─
  try {
    const { settleDuelsForFixture } = require("./duels.cjs");
    const scoresMap = {};
    for (const r of rows) scoresMap[r.userId] = Number(r.points || 0);
    // outcome ZORUNLU: duels puanı "sonucu doğru bildi mi" kararını buna göre
    // verir. Geçilmezse toplam puana düşer ve yanlış sonuç ödüllenebilir.
    const duelRes = await settleDuelsForFixture(fid, scoresMap, db, outcome);
    if (duelRes.settled > 0) {
      console.log(`[settle2] ${duelRes.settled} duello kapandı — fixture ${fid}`);
    }
  } catch (e) {
    console.error("[settle2] duello settlement başarısız:", e);
  }

  const nowISO = new Date().toISOString();

  await writeJson(LEADERBOARD_FILE, { items: rows, updatedAt: nowISO });

  // ✅ match-results snapshot (kalıcı maç bazlı kayıt + idempotency sentinel)
  try {
    const fxMap = await buildFixtureMetaMap();
    const fxMeta = fxMap.get(fid) || {};

    await upsertMatchResultSnapshot({
      db,
      fixtureId: fid,
      finalScore: { home: h, away: a },
      meta: {
        fixtureId: fid,
        home: fxMeta.home || null,
        away: fxMeta.away || null,
        kickoffISO: fxMeta.kickoffISO || st.kickoffISO || null,
        league: fxMeta.league || st.league || null,
        country: fxMeta.country || st.country || null,
        status: st.status || "FT",
      },
      rows,
      awardedAt: nowISO, // ← idempotency sentinel: tekrar yatırma
    });
  } catch (e) {
    console.error("[settle2] match-results snapshot write failed:", e);
  }

  // ─── Kümülatif sezon toplamları ───────────────────────────────────────
  //
  // ⚠️ ÖNCE MONGO. Bu blok uzun süre YALNIZCA totals.json'a yazıyordu, oysa
  // routes/leaderboard.cjs birincil kaynak olarak `season_totals` koleksiyonunu
  // sorguluyor — ki oraya HİÇBİR YERDEN yazılmıyordu. Sonuç zinciri:
  //   season_totals boş → leaderboard totals.json'a düşüyor → Render'da disk
  //   kalıcı değil → HER DEPLOY'DA TÜM SEZON PUANLARI SIFIRLANIYOR.
  // Hata sessizdi: boş koleksiyon hata vermez, fallback de yerelde dolu.
  //
  // `$inc` GÖRELİ: dosyadan okunan bir değere dayanmaz, bu yüzden kilit
  // gerektirmez ve eşzamanlı settle'lar birbirinin puanını ezmez. Dosya
  // tarafındaki read-modify-write ise kullanıcı sayısıyla büyür.
  if (db) {
    try {
      /**
       * ⚠️ SEZON MAÇIN SEZONU, ÖDÜLÜN DEĞİL.
       *
       * `Season.seasonKey()` argümansız çağrılıyordu, yani ŞU AN. Ayın son
       * akşamı oynanan bir maç gece yarısını geçince ödülü ertesi aya —
       * yani BİR SONRAKİ SEZONA — yazılıyordu.
       *
       * ÖLÇÜLDÜ (2026-08-02, 1024 eşleşen snapshot): 9 uzlaştırma yanlış
       * sezona düşmüş. Hepsi aynı desende:
       *     MK-LLANEL-2026-07-31-NEWPOR  mac=2026-07  odul=2026-08
       * Nadir bir kaza değil, HER AY tekrarlayan sınır davranışı: ayın son
       * günü geç başlayan maçların tamamı.
       *
       * Etkisi sıralamada: o puanlar Temmuz'un tablosunda hiç görünmüyor,
       * Ağustos'unkini şişiriyor. Oyuncu maçı Temmuz'da oynadı.
       *
       * ⚠️ KICKOFF FİKSTÜR KAYDINDAN OKUNUYOR: canlı durum dosyası taşımıyor
       * (ölçüldü: 200 dosyanın 199'unda `kickoffISO` yok). Aynı sebeple
       * home/away de fikstürden tamamlanıyor — bkz. yukarıdaki `st` zenginleştirme.
       *
       * ⚠️ OKUNAMAZSA ŞU ANKİ SEZONA DÜŞÜLÜYOR: puanı hiç yazmamaktansa
       * muhtemelen doğru olan sezona yazmak iyidir.
       */
      let sezon = Season.seasonKey();
      try {
        const fxSezon = await FixturesStore.getOne(fid, db);
        const ko = fxSezon?.kickoffISO || null;
        if (ko) {
          const macSezon = Season.seasonKey(new Date(ko));
          if (macSezon && macSezon !== sezon) {
            console.warn(`[settle2] sezon sinirinda: ${fid} macSezon=${macSezon} simdi=${sezon} — MAC sezonuna yaziliyor`);
            sezon = macSezon;
          }
        }
      } catch (e) {
        console.error("[settle2] mac sezonu okunamadi, simdiki sezona yaziliyor:", e?.message || e);
      }
      const ops = rows.map((r) => {
        const uid = String(r.userId);
        const ceza =
          Number(r.detail?.zeroPenalty || 0) +
          Number(r.detail?.redSidePenalty || 0) +
          Number(r.detail?.penaltySidePenalty || 0);
        return {
          updateOne: {
            // Sezon anahtarı bileşik anahtarın parçası: aynı oyuncunun her
            // sezonu AYRI belge, geçmiş sezonlar arşiv olarak duruyor.
            // bkz. lib/season.cjs
            filter: { season: sezon, userIdLower: uid.toLowerCase() },
            update: {
              $inc: {
                totalPoints: Number(r.points || 0),
                totalPenalty: ceza,
                matches: 1,
              },
              $set: { userId: uid, lastAt: nowISO, updatedAt: nowISO },
              $setOnInsert: { season: sezon, userIdLower: uid.toLowerCase(), createdAt: nowISO },
            },
            upsert: true,
          },
        };
      });
      if (ops.length) {
        await db.collection("season_totals").bulkWrite(ops, { ordered: false });
      }
    } catch (e) {
      // Sessiz kalmıyoruz: bu, kaybolan SEZON İLERLEMESİ demek.
      console.error("[settle2] season_totals yazilamadi:", e?.message || e);
    }
  }

  // Kümülatif toplamlar (dosya aynası): read-modify-write, kilit şart. İki maç
  // aynı anda sonuçlanırsa (livescore-sync toplu settle) kilitsiz hâlde biri
  // diğerinin puanını ezer.
  // ⚠️ AYRI BAYRAK: cüzdan aynasına bağlamak yanlıştı. totals.json'ı okuyan
  // rotalar (groups, friends, users, totals-read) cüzdandan bağımsız; cüzdan
  // aynası kapatıldığında grup/arkadaş tabloları sessizce boşalırdı.
  // Hepsi artık lib/season-totals.cjs üzerinden Mongo öncelikli okuyor, ama
  // bayrak varsayılan AÇIK: geçiş doğrulanana kadar dosya yedeği dursun.
  const totalsNeedFile = !db || TOTALS_FILE_MIRROR;
  if (totalsNeedFile) {
    await withFileLock(TOTALS_FILE, async () => {
      const totalsRaw = await readJson(TOTALS_FILE, { items: [], updatedAt: null });

      const map = new Map();
      for (const it of totalsRaw.items || []) {
        map.set(String(it.userId), {
          userId: String(it.userId),
          totalPoints: Number(it.totalPoints || 0),
          totalPenalty: Number(it.totalPenalty || 0),
          matches: Number(it.matches || 0),
          lastAt: it.lastAt || null,
        });
      }

      for (const r of rows) {
        const key = String(r.userId);
        const cur = map.get(key) || { userId: key, totalPoints: 0, totalPenalty: 0, matches: 0, lastAt: null };

        cur.totalPoints += Number(r.points || 0);
        cur.totalPenalty +=
          Number(r.detail?.zeroPenalty || 0) +
          Number(r.detail?.redSidePenalty || 0) +
          Number(r.detail?.penaltySidePenalty || 0);

        cur.matches += 1;
        cur.lastAt = nowISO;
        map.set(key, cur);
      }

      const outTotals = {
        items: Array.from(map.values()).map((x) => ({
          ...x,
          totalPoints: Math.round(x.totalPoints),
          totalPenalty: Math.round(x.totalPenalty),
        })),
        updatedAt: nowISO,
      };
      await writeJson(TOTALS_FILE, outTotals);
    });
  }

  return {
    fixtureId: fid,
    finalScore: { home: h, away: a },
    outcome,
    firstGoal: fg,
    redAny: redAnyActual,
    redSide: redSideActual,
    penaltyAny: penaltyAnyActual,
    penaltySide: penaltySideActual,
    leaderboard: rows,
    competitionIds,
    streakAwards,
  };
}

/* ======================
 * TOURNAMENT AUTO-SETTLE
 * ====================== */


// Turnuvalar Mongo birincil — bkz. lib/social-store.cjs
async function loadTournaments(db) {
  return SocialStore.loadTournaments(db || null);
}

/* ⚠️ `saveTournaments` SARMALI KALDIRILDI — bkz. tryAutoSettleTournaments
 * içindeki mühür notu. Bu fonksiyon `SocialStore.saveTournaments` → `replaceAll`
 * ile TÜM turnuva koleksiyonunu çağıranın snapshot'ıyla değiştiriyordu; buradan
 * çağrılan tek yer auto-settle'ın sonuydu ve araya giren atomik yazmaları
 * siliyordu. Sarmal duruyor olsaydı aynı çağrı kolayca geri gelirdi. */

async function getFixtureOutcome(fid) {
  const st = await readJson(stateFile(fid), null);
  if (!st || String(st.status) !== "FT") return null;
  const h = Number(st.score?.home ?? 0);
  const a = Number(st.score?.away ?? 0);
  return h > a ? "H" : a > h ? "A" : "D";
}

async function tryAutoSettleTournaments(settledFixtureId, settledOutcome, db) {
  try {
    const all = await loadTournaments(db);
    const open = all.filter(
      (t) => t.status === "open" && Array.isArray(t.fixtureIds) && t.fixtureIds.includes(settledFixtureId)
    );
    if (!open.length) return;

    /**
     * ⚠️ PUANLAMA VE ÖDEME HESABI TEK KAYNAKTAN (services/tournament.cjs).
     *
     * BURADA hesabın KOPYASI vardı ve AYRIŞMIŞTI: kopya hâlâ
     * `Math.round(t.pool * pct)` kullanıyordu — fazla-ödeme kusuru ve n=1
     * normalleştirmesi yalnızca servis tarafında düzeltilmişti. Üstelik canlı
     * yol BU: settle2 her maç sonuçlandığında tetikleniyor ve mührü neredeyse
     * hep o alıyor; elle çağrılan uç nadir. Yani düzeltme nadir yolda,
     * kusur canlı yolda duruyordu.
     *
     * ÖLÇÜLDÜ (1536 senaryo, n=1..16 × giriş=5..100, buradaki eski kuralla):
     *     %23.4 havuzdan FAZLA ödeme  ← yoktan LC (turnuva başına +1..+2)
     *     %6.6  havuzdan EKSİK ödeme  ← yakılan LC (n=1'de 30 LC'ye kadar)
     * Ortak hesap 1536/1536 senaryoda havuza TAM eşit.
     *
     * PUANLAMA da aynı sebeple toplandı: onun kopyası da buradaydı ve servis
     * tarafıyla ayrışmıştı (`t.fixtures` yokken orası patlıyor, burası tolere
     * ediyordu). Aynı hatanın ikinci kez aynı fonksiyonda çıkması, kopyanın
     * kendisinin kusur olduğunu gösteriyor.
     */
    const { odemePaylari, puanlariHesapla, _ucretIadeEt } = require("../services/tournament.cjs");
    const nowISO = new Date().toISOString();

    for (const t of open) {
      // Check all fixtures have FT results
      const results = {};
      let allDone = true;
      for (const fid of t.fixtureIds) {
        const outcome = fid === settledFixtureId ? settledOutcome : await getFixtureOutcome(fid);
        if (!outcome) { allDone = false; break; }
        results[fid] = { outcome };
      }
      if (!allDone) {
        // Turnuva 7 gunden eski ve hala tum fiksturler FT degil — iptal + iade.
        const ZAMAN_ASIMI_GUN = 7;
        const olusturma = new Date(t.createdAt || 0).getTime();
        const gecenGun = (Date.now() - olusturma) / 86400000;
        if (gecenGun >= ZAMAN_ASIMI_GUN) {
          /* ⚠️ İPTAL ALANLARI MÜHÜRLE AYNI İŞLEMDE YAZILIR.
           *
           * `claimTournamentSettle` koşulsuz `status:"settled"` yazıyor; iptal
           * hâli eskiden döngü sonundaki toptan `saveTournaments` ile
           * DÜZELTİLİYORDU. O yazma kaldırıldığı için alanlar mühre taşındı —
           * taşınmasaydı iptal edilen turnuva "settled" damgasıyla, iade
           * edilmiş ücretlere rağmen sonuçlanmış görünürdü. Ek alanlar
           * varsayılanlardan SONRA yayılıyor, yani "voided" kazanıyor. */
          const bizimki = await SocialStore.claimTournamentSettle(t.id, nowISO, db, {
            status: "voided",
            voidReason: "FIXTURE_TIMEOUT",
            payouts: [],
          });
          if (!bizimki) continue;
          t.status = "voided";
          t.settledAt = nowISO;
          t.voidReason = "FIXTURE_TIMEOUT";
          t.payouts = [];
          for (const p of (t.participants || [])) {
            const uid = p.userId || p;
            if (!uid) continue;
            try {
              await _ucretIadeEt(db, uid, t.entryLC || t.entryFee || 0, "timeout_void");
            } catch (e) {
              console.error("[settle2] turnuva zaman asimi iadesi basarisiz:", uid, e?.message || e);
            }
          }
          console.log(`[settle2] turnuva ${t.code} zaman asimi ile iptal edildi (${Math.floor(gecenGun)} gun)`);
        }
        continue;
      }

      // Puanlama TEK KAYNAKTAN — kopyası burada yaşıyordu ve servis
      // tarafındakiyle ayrışmıştı (bkz. services/tournament.cjs
      // puanlariHesapla): `t.fixtures` yokken servis yolu TypeError atıyor,
      // bu yol tolere ediyordu. Aynı turnuva, hangi yoldan sonuçlandığına
      // göre farklı davranıyordu.
      const sorted = puanlariHesapla(t, results);

      // Tek kaynak: normalleştirme + en büyük kalan (bkz. yukarıdaki not).
      const { paylar, tablo } = odemePaylari(t.pool, sorted.length);
      t.payouts = paylar.map((lcWon, i) => ({
        rank: i + 1,
        userId: sorted[i].userId,
        score: sorted[i].totalScore,
        lcWon,
        pct: Math.round(tablo[i] * 100),
      }));

      const odenecek = t.payouts.reduce((a, p) => a + Number(p.lcWon || 0), 0);
      if (odenecek > Number(t.pool || 0)) {
        console.error(
          `[settle2] ODEME HAVUZU ASIYOR: ${t.code || t.id} havuz=${t.pool} odenecek=${odenecek} — odeme yapilmadi`
        );
        continue;
      }

      // ⚠️ PARA KORUMASI — MÜHÜR ÖDEMEDEN ÖNCE.
      // Eskiden burada yalnızca bellekteki nesne işaretleniyor, kayıt ise
      // ~60 satır aşağıda (döngünün TAMAMI bittikten sonra) yapılıyordu.
      // O pencerede ikinci bir settle çağrısı turnuvayı hâlâ "open" görüp
      // ödemeyi TEKRAR yapardı; settle2 aynı fixture için livescore-sync,
      // af-sync ve manuel çağrılardan tetiklenebiliyor.
      // claimTournamentSettle koşulu (status:"open") yazmanın içinde tutuyor.
      //
      // ⚠️ `payouts` DA BU İŞLEMDE YAZILIR — eskiden döngünün sonundaki toptan
      // `saveTournaments` yazıyordu (bkz. oradaki not). Ödeme tablosu mühürle
      // aynı anda kayda geçmezse, mühürden sonra süreç düşerse turnuva
      // "settled" ama ödemesiz kalır.
      const bizimki = await SocialStore.claimTournamentSettle(t.id, nowISO, db, {
        payouts: t.payouts,
      });
      if (!bizimki) {
        console.log(`[settle2] turnuva ${t.code || t.id} baska bir cagri tarafindan odendi — atlaniyor`);
        continue;
      }

      t.status = "settled";
      t.settledAt = nowISO;

      /* ⚠️ KATILIMCI PUANLARI AYRI VE HEDEFLİ YAZILIR.
       *
       * `puanlariHesapla` her katılımcının `totalScore` alanını doldurur ve bu
       * değer `GET /api/tournaments/:code` ile istemciye dönüyor. `payouts`
       * yerine geçmez: ödeme tablosu yalnızca ilk 3-4 sırayı kapsıyor, geri
       * kalan katılımcılar puanlarını yalnızca buradan görüyor.
       *
       * `participants` dizisini toptan yazmak DÜZELTİLEN KUSURU belge ölçeğinde
       * geri getirirdi (yukarıdaki `all` snapshot'ından beri gelen bir katılım
       * silinirdi); `setTournamentScoresAtomik` arrayFilters ile yalnızca adı
       * geçen katılımcının tek alanına dokunuyor. */
      await SocialStore.setTournamentScoresAtomik(
        t.id,
        sorted.map((p) => ({ userId: p.userId, totalScore: p.totalScore })),
        db
      );

      // Credit winners' wallets. Ayna kapalı + Mongo varken dosya hiç
      // açılmaz; kilit de gereksizdir (bkz. awardLcForRows).
      const payoutNeedFile = !db || WALLET_FILE_MIRROR;
      const runPayouts = async () => {
      const walletState =
        (payoutNeedFile
          ? await readJson(WALLET_FILE, { users: [], ledger: [], updatedAt: null })
          : { users: [], ledger: [], updatedAt: null }) || {};
      if (!Array.isArray(walletState.users)) walletState.users = [];
      if (!Array.isArray(walletState.ledger)) walletState.ledger = [];

      for (const payout of t.payouts) {
        if (!payout.lcWon || payout.lcWon <= 0) continue;
        const uid = payout.userId;
        const uidLower = uid.toLowerCase();
        if (payoutNeedFile) {
          let wu = walletState.users.find(x => String(x.userId || "").toLowerCase() === uidLower);
          if (!wu) {
            wu = { userId: uid, balance: 0, createdAt: nowISO, updatedAt: nowISO, lastDailyAt: null, totalEarned: 0, totalSpent: 0 };
            walletState.users.push(wu);
          }
          wu.balance = (wu.balance || 0) + payout.lcWon;
          wu.totalEarned = (wu.totalEarned || 0) + payout.lcWon;
          wu.updatedAt = nowISO;
          walletState.ledger.push({
            id: "tx_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8),
            userId: uid, kind: "reward", amount: payout.lcWon,
            reason: "tournament_payout", meta: { tournamentCode: t.code, rank: payout.rank },
            createdAt: nowISO,
          });
        }

        if (db) {
          try {
            const col = db.collection("lc_wallet_users");
            await col.updateOne(
              { userIdLower: uidLower },
              { $inc: { balance: payout.lcWon, totalEarned: payout.lcWon }, $set: { updatedAt: nowISO }, $setOnInsert: { userId: uid, userIdLower: uidLower, createdAt: nowISO, lastDailyAt: null, totalSpent: 0 } },
              { upsert: true }
            );
            const ledgerCol = db.collection("lc_wallet_ledger");
            await ledgerCol.insertOne({ id: "tx_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8), userId: uid, userIdLower: uidLower, kind: "reward", amount: payout.lcWon, reason: "tournament_payout", meta: { tournamentCode: t.code, rank: payout.rank }, createdAt: nowISO });
          } catch (e) {
            // ⚠️ Turnuva `claimTournamentSettle` ile ÇOKTAN mühürlü: bu ödeme
            // tekrar denenmez. Yalnızca log bırakmak parayı geri getirmez.
            console.error("[settle2] ⛔ TURNUVA ODEMESI YAZILAMADI:", e?.message || e);
            await WalletCredit.kayipOdulKaydet(db, {
              kaynak: "tournament_payout",
              tournamentCode: t.code,
              rank: payout.rank,
              odemeler: [{ userIdLower: uidLower, tutar: payout.lcWon }],
              beklenen: 1,
              eksik: 1,
              neden: String(e?.message || e),
            });
          }
        }
      }

      if (payoutNeedFile) {
        walletState.updatedAt = nowISO;
        await writeJson(WALLET_FILE, walletState);
      }
      }; // runPayouts

      if (payoutNeedFile) await withFileLock(WALLET_FILE, runPayouts);
      else await runPayouts();
      console.log(`[settle2] auto-settled tournament ${t.code}: ${t.payouts.length} payouts`);
    }

    /**
     * ⚠️ BURADA `await saveTournaments(all, db)` VARDI — TÜM KOLEKSİYONU
     * FONKSİYONUN BAŞINDA ALINMIŞ SNAPSHOT'LA DEĞİŞTİRİYORDU.
     *
     * `SocialStore.saveTournaments` → `replaceAll`: koleksiyonun tamamı verilen
     * listeye eşitleniyor. `all` ise ~200 satır yukarıda okundu; arada geçen
     * sürede BAŞKA turnuvalara yapılan her yazma — katılım, tahmin, yeni
     * turnuva — snapshot'ta yok olduğu için SİLİNİYORDU. Ücret tahsil edilmiş,
     * uç `ok:true` dönmüş, kullanıcı turnuvada görünmüyor; kimse hata görmüyor
     * çünkü `replaceAll` başarıyla tamamlanıyor.
     *
     * Aralık kısa değil: bu döngü her turnuva için fikstür durum dosyalarını
     * okuyor ve kazananların cüzdanlarına tek tek yazıyor.
     *
     * ÖLÇÜLDÜ (aynı sınıf, services/tournament.cjs settle): A turnuvası
     * sonuçlanırken B'ye katılım geldi; `join` BAŞARILI döndü ama B'nin
     * katılımcı listesinde yoktu, 10 LC gitmişti.
     *
     * Yerine geçen üç hedefli yazma — hepsi tek belge, hiçbiri snapshot
     * taşımıyor:
     *   1. mühür + `payouts`                    (normal yol)
     *   2. mühür + `status:"voided"`/`voidReason`/`payouts:[]` (zaman aşımı)
     *   3. `setTournamentScoresAtomik`          (katılımcı puanları)
     */
  } catch (e) {
    console.error("[settle2] tryAutoSettleTournaments failed:", e);
  }
}

/**
 * POST /api/rt/settle2
 * 🔒 Sadece localhost'tan (livescore-sync, af-sync) veya admin token ile çağrılabilir.
 * Aksi halde birisi ham HTTP ile POST atarak totals'a defalarca puan yatırtabilir.
 * (Idempotency de var — awardedAt sentinel — ama katmanlı savunma.)
 */
/**
 * ⚠️ BURADA ZAYIF BİR KOPYA VARDI ve sağlamlaştırılmış sürüm ZATEN MEVCUTTU.
 *
 * `lib/internal-caller.cjs` tam bu boşluğu kapatmak için yazılmış ve kendi
 * başlığında farkı açıkça anlatıyor: "ters proxy loopback üzerinden
 * bağlanıyorsa yalnızca soket adresine bakmak DIŞ TRAFİĞİ İÇ SAYABİLİR".
 * Yani fark biliniyordu, yazılmıştı — ama yalnızca `routes/pred.cjs`
 * geçirilmiş, bu dosya eski kopyayla kalmıştı.
 *
 * Önemi: bu ucun kendi yorumu neyin tehlikede olduğunu söylüyor — "birisi ham
 * HTTP ile POST atarak totals'a defalarca puan yatırtabilir". Önündeki ters
 * proxy uygulamaya loopback üzerinden ulaşıyorsa `/api/rt/settle2` tüm
 * internete KİMLİKSİZ açık olurdu.
 */
const { isInternalCaller } = require("../lib/internal-caller.cjs");

router.post("/settle2", async (req, res) => {
  try {
    if (!isInternalCaller(req)) {
      return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
    }
    const fixtureId = String(req.query.fixtureId || req.body?.fixtureId || "");
    const db = req.app?.locals?.db || null;

    // Maç bazlı kilit artık scoreFixture'ın İÇİNDE (bkz. oradaki not).
    // Burada tekrar sarmak aynı anahtarla iç içe kilit demek olurdu —
    // withFileLock reentrant değildir, süreç kilitlenirdi.
    const result = await scoreFixture(fixtureId, { updateTotals: true, db });

    // Fire-and-forget: tournaments that include this fixture
    tryAutoSettleTournaments(fixtureId, result.outcome, db).catch(() => {});

    return res.json({ ok: true, ...result });
  } catch (e) {
    console.error("SAFE_SETTLE2_FAILED", e);
    const status = e && e.httpStatus ? e.httpStatus : 500;
    const code = e && e.code ? e.code : "SAFE_SETTLE2_FAILED";

    const payload = {
      ok: false,
      error: code,
      detail: String(e && (e.message || e)),
    };

    if (e && e.code === "STATE_NOT_FOUND" && e.detailObj) {
      payload.debug = e.detailObj;
    }

    return res.status(status).json(payload);
  }
});

/**
 * GET /api/rt/pred/preview-match-board?fixtureId=...
 * ✅ yan etkisiz preview (history snapshot okumaz; anlık hesaplar)
 */
router.get("/pred/preview-match-board", async (req, res) => {
  try {
    const fixtureId = String(req.query.fixtureId || "");
    const result = await scoreFixture(fixtureId, { updateTotals: false, db: null });
    return res.json({ ok: true, ...result });
  } catch (e) {
    console.error("MATCH_BOARD_FAILED", e);
    const status = e && e.httpStatus ? e.httpStatus : 500;
    const code = e && e.code ? e.code : "MATCH_BOARD_FAILED";

    const payload = {
      ok: false,
      error: code,
      detail: String(e && (e.message || e)),
    };
    if (e && e.code === "STATE_NOT_FOUND" && e.detailObj) {
      payload.debug = e.detailObj;
    }

    return res.status(status).json(payload);
  }
});

/**
 * GET /api/rt/match-race?fixtureId=...&userId=...&top=50
 *
 * 🔥 Canlı eleme panosu: admin/af-sync maç durumunu her güncellediğinde
 * (dk 16, 0-1, kırmızı kart, penaltı...) TÜM tahminler anlık state'e göre
 * yeniden puanlanır. Dönen veri:
 *  - top: ilk N (herkese görünür liste)
 *  - me: isteği yapan kullanıcının ANLIK sırası (örn. 351.), puanı,
 *        tahmini hâlâ "tutuyor" mu (outcome == anlık outcome)
 *  - totalPlayers: maça tahmin giren toplam kişi
 *  - inRaceCount: tahmini şu anki skorla hâlâ tutan kişi (3000 -> 1200 -> 400)
 *  - state: dakika/skor/durum özeti
 * Yan etkisizdir (totals'a yazmaz). Az-sorgu modeliyle uyumlu: veri
 * data/live state dosyasından gelir; sağlayıcıya istek atmaz.
 */
router.get("/match-race", optionalToken, async (req, res) => {
  try {
    const fixtureId = String(req.query.fixtureId || "").trim();
    const userId = String(req.query.userId || "").trim();
    const topN = Math.max(1, Math.min(100, Number(req.query.top || 50)));
    if (!fixtureId) return res.status(400).json({ ok: false, error: "FIXTURE_ID_REQUIRED" });

    // Tüm tahminleri ve fixture bilgisini oku
    const db = req.app?.locals?.db || null;
    const fixturePreds = await loadFixturePreds(fixtureId, db);

    // Fixture bilgisi (home/away/date)
    const fixtures = await loadFixturesList(db);
    const fxInfo = fixtures.find((f) => String(f.fixtureId || f.id) === fixtureId);

    let result = null;
    let st = null;
    try {
      result = await scoreFixture(fixtureId, { updateTotals: false, db: null, allowLive: true });
      st = await readJson(stateFile(fixtureId), null);
    } catch (_ignore) {
      // Maç henüz başlamadı — pre-match moduna düş
    }

    // Kullanıcı isim haritası: userId → displayName.
    // Yalnızca BU MAÇIN katılımcıları çekilir — eskiden tüm kullanıcı dosyası
    // okunup herkesin adı belleğe alınıyordu.
    const katilimciIds = [
      ...new Set(fixturePreds.map((p) => String(p.userId || p.user || "")).filter(Boolean)),
    ];
    const usersItems = Object.values(
      await UsersStore.getUsersByIdsLower(katilimciIds, req.app?.locals?.db || null)
    );
    const nameMap = new Map();
    for (const u of usersItems) {
      const uid = String(u.userId || "");
      nameMap.set(uid, u.nickname || u.displayName || uid);
    }
    const getName = (uid) => {
      const name = nameMap.get(uid);
      if (name && name !== uid) return name;
      return uid.length > 12 ? uid.slice(0, 8) + "…" : uid;
    };

    // Pre-match: scoreFixture başarısız → katılımcı listesi döndür
    if (!result) {
      // Sadece skor tahmini yapanlar yarışa dahil
      /**
       * ⚠️ MAÇ BAŞLAMADAN HERKESİN TAM SKOR TAHMİNİ SIZIYORDU.
       *
       * Uçta hiçbir kimlik denetimi yoktu ve `predScore` TÜM katılımcılar
       * için dönüyordu. Ölçüldü (2026-08-02, kickoff'a 3 saat kalan NS maç,
       * ilgisiz kimlikle istek):
       *     RAKIP1  predScore={"home":3,"away":1}
       *     RAKIP2  predScore={"home":0,"away":2}
       *     BEN     predScore={"home":1,"away":1}
       *
       * Rakiplerin skorunu görüp ona göre tahmin girmek doğrudan avantaj;
       * düelloda ve havuzda paraya dönüşür. Aynı sınıf aynı gün `pool.myBet`,
       * `weekly-picks`, `stats/user`, `friends/list` ve mini profil bakiyesinde
       * bulundu — `lib/kimlik-kontrol.cjs` bu dersi yazmış.
       *
       * ⚠️ YALNIZCA MAÇ ÖNCESİ KISITLANIYOR. Maç başladıktan sonra tahminler
       * KİLİTLİ (bkz. TAHMIN_KILIT_DK) — o noktada kimin ne dediğini görmek
       * yarışın kendisi, gizlenecek bir şey değil. Bu yüzden `phase: "race"`
       * yolundaki `predScore` olduğu gibi kalıyor.
       *
       * ⚠️ KATILIMCI LİSTESİ GİZLENMİYOR: "kim yarışta" bilgisi ekranın işi;
       * gizli olan yalnızca NE tahmin ettiği.
       */
      const istekSahibi = String(req.uid || "").trim().toLowerCase();
      const participants = fixturePreds
        .filter((p) => p.home != null && p.away != null)
        .map((p) => {
          const uid = String(p.userId || p.user || "");
          const benim = !!istekSahibi && uid.toLowerCase() === istekSahibi;
          return {
            userId: uid,
            displayName: getName(uid),
            joinedAt: p.createdAt || p.timestamp || null,
            /* Alan HİÇ gönderilmiyor (null değil): istemci koşullu basıyor,
             * null göndermek de "tahmin yok" gibi yanlış okunurdu. */
            ...(benim ? { predScore: { home: p.home, away: p.away } } : {}),
          };
        });
      const meJoined = userId
        ? participants.some((p) => p.userId.toLowerCase() === userId.toLowerCase())
        : false;
      return res.json({
        ok: true,
        fixtureId,
        phase: "pre",
        state: {
          status: "NS",
          home: fxInfo?.home || null,
          away: fxInfo?.away || null,
          date: fxInfo?.date || fxInfo?.dateEvent || null,
          time: fxInfo?.time || null,
          league: fxInfo?.league || null,
        },
        totalPlayers: participants.length,
        participants: participants.slice(0, topN),
        meJoined,
      });
    }

    // Canlı / biten maç — skor bazlı yarış mantığı
    const rows = (result.leaderboard || []).slice();

    // Her kullanıcının tahmini skorunu ve outcome'ını haritala
    const predByUser = new Map();
    for (const p of fixturePreds) {
      const uid = String(p.userId || p.user || "").trim().toLowerCase();
      if (!uid) continue;
      predByUser.set(uid, {
        home: p.home != null ? Number(p.home) : null,
        away: p.away != null ? Number(p.away) : null,
        outcome: String(p.outcome || "").toUpperCase() || null,
      });
    }

    // Gerçek skor
    const actualScore = st?.score || result.finalScore || null;
    const actH = actualScore ? Number(actualScore.home) : 0;
    const actA = actualScore ? Number(actualScore.away) : 0;

    // Sadece skor tahmini yapanlar yarışa alınır
    const scoredRows = rows.filter((r) => {
      const uid = String(r.userId || "").toLowerCase();
      const pred = predByUser.get(uid);
      return pred && pred.home != null && pred.away != null;
    });

    let inRaceCount = 0;
    const decorated = scoredRows.map((r) => {
      const uidLower = String(r.userId || "").toLowerCase();
      const pred = predByUser.get(uidLower);
      const predScore = { home: pred.home, away: pred.away };
      // Gerçek skor tahmini aştıysa imkansız → elendi
      const inRace = actH <= pred.home && actA <= pred.away;
      const distance = Math.abs(pred.home - actH) + Math.abs(pred.away - actA);
      if (inRace) inRaceCount++;
      return {
        rank: 0,
        userId: r.userId,
        displayName: getName(r.userId),
        points: Math.round((r.points || 0) * 100) / 100,
        inRace,
        distance,
        predScore,
      };
    });

    // Sıralama: yarışta olanlar önce, sonra distance (küçük=iyi), sonra puan (büyük=iyi)
    decorated.sort((a, b) => {
      if (a.inRace !== b.inRace) return a.inRace ? -1 : 1;
      const dA = a.distance ?? 999;
      const dB = b.distance ?? 999;
      if (dA !== dB) return dA - dB;
      return (b.points || 0) - (a.points || 0);
    });
    decorated.forEach((r, i) => { r.rank = i + 1; });

    let me = null;
    if (userId) {
      const mine = decorated.find((r) => String(r.userId).toLowerCase() === userId.toLowerCase());
      if (mine) me = mine;
    }

    return res.json({
      ok: true,
      fixtureId,
      phase: "live",
      state: {
        status: st?.status || "NS",
        minute: st?.minute ?? null,
        score: st?.score || result.finalScore || null,
        home: st?.home || null,
        away: st?.away || null,
        firstGoal: result.firstGoal || null,
        redAny: result.redAny || false,
        penaltyAny: result.penaltyAny || false,
        updatedAt: st?.updatedAt || null,
      },
      totalPlayers: decorated.length,
      inRaceCount,
      top: decorated.slice(0, topN),
      me,
    });
  } catch (e) {
    const status = e && e.httpStatus ? e.httpStatus : 500;
    return res.status(status).json({
      ok: false,
      error: (e && e.code) || "MATCH_RACE_FAILED",
      detail: String(e && (e.message || e)),
    });
  }
});

/**
 * GET /api/rt/user-profile?userId=<target>
 * Herkese açık mini profil: puan, maç sayısı, üyelik tarihi, rütbe bilgisi
 */
router.get("/user-profile", optionalToken, async (req, res) => {
  try {
    const targetId = String(req.query.userId || "").trim();
    if (!targetId) return res.status(400).json({ ok: false, error: "USER_ID_REQUIRED" });

    const tidLower = targetId.toLowerCase();
    /* Kimlik JETONDAN; `?userId=` yalnızca kendi kimliğiyle eşleşirse sahip
     * sayılır. bkz. lib/kimlik-kontrol.cjs — aynı ders bugün yedi yerde. */
    const sahibiMi = String(req.uid || "").trim().toLowerCase() === tidLower && !!req.uid;

    // totals.json → puan & maç sayısı
    const totalsRaw = await readJson(TOTALS_FILE, { items: [] });
    const totalsRow = (totalsRaw.items || []).find(
      (r) => String(r.userId || "").toLowerCase() === tidLower
    );

    // Üyelik tarihi — tek kullanıcı, indeksli sorgu (eskiden tüm dosya).
    const userRow =
      (await UsersStore.getUsersByIdsLower([tidLower], req.app?.locals?.db || null))[tidLower] || null;

    // lc-wallet.json → LC bakiye
    const walletRaw = await readJson(WALLET_FILE, { users: [] });
    const walletRow = (walletRaw.users || []).find(
      (u) => String(u.userId || "").toLowerCase() === tidLower
    );

    // Toplam tahmin sayısı. Bu count `{userIdLower}` üzerinden gidiyor ve o
    // alan UZUN SÜRE indekssizdi (mevcut indekslerin ikisi de fixtureId ile
    // başlıyor, bileşik indeks ön ekle çalışır) — yani buradaki yorum "indeksli
    // count" diyordu ama gerçekte 47 bin belge taranıyordu. İndeks
    // scripts/ensure-indexes.cjs içinde eklendi; ölçüm oradaki notta.
    // ⚠️ İndeks kurulmadan deploy edilirse burası yine tam tarama yapar.
    const dbRef = req.app?.locals?.db || null;
    let predCount;
    if (dbRef) {
      predCount = await dbRef.collection("predictions").countDocuments({ userIdLower: tidLower });
    } else {
      const predsRaw = await readJson(PREDS_FILE, []);
      const predsAll = Array.isArray(predsRaw) ? predsRaw : predsRaw.items || [];
      predCount = predsAll.filter(
        (p) => String(p.userId || p.user || "").toLowerCase() === tidLower
      ).length;
    }

    // leaderboard sırası
    const allTotals = (totalsRaw.items || [])
      .slice()
      .sort((a, b) => (Number(b.totalPoints) || 0) - (Number(a.totalPoints) || 0));
    const globalRank = allTotals.findIndex(
      (r) => String(r.userId || "").toLowerCase() === tidLower
    );

    const totalPoints = Math.round(Number(totalsRow?.totalPoints || 0));
    const matches = Number(totalsRow?.matches || 0);

    return res.json({
      ok: true,
      userId: targetId,
      displayName: userRow?.nickname || userRow?.displayName || null,
      totalPoints,
      totalPenalty: Math.round(Number(totalsRow?.totalPenalty || 0)),
      matches,
      predCount,
      globalRank: globalRank >= 0 ? globalRank + 1 : null,
      totalPlayers: allTotals.length,
      joinedAt: userRow?.createdAt || walletRow?.createdAt || null,
      /**
       * ⚠️ LC BAKİYESİ YALNIZCA SAHİBİNE. Uç kimliksizdi ve HERKESİN
       * bakiyesini döndürüyordu; ölçüldü (2026-08-02):
       *     GET /api/rt/user-profile?userId=KURBAN  (jetonsuz) -> 200, lc: 1337
       *
       * Dosyanın kendi başlığı bile bunu vaat etmiyordu: "Herkese açık mini
       * profil: puan, maç sayısı, üyelik tarihi, rütbe bilgisi" — bakiye o
       * listede YOK, sonradan eklenmiş.
       *
       * ⚠️ SIZINTI DEĞİL, ÖZELLİK OLARAK KONMUŞTU: `match-race` ekranı rakibe
       * dokununca "💰 LC bakiye" satırını basıyordu. Ama bir tahmin oyununda
       * rakibin ne kadar parası olduğunu bilmek düello ve havuzda doğrudan
       * avantaj — bugün havuzdaki `myBet` sızıntısı aynı gerekçeyle kapatıldı.
       *
       * ⚠️ ALAN HİÇ GÖNDERİLMİYOR (0 değil): 0 göndermek "parası yok" gibi
       * okunur ve yine bilgi sızdırır. İstemci alanın yokluğunda satırı
       * gizliyor — `${undefined} LC` basmaması için mobil tarafta da
       * düzeltildi.
       */
      ...(sahibiMi ? { lc: Math.round(Number(walletRow?.balance || 0)) } : {}),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "PROFILE_FAILED", detail: String(e?.message || e) });
  }
});

/**
 * GET /api/rt/pred/history?userId=...&limit=50
 * ✅ Kullanıcının maç bazlı puan geçmişi (match-results.json)
 */
router.get("/pred/history", async (req, res) => {
  try {
    const userId = String(req.query.userId || "").trim();
    const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));

    if (!userId) return res.status(400).json({ ok: false, error: "USER_ID_REQUIRED" });

    const uidLower = userId.toLowerCase();
    // İndeksli sorgu: yalnızca bu kullanıcının geçtiği snapshot'lar.
    const snaps = await MatchResults.listSnapshots({
      db: req.app?.locals?.db || null,
      userIdLower: uidLower,
    });

    const out = [];
    for (const snap of snaps) {
      const rows = Array.isArray(snap.rows) ? snap.rows : [];
      const mine = rows.find((r) => String(r.userId || "").trim().toLowerCase() === uidLower);
      if (!mine) continue;

      out.push({
        fixtureId: snap.fixtureId,
        computedAt: snap.computedAt || null,
        points: mine.points ?? 0,
        detail: mine.detail || null,
        finalScore: snap.finalScore || null,
        meta: snap.meta || null,
      });

      if (out.length >= limit) break;
    }

    return res.json({ ok: true, userId, count: out.length, items: out });
  } catch (e) {
    return res
      .status(500)
      .json({ ok: false, error: "PRED_HISTORY_FAILED", detail: String(e && (e.message || e)) });
  }
});

/**
 * GET /api/rt/pred/history/detail?userId=...&fixtureId=...
 * ✅ Tek maç detayı: tahmin + gerçek + puan kırılımı
 */
router.get("/pred/history/detail", async (req, res) => {
  try {
    const userId = String(req.query.userId || "").trim();
    const fixtureId = normFid(req.query.fixtureId);

    if (!userId) return res.status(400).json({ ok: false, error: "USER_ID_REQUIRED" });
    if (!fixtureId) return res.status(400).json({ ok: false, error: "FIXTURE_ID_REQUIRED" });

    const snap = await MatchResults.getSnapshot(fixtureId, req.app?.locals?.db || null);
    if (!snap) return res.status(404).json({ ok: false, error: "MATCH_RESULT_NOT_FOUND" });

    const uidLower = userId.toLowerCase();
    const row =
      (Array.isArray(snap.rows) ? snap.rows : []).find(
        (r) => String(r.userId || "").trim().toLowerCase() === uidLower
      ) || null;

    // benim tahminim (son kaydı tercih eder) — Mongo primary varsa oradan
    const dbRef = req.app?.locals?.db || null;
    let myPred = null;
    if (dbRef) {
      myPred = await dbRef.collection("predictions").findOne({
        fixtureId,
        userIdLower: uidLower,
      });
    } else {
      const predsRaw = await readJson(PREDS_FILE, []);
      const preds = Array.isArray(predsRaw) ? predsRaw : Array.isArray(predsRaw?.items) ? predsRaw.items : [];
      myPred =
        preds
          .slice()
          .reverse()
          .find(
            (p) =>
              String(p.fixtureId) === fixtureId &&
              String(p.userId || "").trim().toLowerCase() === uidLower
          ) || null;
    }

    // state (varsa) — gerçek meta/FT kanıtı
    const st = await readJson(stateFile(fixtureId), null);

    return res.json({
      ok: true,
      userId,
      fixtureId,
      prediction: myPred || null,
      result: {
        finalScore: snap.finalScore || null,
        meta: snap.meta || null,
        state: st || null,
      },
      scoring: row ? { points: row.points ?? 0, detail: row.detail || null } : { points: 0, detail: null },
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: "PRED_HISTORY_DETAIL_FAILED",
      detail: String(e && (e.message || e)),
    });
  }
});

module.exports = router;

// Test edilebilirlik: iç fonksiyonlar dışa açılır. Router bir fonksiyon
// nesnesi olduğu için üzerine özellik eklenebilir — live2.cjs'teki
// (canonicalCountry) desenin aynısı. Uygulama davranışı değişmez.
module.exports.scoreFixture = scoreFixture;
module.exports.computeLcRewardFromDetail = computeLcRewardFromDetail;
module.exports.DATA_DIR = DATA_DIR;
// Turnuva otomatik sonuçlandırma: eşzamanlılık davranışı ancak DOĞRUDAN
// çağrılarak ölçülebiliyor — HTTP ucu üzerinden tetiklemek, ölçmek istenen
// yarışın etrafına fikstür dosyası + yetki katmanı koyuyor.
module.exports.tryAutoSettleTournaments = tryAutoSettleTournaments;
