"use strict";
require("dotenv").config();
require("dotenv").config({ path: require("path").join(__dirname, ".env") });

const express     = require("express");
const cors        = require("cors");
const helmet      = require("helmet");
const compression = require("compression");
const path        = require("path");
const fs          = require("fs");

const rateLimit = require("./middleware/rateLimit.cjs");

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
const ALLOW_DEV_ORIGINS = process.env.NODE_ENV !== "production";

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
    console.log("[mongo] initMongo completed (or skipped)");
  }
})();

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
function safeMount(name, fn) {
  try {
    fn();
    console.log("[mount] " + name + " OK");
  } catch (e) {
    console.log(
      "[mount] " + name + " SKIPPED: " + (e && (e.message || e))
    );
  }
}

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
safeMount("series",           () => app.use("/api",            require("./routes/series.cjs")));
safeMount("skorlig",          () => app.use("/api",            require("./routes/skorlig.cjs")));
safeMount("config",           () => app.use("/api/config",     require("./routes/config.cjs")));
safeMount("fixtures",         () => app.use("/api/live",       require("./routes/fixtures.cjs")));
safeMount("schedule",         () => app.use("/api/live",       require("./routes/schedule.cjs")));
safeMount("friends",          () => app.use("/api/friends",    require("./routes/friends.cjs")));
safeMount("users-friends-compat", () => app.use("/api/users/friends", require("./routes/friends.cjs"))
);
safeMount("users",            () => app.use("/api/users",      require("./routes/users.cjs")));
safeMount("duels",            () => app.use("/api",            require("./routes/duels.cjs")));
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

  /* 🔔 Push bildirim zamanlayıcı: maç başlangıcı + sonuç duyurusu
     Kapatmak için: SKORLIG_PUSH_SCHED=0 (gönderimin tamamı: SKORLIG_PUSH=0) */
  if (process.env.SKORLIG_PUSH_SCHED !== "0") {
    safeMount("push-scheduler", () => require("./services/push-scheduler.cjs").start(5 * 60 * 1000));
  }

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

    // Yazma işlemleri bitene kadar bekle (kilit sayacı sıfırlanmalı)
    const deadline = Date.now() + SHUTDOWN_FORCE_MS - 2000;
    while (activeLockCount() > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const remaining = activeLockCount();
    if (remaining > 0) {
      console.warn(`[shutdown] ${remaining} kilit hâlâ açık — yine de çıkılıyor`);
    } else {
      console.log("[shutdown] tüm dosya yazmaları tamamlandı");
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
