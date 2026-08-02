"use strict";

const express = require("express");
const router  = express.Router();
const fs      = require("fs");
const fsp     = fs.promises;
const path    = require("path");
const crypto  = require("crypto");
const { verifyToken } = require("../middleware/verifyToken.cjs");

function requireAdminToken(req, res, next) {
  const token = String(process.env.SKORLIG_ADMIN_TOKEN || "").trim();
  if (!token) return res.status(503).json({ ok: false, error: "ADMIN_TOKEN_NOT_CONFIGURED" });
  const got = String(req.headers["x-admin-token"] || "").trim() || String(req.query.token || "").trim();
  if (got && got === token) return next();
  return res.status(401).json({ ok: false, error: "ADMIN_TOKEN_REQUIRED" });
}

// ⚠️ SKORLIG_DATA_DIR: sabit yol testleri GERÇEK data/ dizinine yazdırır.
const DATA_DIR     = process.env.SKORLIG_DATA_DIR || path.join(__dirname, "..", "data");
// users.json artık DOĞRUDAN okunmuyor — profil verisi lib/users-store.cjs
// üzerinden (Mongo varsa Mongo). Yol bilgisi orada.
const GROUPS_FILE  = path.join(DATA_DIR, "groups.json");
const SeasonTotals = require("../lib/season-totals.cjs");
const SocialStore = require("../lib/social-store.cjs");
const { kimlikVeyaHata } = require("../lib/kimlik-kontrol.cjs");
const TakimKatalog = require("../lib/takim-katalog.cjs");

// 🔹 LigCoin başlangıç değeri (pred/settle2 ile uyumlu olmalı)
// ⚠️ Tek kaynak: lib/ekonomi.cjs. Bu değer DÖRT dosyada İKİ AYRI ADLA
// (LC_START / INITIAL_DEFAULT) tanımlıydı; birini değiştiren diğerini
// aramazdı ve açılış bakiyesi kod yoluna göre değişebilirdi.
const { LC_START } = require("../lib/ekonomi.cjs");

async function readJson(file, fb) {
  try { return JSON.parse(await fsp.readFile(file, "utf8")); }
  catch { return fb; }
}

// atomic write (tek process için yeterli stabilite)
async function writeJsonAtomic(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fsp.rename(tmp, file);
}

const UsersStore = require("../lib/users-store.cjs");

/** Yeni kullanıcıda kurulacak alanlar (eski kayıtlarda eksikse tamamlanır). */
const USER_DEFAULTS = { mainTeam: null, lc: LC_START, lcLastDaily: null };

/**
 * Kullanıcıyı getirir, yoksa yaratır.
 *
 * Eskiden users.json'un TAMAMINI okuyup doğrusal arıyor ve değişiklik varsa
 * tümünü geri yazıyordu — 500.000 kullanıcıda tek profil isteği 1.34sn (yazma
 * varsa 2.7sn) olay döngüsünü KİLİTLİYORDU (ölçüldü). Ayrıca dosya kilidi
 * olmadığı için eşzamanlı iki yazımdan biri sessizce kayboluyordu.
 * Artık depo katmanı hallediyor: Mongo'da indeksli atomik upsert.
 */
async function ensureUser(userId, req) {
  return UsersStore.ensureUser(userId, USER_DEFAULTS, req?.app?.locals?.db || null);
}

const WALLET_FILE = path.join(DATA_DIR, "lc-wallet.json");

/**
 * Kullanıcının GERÇEK LC bakiyesi.
 *
 * Sıra: Mongo cüzdanı → cüzdan dosyası → profildeki eski `lc` alanı.
 * Son basamak yalnızca hiç cüzdan kaydı yoksa (yeni kullanıcı) devreye girer.
 *
 * Profildeki `lc` alanına GÜVENİLMEZ: cüzdan dosya aynası kapalıyken hiç
 * güncellenmiyor ve başlangıç değerinde donuyor.
 */
async function lcBakiyesi(userId, req, u) {
  const uid = String(userId || "").trim();
  const uidLower = uid.toLowerCase();
  const db = req?.app?.locals?.db || null;

  if (db) {
    try {
      const w = await db.collection("lc_wallet_users").findOne({ userIdLower: uidLower });
      if (w && Number.isFinite(Number(w.balance))) return Number(w.balance);
    } catch (e) {
      console.warn("[profile] cuzdan bakiyesi okunamadi:", e?.message || e);
    }
  }

  try {
    const state = await readJson(WALLET_FILE, { users: [] });
    const w = (state.users || []).find(
      (x) => String(x.userId || "").toLowerCase() === uidLower
    );
    if (w && Number.isFinite(Number(w.balance))) return Number(w.balance);
  } catch {}

  return typeof u?.lc === "number" ? u.lc : null;
}

/* =========================================================
   GROUPS compat layer (users.cjs <-> routes/groups.cjs uyumu)
   =========================================================
   Tek hedef model (source of truth): Map format

   groups.json (Map):
   {
     "ABC123": { name, ownerId, members:[userId], opts:{ userId:{ includeInTotal } }, createdAt }
   }

   Legacy destek:
   { items:[ { id, ownerId, name, members, createdAt, ... } ] }  -> ilk load'da migrate edilir
*/

function code6() {
  return crypto.randomBytes(4).toString("base64url").slice(0, 6).toUpperCase();
}
function normCode(code) {
  return String(code || "").trim().toUpperCase();
}
function normUserId(userId) {
  return String(userId || "").trim();
}

async function loadGroupsStoreCompat(db) {
  // Gruplar Mongo birincil — bkz. lib/social-store.cjs. Aşağıdaki eski biçim
  // toleransı korundu: dosya yedeğinde hâlâ {items:[...]} sarmalı olabilir.
  const raw = await SocialStore.loadGroups(db || null);

  // 1) Map format (ideal)
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    // 2) Legacy wrapper: {items:[...]} -> migrate to map
    if (Array.isArray(raw.items)) {
      const map = {};
      for (const g of raw.items) {
        if (!g || typeof g !== "object") continue;

        const ownerId = normUserId(g.ownerId);
        const name    = String(g.name || "").trim();
        if (!ownerId || !name) continue;

        const membersRaw = Array.isArray(g.members) ? g.members : [];
        const members = membersRaw.map((x) => normUserId(x)).filter(Boolean);

        let code = normCode(g.code || "");
        if (!code) code = code6();
        while (map[code]) code = code6();

        map[code] = {
          name,
          ownerId,
          members: members.includes(ownerId) ? members : [ownerId, ...members],
          opts: (g.opts && typeof g.opts === "object") ? g.opts : {},
          createdAt: g.createdAt || null,
          legacyId: g.id || null,
        };
      }
      await writeJsonAtomic(GROUPS_FILE, map);
      return map;
    }

    // raw zaten map gibi; ama içeriği guardlayalım
    return raw;
  }

  // yoksa boş map
  return {};
}

async function saveGroupsStore(store) {
  await writeJsonAtomic(GROUPS_FILE, store || {});
}

function groupSummary(code, g) {
  const members = Array.isArray(g?.members) ? g.members : [];
  return {
    code,
    name: g?.name || null,
    ownerId: g?.ownerId || null,
    members,
    size: members.length,
    createdAt: g?.createdAt || null,
  };
}

// loadUsersMap() kaldırıldı: tüm kullanıcı dosyasını yükleyip map kuruyordu.
// Tek çağıranı grup tablosuydu ve orası artık yalnızca grubun üyelerini
// çekiyor (UsersStore.getUsersByIds) — 20 kişilik tablo için 500.000 kaydın
// tamamını okumanın anlamı yoktu.

// Sezon toplamları Mongo öncelikli: totals.json Render'da her deploy'da
// siliniyor ve settle2 artık season_totals'a yazıyor. bkz. lib/season-totals.cjs
async function loadTotalsItems(db) {
  const totals = await SeasonTotals.loadTotals(db || null);
  return Array.isArray(totals.items) ? totals.items : [];
}

/* =========================
   USERS ENDPOINTS
   ========================= */

// GET /api/users/profile?userId=...
router.get("/profile", async (req, res) => {
  try {
    const userId = String(req.query.userId || "").trim();
    if (!userId) return res.status(400).json({ ok: false, error: "USER_REQUIRED" });

    const u = await ensureUser(userId, req);
    const profile = {
      userId,
      nickname: u.nickname || null,
      mainTeam: u.mainTeam || null,
      country: u.country || null,
      totals: Number(u.totals || 0),
      // YETKİLİ BAKİYE cüzdandan gelir (lc_wallet_users), profildeki `lc`
      // alanından DEĞİL.
      //
      // NEDEN: `users.lc` eski usul bir aynadır ve yalnızca cüzdan dosya aynası
      // açıkken güncellenir. Ayna kapalıyken (üretimdeki durum) kullanıcı
      // yaratılırken yazılan başlangıç değerinde donup kalır. Yarış ekranı bu
      // alanı "LC bakiye" diye gösteriyordu — yani gerçek bakiyesi ne olursa
      // olsun kullanıcı hep 30 görüyordu.
      lc: await lcBakiyesi(userId, req, u),
      is1987: !!(u.is1987 || String(u.segment || "").toLowerCase() === "1987"),
      preferredLeagues: Array.isArray(u.preferredLeagues) ? u.preferredLeagues : [],
      preferredLang: u.preferredLang || null,
    };

    return res.json({ ok: true, profile });
  } catch (e) {
    console.error("USER_PROFILE_ERR", e);
    return res.status(500).json({
      ok: false,
      error: "USER_PROFILE_ERR",
      detail: String(e && (e.message || e)),
    });
  }
});

// POST /api/users/set-main-team { team }
router.post("/set-main-team", verifyToken, express.json(), async (req, res) => {
  try {
    const userId = req.uid;
    const ham    = String(req.body?.team || "").trim();
    if (!userId || !ham) return res.status(400).json({ ok: false, error: "USER_OR_TEAM_MISSING" });

    /* ⚠️ KANONİKLEŞTİRME — `set-country` bunu yıllardır yapıyordu, takım
     * tarafında hiç yazılmamıştı. Ham kaydedilince "Galatasaray",
     * "galatasaray" ve "Galatasaray SK" AYRI değerler oluyor; `listByTeam`
     * tam eşleşme yaptığı için takım sıralaması sessizce bölünür.
     *
     * ⚠️ TANINMAYAN AD REDDEDİLMİYOR. Katalog 461 takım; dünyadaki her kulüp
     * orada değil ve bu uç başka ekranlardan da çağrılıyor. Reddetmek
     * çalışan bir akışı kırardı — bu yüzden bulunursa kanonik ad, yoksa
     * kırpılmış ham ad yazılıyor. `canonical` bayrağı istemciye hangisinin
     * olduğunu söylüyor. bkz. lib/takim-katalog.cjs */
    const kanonik = TakimKatalog.kanonikTakim(ham);
    const team = kanonik || ham;

    await UsersStore.updateUser(userId, { mainTeam: team }, USER_DEFAULTS, req.app.locals.db);
    return res.json({ ok: true, userId, mainTeam: team, canonical: !!kanonik });
  } catch (e) {
    console.error("SET_MAIN_TEAM_ERR", e);
    return res.status(500).json({
      ok: false,
      error: "SET_MAIN_TEAM_ERR",
      detail: String(e && (e.message || e)),
    });
  }
});

// POST /api/users/set-country { country }
// Kullanıcının "yereli": maç listesi bu ülkenin üst ligi + global kupalar olur.
router.post("/set-country", verifyToken, express.json(), async (req, res) => {
  try {
    const userId  = req.uid;
    const rawCountry = String(req.body?.country || "").trim();
    if (!userId || !rawCountry) return res.status(400).json({ ok: false, error: "USER_OR_COUNTRY_MISSING" });

    // Kanonik ada çevir (aksan/encoding farkları eşleşmeyi bozmasın)
    const { canonicalCountry } = require("./live2.cjs");
    const country = canonicalCountry(rawCountry);
    if (!country) return res.status(400).json({ ok: false, error: "COUNTRY_NOT_SUPPORTED", detail: rawCountry });

    await UsersStore.updateUser(userId, { country }, USER_DEFAULTS, req.app.locals.db);

    // user-country önbelleği 15sn TTL'li — ülke değişince sıralamanın hemen
    // doğru listeye düşmesi için düşür.
    try { require("../lib/user-country.cjs").invalidate(); } catch {}

    return res.json({ ok: true, userId, country });
  } catch (e) {
    console.error("SET_COUNTRY_ERR", e);
    return res.status(500).json({
      ok: false,
      error: "SET_COUNTRY_ERR",
      detail: String(e && (e.message || e)),
    });
  }
});

// POST /api/users/set-leagues { leagues: string[] }  — takip edilen ligler (ülke kodları)
router.post("/set-leagues", verifyToken, express.json(), async (req, res) => {
  try {
    const userId = req.uid;
    const raw = Array.isArray(req.body?.leagues) ? req.body.leagues : [];
    const { canonicalCountry } = require("./live2.cjs");
    // Hem 2-harf kod hem tam isim kabul et; geçersizleri at
    const leagues = raw.map(l => canonicalCountry(String(l).trim())).filter(Boolean).slice(0, 20);

    await UsersStore.updateUser(userId, { preferredLeagues: leagues }, USER_DEFAULTS, req.app.locals.db);
    return res.json({ ok: true, leagues });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "SET_LEAGUES_ERR", detail: String(e?.message || e) });
  }
});

// Rezerve kullanıcı adları — taklit/karışıklık önlemek için yasak (case-insensitive tam eşleşme)
const RESERVED_NICKNAMES = new Set([
  "admin", "administrator", "yonetici", "moderator", "mod",
  "sistem", "system", "skorlig", "official", "resmi", "destek", "support",
  "bot", "demo", "demo1", "demo_admin", "null", "undefined",
  "1987gs", "gs1987", "ben", "sen",
]);

// Türkçe karakterleri sadeleştirip normalize et (İ/I, ş, ü... rezerve/karşılaştırma için)
function normNick(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/ı/g, "i").replace(/İ/g, "i")
    .replace(/ş/g, "s").replace(/ğ/g, "g")
    .replace(/ü/g, "u").replace(/ö/g, "o").replace(/ç/g, "c")
    .trim();
}

// POST /api/users/set-nickname { nickname: string }  — görünen kullanıcı adı
router.post("/set-nickname", verifyToken, express.json(), async (req, res) => {
  try {
    const userId = req.uid;
    const raw = String(req.body?.nickname || "").trim().replace(/\s+/g, " ");
    // 2-20 karakter, harf/rakam/boşluk/._- ; başında-sonunda boşluk yok
    if (raw.length < 2 || raw.length > 20) {
      return res.status(400).json({ ok: false, error: "NICKNAME_LENGTH", detail: "2-20 karakter olmalı" });
    }
    if (!/^[\p{L}\p{N} ._-]+$/u.test(raw)) {
      return res.status(400).json({ ok: false, error: "NICKNAME_INVALID", detail: "Geçersiz karakter" });
    }

    const normRaw = normNick(raw);

    // Rezerve kelime kontrolü (normalize edilmiş halle)
    if (RESERVED_NICKNAMES.has(normRaw)) {
      return res.status(409).json({ ok: false, error: "NICKNAME_RESERVED", detail: "Bu kullanıcı adı kullanılamaz" });
    }

    // Benzersizlik: başka bir kullanıcının nickname'i VEYA userId'si ile
    // çakışmasın (userId kontrolü, okunabilir UID'li eski hesapların taklit
    // edilmesini engeller). Artık indeksli sorgu — eskiden tüm kullanıcılar
    // üzerinde `.some()` çalışıyordu.
    const db = req.app.locals.db;
    if (await UsersStore.isNicknameTaken(normRaw, userId, db)) {
      return res.status(409).json({ ok: false, error: "NICKNAME_TAKEN", detail: "Bu kullanıcı adı alınmış" });
    }

    // nicknameNorm indekslenip sorgulanıyor; normalize hali YAZILMAZSA
    // benzersizlik kontrolü sessizce hiçbir şey bulamaz.
    await UsersStore.updateUser(
      userId,
      { nickname: raw, nicknameNorm: normRaw },
      { ...USER_DEFAULTS, userIdNorm: normNick(userId) },
      db
    );
    return res.json({ ok: true, nickname: raw });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "SET_NICKNAME_ERR", detail: String(e?.message || e) });
  }
});

// POST /api/users/set-lang { lang: string }  — dil tercihi
router.post("/set-lang", verifyToken, express.json(), async (req, res) => {
  try {
    const userId = req.uid;
    const lang = String(req.body?.lang || "").trim().toLowerCase().slice(0, 5);
    if (!lang) return res.status(400).json({ ok: false, error: "LANG_REQUIRED" });

    await UsersStore.updateUser(userId, { preferredLang: lang }, USER_DEFAULTS, req.app.locals.db);
    return res.json({ ok: true, lang });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "SET_LANG_ERR", detail: String(e?.message || e) });
  }
});

// GET /api/users/favorite?userId=...
router.get("/favorite", async (req, res) => {
  try {
    const userId = String(req.query.userId || "").trim();
    if (!userId) return res.status(400).json({ ok: false, error: "USER_REQUIRED" });

    const u = await UsersStore.getUser(userId, req.app.locals.db);
    return res.json({ ok: true, favoriteTeam: u?.mainTeam || null });
  } catch (e) {
    console.error("FAVORITE_ERR", e);
    return res.status(500).json({
      ok: false,
      error: "FAVORITE_ERR",
      detail: String(e && (e.message || e)),
    });
  }
});

/* =========================
   USERS → GROUPS (ALIAS)
   Aynı davranış: /api/groups/*
   ========================= */

/**
 * GET /api/users/groups/list?userId=...
 * → /api/groups/list?userId=... ile aynı sonuç hedeflenir (summary list)
 */
/**
 * GET /api/users/groups/list?userId= — YALNIZCA KENDİ grupların.
 *
 * ⚠️ KİMLİK DENETİMİ YOKTU ve yanıt `groupSummary` döndürüyor: KATILIM
 * KODU ve TAM ÜYE LİSTESİ dahil. Yani herkes, sıralama tablolarında görünen
 * bir kimliği alıp o kişinin tüm özel gruplarının kodunu öğrenebiliyor ve
 * `POST /api/groups/join` ile o gruplara girebiliyordu.
 *
 * Bu, kod tabanlı özel grup fikrini tamamen geçersiz kılıyordu: kodları
 * tahmin edilemez yapmak (bkz. lib/social-store.cjs code6) bir şey ifade
 * etmez, çünkü bu uç onları bedavaya dağıtıyordu.
 *
 * İstemci zaten YALNIZCA kendi kimliğiyle çağırıyor (mobile/app/(tabs)/me.tsx);
 * eksik olan sunucunun bunu zorlamasıydı.
 */
router.get("/groups/list", verifyToken, async (req, res) => {
  try {
    const _k = kimlikVeyaHata(req, res, req.query.userId);
    if (!_k) return;
    const userId = normUserId(_k.uid);
    if (!userId) return res.status(400).json({ ok: false, error: "USER_REQUIRED" });

    const store = await loadGroupsStoreCompat(); // map
    const items = [];

    for (const [code, g] of Object.entries(store)) {
      if (!g || typeof g !== "object") continue;
      const ownerId = normUserId(g.ownerId);
      const members = Array.isArray(g.members) ? g.members.map(normUserId).filter(Boolean) : [];
      if (ownerId === userId || members.includes(userId)) {
        items.push(groupSummary(code, g));
      }
    }

    return res.json({ ok: true, items });
  } catch (e) {
    console.error("GROUP_LIST_ERR", e);
    return res.status(500).json({ ok: false, error: "GROUP_LIST_ERR", detail: String(e && (e.message || e)) });
  }
});

/**
 * POST /api/users/groups/create
 * body: { name, ownerId }
 * → /api/groups/create ile aynı davranış: { ok:true, code, group }
 */
router.post("/groups/create", verifyToken, express.json(), async (req, res) => {
  try {
    /* ⚠️ BU UÇ SocialStore'A DEVREDİLDİ.
     *
     * `groups.cjs` ile `users.cjs` AYNI uçları tanımlıyor ve Express ilk
     * eşleşeni kullanıyor: `/api/users/groups/*` isteklerini BU dosya
     * karşılıyor — istemci de tam olarak bu yolu çağırıyor.
     *
     * İki kopya AYRIŞMIŞTI. Yarış düzeltmesi `SocialStore`a yazılmış ve
     * belgelenmiş (lib/social-store.cjs: "eski kod ... kendisi de yarışlıydı"),
     * ama bu kopya eski "tüm depoyu oku → bellekte değiştir → tüm depoyu yaz"
     * desenini koruyordu. Yani belgelenen düzeltme gerçek kullanıcılar için
     * yürürlükte DEĞİLDİ. Kopyayı yamamak ayrışmayı sürdürürdü. */
    const name = String(req.body?.name || "").trim().slice(0, 40);
    const ownerId = req.uid;
    if (!name) return res.status(400).json({ ok: false, error: "NAME_REQUIRED" });
    if (!ownerId) return res.status(400).json({ ok: false, error: "USER_REQUIRED" });

    await ensureUser(ownerId, req);

    const r = await SocialStore.createGroup({ name, ownerId }, req.app?.locals?.db || null);
    if (!r?.code) return res.status(500).json({ ok: false, error: "GROUP_CREATE_FAILED" });
    return res.json({ ok: true, code: r.code, group: r.group });
  } catch (e) {
    console.error("GROUP_CREATE_ERR", e);
    return res.status(500).json({ ok: false, error: "GROUP_CREATE_FAILED", detail: String(e && (e.message || e)) });
  }
});

router.post("/groups/join", verifyToken, express.json(), async (req, res) => {
  try {
    // Devir gerekçesi için yukarıdaki /groups/create notuna bakın.
    const code = normCode(req.body?.code);
    const userId = req.uid;
    if (!code) return res.status(400).json({ ok: false, error: "CODE_REQUIRED" });
    if (!userId) return res.status(400).json({ ok: false, error: "USER_REQUIRED" });

    await ensureUser(userId, req);

    // Atomik: $addToSet hem yarışı hem mükerrer üyeliği kendisi engelliyor.
    const g = await SocialStore.joinGroup(code, userId, req.app?.locals?.db || null);
    if (!g) return res.status(404).json({ ok: false, error: "GROUP_NOT_FOUND" });

    return res.json({ ok: true, group: { code, name: g.name, size: (g.members || []).length } });
  } catch (e) {
    console.error("GROUP_JOIN_ERR", e);
    return res.status(500).json({ ok: false, error: "GROUP_JOIN_FAILED", detail: String(e && (e.message || e)) });
  }
});

router.get("/groups/:code/board", async (req, res) => {
  try {
    const code = normCode(req.params.code);
    const store = await loadGroupsStoreCompat();
    const g = store[code];
    if (!g) return res.status(404).json({ ok: false, error: "GROUP_NOT_FOUND" });

    const members = Array.isArray(g.members) ? g.members.map(normUserId).filter(Boolean) : [];

    // Yalnızca grubun ÜYELERİ çekilir. Eskiden tüm kullanıcı dosyası yüklenip
    // map kuruluyordu — 20 kişilik bir grup tablosu için 500.000 kaydın
    // tamamı okunuyordu.
    const usersMap = await UsersStore.getUsersByIds(members, req.app.locals.db);
    const totalsItems = await loadTotalsItems(req.app?.locals?.db || null);
    const itemsTotals = Array.isArray(totalsItems) ? totalsItems : [];

    const items = members.map((uid) => {
      const u = usersMap[uid] || {};
      const t = itemsTotals.find(x => String(x.userId) === String(uid)) || {};
      return {
        userId: uid,
        name: u.name || uid,
        flag: u.flag || null,
        includeInTotal: (g.opts?.[uid]?.includeInTotal ?? u.includeInTotal ?? true),
        points: Number(t.totalPoints || 0),
      };
    }).sort((a,b) => b.points - a.points);

    return res.json({
      ok: true,
      code,
      name: g.name,
      size: members.length,
      items,
    });
  } catch (e) {
    console.error("GROUP_BOARD_ERR", e);
    return res.status(500).json({ ok: false, error: "GROUP_BOARD_FAILED", detail: String(e && (e.message || e)) });
  }
});

/**
 * POST /api/users/groups/:code/opt
 * body: { userId, includeInTotal:boolean }
 */
// ⚠️ KİMLİK GÖVDEDEN ALINMIYOR ARTIK. Bu uç kimlik doğrulamasızdı ve
// `userId` gövdeden geliyordu — yani herkes BAŞKASININ adına işlem
// yapabiliyordu. Yetki denetimim bunu kaçırmıştı (kalıbım
// `express.json()` gibi parantezli ara katmanlarda eşleşmiyordu).
router.post("/groups/:code/opt", verifyToken, express.json(), async (req, res) => {
  try {
    const code = normCode(req.params.code);
    const userId = normUserId(req.uid);
    const includeInTotal = req.body?.includeInTotal;

    if (!userId || typeof includeInTotal !== "boolean") {
      return res.status(400).json({ ok: false, error: "REQ" });
    }

    /* ⚠️ Aynı ayrışma burada da vardı: bu kopya TÜM grup deposunu okuyup geri
     * yazıyordu, `groups.cjs` ise `SocialStore.setGroupOpt` ile tek alanı
     * güncelliyordu. Tüm depoyu yazmak, BAŞKA bir gruba yapılan eşzamanlı
     * değişikliği de silebilirdi. */
    const oldu = await SocialStore.setGroupOpt(
      code, userId, !!includeInTotal, req.app?.locals?.db || null
    );
    if (!oldu) return res.status(404).json({ ok: false, error: "GROUP_NOT_FOUND" });
    return res.json({ ok: true });
  } catch (e) {
    console.error("GROUP_OPT_ERR", e);
    return res.status(500).json({ ok: false, error: "GROUP_OPT_FAILED", detail: String(e && (e.message || e)) });
  }
});

/**
 * GET /api/users/groups/diag
 * küçük diag (groups.cjs ile benzer)
 */
router.get("/groups/diag", requireAdminToken, async (req, res) => {
  try {
    const store = await loadGroupsStoreCompat();
    const codes = Object.keys(store || {});
    return res.json({ ok: true, codes, groups: store });
  } catch (e) {
    console.error("GROUP_DIAG_ERR", e);
    return res.status(500).json({ ok: false, error: "GROUP_DIAG_FAILED", detail: String(e && (e.message || e)) });
  }
});

/* =========================
   1987 ÖZEL: ÜYE LİSTESİ VE SEZON TABLOSU
   ========================= */

// GET /api/users/1987
router.get("/1987", async (req, res) => {
  try {
    // İndeksli segment sorgusu — eskiden tüm kullanıcı dosyası yüklenip
    // JS'te süzülüyordu.
    const members = await UsersStore.listSegment1987(req.app.locals.db);

    return res.json({
      ok: true,
      count: members.length,
      users: members.map((u) => ({
        userId: u.userId,
        mainTeam: u.mainTeam || null,
        is1987: !!u.is1987,
        createdAt: u.createdAt || null,
        updatedAt: u.updatedAt || null,
      })),
    });
  } catch (e) {
    console.error("USERS_1987_ERR", e);
    return res.status(500).json({
      ok: false,
      error: "USERS_1987_ERR",
      detail: String(e && (e.message || e)),
    });
  }
});

/* Buradaki iki rota (/groups/join ve /groups/:code/board) İKİNCİ kez
   tanımlıydı; Express ilk eşleşeni kullandığı için HİÇ ÇALIŞMIYORLARDI.
   Eski sürümlerdi: grup dosyasını compat katmanı olmadan ham okuyor
   (legacy {items:[]} formatını göçürmezler) ve join sürümünde verifyToken
   YOKTU — sıralama değişseydi yetkisiz katılıma dönüşürdü.
   Çalışan sürümler yukarıda. Kaldırıldı: 2026-07-28. */


// GET /api/users/1987/season
router.get("/1987/season", async (req, res) => {
  try {
    // İndeksli segment sorgusu — eskiden tüm kullanıcı dosyası yüklenip
    // JS'te süzülüyordu.
    const uyeler = await UsersStore.listSegment1987(req.app.locals.db);
    const totalsItems = await loadTotalsItems(req.app?.locals?.db || null);
    const totalsByUser = new Map();
    for (const t of totalsItems) {
      const id = String(t.userId || "").trim();
      if (!id) continue;
      totalsByUser.set(id, t);
    }

    const rows = [];
    for (const u of uyeler) {
      const id = String(u.userId || "").trim();
      if (!id) continue;

      const t = totalsByUser.get(id) || {};
      const totalPoints = Number(t.totalPoints || t.total || 0);
      const matches     = Number(t.matches || t.played || 0);

      rows.push({
        userId: id,
        mainTeam: u.mainTeam || null,
        totalPoints,
        matches,
        lastAt: t.lastAt || null,
      });
    }

    rows.sort((a, b) => {
      if (b.totalPoints !== a.totalPoints) return b.totalPoints - a.totalPoints;
      if (b.matches     !== a.matches)     return b.matches - a.matches;
      return String(b.lastAt || "").localeCompare(String(a.lastAt || ""));
    });

    const season = rows.map((r, idx) => ({ ...r, rank: idx + 1 }));

    return res.json({ ok: true, count: season.length, season });
  } catch (e) {
    console.error("SEASON_1987_ERR", e);
    return res.status(500).json({
      ok: false,
      error: "SEASON_1987_ERR",
      detail: String(e && (e.message || e)),
    });
  }
});


// DELETE /api/users/delete-account
// Kullanıcının tüm verilerini ve Firebase Auth kaydını siler.
router.delete("/delete-account", verifyToken, async (req, res) => {
  const uid = req.uid;
  if (!uid) return res.status(400).json({ ok: false, error: "USER_REQUIRED" });

  const DATA_FILES = {
    users:       path.join(DATA_DIR, "users.json"),
    preds:       path.join(DATA_DIR, "preds.json"),
    leaderboard: path.join(DATA_DIR, "leaderboard.json"),
    wallet:      path.join(DATA_DIR, "lc-wallet.json"),
    friends:     path.join(DATA_DIR, "friends.json"),
    groups:      path.join(DATA_DIR, "groups.json"),
    totals:      path.join(DATA_DIR, "totals.json"),
  };

  async function readJson(file) {
    try { return JSON.parse(await fsp.readFile(file, "utf8")); } catch { return null; }
  }
  async function writeJson(file, data) {
    await fsp.writeFile(file, JSON.stringify(data, null, 2), "utf8");
  }

  try {
    // 1. users.json — kaydı sil
    const users = await readJson(DATA_FILES.users);
    if (Array.isArray(users)) {
      await writeJson(DATA_FILES.users, users.filter(u => String(u.userId || u.id) !== uid));
    } else if (users && typeof users === "object") {
      delete users[uid];
      await writeJson(DATA_FILES.users, users);
    }

    // 2. preds.json — tahminleri sil
    const preds = await readJson(DATA_FILES.preds);
    if (preds && typeof preds === "object") {
      for (const fid of Object.keys(preds)) {
        if (Array.isArray(preds[fid])) {
          preds[fid] = preds[fid].filter(p => String(p.userId || p.uid) !== uid);
        }
      }
      await writeJson(DATA_FILES.preds, preds);
    }

    // 3. leaderboard.json
    const lb = await readJson(DATA_FILES.leaderboard);
    if (Array.isArray(lb)) {
      await writeJson(DATA_FILES.leaderboard, lb.filter(r => String(r.userId || r.uid) !== uid));
    } else if (lb && typeof lb === "object") {
      delete lb[uid];
      await writeJson(DATA_FILES.leaderboard, lb);
    }

    // 4. lc-wallet.json
    const wallet = await readJson(DATA_FILES.wallet);
    if (wallet && typeof wallet === "object") {
      delete wallet[uid];
      await writeJson(DATA_FILES.wallet, wallet);
    }

    // 5. Arkadaşlıklar — tüm kayıtlardan çıkar
    //
    // ⚠️ BU BLOK ESKİDEN HİÇBİR ŞEY SİLMİYORDU. Şemayı `{uid: {friends,
    // pending, blocked}}` sanıyordu; gerçek şema `{links, requests, blocks}`.
    // `delete friends[uid]` üst düzeyde uid anahtarı olmadığı için boşa
    // gidiyor, döngü de "links"/"requests"/"blocks" DİZİLERİ üzerinde
    // `f.friends` arıyordu — undefined, yani sessiz no-op. Sonuç: hesabını
    // silen kullanıcı başkalarının arkadaş listesinde kalmaya devam ediyordu.
    // Yanlış şema hata vermez, sadece hiçbir şey yapmaz.
    const friends = await SocialStore.loadFriends(req.app?.locals?.db || null);
    const esitDegil = (x) => String(x || "").toLowerCase() !== uid.toLowerCase();
    friends.links    = friends.links.filter(l => esitDegil(l.a) && esitDegil(l.b));
    friends.requests = friends.requests.filter(r => esitDegil(r.from ?? r.a) && esitDegil(r.to ?? r.b));
    friends.blocks   = friends.blocks.filter(b => esitDegil(b.by ?? b.a) && esitDegil(b.target ?? b.b));
    await SocialStore.saveFriends(friends, req.app?.locals?.db || null);

    // 6. Gruplar — sahip olduğu grupları sil, üyelikten çıkar
    // (şema doğruydu; yalnızca depo Mongo'ya taşındı)
    const groups = await SocialStore.loadGroups(req.app?.locals?.db || null);
    if (groups && typeof groups === "object") {
      for (const gid of Object.keys(groups)) {
        const g = groups[gid];
        if (String(g.ownerId) === uid) {
          delete groups[gid];
        } else if (Array.isArray(g.members)) {
          g.members = g.members.filter(m => m !== uid);
        }
      }
      await SocialStore.saveGroups(groups, req.app?.locals?.db || null);
    }

    // 7. totals.json
    const totals = await readJson(DATA_FILES.totals);
    if (Array.isArray(totals)) {
      await writeJson(DATA_FILES.totals, totals.filter(r => String(r.userId || r.uid) !== uid));
    } else if (totals && typeof totals === "object") {
      delete totals[uid];
      await writeJson(DATA_FILES.totals, totals);
    }

    // 7b. Mongo koleksiyonları — dosya tabanlı adımlar bunları KAPSAMIYOR.
    //
    // ⚠️ Play Store hesap silme şartı "kullanıcı verisini sil" diyor; bugün
    // eklenen depolar (havuz bahsi, düello, seri, sezon toplamı, turnuva)
    // dosya adımlarının dışında kaldığı için kullanıcı silinse bile verisi
    // duruyordu. Silme yolunun yeni depolarla birlikte büyümesi gerekiyor —
    // yeni bir koleksiyon eklendiğinde buraya da eklenmeli.
    const dbSil = req.app?.locals?.db || null;
    if (dbSil) {
      const uidL = uid.toLowerCase();
      const islemler = [
        ["pool_bets",      { userIdLower: uidL }],
        ["season_totals",  { userIdLower: uidL }],
        ["streaks",        { userIdLower: uidL }],
        ["lc_wallet_users",{ userIdLower: uidL }],
        ["lc_wallet_ledger", { userIdLower: uidL }],
        ["predictions",    { userIdLower: uidL }],
        // Düello/turnuva: kullanıcı iki alanın herhangi birinde geçebilir.
        ["duels",          { $or: [{ creatorId: uid }, { acceptorId: uid }] }],
        ["tournaments",    { creatorId: uid }],
        ["mini_tournaments", { ownerId: uid }],

        // ⚠️ CİHAZ JETONU KİŞİSEL VERİDİR. Bu koleksiyon depo Mongo'ya
        // taşınırken eklendi ama silme listesine yazılmamıştı: hesabını
        // silen kullanıcının jetonu ve bildirim tercihleri kalıyordu.
        // Play Store "kullanıcı verisini sil" şartı bunu da kapsar.
        ["push_tokens",    { userIdLower: uidL }],
        // Haftalik kupon katilimlari: tahminler, odenen bedel, kazanilan
        // odul — hepsi kullaniciya ait.
        ["kupon_katilim", { userIdLower: uidL }],
        // Kupa/yarışma puanları da kullanıcı verisi.
        ["competition_totals", { $or: [{ userIdLower: uidL }, { userId: uid }] }],
      ];

      /* ⚠️ SİLMEK YETMİYOR: kullanıcı BAŞKALARININ kayıtlarının İÇİNDE de duruyor.
       *
       * Gruplarda bu iki durum ayrı ele alınmıştı (sahibi olduğu grup silinir,
       * üyesi olduğu gruptan çıkarılır) ama aynı ayrım mini turnuvada ve maç
       * sonucu anlık görüntülerinde yapılmamıştı:
       *
       *   mini_tournaments — yalnızca `ownerId` eşleşenler siliniyordu; kullanıcı
       *     BAŞKASININ turnuvasında üye/kazanan olarak kalıyordu.
       *
       *   match_results.rows — kullanıcının tahmini, puanı ve kırılımı her maçın
       *     anlık görüntüsünde gömülü duruyordu. Üstelik `/api/rt/pred/history`
       *     bu satırları `?userId=` ile döndürüyor: hesap silindikten SONRA da
       *     kimliği bilen biri tüm tahmin geçmişini okuyabiliyordu.
       *
       * Play Store "kullanıcı verisini sil" şartı bunları da kapsıyor. */
      const gomuluTemizlik = [
        /* ⚠️ İKİ AYRI GÜNCELLEME, TEK $pull DEĞİL. `$pull` dizi olmayan alanda
         * HATA verir; süzgeci alanın kendisine dayamak (`{winners: uid}` yalnızca
         * winners bir dizi VE uid içeriyorsa eşleşir) bunu yapısal olarak
         * imkânsız kılıyor. Tek $pull'da `winners: null` olan bir belge tüm
         * temizliği düşürürdü. */
        ["mini_tournaments", { members: uid }, { $pull: { members: uid } }],
        ["mini_tournaments", { winners: uid }, { $pull: { winners: uid } }],
        // İndeksli süzgeç (rows.userIdLower) — tüm anlık görüntüleri taramaz.
        ["match_results", { "rows.userIdLower": uidL }, { $pull: { rows: { userIdLower: uidL } } }],
      ];
      for (const [koleksiyon, filtre, guncelleme] of gomuluTemizlik) {
        try {
          const r = await dbSil.collection(koleksiyon).updateMany(filtre, guncelleme);
          if (r.modifiedCount) {
            console.log(`[delete-account] ${koleksiyon}: ${r.modifiedCount} kayittan cikarildi`);
          }
        } catch (e) {
          console.error(`[delete-account] ${koleksiyon} icinden cikarilamadi:`, e?.message || e);
        }
      }

      for (const [koleksiyon, filtre] of islemler) {
        try {
          const r = await dbSil.collection(koleksiyon).deleteMany(filtre);
          if (r.deletedCount) console.log(`[delete-account] ${koleksiyon}: ${r.deletedCount} kayit silindi`);
        } catch (e) {
          // Tek koleksiyon hatası silmeyi durdurmasın; ama sessiz kalma —
          // eksik silme bir uyum sorunudur.
          console.error(`[delete-account] ${koleksiyon} silinemedi:`, e?.message || e);
        }
      }

      /* ⚠️ PROFİL SATIRI. Yukarıdaki adımlar yalnızca `users.json` DOSYASINDAN
       * çıkarıyordu; Mongo'daki `users` belgesi duruyordu. Hesabını silen
       * kullanıcı aramalarda, takım kadrosunda ve 1987 üye listesinde
       * görünmeye devam ediyordu. Depoda silme fonksiyonu HİÇ YOKTU. */
      try {
        await UsersStore.deleteUser(uid, dbSil);
      } catch (e) {
        console.error("[delete-account] users profili silinemedi:", e?.message || e);
      }

      /* Maç bazlı sıralama anlık görüntüsü: belge fikstüre ait, ama `items`
       * dizisi kullanıcı satırları taşıyor. Belgeyi silmek başkalarının
       * verisini de götürürdü — yalnızca bu kullanıcının satırı çekiliyor. */
      try {
        const r = await dbSil.collection("leaderboard").updateMany(
          {},
          { $pull: { items: { $or: [{ userId: uid }, { userIdLower: uidL }] } } }
        );
        if (r.modifiedCount) console.log(`[delete-account] leaderboard: ${r.modifiedCount} anlik goruntuden cikarildi`);
      } catch (e) {
        console.error("[delete-account] leaderboard temizlenemedi:", e?.message || e);
      }
    }

    // 8. Firebase Auth'tan sil
    try {
      const { getAuth } = require("firebase-admin/auth");
      await getAuth().deleteUser(uid);
    } catch (authErr) {
      console.warn("Firebase delete user warn:", authErr.message);
      // Firebase silme başarısız olsa bile yerel veri silindi, devam et
    }

    return res.json({ ok: true, deleted: uid });
  } catch (e) {
    console.error("DELETE_ACCOUNT_ERR", e);
    return res.status(500).json({ ok: false, error: "DELETE_ACCOUNT_ERR", detail: String(e.message || e) });
  }
});

module.exports = router;
