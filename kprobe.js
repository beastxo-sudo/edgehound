/* Kalshi data-access probe: which endpoints expose prices unauthenticated? */
const fs=require('fs');
const out={ranAt:new Date().toISOString(),tests:[]};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function t(name,url){
  try{
    const r=await fetch(url,{headers:{accept:'application/json','user-agent':'probe/1.0'},signal:AbortSignal.timeout(12000)});
    const txt=await r.text();
    let j=null; try{j=JSON.parse(txt);}catch(e){}
    out.tests.push({name,url:url.slice(0,110),status:r.status,body:j?JSON.stringify(j).slice(0,900):txt.slice(0,200)});
  }catch(e){out.tests.push({name,url:url.slice(0,110),error:e.message});}
  await sleep(300);
}
(async()=>{
  const H1='https://api.elections.kalshi.com/trade-api/v2';
  const H2='https://trading-api.kalshi.com/trade-api/v2';
  // 1. liquid series lists on both hosts (BTC daily = definitely quoted on-site)
  await t('elections: KXBTCD series markets', `${H1}/markets?series_ticker=KXBTCD&status=open&limit=5`);
  await t('trading-api host: same', `${H2}/markets?series_ticker=KXBTCD&status=open&limit=5`);
  await t('elections: KXETH series', `${H1}/markets?series_ticker=KXETHD&status=open&limit=3`);
  // 2. grab one open BTC ticker then orderbook
  try{
    const r=await fetch(`${H1}/markets?series_ticker=KXBTCD&status=open&limit=3`,{headers:{accept:'application/json'}});
    const d=await r.json();
    const m=(d.markets||[])[0];
    if(m){
      out.sampleMarketFull=m;
      await t('orderbook (elections)', `${H1}/markets/${m.ticker}/orderbook`);
      await t('orderbook (trading-api)', `${H2}/markets/${m.ticker}/orderbook`);
      await t('single market (elections)', `${H1}/markets/${m.ticker}`);
    } else out.tests.push({name:'no open KXBTCD markets returned',note:JSON.stringify(d).slice(0,300)});
  }catch(e){out.tests.push({name:'btc ticker fetch',error:e.message});}
  // 3. events endpoint nested markets — do они carry prices?
  await t('events nested', `${H1}/events?status=open&limit=2&with_nested_markets=true&series_ticker=KXBTCD`);
  fs.mkdirSync('data',{recursive:true});
  fs.writeFileSync('data/kprobe.json',JSON.stringify(out,null,1));
  console.log('probe done:',out.tests.map(x=>x.name+':'+(x.status||x.error)).join(' | '));
})();
