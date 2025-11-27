"use strict";
const fs = require("fs");
const path = require("path");
const express = require("express");
const router = express.Router();
const dataDir = path.join(__dirname,"..","data");
const logPath = path.join(dataDir,"pin-log.json");
if(!fs.existsSync(dataDir)) fs.mkdirSync(dataDir,{recursive:true});

function readLog(){
 try { const j=JSON.parse(fs.readFileSync(logPath,"utf8"));
 return Array.isArray(j)?j:[]; } catch (e) { return []; }
}
function writeLog(a){ fs.writeFileSync(logPath,JSON.stringify(a.slice(-5000),null,2)); }

// === pin-log ===
router.get("/_health/pin-log",(req,res)=>{
 const limit = parseInt(req.query.limit||"200",10);
const arr = readLog().slice(-limit);
 res.json({ ok:true, count: arr.length, items: arr });
});
router.post("/_health/pin-log/clear",(req,res)=>{
 writeLog([]); res.json({ok:true, cleared:true});
});

// === pin-buckets ===
router.get("/_health/pin-buckets",(req,res)=>{
 const step = parseInt(req.query.stepMs||"60000",10);
const buckets = parseInt(req.query.buckets||"6",10);
const ipFilter = req.query.ip||null;
const now = Date.now();
const from = now - step*buckets;
const arr = readLog().filter(x=>x.ts>=from && (!ipFilter||x.ip===ipFilter));
const out=[]; for(let i=0;i<buckets;i++){
 const bFrom=from+i*step, bTo=bFrom+step;
const seg=arr.filter(x=>x.ts>=bFrom && x.ts<bTo);
 out.push({ ts:new Date(bFrom).toISOString(), total:seg.length,
 wrong:seg.filter(x=>!x.ok).length });
 }
 res.json({ ok:true, buckets:out });
});

// === rate-limit snapshot (aggregate) ===
router.get("/_health/rate-limit-snapshot",(req,res)=>{
 const arr = readLog();
const total = arr.length, wrong = arr.filter(x=>!x.ok).length;
 res.json({ ok:true, window: "last "+arr.length+" records", total, wrong });
});

// === log API (demo endpoint to record ===
router.post("/_debug/sim/pin",(req,res)=>{
 const b = req.body||{};
const arr=readLog();
 arr.push({ ts:Date.now(), preset:b.preset||"?", ip:(b.ips||[])[0]||"0.0.0.0",
 ok: b.ok>0, fail: b.fail>0 });
 writeLog(arr); res.json({ok:true, logged:true});
});

module.exports = router;

router.get("/_health/pin-log.csv",(req,res)=>{
 const arr = readLog();
const rows = ["ts,ip,preset,ok"];
 arr.forEach(x=> rows.push(`${new Date(x.ts).toISOString()},${x.ip},${x.preset},${x.ok}`));
 res.setHeader("Content-Type","text/csv; charset=utf-8");
 res.send(rows.join("\\n"));
});



