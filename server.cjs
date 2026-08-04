"use strict";
require("dotenv").config();
require("dotenv").config({ path: require("path").join(__dirname, ".env") });

/* ⚠️ ANA ŞALTER — TÜM ARKA PLAN SERVİSLERİ: `SKORLIG_BG=0`
 *
 * NEDEN VAR: servisleri kapatmanın tek yolu 9 ayrı bayrağı doğru adıyla
 * hatırlamaktı. Bir test sunucusunu `SKORLIG_BOTS=0` ile açtım — ÖYLE BİR
 * BAYRAK YOK, doğrusu SKORLIG_BOT_FILL. Yani hiçbir şey kapanmadı ve bunu
 * ancak log'da "[bot-filler] basladi" satırını görünce fark ettim.
 *
 * Asıl tehlike bot değil, listedeki SKORLIG_AUTO_SETTLE: yerel `.env` ÜRETİM
 * Atlas'ına bakıyor. Yanlış yazılmış tek bayrak, üretimde maç sonuçlandırıp
 * gerçek LC dağıtabilirdi.
 *
 * Yazım hatası artık sessiz kalamaz: tek isim, ya tutar ya tutmaz — ve tuttuğunda
 * neyin kapandığını log'a basar.
 *
 * ⚠️ Yeni arka plan servisi eklerken bayrağını AŞAĞIDAKİ listeye de ekle.
 */
if (String(process.env.SKORLIG_BG || "") === "0") {
  const KAPAT = [
    "SKORLIG_AF_SYNC", "SKORLIG_LIVESCORE", "SKORLIG_SYNC", "SKORLIG_AUTO_SETTLE",
    "SKORLIG_MONGO_HEALTH", "SKORLIG_PUSH", "SKORLIG_PUSH_SCHED",
    "SKORLIG_FIXTURE_SYNC", "SKORLIG_BOT_FILL", "SKORLIG_SCRAPER_HEALTH",
    "SKORLIG_KUPON_PLAN",
  ];
  for (const ad of KAPAT) process.env[ad] = "0";
  console.warn(`[SkorLig] SKORLIG_BG=0 — ${KAPAT.length} arka plan servisi KAPALI (yalnizca API).`);
}

const express     = require("express");
const cors        = require("cors");
const helmet      = require("helmet");
const compression = require("compression");
const path        = require("path");
const fs          = require("fs");

const rateLimit = require("./middleware/rateLimit.cjs");
// Kapanista yarida kesilmemesi gereken arka plan isleri (bkz. lib/kritik-is.cjs)
const { aktifKritikIs, aktifEtiketler } = require("./lib/kritik-is.cjs");

// 🔹 Mongo helper
const { getDb } = require("./lib/mongo.cjs");

const app  = express();
const PORT = Number(process.env.PORT || 4102);
const HOST = process.env.HOST || "0.0.0.0";

/* ===== Runtime config (Stats & UI için) ===== */
const RUNTIME_STAGE = process.env.RUNTIME_STAGE || "LOCAL_4_TEAMS";
const RUNTIME_STAGE_LABEL =
  process.env.RUNTIME_STAGE_LABEL || "Local 4 takımlı test (GS-FB-BJK-TS)";

const FEATURES_MODE = process.env.FEATURES_MODE || "LOCAL_4_TEAMS"; 
// StatsScreen'de sadece mode string'i gösteriliyor; "GS_ONLY" değilse
// sadece `Mode: LOCAL_4_TEAMS` gibi yazar.

/* ===== Core middlewares ===== */

// Güvenlik başlıkları. contentSecurityPolicy kapalı: public/privacy.html
// inline stil kullanıyor, varsayılan CSP onu bozardı. API JSON döndürdüğü
// için CSP'nin buradaki değeri zaten sınırlı.
app.use(helmet({ contentSecurityPolicy: false }));

// Yanıt sıkıştırma: fikstür/sıralama listeleri tekrarlı JSON — ~%70 kazanç.
app.use(compression());

/* CORS — allowlist.
 * Eskiden `origin: true` idi: gelen Origin başlığı körü körüne yansıtılıyor,
 * üstüne credentials:true veriliyordu. Yani herhangi bir web sitesi
 * kullanıcının tarayıcısından kimlikli istek atabiliyordu.
 * Mobil uygulama Origin başlığı GÖNDERMEZ — allowlist onu etkilemez.
 * Ek origin için: SKORLIG_CORS_ORIGINS="https://a.com,https://b.com"
 */
const CORS_ALLOWLIST = new Set(
  String(process.env.SKORLIG_CORS_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

// Yerel geliştirme origin'leri (Expo web, Metro, tarayıcı önizleme)
const DEV_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3})(:\d+)?$/;

/* ⚠️ Bu bayrak SESSİZCE geliştirme davranışına düşebiliyordu.
 *
 * Tek dayanağı `NODE_ENV`'di ve o değişken `.env.example`'da hiç geçmiyordu —
 * yani üretimde ayarlanmamış olması olağan durumdu. Ayarlanmadığında localhost
 * ve LAN origin'leri (192.168.*, 10.*) `credentials:true` ile kabul ediliyordu.
 *
 * Pratik risk düşük: API kimliği `x-auth-token` BAŞLIĞINDA taşıyor, çerezde
 * değil; tarayıcıdaki kötü niyetli bir sayfa kurbanın token'ını okuyamaz.
 * Yine de gevşek origin politikasının üretimde SESSİZCE açık kalması yanlış.
 *
 * Render `RENDER=true` set eder — NODE_ENV unutulsa bile üretim tanınsın.
 * Açık kaldığında aşağıda log'a uyarı düşer (bkz. mağaza mock uyarısı: sessiz
 * gevşeklik, fark edilmesi en zor olanıdır).
 */
const URETIM_SINYALI = require("./lib/ortam.cjs").uretimMi();
const ALLOW_DEV_ORIGINS = !URETIM_SINYALI;
if (ALLOW_DEV_ORIGINS) {
  console.warn(
    "[cors] ⚠️ Yerel gelistirme origin'leri (localhost/192.168.*/10.*) KABUL EDILIYOR. " +
    "Uretimde NODE_ENV=production ayarla."
  );
}

app.use(cors({
  origin(origin, cb) {
    // Origin yok = mobil uygulama, curl, sunucu-sunucu. Serbest.
    if (!origin) return cb(null, true);
    if (CORS_ALLOWLIST.has(origin)) return cb(null, true);
    if (ALLOW_DEV_ORIGINS && DEV_ORIGIN_RE.test(origin)) return cb(null, true);
    console.warn(`[cors] reddedildi: ${origin}`);
    return cb(null, false);
  },
  credentials: true,
  methods: ["GET","POST","DELETE","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization","x-auth-token","x-user-id","x-admin-token"]
}));

app.use(express.static(path.join(__dirname, "public")));

// Gövde limiti: en büyük gerçek payload (tahmin gönderimi) 1 KB'ın altında.
// Limitsiz bırakılırsa kimliksiz tek istek ana thread'i bloklayabilir.
app.use(express.json({ limit: "64kb" }));
app.use(rateLimit);

/* ===== Mongo init (global) ===== */
/**
 * UYARI: BAGLANTI ATESLE-UNUT, LISTEN ISE HEMEN CALISIYOR.
 *
 * Bu blok `await` iceriyor ve donuyor; modulun geri kalani senkron devam edip
 * `app.listen` cagiriyor. Yani sunucu, Mongo BAGLANMADAN once istek kabul
 * etmeye basliyor ve o pencerede `app.locals.db` TANIMSIZ.
 *
 * Rotalarin cogu `req.app?.locals?.db || null` okuyup null gorunce DOSYA
 * moduna dusuyor. Sonuc: deploy sonrasi ilk saniyelerde gonderilen bir tahmin
 * yalnizca dosyaya yaziliyor, settle2 ise `predictions` koleksiyonunu okuyor —
 * oyuncu 3 LC odemis ama tahmini hic sonuclanmiyor. Bu oturumda dosya/Mongo
 * ayrismasinin ne kadar sessiz oldugunu defalarca gorduk.
 *
 * `/health` kosulsuz 200 donduğu icin Render trafigi hemen yonlendiriyor;
 * yani pencere kuramsal degil, trafige acik.
 */
let _mongoInitBitti = false;

(async () => {
  try {
    const db = await getDb();          // mongo.cjs içindeki connectOnce
    if (db) {
      app.locals.db    = db;           // koleksiyon bazlı kullanmak isteyenler için
      app.locals.getDb = getDb;        // router içinde gerektiğinde tekrar çağırmak için
    }
  } catch (e) {
    console.error("[mongo] initMongo error:", e && e.message ? e.message : e);
  } finally {
    // BASARISIZLIKTA DA true: `connectOnce` denemeleri bitince null donuyor ve
    // uygulama bilerek dosya modunda calisiyor. Burada takili kalmak, Mongo
    // erisilemezken uygulamayi tamamen kapatmak olurdu.
    _mongoInitBitti = true;
    console.log("[mongo] initMongo completed (or skipped)");
  }
})();

/**
 * HAZIR OLMADAN API ISTEGI KABUL ETME.
 *
 * Yalnizca `/api` altini kapsiyor: `/health` ve `/__up` acik kaliyor ki surec
 * izleme calismaya devam etsin.
 *
 * Istemci tarafi (mobile/lib/fetchPolicy.ts) 502/503/504'u GET/HEAD icin
 * OTOMATIK yeniden deniyor (500ms, 1500ms) — okumalar kullaniciya hic
 * yansimiyor. POST'lar bilerek YENIDEN DENENMIYOR (cift gonderim riski), yani
 * yazma isteği durust bir hata aliyor. Bu, sessizce dosya moduna yazip 3 LC
 * alarak tahmini hic sonuclandirmamaktan iyi: kullanici tekrar deniyor ve
 * calisiyor.
 */
/* Hata ayrintilarini temizle: yanit yazilirken TEK yerde (bkz.
 * lib/hata-temizle.cjs). Kod tabaninda 22 dosyada 100 uc hatayi oldugu gibi
 * donduruyor ve olculdu: mutlak sunucu yolu ve Atlas kume adresi siziyor. */
app.use(require("./lib/hata-temizle.cjs").hataTemizleyici);

app.use((req, res, next) => {
  if (_mongoInitBitti) return next();
  if (!req.path.startsWith("/api")) return next();
  res.set("Retry-After", "1");
  return res.status(503).json({ ok: false, error: "NOT_READY" });
});

/* ===== Health ===== */
app.get("/health", (req, res) =>
  res.json({ ok: true, ts: new Date().toISOString() })
);
app.get("/__up", (req, res) => res.json({ ok: true }));

/* ===== Runtime config (mobile StatsScreen için) ===== */
app.get("/api/runtime/config", (req, res) => {
  try {
    const baseUrl = `${req.protocol}://${req.get("host")}`;

    res.json({
      ok: true,
      stage: {
        id: RUNTIME_STAGE,       // örn: LOCAL_4_TEAMS
        label: RUNTIME_STAGE_LABEL,
      },
      features: {
        mode: FEATURES_MODE,     // StatsScreen: Mode: LOCAL_4_TEAMS
        clubs: [
          "Galatasaray",
          "Fenerbahçe",
          "Beşiktaş",
          "Trabzonspor",
        ],
        locale: "tr-TR",
      },
      apiBase: baseUrl,
      now: new Date().toISOString(),
      version: "v1",
    });
  } catch (e) {
    console.error("RUNTIME_CONFIG_FAILED", e);
    res.status(500).json({
      ok: false,
      error: "RUNTIME_CONFIG_FAILED",
      detail: String(e && (e.message || e)),
    });
  }
});

/* ===== Safe-mount helper ===== */
/**
 * Rota yükleme — bir rota patlarsa uygulama komple düşmesin diye sarmalanmış.
 *
 * ⚠️ AMA SESSİZ OLMAMALI. Yaşandı (2026-07-29): mini.cjs'te eksik bir import
 * yüzünden router hiç yüklenmedi; sunucu normal açıldı, sağlık ucu "iyi" dedi
 * ve mini turnuva uçları sessizce 404 vermeye başladı. Tek iz, onlarca "OK"
 * satırının arasındaki bir `console.log` idi.
 *
 * İki değişiklik: hata artık console.ERROR (log toplayıcıda görünür) ve
 * atlanan rotalar /api/health'te listeleniyor — dışarıdan sorulabilir olsun.
 */
const MOUNTS = { ok: [], skipped: [] };

function safeMount(name, fn) {
  try {
    fn();
    MOUNTS.ok.push(name);
    console.log("[mount] " + name + " OK");
  } catch (e) {
    MOUNTS.skipped.push({ name, error: String((e && (e.message || e)) || "?") });
    console.error("[mount] " + name + " SKIPPED: " + (e && (e.message || e)));
  }
}

/**
 * GET /api/health — dışarıdan sorulabilir açılış durumu.
 * Atlanan rota varsa `ok:false` döner: "ayakta" ile "eksiksiz" farklı şeyler.
 */
app.get("/api/health", async (req, res) => {
  const db = req.app?.locals?.db || null;

  /* ⚠️ ÖDENMEMİŞ ÖDÜLLER GÖRÜNÜR OLSUN.
   *
   * settle2 ödül mührünü ödemeden ÖNCE atıyor (çift ödemeyi önlemek için).
   * Bunun ters riski: yazma başarısız olursa ödül kalıcı kaybolur ve tekrar
   * denenmez. O durumda `failed_awards` koleksiyonuna kalıcı iz bırakılıyor.
   *
   * İz yalnızca log'da kalsaydı kimse görmezdi. Burada sayılıyor: sıfırdan
   * büyükse elle telafi edilecek PARA var demektir.
   */
  /* ⚠️ SAYIM YALNIZCA ÇÖZÜLMEMİŞ BORCU KAPSAR.
   *
   * Eskiden `countDocuments({})` idi: kayıtlar hiç kapanmadığı için sayaç
   * yalnızca BÜYÜYORDU. Operatör borcu elle telafi etse bile sayı aynı
   * kalıyor, dolayısıyla YENİ bir kayıp (3 → 4) gürültüden ayırt
   * edilemiyordu. Kapatma yolu da yoktu — ne alan, ne uç.
   * Kapatma: POST /api/admin/failed-awards/resolve (routes/admin-users.cjs)
   */
  let odenmemisOdul = null;
  if (db) {
    try {
      odenmemisOdul = await db.collection("failed_awards")
        .countDocuments({ cozuldu: { $ne: true } }, { maxTimeMS: 2000 });
    } catch {
      odenmemisOdul = "okunamadi";
    }
  }

  /* ⚠️ KİMLİK MODU GÖRÜNÜR OLSUN. `firebase-admin` kurulamazsa üretimde artık
   * hiçbir istek geçmiyor (fail-closed) — ama arızayı ANLAMAK için modun
   * dışarıdan okunabilmesi gerek, yoksa belirti "her uç 503" olur ve nedeni
   * yalnızca log'da kalır. */
  const kimlik = require("./middleware/verifyToken.cjs").kimlikModu();

  const sorunVar = MOUNTS.skipped.length > 0 || kimlik === "kapali";

  /* ⚠️ KAYIP PARA, DURUM KODUNU DEĞİŞTİRMEDEN ALARM VERMELİ.
   *
   * BULUNAN: ödenmemiş ödül sayısı `sorunVar`a HİÇ girmiyordu — uç `ok:true`
   * ve HTTP 200 dönüyordu. İzleme araçları durum koduna ya da `ok` alanına
   * bakar; yani karşılığı ödenmemiş para SESSİZDİ. Bu uca yazılmasının tek
   * sebebi görünürlüktü ve tam orada görünmüyordu.
   *
   * ⚠️ AMA 503 DÖNMEK YANLIŞ ÇÖZÜM OLURDU. Bu servis Render'da çalışıyor ve
   * sağlık ucu 503 verince örnek SAĞLIKSIZ sayılıp yeniden başlatılabilir —
   * muhasebe sorununu KESİNTİYE çevirirdi. Süreç yaşıyor ve istek karşılıyor;
   * canlılık (liveness) ile para alarmı ayrı şeyler.
   *
   * Bu yüzden ayrı bir bayrak: izleme `paraUyarisi` alanına bağlanır,
   * yük dengeleyici durum koduna bakmaya devam eder.
   */
  const paraUyarisi = typeof odenmemisOdul === "number" ? odenmemisOdul > 0 : odenmemisOdul === "okunamadi";
  res.status(sorunVar ? 503 : 200).json({
    ok: !sorunVar,
    mountedCount: MOUNTS.ok.length,
    skipped: MOUNTS.skipped,
    mongo: !!db,
    // "firebase" = normal | "kapali" = URETIMDE kimlik kurulamadi (her uc 503)
    // | "yerel-gecis" = yalnizca gelistirme
    kimlikModu: kimlik,
    // >0 ise: bkz. routes/settle2.cjs "ODUL YAZIMI EKSIK"
    odenmemisOdulKaydi: odenmemisOdul,
    // ⚠️ İZLEME BUNA BAĞLANSIN. Durum kodu bilerek 200 kalıyor (yukarıdaki not).
    paraUyarisi,
    uptimeSec: Math.round(process.uptime()),
  });
});

/* ===== Routers ===== */
const team = require("./routes/team.cjs");
app.use("/api/team", team);

/* 🟢 GS CANLI ADMIN: /api/rt/admin-live-gs */
safeMount("rt-live-gs", () =>
  app.use("/api/rt", require("./routes/rt.live-gs.cjs"))
);

safeMount("totals-read",      () => app.use("/api/rt",         require("./routes/totals-read.cjs")));
safeMount("settle2",          () => app.use("/api/rt",         require("./routes/settle2.cjs")));

safeMount("totals-penalized", () => app.use("/api/stats",      require("./routes/totals-penalized.cjs")));
safeMount("live-fav",         () => app.use("/api/live",       require("./routes/live-fav.cjs")));
safeMount("stats",            () => app.use("/api/stats",      require("./routes/stats.cjs")));
safeMount("provider",         () => app.use("/api/provider",   require("./routes/provider.cjs")));
safeMount("db",               () => app.use("/api/db",         require("./routes/db.cjs")));
safeMount("live2",            () => app.use("/api/live2",      require("./routes/live2.cjs")));
safeMount("live1987",         () => app.use("/api/live1987",   require("./routes/live1987.cjs")));
safeMount("realtime",         () => app.use("/api/rt",         require("./routes/realtime.cjs")));
safeMount("rt-extra",         () => app.use("/api/rt",         require("./routes/rt-extra.cjs")));
safeMount("lc-wallet",        () => app.use("/api/rt",         require("./routes/lc-wallet.cjs")));

/* 🔹 Yeni: competitions + competition-totals */
safeMount("competitions",       () => app.use("/api/rt",       require("./routes/competitions.cjs")));
safeMount("competition-totals", () => app.use("/api/rt",       require("./routes/competition-totals.cjs")));

safeMount("live",             () => app.use("/api",            require("./routes/live.cjs")));
safeMount("pred",             () => app.use("/api",            require("./routes/pred.cjs")));
safeMount("skorlig",          () => app.use("/api",            require("./routes/skorlig.cjs")));
safeMount("config",           () => app.use("/api/config",     require("./routes/config.cjs")));
safeMount("fixtures",         () => app.use("/api/live",       require("./routes/fixtures.cjs")));
safeMount("schedule",         () => app.use("/api/live",       require("./routes/schedule.cjs")));
safeMount("friends",          () => app.use("/api/friends",    require("./routes/friends.cjs")));
safeMount("users-friends-compat", () => app.use("/api/users/friends", require("./routes/friends.cjs"))
);
safeMount("users",            () => app.use("/api/users",      require("./routes/users.cjs")));
safeMount("duels",            () => app.use("/api",            require("./routes/duels.cjs")));
safeMount("pool",             () => app.use("/api/pool",      require("./routes/pool.cjs")));
safeMount("presets",          () => app.use("/api",            require("./routes/presets.cjs")));
safeMount("leaderboard",      () => app.use("/api/leaderboard",require("./routes/leaderboard.cjs")));
safeMount("groups",           () => app.use("/api/groups",     require("./routes/groups.cjs")));
safeMount("users-groups-compat", () => app.use("/api/users/groups", require("./routes/groups.cjs"))
);

safeMount("totals",           () => app.use("/api/rt",         require("./routes/totals.cjs")));
safeMount("mini",             () => app.use("/api/mini",       require("./routes/mini.cjs")));
safeMount("tr-league",        () => app.use("/api/tr-league",  require("./routes/tr-league.cjs")));
safeMount("auth-1987gs",      () => app.use("/api/auth1987gs", require("./routes/auth-1987gs.cjs")));
safeMount("livescore",        () => app.use("/api/livescore",  require("./routes/livescore.cjs")));
safeMount("daily-picks",      () => app.use("/api/daily-picks", require("./routes/daily-picks.cjs")));
// Haftalik kupon (yeni oyun): bkz. lib/kupon.cjs
safeMount("kupon",           () => app.use("/api/kupon",      require("./routes/kupon.cjs")));
safeMount("tournaments",      () => app.use("/api/tournaments",   require("./routes/tournaments.cjs")));
safeMount("weekly-picks",     () => app.use("/api/weekly-picks", require("./routes/weekly-picks.cjs")));
safeMount("teams",            () => app.use("/api/teams",        require("./routes/teams.cjs")));
safeMount("auth-firebase",    () => app.use("/api",              require("./routes/auth-firebase.cjs")));
safeMount("push",             () => app.use("/api/push",         require("./routes/push.cjs")));
safeMount("pred-weights",     () => app.use("/api",              require("./routes/pred-weights.cjs")));

/* 🔹 Yeni: runtime mode admin paneli */
safeMount("admin-runtime", () =>
  app.use("/api/admin", require("./routes/admin-runtime.cjs"))
);

/* Admin-live varsa mount et */
const ADMIN_LIVE_PATH = path.join(__dirname, "routes", "admin-live.cjs");
if (fs.existsSync(ADMIN_LIVE_PATH)) {
  safeMount("admin-live", () =>
    app.use("/api/admin", require("./routes/admin-live.cjs"))
  );
} else {
  console.log("[mount] admin-live SKIPPED: file missing");
}
/* 🔹 Yeni: admin kullanıcı yönetimi (admin listesi API) */
safeMount("admin-users", () =>
  app.use("/api/admin", require("./routes/admin-users.cjs"))
);

/* ===== Debug: list routes ===== */
app.get("/__routes", (req, res) => {
  try {
    const collect = (appInstance) => {
      const out = [];
      const stack = appInstance._router?.stack || [];
      for (const l of stack) {
        if (l.route && l.route.path) {
          const methods = Object.keys(l.route.methods || {}).filter(
            (m) => l.route.methods[m]
          );
          out.push({ path: l.route.path, methods });
        } else if (l.name === "router" && l.handle?.stack) {
          for (const s of l.handle.stack) {
            if (s.route) {
              const methods = Object.keys(s.route.methods || {}).filter(
                (m) => s.route.methods[m]
              );
              out.push({
                path: s.route.path,
                methods,
                base: l.regexp?.toString(),
              });
            }
          }
        }
      }
      return out;
    };
    res.json({ ok: true, routes: collect(app) });
  } catch (e) {
    res.json({ ok: false, error: String(e) });
  }
});

app.get("/", (req, res) => res.redirect("/health"));

/**
 * BİLİNMEYEN ROTA — SESSİZ 404 YOK.
 *
 * ⚠️ NEDEN VAR: mobil tarafta dört ekran, VAR OLMAYAN uçlara istek atarken
 * aylarca fark edilmeden çalıştı (kings → /api/users, board2 →
 * /api/stats/board2, iki favori ekranı → /api/stats/fav ve /api/rt/fav-team).
 * Express varsayılan 404'ü sessizdir; istemci de hatayı yuttuğu için ekran
 * boş/işlevsiz kalıyor ve HİÇBİR YERDE iz kalmıyordu.
 *
 * Bu iki taraflı bir kural: istemci tarafı lib/apiFetch.ts'te 2xx dışını
 * loglar, burası da sunucu tarafında aynı olayı kaydeder. Sunucu logunu
 * izlemek cihaz logundan çok daha kolay.
 *
 * Yalnızca /api altını loglar: statik dosya ve tarayıcı gürültüsü (favicon vb.)
 * bu listeyi kirletmesin.
 */
app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) {
    console.warn(`[404] ${req.method} ${req.originalUrl} — boyle bir uc yok`);
  }
  next();
});

/* ===== Start ===== */
const server = app.listen(PORT, HOST, () => {
  console.log(`[SkorLig API] listening on http://${HOST}:${PORT}`);

  /* 🔄 API-Football senkron servisi: canlı skor + otomatik sonuç/settle
     Kapatmak için: SKORLIG_AF_SYNC=0 */
  if (process.env.SKORLIG_AF_SYNC !== "0") {
    safeMount("af-sync", () => require("./services/af-sync.cjs").start(PORT));
  }

  if (process.env.SKORLIG_LIVESCORE !== "0") {
    safeMount("livescore-scraper", () => require("./services/livescore-scraper.cjs").start(2 * 60 * 1000));
  }

  if (process.env.SKORLIG_SYNC !== "0") {
    safeMount("livescore-sync", () => require("./services/livescore-sync.cjs").start(30 * 1000, PORT));
  }

  /* 🗄️ Mongo sağlık izleme + otomatik toparlanma
     app.locals.db YALNIZCA açılışta atanır; o an Mongo düşükse uygulama
     yeniden başlatılana kadar dosya modunda kalır (2026-07-28'de yaşandı:
     Atlas M0 duraklatılmıştı, kimse fark etmedi, deploy'lar veri sildi).
     Bu servis bağlantı geri geldiğinde app.locals.db'yi CANLI günceller,
     düştüğünde alarm üretir ve düzenli ping'le kümeyi uyanık tutar.
     Kapatmak için: SKORLIG_MONGO_HEALTH=0 */
  safeMount("mongo-health", () =>
    require("./services/mongo-health.cjs").start(app)
  );

  /* 🔔 Push bildirim zamanlayıcı: maç başlangıcı + sonuç duyurusu
     Kapatmak için: SKORLIG_PUSH_SCHED=0 (gönderimin tamamı: SKORLIG_PUSH=0) */
  if (process.env.SKORLIG_PUSH_SCHED !== "0") {
    safeMount("push-scheduler", () => require("./services/push-scheduler.cjs").start(5 * 60 * 1000));
  }

  /* 🔁 Elle eklenen maçları geri yükle.
     fixtures.json her deploy'da siliniyor (kalıcı disk yok). Sağlayıcı
     maçları API'den yeniden gelir; ELLE girilenlerin başka kaynağı yok.
     Fikstür senkronundan ÖNCE mount edilir — merge() MANUAL kayıtlara
     dokunmadığı için önce geri yüklenirlerse korunurlar. */
  safeMount("manual-fixtures-restore", () =>
    require("./services/manual-fixtures-restore.cjs").start(app)
  );

  /* 📅 Fikstür senkronu: football-data.org → fixtures.json
     Ülke sıralaması için maç programı gerekli — Portekizli/Brezilyalı oyuncunun
     tahmin edecek maçı olmalı. Manuel girilen maçlara dokunmaz.
     6 saatte bir, tur başına 3 istek (kota: 10/dk).
     Kapatmak için: SKORLIG_FIXTURE_SYNC=0 */
  if (process.env.SKORLIG_FIXTURE_SYNC !== "0" && process.env.FDO_KEY) {
    safeMount("fixture-sync", () =>
      require("./services/fixture-sync.cjs").start(6 * 3600 * 1000, { days: 30 })
    );
  }

  /* 📅 Maçkolik fikstür senkronu: livescore-cache.json → fixtures.json
     25+ ülke, bugün + yarın penceresi. FDO ile cascade: kısa vadeli (MK 24h)
     + uzun vadeli (FDO 30 gün) ayrı ayrı çalışırlar.
     Her 3 dakika çünkü scraper 2 dakikada bir cache yazar — yeni verileri hızlıca.
     Kapatmak için: SKORLIG_FIXTURE_SYNC=0 */
  if (process.env.SKORLIG_FIXTURE_SYNC !== "0") {
    safeMount("mackolik-fixture-sync", () =>
      require("./services/mackolik-fixture-sync.cjs").start(3 * 60 * 1000)
    );
  }

  /* 🤖 Bot doluluk: yaklaşan maçlara otomatik bot doldurur.
     Sayı gerçek tahminciye göre belirlenir (bot = hedef − gerçek), bu yüzden
     her tur bot sayısı azalır ve hedef dolunca sıfırlanır. Önceden her maç
     için elle admin isteği gerekiyordu.
     Kapatmak için: SKORLIG_BOT_FILL=0 */
  if (process.env.SKORLIG_BOT_FILL !== "0") {
    safeMount("bot-filler", () =>
      require("./services/bot-filler.cjs").start(10 * 60 * 1000, PORT)
    );
  }

  /* 🩺 Scraper sağlık izleme: canlı skor cache'i bayatlarsa veya çalışan
     kaynak sayısı düşerse yönetim alarmı üretir. Şelale fiilen tek kaynağa
     (mackolik) dayandığı için kesinti ancak buradan erken fark edilir.
     Durum ucu: GET /api/admin/scraper-health
     Kapatmak için: SKORLIG_SCRAPER_HEALTH=0 */
  /* 🎟️ Haftalık kupon planlayıcı: eksik kuponları kurar (idempotent).
     Kapatmak için: SKORLIG_KUPON_PLAN=0 */
  if (process.env.SKORLIG_KUPON_PLAN !== "0") {
    safeMount("kupon-planlayici", () =>
      require("./services/kupon-planlayici.cjs").start(6 * 3600 * 1000));
  }

  /* Bayat mac temizleyici: sonucu gelmeyen maclarda kilitli kalan duello
   * bahislerini ve havuz paralarini iade eder. Kapatilabilir ama KAPATMAK
   * parayi kilitli birakir — varsayilan acik. bkz. lib/bayat-mac.cjs */
  if (process.env.SKORLIG_BAYAT_TEMIZLE !== "0") {
    safeMount("bayat-temizleyici", () =>
      require("./services/bayat-temizleyici.cjs").start(6 * 3600 * 1000));
  }

  /* Yetim canli durum dosyalari: fikstur kaydi silindikten sonra diskte kalan
   * data/live/*.json artiklari. Olculdu: 1403 dosyanin 305'i yetim ve hicbir
   * seyin sildigi yoktu. Fail-closed korumalar servisin icinde —
   * bkz. services/yetim-durum-temizleyici.cjs */
  if (process.env.SKORLIG_YETIM_TEMIZLE !== "0") {
    safeMount("yetim-temizleyici", () =>
      require("./services/yetim-durum-temizleyici.cjs").start(6 * 3600 * 1000));
  }

  if (process.env.SKORLIG_SCRAPER_HEALTH !== "0") {
    safeMount("scraper-health", () =>
      require("./services/scraper-health.cjs").start(10 * 60 * 1000)
    );
  }
});

/* ===== Düzgün kapanış =====
 * Süreç SIGTERM/SIGINT aldığında (deploy, restart, container stop) anında
 * ölürse yazılmakta olan dosya yarım kalır. Sıra:
 *   1) yeni bağlantı alma, açık istekleri bitir
 *   2) bekleyen dosya kilitlerinin boşalmasını bekle (yazma bitsin)
 *   3) Mongo bağlantısını kapat
 * FORCE_MS içinde bitmezse yine de çık — asılı kalmaktan iyidir.
 */
const { activeLockCount } = require("./lib/fileLock.cjs");
const SHUTDOWN_FORCE_MS = Number(process.env.SKORLIG_SHUTDOWN_MS || 15000);
let shuttingDown = false;

async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} alındı — düzgün kapanış başlıyor`);

  const forceTimer = setTimeout(() => {
    console.error(`[shutdown] ${SHUTDOWN_FORCE_MS}ms doldu — zorla çıkılıyor`);
    process.exit(1);
  }, SHUTDOWN_FORCE_MS);
  forceTimer.unref();

  try {
    await new Promise((resolve) => server.close(resolve));
    console.log("[shutdown] HTTP sunucusu kapandı");

    /* Yazma işlemleri bitene kadar bekle.
     *
     * ⚠️ İKİ SAYAÇ: `activeLockCount()` yalnızca DOSYA kilitlerini sayar.
     * Depolar Mongo'ya taşındıktan sonra para dağıtımı dosya kilidi tutmuyor,
     * yani o sayaç sıfır görünüyordu ve kapanış "her şey bitti" sanıp
     * çıkabiliyordu. HTTP istekleri `server.close()` ile korunuyor ama arka
     * plan servisleri (otomatik settle) zamanlayıcıyla çalışıyor ve hiçbir
     * isteğe bağlı değil. bkz. lib/kritik-is.cjs
     */
    const deadline = Date.now() + SHUTDOWN_FORCE_MS - 2000;
    while ((activeLockCount() > 0 || aktifKritikIs() > 0) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const remaining = activeLockCount();
    const kritik = aktifKritikIs();
    if (remaining > 0 || kritik > 0) {
      console.warn(
        `[shutdown] ${remaining} dosya kilidi, ${kritik} kritik is hâlâ açık ` +
        `(${aktifEtiketler().join(", ") || "-"}) — yine de çıkılıyor`
      );
    } else {
      console.log("[shutdown] tüm yazmalar tamamlandı (dosya + kritik iş)");
    }

    try {
      const { close } = require("./lib/mongo.cjs");
      if (typeof close === "function") await close();
    } catch {}

    clearTimeout(forceTimer);
    console.log("[shutdown] temiz çıkış");
    process.exit(0);
  } catch (e) {
    console.error("[shutdown] hata:", e && (e.message || e));
    process.exit(1);
  }
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT",  () => gracefulShutdown("SIGINT"));

// Yakalanmamış hatalar: logla ve düzgün kap — sessizce yarım yazma bırakma.
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
  gracefulShutdown("uncaughtException");
});
