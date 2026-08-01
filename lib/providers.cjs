"use strict";

const fs   = require("fs");
const fsp  = fs.promises;
const path = require("path");

// ⚠️ SKORLIG_DATA_DIR: sabit yol testleri GERÇEK data/ dizinine yazdırır.
const DATA_DIR   = process.env.SKORLIG_DATA_DIR || path.join(__dirname, "..", "data");
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

/**
 * ⚠️ ATOMİK YAZMA + KİLİT — ikisi de EKSİKTİ, ikisi de ölçüldü.
 *
 * Bu dosya (providers.json) API KOTA SAYAÇLARINI tutuyor ve ALTI modül
 * tarafından yazılıyor: lib/providers, services/af-sync, routes/live2,
 * routes/fixtures, routes/live1987, routes/provider. Hepsi "oku → değiştir →
 * tümünü yaz" yapıyordu, kilitsiz ve doğrudan hedef dosyaya.
 *
 * ÖLÇÜLDÜ:
 *   • 40 eşzamanlı `markUsage("AF")` → dosyada `used: 1`. 39 artış KAYIP.
 *   • Yazma sürerken 662 okumanın 81'i (%12) YARIM JSON okudu.
 *
 * İkincisi daha sinsi: her okuyucu `JSON.parse` hatasını yutup varsayılana
 * düşüyor, yani `used` SIFIR görünüyor — "kota bitmedi" denip kota aşıldıktan
 * sonra da istek atılıyor. Sayaç, tam korumasız olduğu anda "her şey yolunda"
 * diyor.
 *
 * ⚠️ KİLİT SÜREÇ İÇİ. Render tek süreç çalıştırdığı için gerçek koruma bu;
 * çok süreçli bir dağıtımda kota Mongo'ya taşınmalı.
 */
const { withFileLock, writeJsonAtomic } = require("./fileLock.cjs");
const writeJson = writeJsonAtomic;

/**
 * ⚠️ KİLİTSİZ İÇ SÜRÜM. `withFileLock` YENİDEN GİRİLEBİLİR DEĞİL — kilidin
 * içinden kilit alan bir çağrı sonsuza kadar bekler. Kilidi alan her genel
 * fonksiyon bunu çağırmalı, `ensureModel`'i değil.
 */
async function _ensureModel(){
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

async function ensureModel(){
  return withFileLock(STORE_PATH, _ensureModel);
}

/** kota eşiği: %90 default */
function quotaHot(q, threshold=0.90){
  if(!q || !Number.isFinite(q.daily)) return false;
  return (q.used||0) >= Math.floor(q.daily*threshold);
}

/** sağlayıcıyı işaretle + kota arttır — oku/değiştir/yaz TEK KİLİTTE. */
async function markUsage(name, ok=true, ms=0){
  return withFileLock(STORE_PATH, async () => {
    const m = await _ensureModel();
    const P = (m.providers[name] ||= { ok:0, fail:0, lastMs:0, lastAt:null });
    const Q = (m.quotas[name]    ||= { daily:100, used:0 });
    if(ok) P.ok++; else P.fail++;
    P.lastMs = Number(ms)||0;
    P.lastAt = new Date().toISOString();
    Q.used   = Math.max(0,(Q.used||0)+1);
    m.updatedAt = new Date().toISOString();
    await writeJson(STORE_PATH, m);
    return { provider:P, quota:Q };
  });
}

/** takım için kalıcı tercih oku/yaz */
async function getPreferred(team){
  const m = await ensureModel();
  return m.teams[String(team||"").toLowerCase()] || null;
}
async function setPreferred(team, name){
  return withFileLock(STORE_PATH, async () => {
    const m = await _ensureModel();
    m.teams[String(team||"").toLowerCase()] = name;
    m.updatedAt = new Date().toISOString();
    await writeJson(STORE_PATH, m);
  });
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