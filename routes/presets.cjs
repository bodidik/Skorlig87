"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const router = express.Router();

// ---- paths / io helpers ----
const dataDir = path.join(__dirname, "..", "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const presetsPath    = path.join(dataDir, "presets.json");
const userStorePath  = path.join(dataDir, "user-presets.json");

function readJSONSafe(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    const t = fs.readFileSync(p, "utf8");
    if (!t) return fallback;
    return JSON.parse(t);
  } catch (e) {
    return fallback;
  }
}
function writeJSONSafe(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

function readPresets() {
  const j = readJSONSafe(presetsPath, []);
  return Array.isArray(j) ? j : (j ? [j] : []);
}
function writePresets(arr) {
  const out = Array.isArray(arr) ? arr : (arr ? [arr] : []);
  writeJSONSafe(presetsPath, out);
}
function readUserStore() {
  const j = readJSONSafe(userStorePath, {});
  return (j && typeof j === "object") ? j : {};
}
function writeUserStore(db) {
  writeJSONSafe(userStorePath, db && typeof db === "object" ? db : {});
}

// ---- utils (pin/captcha/analytics) ----
const _pinRL = new Map(); // key: "<id>|<ip>" -> { c:int, t:ms }
function hashPin(p) { return crypto.createHash("sha256").update(String(p || "")).digest("hex"); }

const _captchaMap = new Map(); // token -> { answer, expiresAt }
function makeCaptcha() {
  const a = Math.floor(Math.random() * 9) + 1;
  const b = Math.floor(Math.random() * 9) + 1;
  const question = `${a} + ${b} = ?`;
  const answer   = String(a + b);
  const token = crypto.randomBytes(8).toString("hex");
  const expiresAt = Date.now() + 5 * 60 * 1000; // 5 dk
  _captchaMap.set(token, { answer, expiresAt });
  setTimeout(() => {
    try { const it = _captchaMap.get(token); if (it && it.expiresAt <= Date.now()) _captchaMap.delete(token); } catch (e) {}
  }, 5 * 60 * 1000 + 5000);
  return { token, question };
}
function verifyCaptcha(token, value) {
  try {
    const it = _captchaMap.get(String(token || ""));
    if (!it) return false;
    if (Date.now() > it.expiresAt) { _captchaMap.delete(token); return false; }
    const ok = String(value || "").trim() === String(it.answer);
    if (ok) _captchaMap.delete(token);
    return ok;
  } catch (e) { return false; }
}

// ---- HTML helpers (tema + logo yer tutucu) ----
function baseHead() {
  return `
  <!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    html,body{margin:0;padding:0}
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#0b1220;color:#e5e7eb}
    .card{max-width:520px;margin:10vh auto;background:#0f172a;padding:20px;border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.4)}
    .logo{display:block;margin:0 auto 12px;width:64px;height:64px;border-radius:14px;background:#111 url('/p-static/logo.png') center/cover no-repeat}
    h1{margin:8px 0 6px;font-size:22px;text-align:center}
    p{opacity:.9;text-align:center}
    form{display:flex;gap:10px;justify-content:center;margin-top:14px}
    input{font-size:16px;padding:10px 12px;border-radius:10px;border:1px solid #334155;background:#0b1220;color:#e5e7eb}
    button{font-size:16px;padding:10px 12px;border:0;border-radius:10px;background:#22c55e;color:#0b1220;font-weight:800}
  </style>`;
}
function renderPin(left) {
  return `${baseHead()}
  <title>SkorLig PIN</title>
  <div class="card">
    <div class="logo"></div>
    <h1>SkorLig PIN</h1>
    <p>Koruma: ${left} deneme kaldı.</p>
    <form method="GET">
      <input type="password" name="pin" placeholder="PIN" autofocus />
      <button type="submit">Gönder</button>
    </form>
  </div>`;
}
function renderCaptcha(c, left, wrongPin) {
  return `${baseHead()}
  <title>SkorLig PIN + CAPTCHA</title>
  <div class="card">
    <div class="logo"></div>
    <h1>Güvenlik Doğrulaması</h1>
    <p>${wrongPin ? "Yanlış PIN. " : ""}Lütfen aşağıdaki soruyu cevaplayın.</p>
    <form method="GET" style="flex-direction:column;align-items:stretch">
      <div style="font-size:18px;font-weight:700;text-align:center;margin-bottom:6px">${c.question}</div>
      <input type="hidden" name="captchaToken" value="${c.token}" />
      <input type="password" name="pin" placeholder="PIN" autofocus />
      <input name="captcha" placeholder="Captcha cevabı" />
      <button type="submit">Gönder</button>
    </form>
    <p style="opacity:.7;margin-top:10px">Kalan deneme: ${left}</p>
  </div>`;
}
function renderLaunch(deeplink) {
  const safe = JSON.stringify(deeplink);
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>SkorLig Preset</title>
  <style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#0b1220;color:#e5e7eb;margin:0}
  .card{max-width:520px;margin:10vh auto;background:#0f172a;padding:20px;border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.4)}
  .logo{display:block;margin:0 auto 12px;width:64px;height:64px;border-radius:14px;background:#111 url('/p-static/logo.png') center/cover no-repeat}
  h1{margin:8px 0 6px;font-size:22px;text-align:center}
  p{opacity:.9;text-align:center}</style>
  <div class="card">
    <div class="logo"></div>
    <h1>SkorLig Preset</h1>
    <p>Uygulama açılıyor…</p>
    <script>location.href=${safe};</script>
    <p>Açılmıyorsa: <a href=${safe}>buraya dokun</a></p>
  </div>`;
}

// ========== USER PRESETS ==========
// GET /api/user-presets?userId=&includeDeleted=1
router.get("/user-presets", (req, res) => {
  const userId = String(req.query.userId || "");
  const includeDeleted = String(req.query.includeDeleted || "") === "1";
  if (!userId) return res.status(400).json({ ok: false, error: "USER_REQUIRED" });
  const db = readUserStore();
  const row = db[userId] || { items: [], userVersion: 0 };
  const items = Array.isArray(row.items) ? row.items : [];
  const filtered = includeDeleted ? items : items.filter(x => !x.deletedAt);
  return res.json({ ok: true, presets: filtered, userVersion: row.userVersion || 0 });
});

// POST /api/user-presets/soft-delete {userId,id}
router.post("/user-presets/soft-delete", (req, res) => {
  const body = req.body || {};
  const userId = String(body.userId || "");
  const id = String(body.id || "");
  if (!userId || !id) return res.status(400).json({ ok: false, error: "USER_ID_REQUIRED" });

  const db = readUserStore();
  const row = db[userId] || { items: [], userVersion: 0 };
  let found = false;
  row.items = (row.items || []).map(x => {
    if (String(x.id) === id && !x.deletedAt) { found = true; return Object.assign({}, x, { deletedAt: new Date().toISOString() }); }
    return x;
  });
  if (!found) return res.status(404).json({ ok: false, error: "NOT_FOUND_OR_ALREADY_DELETED" });
  row.userVersion = (row.userVersion || 0) + 1;
  db[userId] = row; writeUserStore(db);
  return res.json({ ok: true, userVersion: row.userVersion });
});

// POST /api/user-presets/restore {userId,id}
router.post("/user-presets/restore", (req, res) => {
  const body = req.body || {};
  const userId = String(body.userId || "");
  const id = String(body.id || "");
  if (!userId || !id) return res.status(400).json({ ok: false, error: "USER_ID_REQUIRED" });

  const db = readUserStore();
  const row = db[userId] || { items: [], userVersion: 0 };
  let found = false;
  row.items = (row.items || []).map(x => {
    if (String(x.id) === id && x.deletedAt) { found = true; const clone = Object.assign({}, x); delete clone.deletedAt; return clone; }
    return x;
  });
  if (!found) return res.status(404).json({ ok: false, error: "NOT_FOUND_OR_NOT_DELETED" });
  row.userVersion = (row.userVersion || 0) + 1;
  db[userId] = row; writeUserStore(db);
  return res.json({ ok: true, userVersion: row.userVersion });
});

// ========== SHORTLINK with PIN + CAPTCHA + THEME + ANALYTICS ==========
// GET /api/p/:id  (optional: ?pin=&captchaToken=&captcha=)
router.get("/p/:id", (req, res) => {
  const id = String(req.params.id || "");
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").toString();
  const pin = String(req.query.pin || "");
  const captchaToken = String(req.query.captchaToken || "");
  const captcha = String(req.query.captcha || "");
  const MAX = 5, WIN = 10 * 60 * 1000;

  const all = readPresets();
  const it = all.find(x => x && x.id === id);
  if (!it) return res.status(404).send("Not found");
  if (it.expiresAt && new Date(it.expiresAt).getTime() < Date.now()) return res.status(410).send("Expired");
  if (it.oneTime && it.usedAt) return res.status(410).send("Already used");

  const key = `${id}|${ip}`;
  let v = _pinRL.get(key) || { c: 0, t: Date.now() };
  if (Date.now() - v.t > WIN) v = { c: 0, t: Date.now() };

  if (it.pinHash) {
    if (v.c >= 3 && v.c < MAX && !captchaToken) {
      const c = makeCaptcha();
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.end(renderCaptcha(c, MAX - v.c, false));
    }
    if (v.c >= 3 && v.c < MAX && captchaToken) {
      const okCap = verifyCaptcha(captchaToken, captcha);
      if (!okCap) return res.status(403).send("Captcha failed");
    }
    if (v.c >= MAX) return res.status(429).send("Too many attempts. Try later.");

    if (!pin) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.end(renderPin(MAX - v.c));
    }
    if (hashPin(pin) !== String(it.pinHash)) {
      v.c += 1; v.t = Date.now(); _pinRL.set(key, v);
      if (v.c >= 3 && v.c < MAX) {
        const c = makeCaptcha();
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        return res.end(renderCaptcha(c, MAX - v.c, true));
      }
      return res.status(403).send(`PIN wrong. Remaining: ${Math.max(0, MAX - v.c)}`);
    }
    _pinRL.delete(key);
  }

  // analytics
  try {
    it.stats = it.stats || { views: 0, uniqueIps: [], lastAccessAt: null };
    it.stats.views += 1;
    const ipKey = (ip || "").toString();
    if (ipKey && !(it.stats.uniqueIps || []).includes(ipKey)) {
      it.stats.uniqueIps.push(ipKey);
      if (it.stats.uniqueIps.length > 5000) it.stats.uniqueIps.splice(0, it.stats.uniqueIps.length - 5000);
    }
    it.stats.lastAccessAt = new Date().toISOString();
    const nx = all.map(x => (x && x.id === it.id ? it : x));
    writePresets(nx);
  } catch (e) {}

  if (it.oneTime && !it.usedAt) {
    it.usedAt = new Date().toISOString();
    const nx = all.map(x => (x && x.id === it.id ? it : x));
    writePresets(nx);
  }

  const payload = encodeURIComponent(JSON.stringify({ type: "skorlig-preset", version: 1, data: it.data || {} }));
  const deeplink = `skorlig://preset?json=${payload}`;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.end(renderLaunch(deeplink));
});

// GET /api/presets/analytics/:id
router.get("/presets/analytics/:id", (req, res) => {
  const id = String(req.params.id || "");
  const all = readPresets();
  const it = all.find(x => x && x.id === id);
  if (!it) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
  const s = it.stats || { views: 0, uniqueIps: [], lastAccessAt: null };
  return res.json({
    ok: true,
    id,
    views: Number(s.views || 0),
    uniqueIPs: Array.isArray(s.uniqueIps) ? s.uniqueIps.length : 0,
    lastAccessAt: s.lastAccessAt || null,
    oneTime: !!it.oneTime,
    expiresAt: it.expiresAt || null
  });
});

module.exports = router;


