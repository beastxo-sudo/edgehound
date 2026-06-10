/* =====================================================
   EDGEHOUND (headless) — Polymarket paper-trading bot
   Runs on GitHub Actions every 15 minutes.
   - Scores all active markets across 4 signal engines
   - Places 10–20 paper trades/day, $100–$1000 each
   - Manages exits: target / stop / max-hold / resolution
   - Learning: signal weights reweighted by realized P&L
   - State persists in data/state.json (committed to repo)
   Read-only public APIs. No keys. No real money. Ever.
===================================================== */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const GAMMA = 'https://gamma-api.polymarket.com';
const DATA  = 'https://data-api.polymarket.com';
const STATE_FILE = path.join(__dirname, 'data', 'state.json');

const STRATS = {
  SHORT_FAVORITE: { label:'Short Favorite', hold:8,  target:null, stop:.45 },
  MOMENTUM:       { label:'Momentum',       hold:3,  target:.18,  stop:.20 },
  SMART_CONSENSUS:{ label:'Smart Consensus',hold:14, target:.30,  stop:.30 },
  VOLUME_SPIKE:   { label:'Volume Spike',   hold:5,  target:.22,  stop:.25 }
};

/* ---------------- utils ---------------- */
async function jget(url){
  const r = await fetch(url, { headers:{ 'accept':'application/json' }, signal: AbortSignal.timeout(15000) });
  if(!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}
const cents = p => Math.round(p*100)+'c';
const fmtUSD = n => Math.abs(n)>=1e6 ? '$'+(n/1e6).toFixed(2)+'M' : Math.abs(n)>=1e3 ? '$'+(n/1e3).toFixed(1)+'K' : '$'+Number(n).toFixed(0);
const todayUTC = () => new Date().toISOString().slice(0,10);
const log = m => console.log(new Date().toISOString()+'  '+m);

/* ---------------- state ---------------- */
function loadState(){
  let s = null;
  try { s = JSON.parse(fs.readFileSync(STATE_FILE,'utf8')); } catch(e) {}
  s = s || { running:true, journal:[], strat:{}, created:Date.now(), log:[] };
  for(const k in STRATS) s.strat[k] = s.strat[k] || { trades:0, wins:0, pnl:0, weight:1 };
  return s;
}
function saveState(s){
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive:true });
  s.lastRun = Date.now();
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 1));
}
function note(s, msg){
  s.log.unshift(new Date().toISOString().slice(0,16).replace('T',' ')+' — '+msg);
  s.log = s.log.slice(0, 12);
  log(msg);
}

/* ---------------- market data ---------------- */
function normalizeMarket(m){
  try{
    const prices = JSON.parse(m.outcomePrices||'[]').map(Number);
    const outcomes = JSON.parse(m.outcomes||'[]');
    let yi = outcomes.findIndex(o=>/^yes$/i.test(o)); if(yi<0) yi=0;
    const yes = prices[yi] ?? 0.5;
    return {
      id:m.id, q:m.question||'', conditionId:m.conditionId||'',
      eventSlug:(m.events&&m.events[0]&&m.events[0].slug)||m.slug||'',
      yes, no:1-yes,
      vol24:Number(m.volume24hr)||0, volume:Number(m.volumeNum||m.volume)||0,
      liq:Number(m.liquidityNum||m.liquidity)||0,
      chg:Number(m.oneDayPriceChange)||0,
      end:m.endDate ? new Date(m.endDate) : null
    };
  }catch(e){ return null; }
}

async function fetchMarkets(){
  const m = await jget(`${GAMMA}/markets?closed=false&active=true&order=volume24hr&ascending=false&limit=200`);
  return (Array.isArray(m)?m:[]).map(normalizeMarket).filter(x=>x && x.yes>0.005 && x.yes<0.995);
}

async function fetchConsensus(){
  /* positions of the top profitable wallets -> consensus signals */
  try{
    const lb = await jget(`${DATA}/v1/leaderboard?category=OVERALL&timePeriod=MONTH&orderBy=PNL&limit=10`);
    const top = (Array.isArray(lb)?lb:[]).slice(0,8);
    const agg = {};
    const results = await Promise.allSettled(top.map(l =>
      jget(`${DATA}/positions?user=${l.proxyWallet}&sortBy=CURRENT&sortDirection=DESC&limit=50`)));
    results.forEach((r,i)=>{
      if(r.status!=='fulfilled' || !Array.isArray(r.value)) return;
      r.value.filter(p=>!p.redeemable && Number(p.currentValue)>50).forEach(p=>{
        const key = p.title+'|'+p.outcome;
        agg[key] = agg[key] || { title:p.title, outcome:p.outcome, slug:p.eventSlug||'', conditionId:p.conditionId||'', wallets:new Set(), value:0, entrySum:0, entryN:0, cur:Number(p.curPrice)||0 };
        agg[key].wallets.add(top[i].userName||top[i].proxyWallet);
        agg[key].value += Number(p.currentValue)||0;
        agg[key].entrySum += Number(p.avgPrice)||0; agg[key].entryN++;
        agg[key].cur = Number(p.curPrice)||agg[key].cur;
      });
    });
    return Object.values(agg)
      .map(s=>({ ...s, n:s.wallets.size, avgEntry:s.entryN?s.entrySum/s.entryN:0, wallets:[...s.wallets] }))
      .filter(s=>s.n>=2);
  }catch(e){ log('consensus fetch failed: '+e.message); return []; }
}

/* ---------------- exits & settlement ---------------- */
async function catchUp(state, markets){
  const open = state.journal.filter(t=>t.status==='open');
  if(!open.length) return;
  const byCondition = {}; markets.forEach(m=>{ if(m.conditionId) byCondition[m.conditionId]=m; });
  const px = {};
  open.forEach(t=>{
    const m = byCondition[t.conditionId] || markets.find(x=>x.q===t.title);
    if(m) px[t.id] = { cur: t.side==='YES'?m.yes:m.no, resolved:false };
  });
  /* markets no longer in the active list: look up directly (may be resolved) */
  const missing = [...new Set(open.filter(t=>!px[t.id] && t.conditionId).map(t=>t.conditionId))].slice(0,30);
  if(missing.length){
    try{
      const ms = await jget(`${GAMMA}/markets?`+missing.map(c=>'condition_ids='+encodeURIComponent(c)).join('&'));
      (Array.isArray(ms)?ms:[]).forEach(mk=>{
        try{
          const prices = JSON.parse(mk.outcomePrices||'[]').map(Number);
          const outs = JSON.parse(mk.outcomes||'[]');
          let yi = outs.findIndex(o=>/^yes$/i.test(o)); if(yi<0) yi=0;
          open.filter(t=>t.conditionId===mk.conditionId).forEach(t=>{
            px[t.id] = { cur: t.side==='YES'?prices[yi]:1-prices[yi], resolved: !!mk.closed };
          });
        }catch(e){}
      });
    }catch(e){ log('settlement lookup failed: '+e.message); }
  }
  const now = Date.now();
  open.forEach(t=>{
    const p = px[t.id]; if(!p) return;
    t.cur = p.cur;
    if(p.resolved || p.cur>=0.995 || p.cur<=0.005){ closeTrade(state,t, p.cur>=0.5?1:0, p.cur>=0.5?'Resolved in our favor':'Resolved against us'); return; }
    const move = (p.cur-t.entry)/t.entry;
    if(t.target && move>= t.target){ closeTrade(state,t,p.cur,`Profit target hit (+${(t.target*100).toFixed(0)}%)`); return; }
    if(move <= -t.stop){ closeTrade(state,t,p.cur,`Stop loss hit (-${(t.stop*100).toFixed(0)}%)`); return; }
    if(t.holdUntil && now>t.holdUntil){ closeTrade(state,t,p.cur,'Max hold reached — closed at market'); }
  });
}

function closeTrade(state,t,exit,reason){
  t.status='closed'; t.exit=exit; t.exitTs=Date.now(); t.exitReason=reason;
  t.pnl = (t.stake/t.entry)*(exit-t.entry);
  const s = state.strat[t.signal];
  s.trades++; if(t.pnl>0) s.wins++; s.pnl += t.pnl;
  const wr = (s.wins+2)/(s.trades+4);
  const roiTilt = 1 + Math.max(-0.5, Math.min(0.5, s.pnl/Math.max(1000, s.trades*400)));
  s.weight = Math.max(0.25, Math.min(2.2, wr*2*roiTilt));
  note(state, `Closed ${t.side} "${t.title.slice(0,45)}" -> ${t.pnl>=0?'+':''}$${t.pnl.toFixed(0)} (${reason}). ${STRATS[t.signal].label} weight -> ${s.weight.toFixed(2)}`);
}

/* ---------------- candidates & scoring ---------------- */
function candidates(state, markets, consensus){
  const cands = [];
  const now = Date.now();
  const openKeys = new Set(state.journal.filter(t=>t.status==='open').map(t=>t.title+'|'+t.side));
  markets.forEach(m=>{
    const daysLeft = m.end ? (m.end-now)/864e5 : 99;
    if(daysLeft<=0) return;
    [['YES',m.yes],['NO',m.no]].forEach(([side,p])=>{
      if(p>=.78 && p<=.94 && daysLeft<=7 && m.liq>10000 && m.vol24>3000){
        const score = .55 + (7-daysLeft)/7*.15 + Math.min(.1, m.liq/2e6) + ((p-.78)/.16)*.05;
        cands.push({ m, side, price:p, signal:'SHORT_FAVORITE', score,
          insight:`${cents(p)} favorite resolving in ${daysLeft.toFixed(1)}d. Favorite-longshot bias: markets underprice near-certainties. Hold to resolution; +${(((1/p)-1)*100).toFixed(0)}% if it lands.` });
      }
    });
    if(Math.abs(m.chg)>=.04 && m.vol24>=50000){
      const side = m.chg>0?'YES':'NO';
      const p = side==='YES'?m.yes:m.no;
      if(p>=.15 && p<=.85){
        const score = .5 + Math.min(.2,Math.abs(m.chg)*2) + Math.min(.15, m.vol24/5e6);
        cands.push({ m, side, price:p, signal:'MOMENTUM', score,
          insight:`Moved ${(m.chg*100).toFixed(1)}pts in 24h on ${fmtUSD(m.vol24)} volume — news is repricing this. Target +18%, stop -20%, out within 3 days.` });
      }
    }
    const spike = m.volume>0 ? m.vol24/m.volume : 0;
    if(spike>=.25 && m.vol24>=30000 && daysLeft<=14){
      const side = m.yes<=.5?'YES':'NO';
      const p = side==='YES'?m.yes:m.no;
      if(p>=.12 && p<=.48){
        const score = .48 + Math.min(.2, spike*.4) + Math.min(.1, m.vol24/3e6);
        cands.push({ m, side, price:p, signal:'VOLUME_SPIKE', score,
          insight:`${(spike*100).toFixed(0)}% of lifetime volume traded in 24h — sudden attention precedes movement. Cheap side at ${cents(p)}; tight risk controls.` });
      }
    }
  });
  consensus.forEach(s=>{
    if(s.cur>0 && s.cur<=s.avgEntry*1.06){
      cands.push({
        m:{ q:s.title, id:'sig:'+s.title, conditionId:s.conditionId, eventSlug:s.slug, end:null },
        side:/yes/i.test(s.outcome)?'YES':'NO', price:s.cur, signal:'SMART_CONSENSUS',
        score:.5 + Math.min(.25, s.n*.07) + Math.min(.1, s.value/2e6),
        insight:`${s.n} top-ranked wallets hold this side (combined ${fmtUSD(s.value)}), avg entry ${cents(s.avgEntry)} vs ${cents(s.cur)} now — inside the copy window. [${s.wallets.slice(0,3).join(', ')}]`
      });
    }
  });
  return cands
    .filter(c=>!openKeys.has(c.m.q+'|'+c.side))
    .map(c=>({ ...c, score:c.score*state.strat[c.signal].weight }))
    .sort((a,b)=>b.score-a.score);
}

/* ---------------- the scan ---------------- */
function scan(state, markets, consensus){
  const taken = state.journal.filter(t=>t.date===todayUTC()).length;
  if(taken>=20){ note(state,'Daily cap (20) reached — holding fire.'); return; }
  /* pace: relax threshold if behind 10/day pro-rated through the UTC day */
  const dayFrac = (Date.now() - new Date(todayUTC()+'T00:00:00Z').getTime())/864e5;
  const behind = taken < Math.floor(10*dayFrac);
  const threshold = behind ? 0.42 : 0.55;
  const room = Math.min(20-taken, 4); /* max 4 per 15-min run, spreads entries through the day */
  const picks = candidates(state, markets, consensus).filter(c=>c.score>=threshold).slice(0, room);
  picks.forEach(c=>{
    const conf = Math.max(0, Math.min(1, (c.score-.42)/.5));
    const stake = Math.round((100+900*conf)/50)*50;
    const sd = STRATS[c.signal];
    state.journal.unshift({
      id:'t'+Date.now()+Math.random().toString(36).slice(2,6),
      date:todayUTC(), openedTs:Date.now(),
      title:c.m.q, mid:c.m.id, conditionId:c.m.conditionId||'', slug:c.m.eventSlug||'',
      side:c.side, entry:c.price, cur:c.price, stake,
      signal:c.signal, insight:c.insight, score:Number(c.score.toFixed(3)),
      target:sd.target, stop:sd.stop,
      holdUntil: Math.min(Date.now()+sd.hold*864e5, c.m.end ? new Date(c.m.end).getTime() : Infinity),
      status:'open'
    });
    note(state, `Opened ${c.side} $${stake} @ ${cents(c.price)} [${STRATS[c.signal].label}] "${c.m.q.slice(0,50)}"`);
  });
  if(!picks.length) log(`Scan complete — no candidates cleared threshold ${threshold} (${taken}/20 today).`);
}

/* ---------------- main ---------------- */
(async ()=>{
  const state = loadState();
  log(`EdgeHound run starting. Journal: ${state.journal.length} trades, ${state.journal.filter(t=>t.status==='open').length} open.`);
  let markets = [];
  try{ markets = await fetchMarkets(); log(`Fetched ${markets.length} active markets.`); }
  catch(e){ log('FATAL: market fetch failed: '+e.message); saveState(state); process.exit(0); }
  const consensus = await fetchConsensus();
  log(`Consensus signals from top wallets: ${consensus.length}`);
  await catchUp(state, markets);
  scan(state, markets, consensus);
  /* summary stats for the dashboard */
  const closed = state.journal.filter(t=>t.status==='closed');
  state.summary = {
    realized: closed.reduce((s,t)=>s+t.pnl,0),
    closed: closed.length,
    wins: closed.filter(t=>t.pnl>0).length,
    open: state.journal.filter(t=>t.status==='open').length,
    staked: state.journal.reduce((s,t)=>s+t.stake,0),
    updated: new Date().toISOString()
  };
  saveState(state);
  log(`Run done. Realized P&L: $${state.summary.realized.toFixed(0)} over ${closed.length} settled trades.`);
})();
