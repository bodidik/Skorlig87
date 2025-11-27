/**
 * routes/config.cjs
 * GET  /api/config          -> { features, scoring }
 * POST /api/config/update   -> settings.json'a yazar (Basic Auth)
 */
const express = require("express");
const router = express.Router();
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const SETTINGS = path.join(DATA_DIR, "settings.json");

async function readJson(file, fb=null){ try { return JSON.parse(await fsp.readFile(file,"utf8")); } catch (e) { return fb; } }
async function writeJson(file, data){
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fsp.rename(tmp, file);
}

// ---- Basic Auth (sadece POST için) ----
function _adminAuth(req, res, next) {
  const ADMIN_USER = process.env.ADMIN_USER || 'admin';
  const ADMIN_PASS = process.env.ADMIN_PASS || 'skorlig';
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="SkorLig Admin"');
    return res.status(401).send('Auth required');
  }
  const [u, p] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
  if (u === ADMIN_USER && p === ADMIN_PASS) return next();
  res.set('WWW-Authenticate', 'Basic realm="SkorLig Admin"');
  return res.status(401).send('Bad credentials');
}

// ---- GET /api/config ----
router.get("/", async (req,res)=>{
  const def = {
    features: { mode:"GS_ONLY", showProfile:true, showLeaderboard:true, enableCoupons:false },
    scoring : { startBalance:500, useProbabilityEngine:false, K_outcome:3, epsilon:0.05, unknownPenaltyPct:0.10 }
  };
  const s = await readJson(SETTINGS, null);
  const out = s ? { features: s.features||def.features, scoring: s.scoring||def.scoring } : def;
  res.json({ ok:true, config: out, from: s? "settings.json":"default" });
});

// ---- POST /api/config/update ----
router.post("/update", _adminAuth, express.json(), async (req, res) => {
  try {
    const body = req.body || {};
    const features = body.features || {};
    const scoring  = body.scoring  || {};
    const modes = new Set(['GS_ONLY','MULTI_LEAGUE']);
    if (features.mode && !modes.has(String(features.mode))) {
      return res.status(400).json({ ok:false, error:'INVALID_MODE' });
    }
    const out = {
      features: {
        mode: features.mode || 'GS_ONLY',
        showProfile: features.showProfile !== false,
        showLeaderboard: features.showLeaderboard !== false,
        enableCoupons: !!features.enableCoupons,
      },
      scoring: {
        startBalance: Number(scoring.startBalance ?? 500),
        useProbabilityEngine: !!scoring.useProbabilityEngine,
        K_outcome: Number(scoring.K_outcome ?? 3),
        epsilon: Number(scoring.epsilon ?? 0.05), unknownPenaltyPct: Number(scoring.unknownPenaltyPct ?? 0.10), unknownPenaltyPct: Number(scoring.unknownPenaltyPct ?? 0.10),
      }
    };
    await writeJson(SETTINGS, out);
    return res.json({ ok:true, saved: out, file:'data/settings.json' });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e) });
  }
});

module.exports = router;






