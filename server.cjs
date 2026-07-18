"use strict";
require("dotenv").config();
require("dotenv").config({ path: require("path").join(__dirname, ".env") });

const express = require("express");
const cors    = require("cors");
const path    = require("path");
const fs      = require("fs");

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
app.use(cors({
  origin: true,
  credentials: true,
  methods: ["GET","POST","DELETE","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization","x-auth-token","x-user-id","x-admin-token"]
}));

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());
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
safeMount("auth-firebase",     () => app.use("/api",            require("./routes/auth-firebase.cjs")));

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
app.listen(PORT, HOST, () => {
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
});
