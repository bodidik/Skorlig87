"use strict";

/**
 * 1987 Modu — haftalık basit tahmin
 *
 * Tüm maçları gösterir, maçtan 24 saat önce açılır.
 * Giriş bedeli herkes için macGirisBedeli(); 1987 üyesi ÖNCE bonus1987'den
 * öder, bonus bitince normal bakiyeden (30+30 tasarımı, 2026-08-08).
 * Sıralama: 1987 segmenti kendi aralarında (match-results.json üzerinden).
 */

const express = require("express");
const { ensurePredIndexes } = require("../lib/preds-index.cjs");
const router  = express.Router();
const fsp     = require("fs").promises;
const path    = require("path");
const { guvenliYol } = require("../lib/guvenli-dosya.cjs");
const { verifyToken, optionalToken } = require("../middleware/verifyToken.cjs");
const { withFileLock, writeJsonAtomic } = require("../lib/fileLock.cjs");

// ⚠️ SKORLIG_DATA_DIR: sabit yol testleri GERÇEK data/ dizinine yazdırır.
const DATA_DIR           = process.env.SKORLIG_DATA_DIR || path.join(__dirname, "..", "data");
const PREDS_FILE         = path.join(DATA_DIR, "preds.json");
const UsersStore = require("../lib/users-store.cjs");
const WALLET_FILE        = path.join(DATA_DIR, "lc-wallet.json");
const MatchResults = require("../lib/match-results.cjs");
// LC harcama: bakiye Mongo'da tutuluyor, dosyaya yazmak parayı kaybettirir.
const WalletCredit = require("../lib/wallet-credit.cjs");
const FixturesStore = require("../lib/fixtures-store.cjs");
const { fiksturKilidi } = require("../lib/fikstur-kilit.cjs");
const LIVE_DIR           = path.join(DATA_DIR, "live");

const WINDOW_BEFORE_MS = 24 * 60 * 60 * 1000;  // 24 saat önce açılır
const WINDOW_AFTER_MS  =  4 * 60 * 60 * 1000;  // bitimden 4 saat sonra kapanır
// ⚠️ DÖRDÜNCÜ AD, AYNI DEĞER (LC_MATCH_COST / MATCH_ENTRY_COST /
// LC_COST_NORMAL). Hepsi maç giriş bedeli; ayrı tanımlıyken biri
// değişince diğerleri sessizce eski kalırdı.
const { macGirisBedeli } = require("../lib/ekonomi.cjs");
const WEEK_MS          = 7 * 24 * 60 * 60 * 1000;

async function readJson(file, fb = null) {
  try { return JSON.parse(await fsp.readFile(file, "utf8")); } catch { return fb; }
}

async function getLiveState(fixtureId) {
  try { return JSON.parse(await fsp.readFile(guvenliYol(LIVE_DIR, fixtureId, ".json"), "utf8")); }
  catch { return null; }
}

async function is1987User(userId, db) {
  const uid = String(userId || "").trim().toLowerCase();
  if (!uid) return false;
  // Küçük harfli sorgu: kimlikler karışık harfli, tam eşleşme kaçırırdı.
  const map = await UsersStore.getUsersByIdsLower([uid], db);
  const u = map[uid];
  return !!(u && (u.is1987 || String(u.segment || "").toLowerCase() === "1987"));
}

/**
 * Kullanıcının bu maça verdiği tahmin (varsa).
 *
 * ⚠️ ÖNCE MONGO: bu fonksiyon "ikinci kez ücret alma" korumasının kendisi
 * (çağıran `!existing` ise 3 LC düşüyor). Yalnızca dosyaya bakarken
 * SKORLIG_PREDS_FILE_MIRROR=0 ile tahmin Mongo'da olup dosyada olmuyordu →
 * kullanıcı aynı maç için TEKRAR ücretlendiriliyordu.
 */
/**
 * Bir kullanıcının VERİLEN maçlardaki tahminleri — TEK sorguda.
 *
 * ⚠️ `getUserPred`i döngüde çağırmak N+1 üretiyordu ve uç 60 sn'de bile
 * yanıt vermiyordu (240 maç × (indeks denemesi 263 ms + sorgu 82 ms)).
 * Dosya moduna düşüş de tek okumaya indirildi: eskiden her maç için 13 MB'lık
 * `preds.json` yeniden okunup taranıyordu.
 *
 * @returns {Promise<Map<string, object>>} fixtureId → tahmin
 */
async function getUserPredsBatch(userId, fixtureIds, db) {
  const harita = new Map();
  const uid = String(userId || "").toLowerCase();
  if (!uid || !fixtureIds.length) return harita;

  if (db) {
    try {
      await ensurePredIndexes(db);            // döngü DIŞINDA, tek kez
      const docs = await db.collection("predictions")
        .find({ fixtureId: { $in: fixtureIds.map(String) }, userIdLower: uid })
        .toArray();
      for (const d of docs) harita.set(String(d.fixtureId), d);
      return harita;
    } catch (e) {
      console.error("[weekly-picks] toplu pred okunamadi:", e?.message || e);
    }
  }

  /* Dosya yedeği — yine TEK okuma. */
  try {
    const raw = await readJson(PREDS_FILE, []);
    const liste = Array.isArray(raw) ? raw : (raw?.items || []);
    const istenen = new Set(fixtureIds.map(String));
    for (const p of liste) {
      if (String(p?.userId || "").toLowerCase() !== uid) continue;
      const fid = String(p?.fixtureId || "");
      if (istenen.has(fid) && !harita.has(fid)) harita.set(fid, p);
    }
  } catch (e) {
    console.error("[weekly-picks] dosyadan pred okunamadi:", e?.message || e);
  }
  return harita;
}

async function getUserPred(userId, fixtureId, db) {
  const uid = String(userId || "").toLowerCase();
  /* ⚠️ SAVUNMACI KIRPMA: çağıran zaten kanonikleştiriyor, ama bu fonksiyon
   * ÜCRET KARARINI besliyor — "tahmin yok" yanıtı 3 LC kesilmesi demek.
   * Kanonikleştirmeyi tek bir çağrı yerinin doğru yapmasına bırakmak, tam
   * olarak bu kusurun kaynağıydı. */
  const fid = String(fixtureId || "").trim();

  if (db) {
    try {
// ⚠️ İNDEKS ONARIMI: bu yol `models/preds.cjs`'i kullanmıyor, yani
// oradaki kendi kendini onarma hiç çalışmıyordu (bkz. lib/preds-index.cjs).
await ensurePredIndexes(db);
      const doc = await db.collection("predictions").findOne({
        fixtureId: fid,
        userIdLower: uid,
      });
      if (doc) return doc;
    } catch (e) {
      console.error("[weekly-picks] mongo pred okunamadi:", e?.message || e);
    }
  }

  const raw  = await readJson(PREDS_FILE, []);
  const list = Array.isArray(raw) ? raw : (raw?.items ?? []);
  return list.find(p =>
    String(p.fixtureId || "").trim() === fid &&
    String(p.userId    || "").toLowerCase() === uid
  ) || null;
}

/**
 * LC düşer. Mongo varsa ORASI tek kaynaktır (atomik, bakiyeyi eksiye
 * düşürmez); yoksa dosyaya düşülür.
 *
 * NEDEN: bakiye Mongo'dan (`lc_wallet_users`) okunuyor. Harcama yalnızca
 * dosyaya yazılınca kullanıcı ÜCRETSİZ oynuyordu — mini/TR-Lig'de ödül
 * yönünde bulduğumuz hatanın harcama yönündeki eşi.
 */
async function spendLc(db, userId, amount, opts = {}) {
  if (db) {
    /* opts.kanal:"1987" → WalletCredit önce bonus1987'den düşer, yetmezse
     * normal bakiyeye kendisi geçer (30+30 tasarımı). Dosya yedeğinde bonus
     * kavramı yok — orada her zaman normal bakiyeden düşülür. */
    const r = await WalletCredit.spendLc(db, userId, amount, "weekly_pick_1987", {
      source: "weekly_picks",
    }, undefined, opts);
    if (r.ok) return { ok: true, lc: r.lc, bonus1987: r.bonus1987 };
    if (r.reason === "INSUFFICIENT") return { ok: false, lc: r.lc, needed: amount };
    // NO_DB / ERROR → dosyaya düşmeyi dene (aşağısı)
  }

  const uid = String(userId || "").trim();
  return withFileLock(WALLET_FILE, async () => {
    const state = await readJson(WALLET_FILE, { users: [], ledger: [] });
    if (!Array.isArray(state.users))  state.users  = [];
    if (!Array.isArray(state.ledger)) state.ledger = [];

    let wu = state.users.find(x => String(x.userId || "").toLowerCase() === uid.toLowerCase());
    if (!wu) {
      wu = { userId: uid, balance: 30, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastDailyAt: null, totalEarned: 30, totalSpent: 0 };
      state.users.push(wu);
    }
    if (Number(wu.balance || 0) < amount) return { ok: false, lc: Number(wu.balance || 0), needed: amount };

    wu.balance    = Number(wu.balance) - amount;
    wu.totalSpent = (wu.totalSpent || 0) + amount;
    wu.updatedAt  = new Date().toISOString();
    state.ledger.push({ id: "tx_" + Date.now().toString(36), userId: uid, kind: "spend", amount: -amount, reason: "weekly_pick_1987", createdAt: new Date().toISOString() });
    state.updatedAt = new Date().toISOString();
    await writeJsonAtomic(WALLET_FILE, state);
    return { ok: true, lc: Number(wu.balance) };
  });
}

/**
 * GET /api/weekly-picks?userId=xxx
 * Önümüzdeki 7 günde olan tüm maçları döndürür.
 * 24 saat penceresi başlamışsa open:true.
 */
/**
 * ⚠️ BAŞKASININ AÇIK TAHMİNİ SIZIYORDU — REKABET BÜTÜNLÜĞÜ AÇIĞI.
 *
 * Uç `?userId=` parametresine güvenip O KULLANICININ tahminlerini yanıta
 * koyuyordu; hiçbir kimlik denetimi yoktu. Denetimli olarak ÜRETİLDİ
 * (kickoff'a 3 saat, maç `open: true`):
 *     KURBAN kendi sorgusu     → {"outcome":"H","firstGoal":"H",...}
 *     SALDIRGAN kimliğiyle     → AYNI cevap
 *     KİMLİKSİZ istek          → AYNI cevap
 * Yani kullanıcı kimlikleri sıralama tablosunda zaten görünürken, herkes
 * rakibinin daha OYNANMAMIŞ maçtaki tahminini okuyup ona göre oynayabiliyordu.
 *
 * ⚠️ LİSTE KAPATILMIYOR, YALNIZCA TAHMİN. Maç listesi herkese açık kalmalı
 * (misafir de görebilmeli); gizli olan yalnızca KİMİN NE OYNADIĞI. Bu yüzden
 * `verifyToken` değil `optionalToken`: kimliksiz istek listeyi alır, `pred`
 * alanı null gelir.
 *
 * ⚠️ KİMLİK JETONDAN, SORGUDAN DEĞİL. `req.uid` doğrulanmış kimlik;
 * `?userId=` istemcinin yazdığı bir dize. `lib/kimlik-kontrol.cjs` aynı
 * dersi anlatıyor ve on rotada kullanılıyor — burada eksikti.
 */
router.get("/", optionalToken, async (req, res) => {
  try {
    const istenen = String(req.query.userId || "").trim();
    const kimlik  = String(req.uid || "").trim();
    /* Yalnızca KENDİ tahminleri döner. Kimlik yoksa ya da başkasının
     * kimliği istenmişse tahmin alanı boş kalır — liste yine gelir. */
    const userId = (kimlik && (!istenen || istenen.toLowerCase() === kimlik.toLowerCase()))
      ? kimlik
      : "";
    const db     = req.app?.locals?.db || null;
    const now    = Date.now();

    // Fikstürler Mongo birincil — bkz. lib/fixtures-store.cjs
    const all = await FixturesStore.loadAll(db);

    /* ────────────────────────────────────────────────────────────────────
     * ⚠️ N+1 KALDIRILDI — UÇ HİÇ YANIT VERMİYORDU.
     *
     * Döngü fikstür BAŞINA `getUserPred` çağırıyordu; o da her çağrıda
     * `ensurePredIndexes` + ayrı bir `findOne` yapıyor. Ölçüldü (üretim):
     *     pencere içi maç              : 240
     *     ensurePredIndexes tek çağrı  : 263 ms  → yalnız indeks ~63 sn
     *     findOne tek çağrı            :  82 ms  → sorgular ~20 sn
     * Uç 60 saniyede bile yanıt vermiyordu (ölçüldü: HTTP 000).
     *
     * `ensurePredIndexes`in pahalı olmasının sebebi ayrıca düzeltildi
     * (bkz. lib/preds-index.cjs — indeks çakışması önbelleği bozuyordu).
     * Ama tek başına o yetmez: 240 ayrı sorgu yine kalırdı.
     *
     * Artık kullanıcının bu penceredeki TÜM tahminleri TEK sorguda alınıp
     * haritaya konuyor. Durum dosyaları da paralel okunuyor.
     * ──────────────────────────────────────────────────────────────────── */
    const pencere = [];
    for (const fx of all) {
      const ko = new Date(fx.kickoffISO || fx.kickoffDate || "").getTime();
      if (!Number.isFinite(ko)) continue;
      if (now < ko - WINDOW_BEFORE_MS) continue;  // pencere açılmamış
      if (now > ko + WINDOW_AFTER_MS)  continue;  // çok geçmiş
      if (ko > now + WEEK_MS)          continue;  // 7 günden uzak
      pencere.push({ fx, ko });
    }

    const predHarita = await getUserPredsBatch(userId, pencere.map((x) => String(x.fx.fixtureId)), db);
    const liveler = await Promise.all(pencere.map((x) => getLiveState(x.fx.fixtureId)));

    const picks = [];
    for (let i = 0; i < pencere.length; i++) {
      const { fx, ko } = pencere[i];

      const live   = liveler[i];
      const status = live?.status ?? (ko <= now ? "LIVE" : "NS");
      const open   = now >= ko - WINDOW_BEFORE_MS && status !== "FT";

      const pred = userId ? (predHarita.get(String(fx.fixtureId)) || null) : null;

      picks.push({
        fixtureId:    fx.fixtureId,
        home:         fx.home,
        away:         fx.away,
        kickoffISO:   fx.kickoffISO,
        league:       fx.league  || "—",
        country:      fx.country || "—",
        status,
        score:        live?.score ?? null,
        htScore:      live?.htScore ?? null,
        open,
        minutesUntil: Math.max(0, Math.round((ko - now) / 60000)),
        pred:         pred ? {
          outcome:    pred.outcome,
          firstGoal:  pred.firstGoal  ?? null,
          firstHalf:  pred.firstHalf  ?? null,
          redAny:     pred.redAny     ?? null,
          penaltyAny: pred.penaltyAny ?? null,
        } : null,
        result: status === "FT" && live?.score ? {
          outcome:  live.score.home > live.score.away ? "H" : live.score.away > live.score.home ? "A" : "D",
          score:    live.score,
          htScore:  live.htScore ?? null,
          firstGoal:live.firstGoal ?? null,
          redAny:   !!(live.redHome || live.redAway),
          penaltyAny: !!live.penaltyAny,
        } : null,
      });
    }

    picks.sort((a, b) => new Date(a.kickoffISO).getTime() - new Date(b.kickoffISO).getTime());
    res.json({ ok: true, count: picks.length, picks });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * POST /api/weekly-picks/predict
 * body: { fixtureId, outcome, firstGoal?, firstHalf?, redAny?, penaltyAny? }
 * 1987 üyeleri ücretsiz; diğerleri 3 LC.
 */
router.post("/predict", verifyToken, async (req, res) => {
  try {
    const uid = req.uid;
    const { fixtureId: fixtureIdRaw, outcome, firstGoal, firstHalf, redAny, penaltyAny } = req.body || {};

    /* ⚠️ KANONİKLEŞTİRME KİLİTTEN VE HER OKUMADAN ÖNCE.
     *
     * BULUNAN: bu uç `fixtureId`i hiç normalize etmiyordu; yardımcıları ise
     * ediyordu. Ayrışma parayı sızdırdı:
     *
     *     FixturesStore.getOne(fixtureId)  → içeride trim → maç BULUNUR
     *     fiksturKilidi(fixtureId)         → içeride trim → kilit AÇIK
     *     getUserPred(uid, fixtureId, db)  → trim YOK     → "tahmin yok"
     *
     * Sonuç: "FDO-1 " (tek boşluk) gönderen kullanıcıdan 3 LC DAHA kesiliyordu.
     * Boşluk sayısı sınırsız olduğu için ücret de sınırsızdı.
     *
     * Karşılığı da yoktu: settle2 tahminleri kanonik id ile arıyor
     * (`{ fixtureId: String(fid) }`), boşluklu kayıt HİÇ puanlanmıyordu; GET /
     * de kanonik id listelediği için kullanıcı ödediğini ekranda göremiyordu.
     *
     * ÖLÇÜLDÜ (bellek-içi Mongo, 5 varyant): 6 LC düştü (olması gereken 3),
     * defterde 2 tahmin kaydı (olması gereken 1).
     *
     * `pred.cjs:793` bunu zaten doğru yapıyordu — iki tahmin ucundan yalnızca
     * biri normalize ediyordu. */
    const fixtureId = String(fixtureIdRaw || "").trim();

    if (!fixtureId || !["H", "D", "A"].includes(outcome)) {
      return res.status(400).json({ ok: false, error: "INVALID_INPUT" });
    }

    // ⚠️ `db` BURADA TANIMLANIR — aşağıda değil.
    // Fikstür okumasını buraya eklerken `db`yi kullandım ama tanımı 14 satır
    // AŞAĞIDAYDI: geçici ölü bölge (TDZ) → her tahmin gönderimi 500 verirdi.
    // Aynı sınıf hata bugün dört kez çıktı (settle2 nowISO, me.tsx banInput,
    // lc-wallet isPrem, bu). Artık `no-use-before-define` kuralı yakalıyor.
    const db = req.app?.locals?.db || null;

    // İndeksli tekil okuma (bkz. lib/fixtures-store.cjs getOne): eskiden TÜM
    // fikstür listesi çekilip bellekte süzülüyordu.
    const fx = await FixturesStore.getOne(fixtureId, db);
    if (!fx) return res.status(404).json({ ok: false, error: "FIXTURE_NOT_FOUND" });

    // Tahmin penceresi maçtan 24 saat önce AÇILIR (bu moda özel kural).
    const now = Date.now();
    const ko  = new Date(fx.kickoffISO || "").getTime();
    if (!Number.isFinite(ko) || now < ko - WINDOW_BEFORE_MS) {
      return res.status(400).json({ ok: false, error: "NOT_OPEN_YET" });
    }

    /* ⚠️ KAPANMA KONTROLÜ ORTAK KİLİDE BAĞLANDI.
     *
     * Eskiden yalnızca canlı durum DOSYASINA bakılıyordu:
     *     if (live?.status && live.status !== "NS") reddet
     * Dosya yoksa `live` null olur ve kontrol SESSİZCE GEÇERDİ. Render'da
     * `data/live/` geçici disk: her deploy'da siliniyor. Üstelik saat tabanlı
     * bir yedek de yoktu — yani kickoff geçmiş olsa bile hiçbir şey durdurmuyordu.
     *
     * Bu ucun yazdığı tahmin `predictions` koleksiyonuna gidiyor ve settle2
     * tarafından normal tahmin gibi PUANLANIP ÖDÜLLENDİRİLİYOR. Yani bitmiş
     * maça tahmin girip sonucu bilerek LC kazanmak mümkündü.
     *
     * `fiksturKilidi` fail-closed ve İKİ bağımsız sinyal kullanıyor: durum
     * (NS değilse başlamış) ve kickoff saati (durum bayatsa saat yakalar).
     * Aynı kilit düelloda ve havuzda da kullanılıyor. */
    const kilit = await fiksturKilidi(fixtureId, { db });
    if (kilit.locked) {
      return res.status(400).json({ ok: false, error: kilit.reason, fixtureId });
    }

    /* ⚠️ OKU→ÜCRETLENDİR→YAZ BÜTÜNÜ TEK KİLİTTE.
     *
     * BULUNAN: "daha önce tahmin var mı" OKUNUYOR, sonra ücret KESİLİYOR —
     * arada kilit yoktu. Eşzamanlı istekler hepsi `existing = null` görüp HER
     * BİRİ ayrı ücret kesiyordu.
     *
     * ÖLÇÜLDÜ (bellek-içi Mongo, 8 eşzamanlı istek, 6 deneme):
     *     /api/pred/submit          → 3 LC düştü, defterde 1 kayıt   (doğru)
     *     /api/weekly-picks/predict → 24 LC düştü, defterde 8 kayıt  (8 KAT)
     *
     * `pred.cjs` aynı sırayı `withFileLock(PREDS_FILE)` içinde yapıyor ve
     * yorumu bunu açıkça söylüyor: "eşzamanlı gönderimlerde tahmin kaybı /
     * çift-harcama olmaz". Burada kilit VARDI ama yalnızca dosya yazımını
     * sarıyordu — doğru araç, yanlış kapsam.
     *
     * ⚠️ AYNI ANAHTAR BİLEREK: iki uç da aynı `predictions` koleksiyonuna
     * yazıyor. Ayrı anahtar kullansaydık kullanıcı iki uca aynı anda gönderip
     * yine iki kez ödeyebilirdi.
     *
     * ⚠️ İÇERİDEKİ KİLİT KALDIRILDI: `withFileLock` reentrant DEĞİL; aynı
     * anahtarı iç içe almak süreci kilitlerdi. */
    await withFileLock(PREDS_FILE, async () => {
    const existing = await getUserPred(uid, fixtureId, db);
    const free     = await is1987User(uid, db);
    let lc         = 0;
    let lcCharged  = 0;

    /* ⚠️ 1987 MUAFİYETİ KALDIRILDI (2026-08-08, kullanıcı kararı — 30+30):
     * eskiden `!free && !existing` idi; üye hiç ödemiyor ve bonus1987 hiç
     * harcanmıyordu (cüzdanda görünen ama hiçbir oyunun düşüremediği ÖLÜ
     * bakiye). Bu uç 1987'ye TANIMLI oyun: üye bedeli önce bonus1987'den
     * öder (`kanal:"1987"` — bonus yetmezse spendLc kendisi normal
     * bakiyeye düşer), üye olmayan normal bakiyeden. */
    if (!existing) {
      const bedel = macGirisBedeli();
      /* ⚠️ Buradaki spendLc YEREL sarmalayıcı (yukarıda) — WalletCredit'inki
       * değil. İlk düzeltme 7 argümanlı gerçek imzayla çağırmıştı ve kanal
       * seçeneği sarmalayıcıda SESSİZCE yutuluyordu — uç dövülmeden fark
       * edilmezdi. Sarmalayıcı artık opts'u geçiriyor. */
      const spend = await spendLc(db, uid, bedel, free ? { kanal: "1987" } : {});
      if (!spend.ok) return res.status(400).json({ ok: false, error: "LC_NOT_ENOUGH", lc: spend.lc, needed: spend.needed });
      lc        = spend.lc;
      lcCharged = bedel;
    }

    /* İADE ÖDENENİN AYNASI: belgeye yazılacak tutar. Bu tur ücret kesildiyse
     * o; kesilmediyse (üzerine yazma) ESKİ kayıttaki tutar taşınır — burasi
     * $set ile TÜM nesneyi bastığından taşımamak, ödenmiş girişi 0'a ezip
     * iade hakkını silerdi. İlk gönderim ücretsizse (1987) açıkça 0.
     * bkz. tests/lansman-iade-uyumu.test.cjs */
    const eskiBedel   = Number(existing?.lcCharged);
    const belgeBedeli = lcCharged > 0 ? lcCharged
      : Number.isFinite(eskiBedel) ? eskiBedel
      : 0;

    // ⚠️ ÖNCE MONGO: settle2 tahminleri `preds` koleksiyonundan okur. Yalnızca
    // dosyaya yazmak, oyuncunun 3 LC ödeyip tahmininin hiç sonuçlanmaması
    // demekti (ayna kapalıyken dosya zaten okunmuyor).
    // upsert: aynı maça ikinci tahmin ESKİSİNİ EZER — dosya tarafındaki
    // "filtrele + yeniden ekle" davranışının birebir karşılığı.
    if (db) {
      try {
        await db.collection("predictions").updateOne(
          { fixtureId: String(fixtureId), userIdLower: uid.toLowerCase() },
          {
            $set: {
              fixtureId: String(fixtureId),
              userId: uid,
              userIdLower: uid.toLowerCase(),
              outcome,
              firstGoal:  firstGoal  || null,
              firstHalf:  firstHalf  || null,
              redAny:     typeof redAny     === "boolean" ? redAny     : null,
              penaltyAny: typeof penaltyAny === "boolean" ? penaltyAny : null,
              home: null, away: null,
              at: new Date().toISOString(),
              source: "weekly_pick_1987",
              is1987Free: false, // 2026-08-08: 1987 girisi artik ucretsiz DEGIL (30+30 tasarimi)
              lcCharged: belgeBedeli,
            },
          },
          { upsert: true }
        );
      } catch (e) {
        // Sessiz kalmıyoruz: bu, ödenmiş ama sonuçlanmayacak bir tahmin demek.
        console.error("[weekly-picks] mongo pred yazilamadi:", e?.message || e);
      }
    }

    // Dosya aynası — kilit ZATEN alınmış durumda (yukarıdaki blok).
    {
      const predsRaw = await readJson(PREDS_FILE, []);
      const list     = Array.isArray(predsRaw) ? predsRaw : (predsRaw?.items ?? []);
      const uidLower = uid.toLowerCase();

      /* ⚠️ Kırpılmış karşılaştırma: dosyaya daha önce (düzeltme öncesi)
       * boşluklu id yazılmış olabilir; onu da eleyip kanonik satırla
       * değiştiriyoruz ki ayna Mongo ile aynı şeyi söylesin. */
      const filtered = list.filter(p =>
        !(String(p.fixtureId || "").trim() === fixtureId &&
          String(p.userId    || "").toLowerCase() === uidLower)
      );

      filtered.push({
        fixtureId,
        userId:     uid,
        outcome,
        firstGoal:  firstGoal  || null,
        firstHalf:  firstHalf  || null,
        redAny:     typeof redAny     === "boolean" ? redAny     : null,
        penaltyAny: typeof penaltyAny === "boolean" ? penaltyAny : null,
        home: null, away: null,
        at:   new Date().toISOString(),
        source: "weekly_pick_1987",
        is1987Free: false, // 2026-08-08: 1987 girisi artik ucretsiz DEGIL (30+30 tasarimi)
        lcCharged: belgeBedeli,
      });

      const toWrite = Array.isArray(predsRaw) ? filtered : { ...predsRaw, items: filtered };
      await writeJsonAtomic(PREDS_FILE, toWrite);
    }

    res.json({ ok: true, fixtureId, outcome, lc, lcCharged, free });
    }); // withFileLock(PREDS_FILE)
  } catch (e) {
    console.error("[weekly-picks] predict error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * GET /api/weekly-picks/leaderboard
 * 1987 segmentinin bu haftalık sıralaması
 * match-results.json'dan son 7 günü toplar, is1987 kullanıcılarını filtreler
 */
router.get("/leaderboard", async (req, res) => {
  try {
    const limit  = Math.min(200, Number(req.query.limit  || 50));
    const userId = String(req.query.userId || "").trim();
    const now    = Date.now();
    const weekAgo = now - WEEK_MS;

    // 1987 kullanıcıları — indeksli segment sorgusu (eskiden tüm kullanıcı
    // dosyası okunup JS'te süzülüyordu).
    const userList = await UsersStore.listSegment1987(req.app?.locals?.db || null);
    const is1987Set = new Set(
      userList
        .map(u => String(u.userId || u.id || "").toLowerCase())
        .filter(Boolean)
    );

    if (!is1987Set.size) return res.json({ ok: true, count: 0, items: [], week: new Date(weekAgo).toISOString() });

    // match-results.json — son 7 günün maçları
    // Tarih filtresi depoda — eskiden tüm kitap okunup burada süzülüyordu.
    const snaps = await MatchResults.listSnapshots({
      db: req.app?.locals?.db || null,
      sinceISO: new Date(weekAgo).toISOString(),
    });

    // Kullanıcı bazında toplam puan
    const totals = new Map(); // uid → { userId, points, matches, correct }
    for (const snap of snaps) {
      for (const row of snap.rows ?? []) {
        const uid = String(row.userId || "").toLowerCase();
        if (!is1987Set.has(uid)) continue;
        const cur = totals.get(uid) || { userId: row.userId, points: 0, matches: 0, correct: 0 };
        cur.points  += Number(row.points || 0);
        cur.matches += 1;
        cur.correct += (row.detail?.outcome > 0) ? 1 : 0;
        totals.set(uid, cur);
      }
    }

    /**
     * ⚠️ SIRALAMA ÖLÇÜTÜ TEK KAYNAKTA — İKİ KOPYA AYRIŞMIŞTI.
     *
     * Tablo `b.points - a.points || b.correct - a.correct` ile sıralanıyordu,
     * ama kullanıcının KENDİ sırası aşağıda `b.points - a.points` ile ayrıca
     * hesaplanıyordu — beraberlik bozma ölçütü (`correct`) eksikti. Eşit
     * puanlı iki kişide sıra, `Array.sort` kararlı olduğu için Map ekleme
     * sırasına düşüyordu.
     *
     * ÖLÇÜLDÜ (eşit puan, farklı doğru sayısı; top-N dışı):
     *     ali  → tabloya göre 4., kendi kartında 5. gösteriliyor
     *     veli → tabloya göre 5., kendi kartında 4. gösteriliyor
     * Yani ikisi de yanlış ve ikisi de BİRBİRİNİN sırasını görüyordu. Daha çok
     * maç bilen kişi daha kötü sıra görebiliyordu.
     *
     * Tek dizi + tek ölçüt: hem tutarlı hem de ikinci sıralamayı ortadan
     * kaldırıyor.
     */
    const siraOlcutu = (a, b) => b.points - a.points || b.correct - a.correct;
    const tumSirali = Array.from(totals.values()).sort(siraOlcutu);

    const sorted = tumSirali
      .slice(0, limit)
      .map((u, i) => ({ rank: i + 1, ...u, points: Math.round(u.points * 10) / 10 }));

    let me = null;
    if (userId) {
      me = sorted.find(r => r.userId.toLowerCase() === userId.toLowerCase()) ?? null;
      if (!me) {
        const myData = totals.get(userId.toLowerCase());
        if (myData) {
          /* AYNI sıralı diziden — tablonun devamı olarak doğru sırayı verir. */
          const rank = tumSirali.findIndex(u => u.userId.toLowerCase() === userId.toLowerCase()) + 1;
          me = { rank, ...myData, points: Math.round(myData.points * 10) / 10 };
        }
      }
    }

    res.json({ ok: true, count: sorted.length, total1987: is1987Set.size, week: new Date(weekAgo).toISOString(), items: sorted, me });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * GET /api/weekly-picks/my
 * Kullanıcının bu haftaki tahminleri + sonuçlar
 */
router.get("/my", verifyToken, async (req, res) => {
  try {
    const uid      = req.uid;
    const uidLower = uid.toLowerCase();
    const db       = req.app?.locals?.db || null;

    /**
     * ⚠️ ÖNCE MONGO: bu uç YALNIZCA `preds.json`'a bakıyordu. Tahmin ise
     * yukarıdaki `/predict` tarafından hem Mongo'ya hem dosyaya yazılıyor —
     * yani `SKORLIG_PREDS_FILE_MIRROR=0` yapıldığı anda dosya donar ve
     * kullanıcı 3 LC ödediği haftalık tahminlerini "hiç yapmamış" görür.
     * Çökme yok, hata yok: sessizce boş liste. `routes/duels.cjs`teki
     * migration tuzağının aynısı, bu sefer ekranda.
     */
    let myPreds = null;
    if (db) {
      try {
        myPreds = await db.collection("predictions")
          .find({ userIdLower: uidLower, source: "weekly_pick_1987" })
          .toArray();
      } catch (e) {
        console.error("[weekly-picks] /my mongo okunamadi:", e?.message || e);
        myPreds = null;
      }
    }

    if (!myPreds) {
      const predsRaw = await readJson(PREDS_FILE, []);
      const list     = Array.isArray(predsRaw) ? predsRaw : (predsRaw?.items ?? []);
      myPreds = list.filter(p =>
        String(p.userId || "").toLowerCase() === uidLower &&
        p.source === "weekly_pick_1987"
      );
    }

    const result = [];
    for (const pred of myPreds) {
      const live   = await getLiveState(pred.fixtureId);
      const isFT   = live?.status === "FT";
      const actual = isFT && live?.score
        ? (live.score.home > live.score.away ? "H" : live.score.away > live.score.home ? "A" : "D")
        : null;

      result.push({
        fixtureId:  pred.fixtureId,
        outcome:    pred.outcome,
        firstGoal:  pred.firstGoal  ?? null,
        firstHalf:  pred.firstHalf  ?? null,
        redAny:     pred.redAny     ?? null,
        penaltyAny: pred.penaltyAny ?? null,
        at:         pred.at,
        is1987Free: pred.is1987Free || false,
        status:     live?.status ?? "NS",
        score:      live?.score  ?? null,
        correct:    actual ? pred.outcome === actual : null,
        actual,
      });
    }

    res.json({ ok: true, count: result.length, items: result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * POST /api/weekly-picks/verify-code
 * 1987GS Facebook grup kodunu doğrular; doğruysa kullanıcıya is1987 bayrağı verir.
 */
/**
 * POST /api/weekly-picks/verify-code — 1987GS grup kodu (live.tsx "1987GS MODU").
 *
 * ⚠️ VARSAYILAN KOD KALDIRILDI. Önceki hâli:
 *     const expected = String(process.env.GS1987_CODE || "1987GS").trim();
 *
 * `GS1987_CODE` üretimde tanımsızsa geçerli kod kelimenin tam anlamıyla
 * "1987GS" oluyordu — ucun kendi adından tahmin edilebilir. Değişken
 * `.env.example`'da da yoktu, yani örnekten kurulan bir ortamda tanımsız
 * kalması olağan durumdu.
 *
 * Verdiği şey bedava değil: `is1987` açılış bakiyesini 60 LC yapıyor
 * (normalde 30), haftalık seçimleri ücretsizleştiriyor ve premium tabanını
 * geçerli kılıyor. Yani tahmin edilebilir bir kelime, sınırsız sayıda hesaba
 * premium ayrıcalığı dağıtabilirdi.
 *
 * Artık tanımsızsa 503 döner ve GEÇİRMEZ (yönetici token'ıyla aynı ilke:
 * yapılandırma eksikse kapalı kal, sessizce zayıf bir varsayılana düşme).
 *
 * ⚠️ NOT — İKİ PARALEL YOL: aynı `is1987` ayrıcalığını `/api/auth1987gs/verify`
 * de veriyor, ama o kod BAŞINA KOTA tutuyor (lib/invite-store.cjs, atomik
 * `redeem`). Buradaki tek paylaşılan kodun kotası yok. İkisi bilinçli bir
 * tercih mi, yoksa biri diğerinin yerini mi almalı — ürün kararı.
 */
router.post("/verify-code", verifyToken, async (req, res) => {
  try {
    const uid  = req.uid;
    const code = String(req.body?.code || "").trim();
    const expected = String(process.env.GS1987_CODE || "").trim();

    if (!expected) {
      console.error("[weekly-picks] GS1987_CODE tanimsiz — kod dogrulama KAPALI");
      return res.status(503).json({ ok: false, error: "GROUP_CODE_NOT_CONFIGURED" });
    }
    if (!code || code.toUpperCase() !== expected.toUpperCase()) {
      return res.status(400).json({ ok: false, error: "WRONG_CODE" });
    }

    // 1987 üyeliği DEPOYA yazılır. Eskiden doğrudan users.json'a yazılıyordu;
    // premium.cjs ve listSegment1987 depodan okuduğu için o yazım hiçbir yere
    // ulaşmıyordu — kullanıcı kodu giriyor, üyeliği (ve premium ayrıcalığını)
    // hiç alamıyordu.
    await UsersStore.updateUser(
      uid,
      { is1987: true, is1987At: new Date().toISOString() },
      { mainTeam: null, lc: 0, lcLastDaily: null },
      req.app?.locals?.db || null
    );

    res.json({ ok: true, is1987: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
/* Test icin: N+1 kaldiran toplu okuyucu — davranisi dogrudan sinanabilsin. */
module.exports._getUserPredsBatch = getUserPredsBatch;
