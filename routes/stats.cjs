"use strict";

const express = require("express");
const router  = express.Router();
const { verifyToken, optionalToken } = require("../middleware/verifyToken.cjs");
const { kimlikVeyaHata } = require("../lib/kimlik-kontrol.cjs");
const path    = require("path");
const fs      = require("fs");
const fsp     = fs.promises;
const UsersStore   = require("../lib/users-store.cjs");
const SeasonTotals = require("../lib/season-totals.cjs");
const Season       = require("../lib/season.cjs");
const TakimKatalog = require("../lib/takim-katalog.cjs");
const ArsivKapi    = require("../lib/sezon-arsiv.cjs");

// ⚠️ SKORLIG_DATA_DIR: sabit yol testleri GERÇEK data/ dizinine yazdırır.
const DATA_DIR         = process.env.SKORLIG_DATA_DIR || path.join(__dirname, "..", "data");
const TOTALS_FILE      = path.join(DATA_DIR, "totals.json");
const LEADERBOARD_FILE = path.join(DATA_DIR, "leaderboard.json");
const WALLET_FILE      = path.join(DATA_DIR, "lc-wallet.json");

async function readJson(file, fb = null) {
  try {
    const txt = await fsp.readFile(file, "utf8");
    return JSON.parse(txt);
  } catch {
    return fb;
  }
}

/**
 * Basit ping:
 * GET /api/stats
 */
router.get("/", (req, res) => {
  res.json({ ok: true, where: "stats-router-alive" });
});

/**
 * Core helper:
 *  - Mongo varsa: season_totals + leaderboard + lc_wallet_* koleksiyonlarını kullanır
 *  - Mongo yoksa: totals.json + leaderboard.json + lc-wallet.json kullanır
 *
 * Dönüş:
 * {
 *   userId,
 *   source: "mongo" | "files",
 *   season: { userId, total, played, penalties, avg, lastAt },
 *   recentMatches: [{ fixtureId, points, detail, updatedAt }],
 *   wallet: { ... } | null,
 *   walletLedger: [...]
 * }
 */
async function loadUserStatsCore(req, userId) {
  const uid = String(userId || "").trim();
  if (!uid) {
    const err = new Error("USER_ID_REQUIRED");
    err.code = "USER_ID_REQUIRED";
    err.httpStatus = 400;
    throw err;
  }

  const db = req.app?.locals?.db || null;
  const uidLower = uid.toLowerCase();

  // ======================
  // 1) Mongo modu
  // ======================
  if (db) {
    const seasonCol   = db.collection("season_totals");
    const lbCol       = db.collection("leaderboard");
    const walletUsers = db.collection("lc_wallet_users");
    const ledgerCol   = db.collection("lc_wallet_ledger");

    /* ⚠️ SEZON KAPSAMI — BURADA HİÇ YOKTU.
     *
     * Eski sorgu: `seasonCol.findOne({ userIdLower })` — hangi sezon olduğu
     * BELİRTİLMİYORDU, yani kullanıcının herhangi bir sezon kaydı dönüyordu.
     * Aynı yanıttaki takım bloğu ise güncel sezonu kullanıyor.
     *
     * ÖLÇÜLDÜ (üretim, gerçek kullanıcı; yalnızca 2026-07 kaydı var, güncel
     * sezon 2026-08):
     *     totalPoints      : 9.9   ← Temmuz'dan
     *     team.myTeamTotal : 0     ← Ağustos'tan
     * Tek ekranda "9.9 puanım var" ve "takımımdaki toplamım 0".
     *
     * Birden fazla sezonu olan kullanıcıda `findOne` hangi belgeyi
     * döndüreceğini GARANTİ ETMEZ — sezon biriktikçe "puanım" rastgele bir
     * geçmiş sezonu gösterebilirdi, hata vermeden.
     *
     * Okuma tek kaynaktan: `SeasonTotals.kullaniciToplami` sıralamayla AYNI
     * kuralı uygular (geçiş toleransı + mükerrer birleştirme + yuvarlama),
     * yoksa profil ile sıralama farklı sayı gösterirdi.
     */
    /* ⚠️ ARSIV DERINLIGI PREMIUM AYRICALIGI. Bu ucta ?season= destegini
     * eklerken kapiyi TASIMAMISTIM: ucretsiz kullanici 6 ay geriye
     * okuyabiliyordu (leaderboard 1 sezonla sinirliyor). Kural artik tek
     * kaynakta — bkz. lib/sezon-arsiv.cjs */
    /* ⚠️ KAPI İZLEYİCİYE BAKAR, PROFİL SAHİBİNE DEĞİL.
     *
     * Bu çekirdek hem `/me` (kimlik doğrulanmış) hem `/user` (başkasının
     * profili, `optionalToken`) tarafından çağrılıyor. `uid` burada PROFİL
     * SAHİBİ; onu kapıya vermek, ücretsiz bir izleyicinin premium birinin
     * profilini açarak derin arşive erişmesi demekti. Ayrıcalık izleyicinin.
     * `/me`'de ikisi zaten aynı kimlik (kimlikVeyaHata eşitliği zorunlu
     * kılıyor), yani orada davranış değişmiyor. */
    const _ark = await ArsivKapi.arsivSezonu(req.query.season, {
      uid: String(req.uid || "").trim(),
      db,
    });
    const istenenSezon = _ark.sezon;
    const arsivKisitli = _ark.kisitli;
    const seasonDoc = await SeasonTotals.kullaniciToplami(db, uidLower, istenenSezon);

    const season = seasonDoc
      ? {
          userId: seasonDoc.userId || uid,
          total: Number(seasonDoc.totalPoints || 0),
          played: Number(seasonDoc.matches || 0),
          penalties: Number(seasonDoc.totalPenalty || 0),
          /* ⚠️ İKİ BASAMAK, TAM SAYI DEĞİL. Eskiden `Math.round` ile tam sayıya
           * yuvarlanıyordu: 9.9/6 = 1.65 → "2" görünüyordu, sıralama ekranı ise
           * aynı oyuncu için 1.67 diyordu (lib/ranking.cjs iki basamak
           * kullanıyor). Aynı metrik, iki ekranda iki sayı. */
          avg: seasonDoc.matches
            ? Math.round((Number(seasonDoc.totalPoints || 0) / Number(seasonDoc.matches || 1)) * 100) / 100
            : 0,
          lastAt: seasonDoc.lastAt || null,
        }
      : {
          userId: uid,
          total: 0,
          played: 0,
          penalties: 0,
          avg: 0,
          lastAt: null,
        };

    // Son maçlar (leaderboard koleksiyonundan)
    const recentMatchesRaw = await lbCol
      .find({ userIdLower: uidLower })
      .sort({ updatedAt: -1, createdAt: -1 })
      .limit(20)
      .toArray();

    const recentMatches = recentMatchesRaw.map((m) => ({
      fixtureId: m.fixtureId || null,
      points: Number(m.points || 0),
      detail: m.detail || null,
      updatedAt: m.updatedAt || m.createdAt || null,
    }));

    // LC cüzdan kullanıcı kaydı
    const walletUser = await walletUsers.findOne({ userIdLower: uidLower });

    const wallet = walletUser
      ? {
          userId: walletUser.userId || uid,
          balance: walletUser.balance || 0,
          totalEarned: walletUser.totalEarned || 0,
          totalSpent: walletUser.totalSpent || 0,
          lastDailyAt: walletUser.lastDailyAt || null,
          updatedAt: walletUser.updatedAt || null,
          is1987: !!walletUser.is1987,
        }
      : null;

    // LC ledger son hareketler
    const ledgerItems = await ledgerCol
      .find({ userIdLower: uidLower })
      .sort({ createdAt: -1 })
      .limit(20)
      .toArray();

    const walletLedger = ledgerItems.map((tx) => ({
      id: tx.id || null,
      kind: tx.kind || null,
      amount: tx.amount || 0,
      reason: tx.reason || null,
      fixtureId: tx.fixtureId || null,
      createdAt: tx.createdAt || null,
    }));

    return {
      userId: uid,
      source: "mongo",
      /* ⚠️ SEZON YANITTA TAŞINIYOR: takım bloğu ile puan bloğu AYNI sezonu
       * kullanmalı. Rota katmanı ham `req.query.season` kullansaydı geçersiz
       * bir değer geldiğinde çekirdek güncel sezona düşer, takım bloğu ham
       * değeri kullanır ve iki blok yine ayrışırdı — düzelttiğim kusurun
       * aynısı, başka yoldan. */
      season: { ...season, key: istenenSezon, kisitli: arsivKisitli },
      recentMatches,
      wallet,
      walletLedger,
    };
  }

  // ======================
  // 2) Dosya modu
  // ======================

  // 2.1) totals.json → sezon özeti
  const totals = await readJson(TOTALS_FILE, {
    items: [],
    updatedAt: null,
  });

  let season = {
    userId: uid,
    total: 0,
    played: 0,
    penalties: 0,
    avg: 0,
    lastAt: null,
  };

  if (totals && Array.isArray(totals.items)) {
    const t = totals.items.find(
      (x) =>
        String(x.userId || "")
          .trim()
          .toLowerCase() === uidLower
    );
    if (t) {
      const total = Number(t.totalPoints || 0);
      const played = Number(t.matches || 0);
      const penalties = Number(t.totalPenalty || 0);
      season = {
        userId: t.userId || uid,
        total,
        played,
        penalties,
        avg: played ? Math.round((total / played) * 100) / 100 : 0,
        lastAt: t.lastAt || null,
      };
    }
  }

  // 2.2) leaderboard.json → son settle edilen maçtaki satırlar
  const lb = await readJson(LEADERBOARD_FILE, {
    items: [],
    updatedAt: null,
  });
  const items = Array.isArray(lb.items) ? lb.items : [];

  const recentMatches = items
    .filter(
      (r) =>
        String(r.userId || r.user || "")
          .trim()
          .toLowerCase() === uidLower
    )
    .map((r) => ({
      fixtureId: r.fixtureId || null,
      points: Number(r.points || 0),
      detail: r.detail || null,
      updatedAt: lb.updatedAt || null,
    }));

  // 2.3) lc-wallet.json → cüzdan + ledger
  const walletState =
    (await readJson(WALLET_FILE, {
      users: [],
      ledger: [],
      updatedAt: null,
    })) || {};

  const usersArr = Array.isArray(walletState.users)
    ? walletState.users
    : [];
  const ledgerArr = Array.isArray(walletState.ledger)
    ? walletState.ledger
    : [];

  const wu = usersArr.find(
    (x) =>
      String(x.userId || "")
        .trim()
        .toLowerCase() === uidLower
  );

  const wallet = wu
    ? {
        userId: wu.userId,
        balance: wu.balance || 0,
        totalEarned: wu.totalEarned || 0,
        totalSpent: wu.totalSpent || 0,
        lastDailyAt: wu.lastDailyAt || null,
        updatedAt: wu.updatedAt || walletState.updatedAt || null,
        is1987: !!wu.is1987,
      }
    : null;

  const walletLedger = ledgerArr
    .filter(
      (tx) =>
        String(tx.userId || "")
          .trim()
          .toLowerCase() === uidLower
    )
    .sort(
      (a, b) =>
        new Date(b.createdAt || 0).getTime() -
        new Date(a.createdAt || 0).getTime()
    )
    .slice(0, 20)
    .map((tx) => ({
      id: tx.id || null,
      kind: tx.kind || null,
      amount: tx.amount || 0,
      reason: tx.reason || null,
      fixtureId: tx.fixtureId || null,
      createdAt: tx.createdAt || null,
    }));

  return {
    userId: uid,
    source: "files",
    season,
    recentMatches,
    wallet,
    walletLedger,
  };
}

/**
 * GET /api/stats/user?userId=...
 *
 * Full JSON:
 *  { ok, userId, source, season, recentMatches, wallet, walletLedger }
 */
/**
 * ⚠️ CÜZDAN VE DEFTER HERKESE AÇIKTI — DENETİMLİ OLARAK ÜRETİLDİ.
 *
 * `loadUserStatsCore` yanıta `wallet` (bakiye, toplam kazanç/harcama) ve
 * `walletLedger` (TÜM işlem geçmişi) koyuyor. Uçta kimlik denetimi yoktu:
 *     SAHİBİ     → bakiye 137 · 2 defter kaydı
 *     SALDIRGAN  → AYNI
 *     KİMLİKSİZ  → AYNI
 * Kullanıcı kimlikleri sıralama tablosunda zaten görünür, yani herkesin
 * parası ve harcama geçmişi okunabiliyordu.
 *
 * ⚠️ `lib/kimlik-kontrol.cjs` TAM BU KUSUR İÇİN YAZILMIŞ ve notu şöyle:
 * "cüzdan uçlarında YAZMALARIN hepsinde verifyToken vardı, OKUMALARIN
 * hiçbirinde yoktu." Düzeltme `lc-wallet` uçlarına uygulanmış, buraya
 * dönülmemiş — aynı yarım-düzeltme izi.
 *
 * ⚠️ İSTATİSTİK GİZLİ DEĞİL, CÜZDAN GİZLİ. Profil ekranı başkasının puanını/
 * formunu göstermeli (sıralamadan tıklanıyor); gizli olan yalnızca para.
 * Bu yüzden uç kapatılmıyor, para alanları SAHİBİ DIŞINDA çıkarılıyor.
 * `optionalToken`: misafir de profil görebilir.
 */
router.get("/user", optionalToken, async (req, res) => {
  try {
    const userId = String(req.query.userId || "").trim();
    if (!userId) {
      return res
        .status(400)
        .json({ ok: false, error: "USER_ID_REQUIRED" });
    }

    const core = await loadUserStatsCore(req, userId);

    const kimlik = String(req.uid || "").trim();
    const kendisi = !!kimlik && kimlik.toLowerCase() === userId.toLowerCase();
    if (!kendisi) {
      /* Para alanları yalnızca sahibine. Alanı `null` bırakmak yerine
       * SİLMEK, istemcinin "0 LC" gibi yanlış bir şey göstermesini önler. */
      delete core.wallet;
      delete core.walletLedger;
    }

    return res.json({
      ok: true,
      kendisi,
      ...core,
    });
  } catch (e) {
    console.error("STATS_USER_FAILED", e);
    const status = e && e.httpStatus ? e.httpStatus : 500;
    const code = e && e.code ? e.code : "STATS_USER_FAILED";
    return res.status(status).json({
      ok: false,
      error: code,
      detail: String(e && (e.message || e)),
    });
  }
});

/**
 * GET /api/stats/me?userId=...
 *
 * Eski MeStats şemasına uyumlu cevap döner:
 *  {
 *    ok,
 *    userId,
 *    favTeam: null | string,
 *    team: null | { team, rank, count, myTeamTotal },
 *    totalPoints,
 *    played,
 *    avg,
 *    lastAt,
 *    form: number[],                // recentMatches üzerinden
 *    wallet,
 *    walletLedger
 *  }
 *
 * Not:
 *  - Şu an favTeam / team alanlarını dolduracak veri kaynağı yok; ileride users.json / Mongo user profile bağlanabilir.
 */
router.get("/me", verifyToken, async (req, res) => {
  try {
    // ⚠️ SAHIPLİK: kimlik sorgudan geliyordu; denetim yoktu.
    // bkz. lib/kimlik-kontrol.cjs
    const _k = kimlikVeyaHata(req, res, req.query.userId);
    if (!_k) return;
    const userId = _k.uid;
    if (!userId) {
      return res
        .status(400)
        .json({ ok: false, error: "USER_ID_REQUIRED" });
    }

    const core = await loadUserStatsCore(req, userId);
    const season = core.season || {
      userId,
      total: 0,
      played: 0,
      penalties: 0,
      avg: 0,
      lastAt: null,
    };
    const recent = Array.isArray(core.recentMatches)
      ? core.recentMatches
      : [];

    // Form: son 10 maçın puanı (yeniden sırala: en eski → en yeni)
    const form = recent
      .slice()
      .sort((a, b) => {
        const ta = new Date(a.updatedAt || 0).getTime();
        const tb = new Date(b.updatedAt || 0).getTime();
        return ta - tb;
      })
      .map((m) => Number(m.points || 0))
      .slice(-10);

    /* Kullanıcının tuttuğu takım. Eskiden burası `null` sabitiydi ve yanında
     * "frontend default olarak Galatasaray kullanmaya devam edecek" notu
     * vardı — yani HERKESİN takımı Galatasaray görünüyordu. Depoda alan
     * (`mainTeam`) ve indeks zaten vardı, yalnızca okunmuyordu.
     * `favTeam` mobilin beklediği ad; `team` ile aynı değer. */
    let mainTeam = null;
    let takimOzet = null;
    try {
      const u = await UsersStore.getUser(userId, req.app.locals.db);
      mainTeam = u?.mainTeam || null;

      /* ⚠️ `team` ALANI NESNE, STRING DEĞİL. Mobil `MeStats` tipi
       * `{team, rank, count, myTeamTotal}` bekliyor ve `meStats.team.team`
       * okuyor; buraya düz metin koymak sessizce `undefined` üretirdi.
       *
       * Sıralama `takimSiralamasi()` ile hesaplanıyor — /team-ranks ucuyla
       * AYNI fonksiyon. İkinci bir kopya yazsaydım sezon birleştirme ya da
       * kanonikleştirme düzeltmesi birinde yapılıp öbüründe unutulurdu. */
      if (mainTeam) {
        const s = await takimSiralamasi(req.app.locals.db, mainTeam, core.season?.key);
        const sira = s.items.findIndex((x) => String(x.userId).toLowerCase() === String(userId).toLowerCase());
        takimOzet = {
          team: s.team,
          rank: sira >= 0 ? sira + 1 : null,
          count: s.items.length,
          myTeamTotal: sira >= 0 ? s.items[sira].total : null,
        };
      }
    } catch (e) {
      /* Profil ya da sıralama okunamazsa istatistik ekranı komple
       * çökmemeli — takım boş geçer, puanlar yine gösterilir. */
      console.error("STATS_ME_MAINTEAM_ERR", e?.message || e);
    }

    return res.json({
      ok: true,
      userId: core.userId,
      favTeam: mainTeam,
      team: takimOzet,
      totalPoints: season.total,
      played: season.played,
      avg: season.avg,
      lastAt: season.lastAt,
      /* Hangi sezona bakildigi gorunur olmali: tablo ayin 1inde sifirlaniyor
       * ve aciklama olmadan kullanici bir aylik emegini kayip saniyor.
       * Ayni alanlar leaderboard ve rt/totals uclarinda da var. */
      season: season.key || null,
      seasonLabel: season.key ? Season.label(season.key) : null,
      isCurrentSeason: (season.key || null) === Season.seasonKey(),
      ...(season.kisitli ? { archiveLimited: true } : {}),
      form,
      wallet: core.wallet || null,
      walletLedger: core.walletLedger || [],
    });
  } catch (e) {
    console.error("STATS_ME_FAILED", e);
    const status = e && e.httpStatus ? e.httpStatus : 500;
    const code = e && e.code ? e.code : "STATS_ME_FAILED";
    return res.status(status).json({
      ok: false,
      error: code,
      detail: String(e && (e.message || e)),
    });
  }
});

/**
 * GET /api/stats/team-ranks?team=Galatasaray
 * → { ok, team, canonical, items: [{ userId, total, played, flag, team }], updatedAt }
 *
 * AYNI TAKIMI TUTANLARIN PUAN SIRALAMASI.
 *
 * ⚠️ NEDEN YENİ: mobil `app/(tabs)/stats.tsx:353` bu ucu ÇAĞIRIYORDU ama uç
 * hiç yazılmamıştı — kullanıcının telefon günlüğünde `404 ... böyle bir uç
 * YOK` satırı buradan geliyor. İstemci 404'ü yutup listeyi boş bırakıyordu
 * (`setTeamRanks([])`), o yüzden çökme değil SESSİZ BOŞ EKRAN olarak
 * görünüyordu.
 *
 * ⚠️ YANIT SÖZLEŞMESİ İSTEMCİDEN SABİT, ONU DEĞİŞTİRMİYORUM: mobil
 * `j?.ok && Array.isArray(j.items)` kontrolü yapıp `{userId,total,flag,team}`
 * okuyor. Alan adlarını "daha güzel" diye değiştirmek yayınlanmış istemciyi
 * kırardı.
 */
async function takimSiralamasi(db, hamAd, sezonIstek) {
    /* ⚠️ SEZON EN BASTA COZULUR: erken cikis (takimin uyesi yok) da sezonu
     * bildirmeli, yoksa ekran o durumda hangi sezona baktigini yazamaz. */
    const hamSezon = String(sezonIstek || "").trim();
    const sezon = Season.isValidKey(hamSezon) ? hamSezon : Season.seasonKey();

    const ham = String(hamAd || "").trim();

    /* Sorgu da kaydetme yolu gibi kanonikleştiriliyor. İkisi aynı fonksiyondan
     * geçmezse "Galatasaray SK" arayan kullanıcı boş liste görürdü. */
    const kanonik = TakimKatalog.kanonikTakim(ham);
    const team = kanonik || ham;

    const uyeler = await UsersStore.listByTeam(team, db);
    if (!uyeler.length) {
      /* Sezon ERKEN ÇIKIŞTA da bildirilmeli: takımın hiç üyesi yoksa da
       * ekran hangi sezona baktığını yazabilmeli. */
      return { team, canonical: !!kanonik, items: [], updatedAt: null, season: sezon };
    }

    const idler = uyeler.map((u) => String(u?.userId || "")).filter(Boolean);
    const bayrakla = new Map(
      uyeler.map((u) => [
        String(u?.userId || "").toLowerCase(),
        u?.country ? TakimKatalog.ulkeBayragi(u.country) : "",
      ])
    );

    /* ── Puanlar ──────────────────────────────────────────────────────────
     * routes/leaderboard.cjs ile AYNI okuma yolu. İki tuzağı da oradan
     * devralıyorum, çünkü ikisi de sessiz:
     *   1) Sezon alanı eklenmeden önceki kayıtlarda `season` YOK; geçiş
     *      döneminde onlar da güncel sezona sayılmalı ($or).
     *   2) Eski (sezonsuz) + yeni belge aynı kullanıcıya aitse BİRLEŞTİRİLMELİ
     *      — yoksa kullanıcı sıralamada İKİ KEZ görünür ve puanı bölünür.
     *      bkz. lib/season-totals.cjs belgeleriBirlestir
     * ──────────────────────────────────────────────────────────────────── */
    /* ⚠️ SEZON DOĞRULAMASI BURADA — ÇAĞIRANDA DEĞİL.
     *
     * Eski hâli `String(sezonIstek||"").trim() || Season.seasonKey()` idi:
     * GEÇERSİZ bir dize (istemci hatası, eski bağlantı, elle yazılan URL)
     * olduğu gibi sorguya giriyordu. O sezonda hiç belge olmadığı için
     * herkes 0 puanla dönüyor — hata yok, yalnızca yanlış tablo.
     *
     * ÖLÇÜLDÜ (gerçek rota, üretim verisi, ?season=SACMA):
     *     /api/stats/me         → 2026-08'e düştü, yanıtta season alanı var
     *     /api/stats/user       → 2026-08'e düştü
     *     /api/stats/team-ranks → "SACMA" sorgulandı, total 0, season alanı YOK
     * Aynı girdiye üç farklı davranış; ekran hangi sezona baktığını da
     * söyleyemiyordu.
     *
     * Doğrulama ortak fonksiyonda: `/team-ranks` ve `stats/me`'nin takım
     * bloğu ikisi de buradan geçiyor, yeni bir çağıran da korumalı doğar.
     */
    const puan = new Map();   // userIdLower → { total, played }
    let updatedAt = null;

    if (db) {
      const suzgec = sezon === Season.seasonKey()
        ? { $or: [{ season: sezon }, { season: { $exists: false } }] }
        : { season: sezon };
      const alt = idler.map((x) => x.toLowerCase());
      const ham2 = await db.collection("season_totals")
        .find({ ...suzgec, userIdLower: { $in: alt } })
        .toArray();
      for (const d of SeasonTotals.belgeleriBirlestir(ham2)) {
        const k = String(d.userIdLower || d.userId || "").toLowerCase();
        if (!k) continue;
        puan.set(k, {
          // Kesirli puanlar $inc ile birikince kayan nokta artığı bırakıyor
          // (10.700000000000001) — bkz. lib/season-totals.cjs
          total: Math.round(Number(d.totalPoints || 0)),
          played: Number(d.matches || 0),
        });
        const t = d.updatedAt || d.lastAt || null;
        if (t && (!updatedAt || t > updatedAt)) updatedAt = t;
      }
    } else {
      const map = await SeasonTotals.totalsMap(null, sezon);
      for (const id of idler) {
        const d = map?.[id] || map?.[id.toLowerCase()];
        if (!d) continue;
        puan.set(id.toLowerCase(), {
          total: Math.round(Number(d.total ?? d.totalPoints ?? 0)),
          played: Number(d.played ?? d.matches ?? 0),
        });
      }
    }

    /* ⚠️ PUANI OLMAYAN ÜYE DE LİSTEDE, 0 ile. Süzmek "takımın kadrosu"
     * ekranını yeni katılanlara boş gösterirdi; kullanıcı kendini
     * bulamayınca özelliği bozuk sanar. */
    const items = uyeler
      .map((u) => {
        const id = String(u?.userId || "");
        const p = puan.get(id.toLowerCase()) || { total: 0, played: 0 };
        return {
          userId: id,
          total: p.total,
          played: p.played,
          flag: bayrakla.get(id.toLowerCase()) || "",
          team,
        };
      })
      .sort((a, b) => b.total - a.total || a.userId.localeCompare(b.userId));

  return { team, canonical: !!kanonik, items, updatedAt, season: sezon };
}

router.get("/team-ranks", optionalToken, async (req, res) => {
  try {
    const ham = String(req.query.team || "").trim();
    if (!ham) return res.status(400).json({ ok: false, error: "TEAM_REQUIRED" });

    /* ⚠️ ARSIV DERINLIGI KAPISI — bu ucta HIC YOKTU (leaderboard 1 sezonla
     * sinirlarken buradan 6 ay geriye okunabiliyordu). Kimlik yoksa ucretsiz
     * kademe uygulanir; bkz. lib/sezon-arsiv.cjs */
    const _ark = await ArsivKapi.arsivSezonu(req.query.season, {
      /* Ayricalik kapisi IZLEYICININ dogrulanmis kimligine bakar; sorgudan
       * gelen kimlik baskasinin premium hakkini kullandirirdi. */
      uid: String(req.uid || "").trim(),
      db: req.app.locals.db,
    });
    const r = await takimSiralamasi(req.app.locals.db, ham, _ark.sezon);
    /* Sezon etiketi diger uclarla ayni sozlesme (leaderboard, rt/totals,
     * stats/me): ekran hangi sezona baktigini yazabilsin. */
    return res.json({
      ok: true,
      ...r,
      seasonLabel: r.season ? Season.label(r.season) : null,
      isCurrentSeason: r.season === Season.seasonKey(),
      ...(_ark.kisitli ? { archiveLimited: true } : {}),
    });
  } catch (e) {
    console.error("TEAM_RANKS_ERR", e);
    return res.status(500).json({
      ok: false,
      error: "TEAM_RANKS_ERR",
      detail: String(e && (e.message || e)),
    });
  }
});

/**
 * GET /api/stats/teams?country=Türkiye
 * → { ok, teams: [{ team, country, flag }] }
 *
 * Onboarding takım seçicisinin kaynağı. `/api/live2/countries` ile aynı rol:
 * istemci serbest metin göndermesin, listeden seçsin — böylece kaydedilen ad
 * zaten kanonik olur. bkz. lib/takim-katalog.cjs
 */
router.get("/teams", (req, res) => {
  try {
    const ulke = String(req.query.country || "").trim();
    return res.json({ ok: true, country: ulke || null, teams: TakimKatalog.takimlar(ulke || null) });
  } catch (e) {
    console.error("TEAMS_LIST_ERR", e);
    return res.status(500).json({ ok: false, error: "TEAMS_LIST_ERR", detail: String(e?.message || e) });
  }
});

module.exports = router;
