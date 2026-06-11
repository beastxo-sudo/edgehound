/* =====================================================
   EDGEHOUND ANALYST — autonomous AI supervisor
   Runs on a schedule via GitHub Actions. Reads the bot's
   full journal, brain state and performance, sends it to
   Claude (Anthropic API) acting as a professional quant
   trading supervisor, and applies its decisions to
   config.json — strictly within hard safety rails.

   Powers (bounded):
   - enable/disable individual signal engines (>=1 must stay on)
   - tune entry threshold pMin within [0.52, 0.66]
   - tune Kelly multiplier within [0.10, 0.50]
   - tune max portfolio exposure within [0.30, 0.60]
   - tune max per-event exposure within [500, 1500]
   It can NEVER: touch the bankroll, raise stake limits,
   change daily trade caps, or modify code.

   Every session writes data/analyst.json: full memo,
   observations, changes made and the reasoning.
===================================================== */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const STATE_FILE  = path.join(__dirname, 'data', 'state.json');
const CONFIG_FILE = path.join(__dirname, 'config.json');
const MEMO_FILE   = path.join(__dirname, 'data', 'analyst.json');

const RAILS = {
  pMin: [0.52, 0.66],
  kellyMult: [0.10, 0.50],
  maxExposure: [0.30, 0.60],
  maxEventExposure: [500, 1500]
};
const ENGINES = ['SHORT_FAVORITE','MOMENTUM','SMART_CONSENSUS','VOLUME_SPIKE'];

const clamp=(x,a,b)=>Math.max(a,Math.min(b,Number(x)));
const log=m=>console.log(new Date(Date.now()+5.5*3600e3).toISOString().slice(0,16).replace('T',' ')+' IST  '+m);

function loadJSON(f,fallback){ try{ return JSON.parse(fs.readFileSync(f,'utf8')); }catch(e){ return fallback; } }

function buildBriefing(state,config){
  const j=state.journal||[];
  const closed=j.filter(t=>t.status==='closed');
  const open=j.filter(t=>t.status==='open');
  const recent=closed.slice(0,40).map(t=>({
    title:t.title.slice(0,70), side:t.side, signal:t.signal, stake:t.stake,
    entry:t.entry, exit:t.exit, pnl:Math.round(t.pnl), pPredicted:t.p, exitReason:t.exitReason,
    heldHours:t.exitTs&&t.openedTs?Math.round((t.exitTs-t.openedTs)/36e5):null
  }));
  const openBrief=open.map(t=>({title:t.title.slice(0,70),side:t.side,signal:t.signal,stake:t.stake,entry:t.entry,cur:t.cur,p:t.p}));
  const perSignal={};
  ENGINES.forEach(k=>{ const s=(state.strat||{})[k]||{trades:0,wins:0,pnl:0};
    perSignal[k]={trades:s.trades,wins:s.wins,pnl:Math.round(s.pnl)}; });
  return {
    nowIST:new Date(Date.now()+5.5*3600e3).toISOString().slice(0,16).replace('T',' '),
    bank:state.bank, summary:state.summary,
    perSignal,
    hypotheses:(state.brain&&state.brain.hypotheses)||[],
    modelUpdates:state.brain?state.brain.nUpdates:0,
    brier:state.brain&&state.brain.brier&&state.brain.brier.n?+(state.brain.brier.sum/state.brain.brier.n).toFixed(3):null,
    walletScores:state.brain?Object.fromEntries(Object.entries(state.brain.wallets||{}).map(([k,v])=>[k,+( v.a/(v.a+v.b)).toFixed(2)])):{},
    recentClosedTrades:recent,
    openPositions:openBrief,
    currentConfig:config,
    rails:RAILS
  };
}

const SYSTEM_PROMPT = `You are the supervising portfolio manager of EdgeHound, an autonomous paper-trading bot on Polymarket prediction markets. You review its complete recent behavior and performance like a professional quant fund supervisor reviewing a junior strategy.

Your job each session:
1. OBSERVE: what is working, what is bleeding money, anomalies, concentration risks, calibration problems (predicted P(win) vs realized), patterns the statistical brain may be missing (e.g. all losses share a context the features don't capture).
2. DECIDE: adjust the bot's tunable parameters ONLY where evidence justifies it. Small sample sizes (<15 settled trades per engine) warrant patience, not reaction. Prefer no change over noise-chasing.
3. EXPLAIN: write a concise professional memo a client could read.

You control ONLY these parameters, within these hard rails (out-of-range values will be clamped):
- engines: enable/disable each of SHORT_FAVORITE, MOMENTUM, SMART_CONSENSUS, VOLUME_SPIKE (at least one must remain enabled)
- pMin (entry probability threshold): 0.52-0.66
- kellyMult (fraction of full Kelly for sizing): 0.10-0.50
- maxExposure (max fraction of equity deployed): 0.30-0.60
- maxEventExposure (max $ on one underlying event): 500-1500

Respond ONLY with valid JSON, no markdown fences, in exactly this shape:
{
 "memo": "professional analysis memo, 150-300 words",
 "observations": ["short bullet", "short bullet", ...],
 "changes": { "engines": {"SHORT_FAVORITE": true, "MOMENTUM": true, "SMART_CONSENSUS": true, "VOLUME_SPIKE": true}, "pMin": 0.56, "kellyMult": 0.25, "maxExposure": 0.6, "maxEventExposure": 1000 },
 "changeReasoning": "why these changes (or why none)",
 "riskFlags": ["any concerns worth a human's attention"]
}`;

async function askClaude(briefing){
  const r=await fetch('https://api.anthropic.com/v1/messages',{
    method:'POST',
    headers:{
      'content-type':'application/json',
      'x-api-key':process.env.ANTHROPIC_API_KEY,
      'anthropic-version':'2023-06-01'
    },
    body:JSON.stringify({
      model:'claude-sonnet-4-6',
      max_tokens:1500,
      system:SYSTEM_PROMPT,
      messages:[{role:'user',content:'Here is the complete current state of EdgeHound. Review and respond with your JSON decision.\n\n'+JSON.stringify(briefing)}]
    }),
    signal:AbortSignal.timeout(60000)
  });
  if(!r.ok) throw new Error('Anthropic API '+r.status+': '+(await r.text()).slice(0,200));
  const d=await r.json();
  const text=(d.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');
  const clean=text.replace(/```json|```/g,'').trim();
  return JSON.parse(clean);
}

function applyChanges(config,decision){
  const ch=decision.changes||{};
  const before=JSON.stringify(config);
  const applied=[];
  if(ch.engines&&typeof ch.engines==='object'){
    const next={...config.engines};
    ENGINES.forEach(k=>{ if(typeof ch.engines[k]==='boolean') next[k]=ch.engines[k]; });
    if(Object.values(next).some(v=>v)){ /* at least one engine must stay on */
      ENGINES.forEach(k=>{ if(next[k]!==config.engines[k]) applied.push(`${k}: ${config.engines[k]?'ON':'OFF'} -> ${next[k]?'ON':'OFF'}`); });
      config.engines=next;
    } else applied.push('REJECTED engine change: all engines off is not allowed');
  }
  for(const key of ['pMin','kellyMult','maxExposure','maxEventExposure']){
    if(ch[key]!==undefined&&!isNaN(Number(ch[key]))){
      const v=clamp(ch[key],RAILS[key][0],RAILS[key][1]);
      if(Math.abs(v-config[key])>1e-9){ applied.push(`${key}: ${config[key]} -> ${v}`); config[key]=v; }
    }
  }
  config.updatedBy='analyst';
  config.updatedAt=new Date().toISOString();
  return { applied, changed: JSON.stringify(config)!==before };
}

(async()=>{
  if(!process.env.ANTHROPIC_API_KEY){
    log('No ANTHROPIC_API_KEY secret set — Analyst is dormant. Add the secret to activate.');
    fs.mkdirSync(path.dirname(MEMO_FILE),{recursive:true});
    fs.writeFileSync(MEMO_FILE,JSON.stringify({status:'dormant',
      memo:'Analyst installed but waiting for an Anthropic API key (repo secret ANTHROPIC_API_KEY). No analysis performed.',
      updated:new Date().toISOString()},null,1));
    process.exit(0);
  }
  const state=loadJSON(STATE_FILE,null);
  if(!state){ log('No state.json found — nothing to analyze.'); process.exit(0); }
  const config=loadJSON(CONFIG_FILE,{engines:{SHORT_FAVORITE:true,MOMENTUM:true,SMART_CONSENSUS:true,VOLUME_SPIKE:true},pMin:0.56,kellyMult:0.25,maxExposure:0.6,maxEventExposure:1000});
  const briefing=buildBriefing(state,config);
  log(`Analyst session starting. ${briefing.recentClosedTrades.length} recent closed trades, ${briefing.openPositions.length} open.`);
  let decision;
  try{ decision=await askClaude(briefing); }
  catch(e){
    log('Claude call failed: '+e.message);
    fs.writeFileSync(MEMO_FILE,JSON.stringify({status:'error',error:e.message,updated:new Date().toISOString()},null,1));
    process.exit(0);
  }
  const {applied,changed}=applyChanges(config,decision);
  if(changed) fs.writeFileSync(CONFIG_FILE,JSON.stringify(config,null,2));
  fs.mkdirSync(path.dirname(MEMO_FILE),{recursive:true});
  fs.writeFileSync(MEMO_FILE,JSON.stringify({
    status:'ok',
    updated:new Date().toISOString(),
    updatedIST:new Date(Date.now()+5.5*3600e3).toISOString().slice(0,16).replace('T',' ')+' IST',
    memo:decision.memo||'',
    observations:decision.observations||[],
    changesApplied:applied,
    changeReasoning:decision.changeReasoning||'',
    riskFlags:decision.riskFlags||[],
    configNow:config
  },null,1));
  log('Analyst session done. Changes: '+(applied.length?applied.join(' | '):'none'));
})();
