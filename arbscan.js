/* Polymarket <-> Kalshi arbitrage scan (server-side). Writes data/arbscan.json */
const fs = require('fs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = m => console.log(new Date().toISOString().slice(11,19)+'  '+m);
async function jget(url, ms=15000, tries=3){
  for(let i=0;i<tries;i++){
    try{
      const r=await fetch(url,{headers:{accept:'application/json','user-agent':'arb-scan/1.0'},signal:AbortSignal.timeout(ms)});
      if(r.status===429){await sleep(1500*(i+1));continue;}
      if(!r.ok)throw new Error('HTTP '+r.status);
      return await r.json();
    }catch(e){if(i===tries-1)throw e;await sleep(600*(i+1));}
  }
}
async function fetchPoly(){
  const out=[];
  for(let off=0;off<1500;off+=500){
    const d=await jget(`https://gamma-api.polymarket.com/markets?closed=false&active=true&limit=500&offset=${off}&order=volume24hr&ascending=false`);
    if(!Array.isArray(d)||!d.length)break;
    for(const m of d){
      const ba=+m.bestAsk, bb=+m.bestBid;
      if(!(ba>0&&ba<1)||!(bb>0&&bb<1))continue;
      out.push({id:m.id,slug:m.slug,title:(m.question||'').trim(),yesAsk:ba,noAsk:+(1-bb).toFixed(4),end:m.endDate,vol:+m.volume24hr||0});
    }
    if(d.length<500)break;
    await sleep(200);
  }
  return out;
}
async function fetchKalshi(){
  const out=[];let cursor='';
  for(let p=0;p<8;p++){
    const d=await jget(`https://api.elections.kalshi.com/trade-api/v2/markets?limit=1000&status=open${cursor?'&cursor='+cursor:''}`);
    for(const m of (d.markets||[])){
      const ya=m.yes_ask,na=m.no_ask;
      if(!(ya>0&&ya<100)||!(na>0&&na<100))continue;
      out.push({id:m.ticker,event:m.event_ticker,title:((m.title||'')+' '+(m.yes_sub_title||m.subtitle||'')).trim(),
        yesAsk:ya/100,noAsk:na/100,end:m.close_time,vol:+m.volume_24h||0});
    }
    cursor=d.cursor||'';
    if(!cursor)break;
    await sleep(250);
  }
  return out;
}
const STOP=new Set(['will','the','be','a','an','of','on','in','at','to','by','for','or','and','vs','win','before','after','above','below','than','more','less','over','under','is','does','do','what']);
function feats(t){
  const lower=t.toLowerCase();
  const nums=(lower.match(/\d[\d,.]*/g)||[]).map(x=>x.replace(/,/g,'').replace(/\.$/,''));
  const toks=new Set(lower.replace(/[^a-z0-9 ]/g,' ').split(/\s+/).filter(w=>w&&!STOP.has(w)&&!/^\d/.test(w)));
  return {nums:new Set(nums),toks};
}
function sim(a,b){
  let inter=0;for(const t of a.toks)if(b.toks.has(t))inter++;
  const uni=a.toks.size+b.toks.size-inter;
  const j=uni?inter/uni:0;
  const big=s=>new Set([...s].filter(n=>+n>=1000));
  const ab=big(a.nums),bb=big(b.nums);
  if(ab.size&&bb.size){let bi=0;for(const n of ab)if(bb.has(n))bi++;if(bi===0)return 0;}
  if(a.nums.size&&b.nums.size){
    let ni=0;for(const n of a.nums)if(b.nums.has(n))ni++;
    if(ni===0)return 0;
    return j*0.6+0.4*ni/Math.max(a.nums.size,b.nums.size);
  }
  return j;
}
const fee=p=>Math.min(0.07*p*(1-p),0.02);
(async()=>{
  log('fetching Polymarket…');
  const poly=await fetchPoly(); log(`poly: ${poly.length} markets`);
  log('fetching Kalshi…');
  const kalshi=await fetchKalshi(); log(`kalshi: ${kalshi.length} markets`);
  const kf=kalshi.map(k=>({k,f:feats(k.title)}));
  const byK={};
  let scanned=0;
  for(const p of poly){
    const pf=feats(p.title);
    if(pf.toks.size<2)continue;
    let best=null,bs=0;
    for(const {k,f} of kf){const s=sim(pf,f);if(s>bs){bs=s;best=k;}}
    if(best&&bs>=0.34){
      const cur=byK[best.id];
      if(!cur||bs>cur.s) byK[best.id]={p,k:best,s:bs};
    }
    if(++scanned%200===0) log(`matched ${scanned}/${poly.length}`);
  }
  const pairs=Object.values(byK).map(({p,k,s})=>{
    const d1=p.yesAsk+k.noAsk+fee(k.noAsk);
    const d2=k.yesAsk+fee(k.yesAsk)+p.noAsk;
    const best=Math.min(d1,d2);
    return {s:+s.toFixed(2),cost:+best.toFixed(4),
      dir:d1<=d2?'YES@poly + NO@kalshi':'YES@kalshi + NO@poly',
      legs:d1<=d2?[p.yesAsk,k.noAsk]:[k.yesAsk,p.noAsk],
      poly:{title:p.title,slug:p.slug,yesAsk:p.yesAsk,noAsk:p.noAsk,vol:Math.round(p.vol),end:p.end},
      kalshi:{title:k.title,id:k.id,event:k.event,yesAsk:k.yesAsk,noAsk:k.noAsk,vol:k.vol,end:k.end}};
  }).sort((a,b)=>a.cost-b.cost);
  fs.mkdirSync('data',{recursive:true});
  fs.writeFileSync('data/arbscan.json',JSON.stringify({
    ranAt:new Date().toISOString(),
    counts:{poly:poly.length,kalshi:kalshi.length,pairs:pairs.length,
      under1:pairs.filter(x=>x.cost<1).length,under1_02:pairs.filter(x=>x.cost<1.02).length},
    pairs:pairs.slice(0,80)
  },null,1));
  log(`DONE: ${pairs.length} pairs | <\$1.00: ${pairs.filter(x=>x.cost<1).length} | <\$1.02: ${pairs.filter(x=>x.cost<1.02).length}`);
})();
