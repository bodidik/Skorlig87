"use strict";

const fs   = require("fs");
const fsp  = fs.promises;
const path = require("path");

const DATA_DIR   = path.join(__dirname, "..", "data");
const STORE_PATH = path.join(DATA_DIR, "providers.json");

/** onarım + varsayılan */
function emptyModel(){
  return {
    providers: {
      AF:   { ok:0, fail:0, lastMs:0, lastAt:null },
      TSDB: { ok:0, fail:0, lastMs:0, lastAt:null },
      FDO:  { ok:0, fail:0, lastMs:0, lastAt:null }
    },
    quotas: {
      AF:   { daily: 100,   used: 0 },
      TSDB: { daily: 10000, used: 0 },
      FDO:  { daily: 1000,  used: 0 }
    },
    teams: { /* "Galatasaray":"TSDB", ... kalıcı tercih */ },
    updatedAt: null
  };
}

async function readJson(file, fb){ try{ return JSON.parse(await fsp.readFile(file,"utf8")); }catch{ return fb; } }
async function writeJson(file, data){
  await fsp.mkdir(path.dirname(file), { recursive:true });
  await fsp.writeFile(file, JSON.stringify(data,null,2), "utf8");
}

async function ensureModel(){
  let m = await readJson(STORE_PATH, null);
  const def = emptyModel();
  if(!m || typeof m!=="object") m = def;
  // alanları garanti
  m.providers = Object.assign({}, def.providers, (m.providers||{}));
  m.quotas    = Object.assign({}, def.quotas,    (m.quotas||{}));
  m.teams     = Object.assign({}, def.teams,     (m.teams||{}));
  if(!m.updatedAt) m.updatedAt = new Date().toISOString();
  await writeJson(STORE_PATH, m);
  return m;
}

/** kota eşiği: %90 default */
function quotaHot(q, threshold=0.90){
  if(!q || !Number.isFinite(q.daily)) return false;
  return (q.used||0) >= Math.floor(q.daily*threshold);
}

/** sağlayıcıyı işaretle + kota arttır */
async function markUsage(name, ok=true, ms=0){
  const m = await ensureModel();
  const P = (m.providers[name] ||= { ok:0, fail:0, lastMs:0, lastAt:null });
  const Q = (m.quotas[name]    ||= { daily:100, used:0 });
  if(ok) P.ok++; else P.fail++;
  P.lastMs = Number(ms)||0;
  P.lastAt = new Date().toISOString();
  Q.used   = Math.max(0,(Q.used||0)+1);
  m.updatedAt = new Date().toISOString();
  await writeJson(STORE_PATH, m);
  return { provider:P, quota:Q };
}

/** takım için kalıcı tercih oku/yaz */
async function getPreferred(team){
  const m = await ensureModel();
  return m.teams[String(team||"").toLowerCase()] || null;
}
async function setPreferred(team, name){
  const m = await ensureModel();
  m.teams[String(team||"").toLowerCase()] = name;
  m.updatedAt = new Date().toISOString();
  await writeJson(STORE_PATH, m);
}

/** sırayı hazırla: takımda varsa onu öne al; kotaları %90 üstüyse sona at */
async function buildOrder(team){
  const m = await ensureModel();
  const base = ["TSDB","FDO","AF"]; // ücretsiz önce
  const pref = await getPreferred(team);
  let order = base.slice();
  if (pref && order.includes(pref)) {
    order = [pref, ...order.filter(x=>x!==pref)];
  }
  // kotaları değerlendir
  order.sort((a,b)=>{
    const qa = m.quotas[a]||{daily:100,used:0}, qb = m.quotas[b]||{daily:100,used:0};
    const ha = quotaHot(qa) ? 1 : 0;
    const hb = quotaHot(qb) ? 1 : 0;
    return ha - hb; // sıcak (1) olanlar sona
  });
  return order;
}

module.exports = {
  ensureModel, markUsage, getPreferred, setPreferred, buildOrder, quotaHot,
  STORE_PATH
};