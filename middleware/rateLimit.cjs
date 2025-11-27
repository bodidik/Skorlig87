const WHITELIST_PATHS = [
  /^\/health$/,
  /^\/api\/leaderboard$/,
  /^\/api\/rt\/state$/,
  /^\/api\/rt\/board$/,
  /^\/api\/rt\/disabled$/
];
/**
 * middleware/rateLimit.cjs
 * Muaf: /health, /api/rt/state, /api/fixtures/list, /api/leaderboard, /api/rt/poll
 * Sınırlı: /api/pred/submit (5s)
 */
const buckets = new Map();

const SKIP = [
  /\/health$/,
  /\/api\/rt\/state\b/,
  /\/api\/fixtures\/list\b/,
  /\/api\/leaderboard\b/,
  /\/api\/rt\/poll\b/          // poll MUAF — zaten MAX_POLL var
];

const WINDOWS = [
  { re: /\/api\/pred\/submit\b/, ms: 5_000 }   // sadece submit 5sn
];

function windowFor(url){
  for (const s of SKIP) if (s.test(url)) return 0;
  for (const w of WINDOWS) if (w.re.test(url)) return w.ms;
  return 0; // diğer her şey muaf
}

function key(req){
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "0.0.0.0";
  const uid = req.body?.userId || req.query?.userId || "-";
  const route = req.originalUrl || req.path || "/";
  return `${ip}::${uid}::${route}`;
}

function rateLimit(req,res,next){
  try { if (WHITELIST_PATHS.some(rx => rx.test(String(req.path||req.url||"")))) return next(); } catch(e) {}
  const url = String(req.originalUrl || req.path || "/");
  const win = windowFor(url);
  if (win === 0) return next();

  const k = key(req);
  const now = Date.now();
  const hit = buckets.get(k) || 0;
  if (now - hit < win){
    return res.status(429).json({ ok:false, error:"RATE_LIMIT", waitMs: win - (now - hit) });
  }
  buckets.set(k, now);
  next();
}

module.exports = rateLimit;

