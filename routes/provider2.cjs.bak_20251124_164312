"use strict";
const express = require("express");
const router  = express.Router();
const fs = require("fs"); const fsp = fs.promises; const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const FILE = path.join(DATA_DIR, "providers.json");
async function readJson(file, fb){ try{ return JSON.parse(await fsp.readFile(file,"utf8")); }catch{ return fb; } }
async function writeJson(file, data){ await fsp.mkdir(path.dirname(file), {recursive:true}); await fsp.writeFile(file, JSON.stringify(data,null,2), "utf8"); }

function ensureModel(m){
  m.providers   = m.providers   || {};
  m.quotas      = m.quotas      || {};
  m.teamPrimary = m.teamPrimary || {};
  m.settings    = m.settings    || { autoPrimary: true }; // varsayılan: açık
  return m;
}

/** GET /api/provider/team-primary?team=Galatasaray */
router.get("/team-primary", async (req,res)=>{
  const team = String(req.query.team||"");
  const m = ensureModel(await readJson(FILE, {}));
  const p = m.teamPrimary?.[team] || null;
  res.json({ ok:true, team, provider: p });
});

/** POST /api/provider/team-primary { team, provider } */
router.post("/team-primary", express.json(), async (req,res)=>{
  const team = String(req.body?.team||""); const provider = String(req.body?.provider||"").toUpperCase();
  if(!team || !provider) return res.status(400).json({ ok:false, error:"REQUIRED" });
  const allowed = ["AF","TSDB","FDO"];
  if(!allowed.includes(provider)) return res.status(400).json({ ok:false, error:"PROVIDER_INVALID" });
  const m = ensureModel(await readJson(FILE, {}));
  m.teamPrimary[team] = provider;
  m.updatedAt = new Date().toISOString();
  await writeJson(FILE, m);
  res.json({ ok:true, team, provider });
});

/** GET /api/provider/warn */
router.get("/warn", async (req,res)=>{
  const m = ensureModel(await readJson(FILE, {}));
  res.json({ ok:true, quotas: m.quotas });
});

/** POST /api/provider/warn { name, warn }  (yüzde veya mutlak) */
router.post("/warn", express.json(), async (req,res)=>{
  const name = String(req.body?.name||"").toUpperCase();
  let warn = Number(req.body?.warn||0);
  if(!name || !Number.isFinite(warn)) return res.status(400).json({ ok:false, error:"REQUIRED" });
  const m = ensureModel(await readJson(FILE, {}));
  m.quotas[name] = m.quotas[name] || { daily:100, used:0, warn:90 };
  if (warn>1 && warn<=100) { m.quotas[name].warn = Math.round(m.quotas[name].daily * warn / 100); }
  else { m.quotas[name].warn = Math.round(warn); }
  m.updatedAt = new Date().toISOString();
  await writeJson(FILE, m);
  res.json({ ok:true, quota: m.quotas[name] });
});

/** GET /api/provider/auto-primary → {autoPrimary: true/false} */
router.get("/auto-primary", async (req,res)=>{
  const m = ensureModel(await readJson(FILE, {}));
  res.json({ ok:true, settings: m.settings });
});

/** POST /api/provider/auto-primary { enabled: boolean } */
router.post("/auto-primary", express.json(), async (req,res)=>{
  const enabled = !!req.body?.enabled;
  const m = ensureModel(await readJson(FILE, {}));
  m.settings.autoPrimary = enabled;
  m.updatedAt = new Date().toISOString();
  await writeJson(FILE, m);
  res.json({ ok:true, settings: m.settings });
});

module.exports = router;