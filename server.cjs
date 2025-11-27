"use strict";
require("dotenv").config();
require("dotenv").config({ path: require("path").join(__dirname, ".env") });

const express = require("express");
const cors    = require("cors");
const path    = require("path");
const fs      = require("fs");

const rateLimit = require("./middleware/rateLimit.cjs");

const app  = express();
const PORT = Number(process.env.PORT || 4102);
const HOST = process.env.HOST || "0.0.0.0";

/* ===== Core middlewares ===== */
app.use(cors({
  origin: true,
  credentials: true,
  methods: ["GET","POST","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization"]
}));
app.use(express.json());
app.use(rateLimit);

/* ===== Health ===== */
app.get("/health", (req,res)=> res.json({ ok:true, ts:new Date().toISOString() }));
app.get("/__up",   (req,res)=> res.json({ ok:true }));

/* ===== Safe-mount helper ===== */
function safeMount(name, fn){
  try {
    fn();
    console.log("[mount] " + name + " OK");
  } catch (e) {
    console.log("[mount] " + name + " SKIPPED: " + (e && (e.message || e)));
  }
}

/* ===== Routers ===== */
const team = require("./routes/team.cjs");
app.use("/api/team", team);

/* 🟢 GS CANLI ADMIN: /api/rt/admin-live-gs */
safeMount("rt-live-gs", () =>
  app.use("/api/rt", require("./routes/rt.live-gs.cjs"))
);

safeMount("totals-read",      ()=> app.use("/api/rt",         require("./routes/totals-read.cjs")));
safeMount("settle2",          ()=> app.use("/api/rt",         require("./routes/settle2.cjs")));

safeMount("totals-penalized", ()=> app.use("/api/stats",      require("./routes/totals-penalized.cjs")));
safeMount("live-fav",         ()=> app.use("/api/live",       require("./routes/live-fav.cjs")));
safeMount("stats",            ()=> app.use("/api/stats",      require("./routes/stats.cjs")));
safeMount("provider",         ()=> app.use("/api/provider",   require("./routes/provider.cjs")));
safeMount("db",               ()=> app.use("/api/db",         require("./routes/db.cjs")));
safeMount("live2",            ()=> app.use("/api/live2",      require("./routes/live2.cjs")));
safeMount("live1987",         ()=> app.use("/api/live1987",   require("./routes/live1987.cjs")));
safeMount("realtime",         ()=> app.use("/api/rt",         require("./routes/realtime.cjs")));
safeMount("rt-extra",         ()=> app.use("/api/rt",         require("./routes/rt-extra.cjs")));

safeMount("live",             ()=> app.use("/api",            require("./routes/live.cjs")));
safeMount("pred",             ()=> app.use("/api",            require("./routes/pred.cjs")));
safeMount("series",           ()=> app.use("/api",            require("./routes/series.cjs")));
safeMount("skorlig",          ()=> app.use("/api",            require("./routes/skorlig.cjs")));
safeMount("config",           ()=> app.use("/api/config",     require("./routes/config.cjs")));

safeMount("schedule",         ()=> app.use("/api/live",       require("./routes/schedule.cjs")));
safeMount("friends",          ()=> app.use("/api/friends",    require("./routes/friends.cjs")));
safeMount("users",            ()=> app.use("/api/users",      require("./routes/users.cjs")));
safeMount("presets",          ()=> app.use("/api",            require("./routes/presets.cjs")));
safeMount("leaderboard",      ()=> app.use("/api/leaderboard",require("./routes/leaderboard.cjs")));
safeMount("groups",           ()=> app.use("/api/groups",     require("./routes/groups.cjs")));
safeMount("totals",           ()=> app.use("/api/rt",         require("./routes/totals.cjs")));
safeMount("auth-1987gs",      ()=> app.use("/api/auth1987gs", require("./routes/auth-1987gs.cjs")));

/* Admin-live varsa mount et */
const ADMIN_LIVE_PATH = path.join(__dirname, "routes", "admin-live.cjs");
if (fs.existsSync(ADMIN_LIVE_PATH)) {
  safeMount("admin-live", ()=> app.use("/api/admin",    require("./routes/admin-live.cjs")));
} else {
  console.log("[mount] admin-live SKIPPED: file missing");
}

/* ===== Debug: list routes ===== */
app.get("/__routes", (req,res)=>{
  try{
    const collect = (appInstance)=> {
      const out = [];
      const stack = appInstance._router?.stack || [];
      for (const l of stack){
        if (l.route && l.route.path){
          const methods = Object.keys(l.route.methods || {}).filter(m=> l.route.methods[m]);
          out.push({ path: l.route.path, methods });
        } else if (l.name === "router" && l.handle?.stack){
          for (const s of l.handle.stack){
            if (s.route){
              const methods = Object.keys(s.route.methods || {}).filter(m=> s.route.methods[m]);
              out.push({ path: s.route.path, methods, base: l.regexp?.toString() });
            }
          }
        }
      }
      return out;
    };
    res.json({ ok:true, routes: collect(app) });
  } catch (e) {
    res.json({ ok:false, error:String(e) });
  }
});

app.get("/", (req,res)=> res.redirect("/health"));

/* ===== Start ===== */
app.listen(PORT, HOST, ()=>{
  console.log(`[SkorLig API] listening on http://${HOST}:${PORT}`);
});
