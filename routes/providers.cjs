"use strict";

const express = require("express");
const router  = express.Router();
const fs      = require("fs");
const fsp     = fs.promises;
const path    = require("path");

const DATA_DIR  = path.join(__dirname, "..", "data");
const FILE_PATH = path.join(DATA_DIR, "providers.json");

async function readJson(file, fb){ try{ return JSON.parse(await fsp.readFile(file,"utf8")); }catch{ return fb; } }
async function writeJson(file, data){
  await fsp.mkdir(path.dirname(file), { recursive:true });
  await fsp.writeFile(file, JSON.stringify(data,null,2), "utf8");
}

function emptyModel(){
  return {
    providers: {
      AF:   { ok:0, fail:0, lastMs:0, lastAt:null },
      TSDB: { ok:0, fail:0, lastMs:0, lastAt:null },
      FDO:  { ok:0, fail:0, lastMs:0, lastAt:null }
    },
    quotas: { AF: { daily: 100, used: 0 }, TSDB: { daily: 1000, used: 0 }, FDO: { daily: 1000, used: 0 } },
    updatedAt: null
  };
}

// GET /api/provider/diag
router.get("/diag", async (req,res)=>{
  const m = await readJson(FILE_PATH, emptyModel());
  return res.json({ ok:true, model: m });
});

// POST /api/provider/mark?name=AF&ok=1&ms=120
router.post("/mark", express.json(), async (req,res)=>{
  const name = String(req.query.name||req.body?.name||"").toUpperCase();
  const ok   = String(req.query.ok??req.body?.ok??"1") === "1";
  const ms   = Number(req.query.ms??req.body?.ms??0) || 0;

  if(!name || !["AF","TSDB","FDO"].includes(name)) return res.status(400).json({ ok:false, error:"NAME_INVALID" });
  const m = await readJson(FILE_PATH, emptyModel());

  const p = m.providers[name] || (m.providers[name] = { ok:0, fail:0, lastMs:0, lastAt:null });
  if(ok) p.ok++; else p.fail++;
  p.lastMs = ms; p.lastAt = new Date().toISOString();

  const q = m.quotas[name] || (m.quotas[name] = { daily: 100, used: 0 });
  q.used = Math.max(0, q.used + 1);

  m.updatedAt = new Date().toISOString();
  await writeJson(FILE_PATH, m);
  res.json({ ok:true, provider:name, stats:p, quota:q });
});

// POST /api/provider/reset?name=AF  (tek)  veya  /api/provider/reset  (hepsi)
router.post("/reset", async (req,res)=>{
  const name = String(req.query.name||"").toUpperCase();
  let m = await readJson(FILE_PATH, emptyModel());
  if(name && ["AF","TSDB","FDO"].includes(name)){
    m.providers[name] = { ok:0, fail:0, lastMs:0, lastAt:null };
    m.quotas[name]    = { daily: (m.quotas[name]?.daily||100), used: 0 };
  }else if(!name){
    m = emptyModel();
  }else{
    return res.status(400).json({ ok:false, error:"NAME_INVALID" });
  }
  m.updatedAt = new Date().toISOString();
  await writeJson(FILE_PATH, m);
  res.json({ ok:true, model:m });
});

module.exports = router;