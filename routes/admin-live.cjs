/**
 * routes/admin-live.cjs
 * Yalın admin uçları: bootstrap, goal, status, red, halfscore, penalty
 * NOT: Bu router, server.cjs içinde "/api/admin" altına mount edilmeli.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const express = require('express');
const router = express.Router();

const DATA_DIR = path.join(__dirname, '..', 'data');
const LIVE_DIR = path.join(DATA_DIR, 'live');

function stFile(id){ return path.join(LIVE_DIR, `${id}.json`); }

async function readJson(file, fb=null){
  try{
    const txt = await fsp.readFile(file, 'utf8');
    return JSON.parse(txt);
  }catch(e){ return fb; }
}
async function writeJson(file, data){
  await fsp.mkdir(path.dirname(file), { recursive:true });
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(data,null,2), 'utf8');
  await fsp.rename(tmp, file);
}

/* ---- POST /api/admin/match/bootstrap ----
   Body: { fixtureId, home, away, kickoffISO? }
*/
router.post('/match/bootstrap', async (req,res)=>{
  try{
    const b = req.body || {};
    const fixtureId  = String(b.fixtureId||'').trim();
    const home       = String(b.home||'').trim();
    const away       = String(b.away||'').trim();
    const kickoffISO = String(b.kickoffISO|| new Date().toISOString());

    if(!fixtureId || !home || !away){
      return res.status(400).json({ ok:false, error:'fixtureId_home_away_required' });
    }

    const file = stFile(fixtureId);
    const st = await readJson(file, null) || {
      fixtureId, pollCount:0, lastPolledAt:null,
      kickoffISO, status:'NS',
      score:{ home:0, away:0 },
      minute:0, firstGoal:null,
      redHome:0, redAway:0,
      htScore:null
    };
    await writeJson(file, st);
    return res.json({ ok:true, fixtureId, created: true, state: st });
  }catch(e){
    return res.status(500).json({ ok:false, error:String(e.message||e) });
  }
});

/* ---- POST /api/admin/match/goal?fixtureId=&team=H|A ---- */
router.post('/match/goal', async (req,res)=>{
  try{
    const fixtureId = String(req.query.fixtureId||'').trim();
    const team      = String(req.query.team||'').toUpperCase();
    if(!fixtureId || !['H','A'].includes(team)){
      return res.status(400).json({ ok:false, error:'fixtureId_or_team_invalid' });
    }
    const file = stFile(fixtureId);
    const st = await readJson(file, null);
    if(!st) return res.status(404).json({ ok:false, error:'STATE_NOT_FOUND' });

    st.score = st.score || { home:0, away:0 };
    if(team==='H') st.score.home = Number(st.score.home||0)+1;
    if(team==='A') st.score.away = Number(st.score.away||0)+1;
    if(!st.firstGoal) st.firstGoal = team;
    st.minute = Math.max( (st.minute||0), 1 );

    await writeJson(file, st);
    return res.json({ ok:true, fixtureId, score: st.score, firstGoal: st.firstGoal });
  }catch(e){
    return res.status(500).json({ ok:false, error:String(e.message||e) });
  }
});

/* ---- POST /api/admin/match/status?fixtureId=&s=NS|HT|2H|FT&minute?=int ---- */
router.post('/match/status', async (req,res)=>{
  try{
    const fixtureId = String(req.query.fixtureId||'').trim();
    const s         = String(req.query.s||'').toUpperCase();
    const minute    = req.query.minute!=null ? Number(req.query.minute) : null;
    const allowed   = ['NS','1H','HT','2H','ET','P','FT'];
    if(!fixtureId || !allowed.includes(s)){
      return res.status(400).json({ ok:false, error:'fixtureId_or_status_invalid' });
    }
    const file = stFile(fixtureId);
    const st = await readJson(file, null);
    if(!st) return res.status(404).json({ ok:false, error:'STATE_NOT_FOUND' });

    st.status = s;
    if(Number.isFinite(minute)) st.minute = minute;
    await writeJson(file, st);
    return res.json({ ok:true, fixtureId, status: st.status, minute: st.minute||0 });
  }catch(e){
    return res.status(500).json({ ok:false, error:String(e.message||e) });
  }
});

/* ---- POST /api/admin/match/red?fixtureId=&team=H|A ---- */
router.post('/match/red', async (req,res)=>{
  try{
    const fixtureId = String(req.query.fixtureId||'').trim();
    const team      = String(req.query.team||'').toUpperCase();
    if(!fixtureId || !['H','A'].includes(team)){
      return res.status(400).json({ ok:false, error:'fixtureId_or_team_invalid' });
    }
    const file = stFile(fixtureId);
    const st = await readJson(file, null);
    if(!st) return res.status(404).json({ ok:false, error:'STATE_NOT_FOUND' });

    st.redHome = Number(st.redHome||0);
    st.redAway = Number(st.redAway||0);
    if(team==='H') st.redHome += 1;
    if(team==='A') st.redAway += 1;

    await writeJson(file, st);
    return res.json({ ok:true, fixtureId, redHome: st.redHome, redAway: st.redAway });
  }catch(e){
    return res.status(500).json({ ok:false, error:String(e.message||e) });
  }
});

/* ---- POST /api/admin/match/halfscore?fixtureId=&home=&away= ---- */
router.post('/match/halfscore', async (req,res)=>{
  try{
    const fixtureId = String(req.query.fixtureId||'').trim();
    const home = Number(req.query.home);
    const away = Number(req.query.away);
    if(!fixtureId || !Number.isFinite(home) || !Number.isFinite(away)){
      return res.status(400).json({ ok:false, error:'fixtureId_home_away_required' });
    }
    const file = stFile(fixtureId);
    const st = await readJson(file, null);
    if(!st) return res.status(404).json({ ok:false, error:'STATE_NOT_FOUND' });

    st.htScore = { home, away };
    await writeJson(file, st);
    return res.json({ ok:true, fixtureId, htScore: st.htScore });
  }catch(e){
    return res.status(500).json({ ok:false, error:String(e.message||e) });
  }
});

/* ---- POST /api/admin/match/penalty?fixtureId=&team=H|A ---- */
router.post('/match/penalty', async (req,res)=>{
  try{
    const fixtureId = String(req.query.fixtureId||'').trim();
    const team      = String(req.query.team||'').toUpperCase();
    if(!fixtureId || !['H','A'].includes(team)){
      return res.status(400).json({ ok:false, error:'fixtureId_or_team_invalid' });
    }
    const file = stFile(fixtureId);
    const st = await readJson(file, null);
    if(!st) return res.status(404).json({ ok:false, error:'STATE_NOT_FOUND' });
    st.pen = st.pen || { home:0, away:0 };
    if(team==='H') st.pen.home = Number(st.pen.home||0)+1;
    if(team==='A') st.pen.away = Number(st.pen.away||0)+1;
    await writeJson(file, st);
    return res.json({ ok:true, fixtureId, pen: st.pen });
  }catch(e){
    return res.status(500).json({ ok:false, error:String(e.message||e) });
  }
});

module.exports = router;
module.exports = router;

router.post('/match/ht', async (req,res)=>{
  try{
    const fid  = String(req.query.fixtureId||'').trim();
    const home = Number(req.query.home);
    const away = Number(req.query.away);
    if(!fid || Number.isNaN(home) || Number.isNaN(away)){
      return res.status(400).json({ ok:false, error:'fixtureId_home_away_required' });
    }
    const f = stFile(fid);
    const raw = await fsp.readFile(f,'utf8').catch(()=>null);
    if(!raw) return res.status(404).json({ ok:false, error:'STATE_NOT_FOUND' });

    const st = JSON.parse(raw);
    st.htScore = { home, away };
    st.htOutcome = home>away ? 'H' : (away>home ? 'A' : 'D');
    await fsp.writeFile(f, JSON.stringify(st,null,2),'utf8');
    return res.json({ ok:true, fixtureId: fid, ht: st.htScore, htOutcome: st.htOutcome });
  }catch(e){
    return res.status(500).json({ ok:false, error: String(e && e.message || e) });
  }
});
router.post('/match/ht', async (req,res)=>{
  try{
    const fid  = String(req.query.fixtureId||'').trim();
    const home = Number(req.query.home);
    const away = Number(req.query.away);
    if(!fid || Number.isNaN(home) || Number.isNaN(away)){
      return res.status(400).json({ ok:false, error:'fixtureId_home_away_required' });
    }
    const f = stFile(fid);
    const raw = await fsp.readFile(f,'utf8').catch(()=>null);
    if(!raw) return res.status(404).json({ ok:false, error:'STATE_NOT_FOUND' });

    const st = JSON.parse(raw);
    st.htScore = { home, away };
    st.htOutcome = home>away ? 'H' : (away>home ? 'A' : 'D');
    await fsp.writeFile(f, JSON.stringify(st,null,2),'utf8');
    return res.json({ ok:true, fixtureId: fid, ht: st.htScore, htOutcome: st.htOutcome });
  }catch(e){
    return res.status(500).json({ ok:false, error: String(e && e.message || e) });
  }
});

router.post('/match/final', async (req,res)=>{
  try{
    const fid  = String(req.query.fixtureId||'').trim();
    const home = Number(req.query.home);
    const away = Number(req.query.away);
    const fg   = (req.query.firstGoal? String(req.query.firstGoal).toUpperCase(): null);
    if(!fid || Number.isNaN(home) || Number.isNaN(away)){
      return res.status(400).json({ ok:false, error:'fixtureId_home_away_required' });
    }
    const f = stFile(fid);
    const raw = await fsp.readFile(f,'utf8').catch(()=>null);
    if(!raw) return res.status(404).json({ ok:false, error:'STATE_NOT_FOUND' });

    const st = JSON.parse(raw);
    st.score = { home, away };
    if(fg==='H' || fg==='A' || fg===null) st.firstGoal = fg;
    st.status = 'FT';
    await fsp.writeFile(f, JSON.stringify(st,null,2),'utf8');
    return res.json({ ok:true, fixtureId: fid, final: st.score, firstGoal: st.firstGoal??null, status: st.status });
  }catch(e){
    return res.status(500).json({ ok:false, error: String(e && e.message || e) });
  }
});
