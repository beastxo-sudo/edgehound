/* =====================================================
   EDGEHOUND v2 — ML-driven Polymarket paper-trading bot
   Runs on GitHub Actions every 15 minutes. No real money.

   The brain (all learned online, from the bot's own results):
   - Online logistic regression -> P(win) for every candidate,
     updated by gradient descent after every settled trade
   - Bayesian pattern memory: Beta posteriors per pattern bucket
     (signal x price band x market type) + Thompson sampling
   - Hypothesis ledger: plain-language learnings, auto-validated
     or rejected by posterior evidence; rejected patterns are
     blocked from future trading
   - Wallet intelligence: per-wallet track record; consensus
     weighted by who has actually been right
   - Kelly-criterion sizing on a $10,000 virtual bankroll,
     max 60% deployed, stakes $100-$1000
   - Every trade carries: model probability, pattern posterior,
     EV per $1, sizing math, and a written justification
===================================================== */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const GAMMA = 'https://gamma-api.polymarket.com';
const DATA  = 'https://data-api.polymarket.com';
const STATE_FILE = path.join(__dirname, 'data', 'state.json');
const CONFIG_FILE = path.join(__dirname, 'config.json');
/* Tunable parameters — adjustable by the AI Analyst within hard rails */
let CFG={engines:{SHORT_FAVORITE:true,MOMENTUM:true,SMART_CONSENSUS:true,VOLUME_SPIKE:true,ELITE_FOLLOW:true},pMin:0.56,kellyMult:0.25,maxExposure:0.6,maxEventExposure:1000};
try{ CFG={...CFG,...JSON.parse(fs.readFileSync(CONFIG_FILE,'utf8'))}; }catch(e){}
CFG.kellyMult=Math.max(0.10,Math.min(0.50,Number(CFG.kellyMult)||0.25));
CFG.pMin=Math.max(0.52,Math.min(0.66,Number(CFG.pMin)||0.56));
CFG.maxExposure=Math.max(0.30,Math.min(0.60,Number(CFG.maxExposure)||0.6));
CFG.maxEventExposure=Math.max(500,Math.min(1500,Number(CFG.maxEventExposure)||1000));
if(!Object.values(CFG.engines||{}).some(v=>v)) CFG.engines={SHORT_FAVORITE:true,MOMENTUM:true,SMART_CONSENSUS:true,VOLUME_SPIKE:true,ELITE_FOLLOW:true};
if(CFG.engines.ELITE_FOLLOW===undefined) CFG.engines.ELITE_FOLLOW=true;

const BANKROLL_START = 10000;
const MAX_EXPOSURE = CFG.maxExposure; /* from config.json (Analyst-tunable) */
const STAKE_MIN = 100, STAKE_MAX = 1000;
const DAILY_MIN = 10, DAILY_MAX = 20;

const STRATS = {
  SHORT_FAVORITE: { label:'Short Favorite', hold:8,  target:null, stop:.45 },
  MOMENTUM:       { label:'Momentum',       hold:3,  target:.18,  stop:.20 },
  SMART_CONSENSUS:{ label:'Smart Consensus',hold:14, target:.30,  stop:.30 },
  VOLUME_SPIKE:   { label:'Volume Spike',   hold:5,  target:.22,  stop:.25 },
  ELITE_FOLLOW:   { label:'Elite Follow',   hold:10, target:.25,  stop:.25 }
};
const SIGNAL_KEYS = Object.keys(STRATS);

/* ============ utils ============ */
async function jget(url){
  const r = await fetch(url, { headers:{accept:'application/json'}, signal: AbortSignal.timeout(15000) });
  if(!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}
const cents = p => Math.round(p*100)+'c';
const fmtUSD = n => Math.abs(n)>=1e6?'$'+(n/1e6).toFixed(2)+'M':Math.abs(n)>=1e3?'$'+(n/1e3).toFixed(1)+'K':'$'+Number(n).toFixed(0);
/* ---- IST (Asia/Kolkata, UTC+5:30) timestamps & trading day ---- */
const IST_OFFSET_MS = 5.5*3600*1000;
function istNow(){ const d=new Date(Date.now()+IST_OFFSET_MS);
  return d.toISOString().slice(0,16).replace('T',' ')+' IST'; }
function istDate(){ return new Date(Date.now()+IST_OFFSET_MS).toISOString().slice(0,10); }
function istDayFrac(){ const d=new Date(Date.now()+IST_OFFSET_MS);
  return (d.getUTCHours()*3600+d.getUTCMinutes()*60+d.getUTCSeconds())/86400; }
const todayKey = istDate;
const log = m => console.log(istNow()+'  '+m);
const sigmoid = z => 1/(1+Math.exp(-z));
const clamp = (x,a,b)=>Math.max(a,Math.min(b,x));

/* Beta posterior helpers */
const betaMean = (a,b)=>a/(a+b);
function betaCI(a,b){ /* ~90% interval via normal approx of Beta */
  const m=betaMean(a,b), v=(a*b)/(((a+b)**2)*(a+b+1)), sd=Math.sqrt(v);
  return [clamp(m-1.645*sd,0,1), clamp(m+1.645*sd,0,1)];
}
function gauss(){ let u=0,v=0; while(u===0)u=Math.random(); while(v===0)v=Math.random();
  return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v); }
function gammaDraw(k){
  if(k<1){ const u=Math.random(); return gammaDraw(1+k)*Math.pow(u,1/k); }
  const d=k-1/3, c=1/Math.sqrt(9*d);
  for(;;){ let x,v;
    do{ x=gauss(); v=1+c*x; }while(v<=0);
    v=v*v*v;
    const u=Math.random();
    if(u<1-0.0331*x*x*x*x) return d*v;
    if(Math.log(u)<0.5*x*x+d*(1-v+Math.log(v))) return d*v;
  }
}
function betaSample(a,b){ const ga=gammaDraw(a), gb=gammaDraw(b); return ga/(ga+gb); }

/* ============ features ============ */
const FEATURE_NAMES = [
  'sig_fav','sig_mom','sig_smart','sig_spike',
  'price','days_short','abs_move','volume24','liquidity','spike_ratio','consensus_n','is_game','entry_vs_smart'
];
function features(c){
  const m=c.m||{};
  const daysLeft = m.end ? clamp((new Date(m.end)-Date.now())/864e5,0,14) : 14;
  return [
    c.signal==='SHORT_FAVORITE'?1:0,
    c.signal==='MOMENTUM'?1:0,
    c.signal==='SMART_CONSENSUS'?1:0,
    c.signal==='VOLUME_SPIKE'?1:0,
    c.price,                                       /* entry price 0-1 */
    1-daysLeft/14,                                 /* shorter = higher */
    clamp(Math.abs(m.chg||0)*5,0,1),               /* 24h move size */
    clamp(Math.log10((m.vol24||0)+1)/7,0,1),       /* 24h volume (log) */
    clamp(Math.log10((m.liq||0)+1)/7,0,1),         /* liquidity (log) */
    clamp(m.volume>0?(m.vol24/m.volume):0,0,1),    /* attention spike */
    clamp((c.consensusN||0)/5,0,1),                /* top wallets aligned */
    /\bvs\.?\b|\bmatch\b|\bgame\b|\bwin (tonight|today)\b/i.test(m.q||'')?1:0,
    clamp(c.entryVsSmart??0,-1,1)                  /* price vs smart-money entry */
  ];
}
function priceBand(p){ return p<.35?'low':p<.65?'mid':'high'; }
function bucketKeyFor(signal,price,isGame){ return signal+'|'+priceBand(price)+'|'+(isGame?'sport':'other'); }

/* ---- same-event correlation guard ----
   Different markets often share one underlying outcome (e.g. "Will the
   Knicks win the Finals?" and "Will the Spurs win the Finals?"). Stacking
   them doubles risk without doubling insight. Two detectors:
   1) shared Polymarket event slug
   2) high word overlap between market titles */
const STOPWORDS=new Set(['will','the','a','an','to','of','in','on','by','be','is','at','for','vs','win','2025','2026','before','after']);
function titleTokens(q){ return new Set(String(q||'').toLowerCase().replace(/[^a-z0-9 ]/g,' ').split(/\s+/).filter(w=>w.length>2&&!STOPWORDS.has(w))); }
function titleSim(a,b){
  const A=titleTokens(a),B=titleTokens(b);
  if(!A.size||!B.size) return 0;
  let inter=0; A.forEach(w=>{if(B.has(w))inter++;});
  return inter/Math.min(A.size,B.size);
}
function sameEvent(t1,t2){
  if(t1.slug&&t2.slug&&t1.slug===t2.slug) return true;
  return titleSim(t1.title??t1.q, t2.title??t2.q)>=0.7;
}
const MAX_EVENT_EXPOSURE = CFG.maxEventExposure; /* from config.json (Analyst-tunable) */

/* ============ state & brain ============ */
function freshBrain(){
  return {
    w: new Array(FEATURE_NAMES.length).fill(0), b: 0, nUpdates: 0,
    buckets: {},      /* bucketKey -> {a,b} Beta posterior of win prob */
    wallets: {},      /* walletName -> {a,b} */
    brier: { sum:0, n:0 },
    payoff: {},       /* signal -> avg win/loss fractions of stake */
    hypotheses: []
  };
}
function loadState(){
  let s=null; try{ s=JSON.parse(fs.readFileSync(STATE_FILE,'utf8')); }catch(e){}
  s = s || { running:true, journal:[], strat:{}, created:Date.now(), log:[] };
  for(const k of SIGNAL_KEYS) s.strat[k]=s.strat[k]||{trades:0,wins:0,pnl:0,weight:1};
  if(!s.brain) s.brain=freshBrain();
  if(!Array.isArray(s.brain.w)||s.brain.w.length!==FEATURE_NAMES.length){ s.brain.w=new Array(FEATURE_NAMES.length).fill(0); s.brain.b=0; }
  s.brain.buckets=s.brain.buckets||{}; s.brain.wallets=s.brain.wallets||{};
  s.brain.brier=s.brain.brier||{sum:0,n:0}; s.brain.hypotheses=s.brain.hypotheses||[];
  s.brain.payoff=s.brain.payoff||{};
  for(const k of SIGNAL_KEYS) s.brain.payoff[k]=s.brain.payoff[k]||{wSum:0,wN:0,lSum:0,lN:0};
  if(!s.bank){
    s.bank={ start:BANKROLL_START, cash:BANKROLL_START, created:Date.now() };
    s.journal.filter(t=>t.status==='open').forEach(t=>{ s.bank.cash-=t.stake; }); /* migrate v1 open trades */
  }
  return s;
}
function saveState(s){
  fs.mkdirSync(path.dirname(STATE_FILE),{recursive:true});
  s.lastRun=Date.now();
  fs.writeFileSync(STATE_FILE, JSON.stringify(s,null,1));
}
function note(s,msg){ s.log.unshift(istNow()+' — '+msg); s.log=s.log.slice(0,14); log(msg); }

/* ============ the brain: predict / learn ============ */
function predict(brain,c){
  const x=features(c);
  let z=brain.b; for(let i=0;i<x.length;i++) z+=brain.w[i]*x[i];
  const pModel=sigmoid(z);
  const bk=bucketKeyFor(c.signal,c.price,x[11]===1);
  const B=brain.buckets[bk]||{a:1,b:1};
  const n=B.a+B.b-2;
  const pBucket=betaMean(B.a,B.b);
  /* blend prior -> pattern posterior -> model, by how much evidence each has */
  const wBucket=n/(n+10);
  const wModel=clamp(brain.nUpdates/(brain.nUpdates+30),0,0.6)*(1-wBucket);
  const pPrior=c.prior??0.54;
  const wPrior=1-wBucket-wModel;
  const p=clamp(wPrior*pPrior + wBucket*pBucket + wModel*pModel, .05,.95);
  const thompson=n>=2?betaSample(B.a,B.b):p;
  return { p, pModel, pBucket, bucketN:n, bk, x, thompson };
}
function learn(state,t){
  const brain=state.brain;
  const y=t.pnl>0?1:0;
  if(Array.isArray(t.x)&&t.x.length===FEATURE_NAMES.length){
    let z=brain.b; for(let i=0;i<t.x.length;i++) z+=brain.w[i]*t.x[i];
    const p=sigmoid(z), lr=0.18/Math.sqrt(1+brain.nUpdates/40), err=y-p;
    for(let i=0;i<t.x.length;i++) brain.w[i]+=lr*err*t.x[i] - 0.0005*brain.w[i];
    brain.b+=lr*err;
    brain.nUpdates++;
  }
  if(t.bk){ const B=brain.buckets[t.bk]=brain.buckets[t.bk]||{a:1,b:1}; if(y)B.a++; else B.b++; }
  if(typeof t.p==='number'){ brain.brier.sum+=(t.p-y)**2; brain.brier.n++; }
  const po=brain.payoff[t.signal]; const frac=t.pnl/t.stake;
  if(y){ po.wSum+=frac; po.wN++; } else { po.lSum+=Math.abs(frac); po.lN++; }
  if((t.signal==='SMART_CONSENSUS'||t.signal==='ELITE_FOLLOW')&&Array.isArray(t.walletNames)){
    t.walletNames.forEach(wn=>{ const W=brain.wallets[wn]=brain.wallets[wn]||{a:1,b:1}; if(y)W.a++; else W.b++; });
  }
}

/* ============ hypothesis ledger ============ */
function updateHypotheses(state){
  const brain=state.brain, out=[];
  for(const[bk,B]of Object.entries(brain.buckets)){
    const n=B.a+B.b-2; if(n<6) continue;
    const m=betaMean(B.a,B.b),[lo,hi]=betaCI(B.a,B.b);
    const [sig,band,kind]=bk.split('|');
    let status='FORMING';
    if(lo>0.55) status='VALIDATED';
    else if(hi<0.45) status='REJECTED';
    out.push({ key:bk, status, n, winRate:+(m*100).toFixed(1), ci:[+(lo*100).toFixed(0),+(hi*100).toFixed(0)],
      text:`${STRATS[sig]?STRATS[sig].label:sig} on ${band}-priced ${kind==='sport'?'sports':'non-sports'} markets: ${B.a-1}W/${B.b-1}L (posterior ${(m*100).toFixed(0)}%, 90% CI ${(lo*100).toFixed(0)}-${(hi*100).toFixed(0)}%) — ${status==='VALIDATED'?'proven edge, prioritized':status==='REJECTED'?'no edge, blocked from trading':'collecting evidence'}`,
      updated:new Date().toISOString() });
  }
  for(const[wn,W]of Object.entries(brain.wallets)){
    const n=W.a+W.b-2; if(n<5) continue;
    const m=betaMean(W.a,W.b),[lo,hi]=betaCI(W.a,W.b);
    const status= lo>0.55?'VALIDATED': hi<0.45?'REJECTED':'FORMING';
    out.push({ key:'wallet|'+wn, status, n, winRate:+(m*100).toFixed(1), ci:[+(lo*100).toFixed(0),+(hi*100).toFixed(0)],
      text:`Copying wallet "${wn}": ${W.a-1}W/${W.b-1}L when followed (posterior ${(m*100).toFixed(0)}%) — ${status==='VALIDATED'?'reliable, weighted up':status==='REJECTED'?'unreliable, ignored':'still evaluating'}`,
      updated:new Date().toISOString() });
  }
  const prev=new Map((brain.hypotheses||[]).map(h=>[h.key,h.status]));
  out.forEach(h=>{ if(prev.has(h.key)&&prev.get(h.key)!==h.status) note(state,`Learning update: ${h.text}`); });
  brain.hypotheses=out.sort((a,b)=>b.n-a.n);
}
function isRejected(brain,bk){ const h=(brain.hypotheses||[]).find(x=>x.key===bk); return !!(h&&h.status==='REJECTED'); }
function walletQuality(brain,names){
  if(!names||!names.length) return 0.5;
  const ms=names.map(n=>{ const W=brain.wallets[n]; return W?betaMean(W.a,W.b):0.5; });
  return ms.reduce((s,v)=>s+v,0)/ms.length;
}

/* ============ market data ============ */
function normalizeMarket(m){
  try{
    const prices=JSON.parse(m.outcomePrices||'[]').map(Number);
    const outcomes=JSON.parse(m.outcomes||'[]');
    let yi=outcomes.findIndex(o=>/^yes$/i.test(o)); if(yi<0)yi=0;
    const yes=prices[yi]??0.5;
    return { id:m.id,q:m.question||'',conditionId:m.conditionId||'',
      eventSlug:(m.events&&m.events[0]&&m.events[0].slug)||m.slug||'',
      yes,no:1-yes,
      vol24:Number(m.volume24hr)||0,volume:Number(m.volumeNum||m.volume)||0,
      liq:Number(m.liquidityNum||m.liquidity)||0,
      chg:Number(m.oneDayPriceChange)||0,
      end:m.endDate?new Date(m.endDate):null };
  }catch(e){return null;}
}
async function fetchMarkets(){
  const m=await jget(`${GAMMA}/markets?closed=false&active=true&order=volume24hr&ascending=false&limit=200`);
  return (Array.isArray(m)?m:[]).map(normalizeMarket).filter(x=>x&&x.yes>0.005&&x.yes<0.995);
}
async function fetchConsensus(){
  try{
    const lb=await jget(`${DATA}/v1/leaderboard?category=OVERALL&timePeriod=MONTH&orderBy=PNL&limit=10`);
    const top=(Array.isArray(lb)?lb:[]).slice(0,8);
    const agg={};
    const results=await Promise.allSettled(top.map(l=>jget(`${DATA}/positions?user=${l.proxyWallet}&sortBy=CURRENT&sortDirection=DESC&limit=50`)));
    results.forEach((r,i)=>{
      if(r.status!=='fulfilled'||!Array.isArray(r.value))return;
      r.value.filter(p=>!p.redeemable&&Number(p.currentValue)>50).forEach(p=>{
        const key=p.title+'|'+p.outcome;
        agg[key]=agg[key]||{title:p.title,outcome:p.outcome,slug:p.eventSlug||'',conditionId:p.conditionId||'',wallets:new Set(),value:0,entrySum:0,entryN:0,cur:Number(p.curPrice)||0};
        agg[key].wallets.add(top[i].userName||top[i].proxyWallet);
        agg[key].value+=Number(p.currentValue)||0;
        agg[key].entrySum+=Number(p.avgPrice)||0; agg[key].entryN++;
        agg[key].cur=Number(p.curPrice)||agg[key].cur;
      });
    });
    return Object.values(agg).map(s=>({...s,n:s.wallets.size,avgEntry:s.entryN?s.entrySum/s.entryN:0,wallets:[...s.wallets]})).filter(s=>s.n>=2);
  }catch(e){ log('consensus fetch failed: '+e.message); return []; }
}

/* ============ elite wallet pool & fresh-follow signals ============
   Research-informed filters:
   - win rate >= 62% over >= 15 SETTLED positions (luck filter)
   - exclude settlement-scalpers (mostly >=93c entries: great win rate, no edge to copy)
   - exclude hyperactive bot-like books (cannot replicate their speed)
   - copy only FRESH buys (<60 min), $200+, price not run >5%, liquid markets only */
async function buildElitePool(state){
  if(state.elite && Date.now()-state.elite.updated < 24*3600e3 && (state.elite.list||[]).length) return state.elite.list;
  let pool=[];
  try{
    const lb=await jget(`${DATA}/v1/leaderboard?category=OVERALL&timePeriod=MONTH&orderBy=PNL&limit=30`);
    const top=(Array.isArray(lb)?lb:[]).slice(0,25);
    const results=await Promise.allSettled(top.map(l=>jget(`${DATA}/positions?user=${l.proxyWallet}&sortBy=CURRENT&sortDirection=DESC&limit=100`)));
    results.forEach((r,i)=>{
      if(r.status!=='fulfilled'||!Array.isArray(r.value))return;
      const pos=r.value;
      const decided=pos.filter(p=>p.redeemable||Math.abs(Number(p.realizedPnl)||0)>1);
      if(decided.length<15) return;
      const wins=decided.filter(p=>(p.redeemable?(Number(p.currentValue)||0)-(Number(p.initialValue)||0):(Number(p.realizedPnl)||0))>0).length;
      const winRate=wins/decided.length;
      const scalps=pos.filter(p=>(Number(p.avgPrice)||0)>=0.93).length;
      const scalpShare=pos.length?scalps/pos.length:1;
      if(winRate>=0.62 && scalpShare<0.5){
        pool.push({wallet:top[i].proxyWallet,name:top[i].userName||top[i].proxyWallet.slice(0,8),
          winRate:+winRate.toFixed(3),n:decided.length,score:+(winRate*Math.log(1+decided.length)).toFixed(3)});
      }
    });
    pool.sort((a,b)=>b.score-a.score); pool=pool.slice(0,10);
    state.elite={updated:Date.now(),list:pool};
    note(state,`Elite pool refreshed: ${pool.length} wallets qualify (>=62% win rate over >=15 settled, scalpers excluded): ${pool.map(w=>w.name+' '+Math.round(w.winRate*100)+'%').join(', ')||'none today'}`);
  }catch(e){ log('elite pool build failed: '+e.message); pool=(state.elite&&state.elite.list)||[]; }
  return pool;
}
async function fetchEliteSignals(elite,markets){
  const byCondition={}; markets.forEach(m=>{ if(m.conditionId) byCondition[m.conditionId]=m; });
  const out=[];
  const results=await Promise.allSettled(elite.map(w=>jget(`${DATA}/activity?user=${w.wallet}&limit=15&sortDirection=DESC`)));
  results.forEach((r,i)=>{
    if(r.status!=='fulfilled'||!Array.isArray(r.value))return;
    const w=elite[i];
    r.value.filter(a=>a.type==='TRADE'&&a.side==='BUY').forEach(a=>{
      const ageMin=(Date.now()-(Number(a.timestamp)||0)*1000)/60000;
      const fill=Number(a.price)||0, usd=Number(a.usdcSize)||0;
      if(!/^(yes|no)$/i.test(String(a.outcome||'').trim())) return;
      if(ageMin>60||ageMin<0||usd<200||fill<0.10||fill>0.88) return;
      const m=byCondition[a.conditionId]; if(!m) return;            /* must be a liquid top-volume market */
      if(m.liq<25000||m.vol24<10000) return;                        /* don't become exit liquidity */
      const cur=/yes/i.test(a.outcome)?m.yes:m.no;
      if(cur>fill*1.05||cur<=0.02||cur>=0.95) return;               /* price already ran, or pinned */
      out.push({m,side:/yes/i.test(a.outcome)?'YES':'NO',price:cur,signal:'ELITE_FOLLOW',
        walletNames:[w.name],
        prior:Math.min(.64,.55+(w.winRate-.62)*.5+(ageMin<20?.02:0)),
        why:`Elite wallet "${w.name}" (${Math.round(w.winRate*100)}% win rate over ${w.n} settled positions) bought ${a.outcome} ${Math.round(ageMin)}min ago at ${cents(fill)} — still copyable at ${cents(cur)}`});
    });
  });
  /* dedupe: same market+side keeps the strongest wallet */
  const seen={};
  return out.filter(c=>{ const k=c.m.q+'|'+c.side; if(seen[k])return false; seen[k]=1; return true; });
}

/* ============ exits & settlement ============ */
async function catchUp(state,markets){
  const open=state.journal.filter(t=>t.status==='open');
  if(!open.length)return;
  const byCondition={}; markets.forEach(m=>{if(m.conditionId)byCondition[m.conditionId]=m;});
  const px={};
  open.forEach(t=>{
    const m=byCondition[t.conditionId]||markets.find(x=>x.q===t.title);
    if(m)px[t.id]={cur:t.side==='YES'?m.yes:m.no,resolved:false};
  });
  const missing=[...new Set(open.filter(t=>!px[t.id]&&t.conditionId).map(t=>t.conditionId))].slice(0,30);
  if(missing.length){
    try{
      const ms=await jget(`${GAMMA}/markets?`+missing.map(c=>'condition_ids='+encodeURIComponent(c)).join('&'));
      (Array.isArray(ms)?ms:[]).forEach(mk=>{
        try{
          const prices=JSON.parse(mk.outcomePrices||'[]').map(Number);
          const outs=JSON.parse(mk.outcomes||'[]');
          let yi=outs.findIndex(o=>/^yes$/i.test(o)); if(yi<0)yi=0;
          open.filter(t=>t.conditionId===mk.conditionId).forEach(t=>{
            px[t.id]={cur:t.side==='YES'?prices[yi]:1-prices[yi],resolved:!!mk.closed};
          });
        }catch(e){}
      });
    }catch(e){log('settlement lookup failed: '+e.message);}
  }
  const now=Date.now();
  open.forEach(t=>{
    const p=px[t.id]; if(!p)return;
    t.cur=p.cur;
    if(p.resolved||p.cur>=0.995||p.cur<=0.005){ closeTrade(state,t,p.cur>=0.5?1:0,p.cur>=0.5?'Resolved in our favor':'Resolved against us'); return; }
    const move=(p.cur-t.entry)/t.entry;
    if(t.target&&move>=t.target){ closeTrade(state,t,p.cur,`Profit target hit (+${(t.target*100).toFixed(0)}%)`); return; }
    if(move<=-t.stop){ closeTrade(state,t,p.cur,`Stop loss hit (-${(t.stop*100).toFixed(0)}%)`); return; }
    if(t.holdUntil&&now>t.holdUntil){ closeTrade(state,t,p.cur,'Max hold reached — closed at market'); }
  });
}
function closeTrade(state,t,exit,reason){
  t.status='closed'; t.exit=exit; t.exitTs=Date.now();
  if(t.entry<0.02||t.entry>0.98){ /* impossible entry = corrupted data; void at zero P&L, learn nothing */
    t.pnl=0; t.exitReason='VOIDED — bad entry data ('+cents(t.entry)+')';
    state.bank.cash+=t.stake;
    note(state,`Voided "${t.title.slice(0,40)}" — entry ${cents(t.entry)} is a data error, no P&L booked.`);
    return;
  }
  t.exitReason=reason;
  t.pnl=(t.stake/t.entry)*(exit-t.entry);
  state.bank.cash+=t.stake+t.pnl;
  const s=state.strat[t.signal];
  s.trades++; if(t.pnl>0)s.wins++; s.pnl+=t.pnl;
  learn(state,t);
  note(state,`Closed ${t.side} "${t.title.slice(0,42)}" -> ${t.pnl>=0?'+':''}$${t.pnl.toFixed(0)} (${reason})${typeof t.p==='number'?` · model said P(win)=${(t.p*100).toFixed(0)}%`:''}`);
}

/* ============ candidates ============ */
function rawCandidates(markets,consensus){
  const cands=[]; const now=Date.now();
  markets.forEach(m=>{
    const daysLeft=m.end?(m.end-now)/864e5:99;
    if(daysLeft<=0)return;
    [['YES',m.yes],['NO',m.no]].forEach(([side,p])=>{
      if(p>=.78&&p<=.94&&daysLeft<=7&&m.liq>10000&&m.vol24>3000)
        cands.push({m,side,price:p,signal:'SHORT_FAVORITE',
          prior:clamp(.56+(7-daysLeft)/7*.05+Math.min(.03,m.liq/3e6),.5,.64),
          why:`${cents(p)} favorite resolving in ${daysLeft.toFixed(1)}d (favorite-longshot bias); +${(((1/p)-1)*100).toFixed(0)}% if it lands`});
    });
    if(Math.abs(m.chg)>=.04&&m.vol24>=50000){
      const side=m.chg>0?'YES':'NO'; const p=side==='YES'?m.yes:m.no;
      if(p>=.15&&p<=.85) cands.push({m,side,price:p,signal:'MOMENTUM',
        prior:clamp(.54+Math.min(.05,Math.abs(m.chg))+Math.min(.03,m.vol24/8e6),.5,.62),
        why:`moved ${(m.chg*100).toFixed(1)}pts/24h on ${fmtUSD(m.vol24)} — riding repricing, out in <=3d`});
    }
    const spike=m.volume>0?m.vol24/m.volume:0;
    if(spike>=.25&&m.vol24>=30000&&daysLeft<=14){
      const side=m.yes<=.5?'YES':'NO'; const p=side==='YES'?m.yes:m.no;
      if(p>=.12&&p<=.48) cands.push({m,side,price:p,signal:'VOLUME_SPIKE',
        prior:clamp(.53+Math.min(.04,spike*.08),.5,.6),
        why:`${(spike*100).toFixed(0)}% of lifetime volume in 24h — attention precedes movement`});
    }
  });
  consensus.forEach(s=>{
    if(!/^(yes|no)$/i.test(String(s.outcome||'').trim())) return; /* team-name outcome markets break side mapping — skip */
    if(s.cur>0 && s.cur<=s.avgEntry*1.06 && s.cur>=s.avgEntry*0.7)  /* not run up, and NOT collapsed (falling knife != copy window) */
      cands.push({m:{q:s.title,id:'sig:'+s.title,conditionId:s.conditionId,eventSlug:s.slug,end:null,vol24:0,volume:0,liq:0,chg:0},
        side:/yes/i.test(s.outcome)?'YES':'NO',price:s.cur,signal:'SMART_CONSENSUS',
        consensusN:s.n,walletNames:s.wallets,
        entryVsSmart:s.avgEntry>0?(s.cur-s.avgEntry)/s.avgEntry:0,
        prior:clamp(.55+Math.min(.06,s.n*.015),.5,.62),
        why:`${s.n} top wallets aligned (${fmtUSD(s.value)} combined), avg entry ${cents(s.avgEntry)} vs ${cents(s.cur)} now`});
  });
  return cands;
}

/* ============ decide & place ============ */
function topDrivers(brain,c){
  if(brain.nUpdates<10) return 'engine heuristics (model still warming up)';
  const contrib=c.x.map((v,i)=>({name:FEATURE_NAMES[i],val:v*brain.w[i]}))
    .filter(d=>Math.abs(d.val)>0.02).sort((a,b)=>Math.abs(b.val)-Math.abs(a.val)).slice(0,3);
  if(!contrib.length) return 'no strong feature signals yet';
  const nice={sig_fav:'favorite setup',sig_mom:'momentum setup',sig_smart:'smart-money setup',sig_spike:'spike setup',
    price:'price level',days_short:'short time to resolution',abs_move:'24h move size',volume24:'24h volume',
    liquidity:'liquidity',spike_ratio:'attention spike',consensus_n:'wallet consensus',is_game:'sports market',entry_vs_smart:'entry vs smart money'};
  return contrib.map(d=>`${nice[d.name]||d.name} ${d.val>0?'+':'-'}`).join(', ');
}

function scan(state,markets,consensus,eliteCands){
  const brain=state.brain;
  const open=state.journal.filter(t=>t.status==='open');
  const equity=state.bank.cash+open.reduce((s,t)=>s+t.stake,0);
  let exposure=open.reduce((s,t)=>s+t.stake,0);
  const taken=state.journal.filter(t=>t.date===todayKey()).length;
  if(taken>=DAILY_MAX){ log('Daily cap reached.'); return; }
  const dayFrac=istDayFrac();
  const behind=taken<Math.floor(DAILY_MIN*dayFrac);
  const pMin=behind?Math.max(0.52,CFG.pMin-0.04):CFG.pMin;
  const room=Math.min(DAILY_MAX-taken,4);
  const openKeys=new Set(open.map(t=>t.title+'|'+t.side));

  const scored=rawCandidates(markets,consensus).concat(eliteCands||[])
    .filter(c=>!openKeys.has(c.m.q+'|'+c.side))
    .map(c=>{
      const pred=predict(brain,c);
      let p=pred.p;
      if(c.signal==='SMART_CONSENSUS'){
        const wq=walletQuality(brain,c.walletNames);
        p=clamp(p*(0.6+0.8*wq),.05,.95);
      }
      return {...c,...pred,p,rank:0.7*p+0.3*pred.thompson};
    })
    .filter(c=>CFG.engines[c.signal]!==false)
    .filter(c=>!isRejected(brain,c.bk))
    .filter(c=>c.p>=pMin)
    .sort((a,b)=>b.rank-a.rank)
    .slice(0,room);

  let placed=0;
  const openLive=()=>state.journal.filter(t=>t.status==='open');
  for(const c of scored){
    if(!(c.price>=0.05&&c.price<=0.95)){ log(`Sanity guard: rejected entry at ${cents(c.price)} on "${(c.m.q||'').slice(0,40)}"`); continue; }
    /* event-correlation guard: total $ on one underlying event capped at MAX_EVENT_EXPOSURE */
    const cand={title:c.m.q,slug:c.m.eventSlug||''};
    const eventExposure=openLive().filter(t=>sameEvent(t,cand)).reduce((s,t)=>s+t.stake,0);
    const eventHeadroom=MAX_EVENT_EXPOSURE-eventExposure;
    if(eventHeadroom<STAKE_MIN){ log(`Event guard: skipping "${c.m.q.slice(0,40)}" — already $${eventExposure} on this underlying event.`); continue; }
    const po=brain.payoff[c.signal];
    const avgWin=po.wN?po.wSum/po.wN:0.45, avgLoss=po.lN?po.lSum/po.lN:0.35;
    const bRatio=avgWin/Math.max(0.05,avgLoss);
    const kelly=Math.max(0,c.p-(1-c.p)/bRatio);
    const frac=clamp(kelly*CFG.kellyMult,0.005,0.08);
    const stake=Math.round(clamp(Math.min(frac*equity,eventHeadroom),STAKE_MIN,STAKE_MAX)/50)*50;
    if(exposure+stake>MAX_EXPOSURE*equity){ log(`Exposure cap (${MAX_EXPOSURE*100}% of equity) — skipping remaining candidates.`); break; }
    if(stake>state.bank.cash){ log('Insufficient paper cash — skipping.'); break; }
    const ev=c.p*avgWin-(1-c.p)*avgLoss;
    const sd=STRATS[c.signal];
    const t={
      id:'t'+Date.now()+Math.random().toString(36).slice(2,6),
      date:todayKey(),openedTs:Date.now(),
      title:c.m.q,mid:c.m.id,conditionId:c.m.conditionId||'',slug:c.m.eventSlug||'',
      side:c.side,entry:c.price,cur:c.price,stake,
      signal:c.signal,
      p:+c.p.toFixed(3),pModel:+c.pModel.toFixed(3),pBucket:+c.pBucket.toFixed(3),bucketN:c.bucketN,bk:c.bk,
      ev:+ev.toFixed(3),kelly:+frac.toFixed(4),x:c.x.map(v=>+v.toFixed(3)),
      walletNames:c.walletNames||null,
      insight:`P(win) ${(c.p*100).toFixed(0)}% [model ${(c.pModel*100).toFixed(0)}%, pattern ${(c.pBucket*100).toFixed(0)}% on n=${c.bucketN}] · EV ${ev>=0?'+':''}${ev.toFixed(2)}/$1 · 1/4-Kelly ${(frac*100).toFixed(1)}% of equity -> $${stake}. ${c.why}. Drivers: ${topDrivers(brain,c)}`,
      target:sd.target,stop:sd.stop,
      holdUntil:Math.min(Date.now()+sd.hold*864e5,c.m.end?new Date(c.m.end).getTime():Infinity),
      status:'open'
    };
    state.journal.unshift(t);
    state.bank.cash-=stake;
    exposure+=stake;
    placed++;
    note(state,`Opened ${c.side} $${stake} @ ${cents(c.price)} P=${(c.p*100).toFixed(0)}% EV=${ev>=0?'+':''}${ev.toFixed(2)} [${STRATS[c.signal].label}] "${c.m.q.slice(0,46)}"`);
  }
  if(!placed) log(`No candidates cleared P(win) >= ${pMin} after learned filters (${taken}/${DAILY_MAX} today).`);
}

/* ============ main ============ */
(async()=>{
  const state=loadState();
  log(`EdgeHound v2 starting. Journal: ${state.journal.length} trades. Cash: $${state.bank.cash.toFixed(0)}. Model updates: ${state.brain.nUpdates}.`);
  log(`Config: pMin=${CFG.pMin} kelly=${CFG.kellyMult} maxExp=${CFG.maxExposure} eventCap=$${CFG.maxEventExposure} engines=${Object.entries(CFG.engines).filter(([k,v])=>v).map(([k])=>k).join(',')}`);
  let markets=[];
  try{ markets=await fetchMarkets(); log(`Fetched ${markets.length} markets.`); }
  catch(e){ log('FATAL: market fetch failed: '+e.message); saveState(state); process.exit(0); }
  const consensus=await fetchConsensus();
  log(`Consensus signals: ${consensus.length}`);
  const elite=await buildElitePool(state);
  const eliteCands=elite.length?await fetchEliteSignals(elite,markets):[];
  log(`Elite pool: ${elite.length} wallets, fresh follow signals: ${eliteCands.length}`);
  await catchUp(state,markets);
  updateHypotheses(state);
  scan(state,markets,consensus,eliteCands);
  const closed=state.journal.filter(t=>t.status==='closed');
  const openT=state.journal.filter(t=>t.status==='open');
  const equity=state.bank.cash+openT.reduce((s,t)=>s+t.stake+(t.cur&&t.entry?(t.stake/t.entry)*(t.cur-t.entry):0),0);
  state.summary={
    realized:+closed.reduce((s,t)=>s+t.pnl,0).toFixed(2),
    closed:closed.length, wins:closed.filter(t=>t.pnl>0).length,
    open:openT.length, staked:state.journal.reduce((s,t)=>s+t.stake,0),
    bankStart:state.bank.start, cash:+state.bank.cash.toFixed(0), equity:+equity.toFixed(0),
    returnPct:+(((equity-state.bank.start)/state.bank.start)*100).toFixed(2),
    modelUpdates:state.brain.nUpdates,
    brier:state.brain.brier.n?+(state.brain.brier.sum/state.brain.brier.n).toFixed(3):null,
    hypotheses:state.brain.hypotheses.length,
    updated:new Date().toISOString()
  };
  saveState(state);
  log(`Run done. Equity $${state.summary.equity} (${state.summary.returnPct>=0?'+':''}${state.summary.returnPct}%). Hypotheses: ${state.summary.hypotheses}. Brier: ${state.summary.brier??'n/a'}.`);
})();
