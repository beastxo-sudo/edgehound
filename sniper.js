/* ============================================================
   SNIPER LAB — tests the "last 30 seconds" hypothesis on
   Polymarket's 5-minute BTC Up/Down markets.

   The earlier 5-second test confirmed the direction is ~99%
   knowable that late — but you pay ~98c for it, so there's no
   reward. This 30-second version trades certainty for price:
   30s out the direction is less certain (so accuracy drops) but
   the favorite side is cheaper (so each win pays more). The real
   question: does the better entry price more than make up for
   the lower hit rate? That's where any real edge would live.

   Method, every 5-minute boundary while this job is alive:
     T-30s : Binance spot vs candle open -> direction
             Polymarket CLOB best ask for that direction -> price paid
     T+8s  : Binance 5m candle close vs open -> actual outcome
     log   : direction correct? PnL at $10 if filled at that ask
   Paper only. No orders are ever placed.
   ============================================================ */
const fs = require('fs');
const path = require('path');

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const BIN_HOSTS = ['https://api.binance.com/api/v3', 'https://api.binance.us/api/v3'];
let BIN = BIN_HOSTS[0];
const OUT_FILE = path.join(__dirname, 'data', 'sniper.json');

const DURATION_MS = Number(process.env.SNIPER_DURATION_MS || 13.5 * 60e3);
const LEAD_MS = 30000;    /* sample 30s before the boundary */
const SETTLE_DELAY = 8000;/* read the closed candle 8s after */

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ist = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().replace('T', ' ').slice(0, 19) + ' IST';
const log = (m) => console.log(`${ist()}  ${m}`);

async function jget(url, t = 8000) {
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout ? AbortSignal.timeout(t) : undefined });
  if (!res.ok) throw new Error(`${res.status} ${url.slice(0, 90)}`);
  return res.json();
}
/* Binance geo-blocks US IPs (HTTP 451) and GitHub runners are US-based —
   fail over between binance.com and binance.us, remember what works */
async function binGet(pathQ, t = 6000) {
  let lastErr;
  for (const h of [BIN, ...BIN_HOSTS.filter(x => x !== BIN)]) {
    try { const r = await jget(h + pathQ, t); BIN = h; return r; }
    catch (e) { lastErr = e; }
  }
  throw lastErr;
}

function loadLab() {
  try { return JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')); } catch (e) {}
  return { hypothesis: 'Bet the visible direction in the last 5 seconds of each 5-min BTC window', created: Date.now(), samples: [] };
}

function summarize(lab) {
  const s = lab.samples.filter(x => x.actual !== null);
  const correct = s.filter(x => x.won);
  const withPx = s.filter(x => x.paid > 0);
  const pnl = withPx.reduce((a, x) => a + (x.won ? 10 * (1 - x.paid) / x.paid : -10), 0);
  const avgPaid = withPx.length ? withPx.reduce((a, x) => a + x.paid, 0) / withPx.length : null;
  /* At T-30s the favorite is only mildly favored, so EVERY priced sample is a
     real instance of the hypothesis (no near-certain subset to isolate). The
     "decided*" fields therefore mirror the full priced-sample population — the
     dashboard reads these names, and here they ARE the headline result. */
  const decided = withPx;
  const dPnl = decided.reduce((a, x) => a + (x.won ? 10 * (1 - x.paid) / x.paid : -10), 0);
  const dAvg = decided.length ? decided.reduce((a, x) => a + x.paid, 0) / decided.length : null;
  lab.summary = {
    samples: s.length,
    pricedSamples: withPx.length,
    directionAccuracy: s.length ? +(correct.length / s.length).toFixed(4) : null,
    avgPricePaid: avgPaid ? +avgPaid.toFixed(4) : null,
    pnlPer10Flat: +pnl.toFixed(2),
    evPerTrade: withPx.length ? +(pnl / withPx.length).toFixed(3) : null,
    breakEvenAccuracy: avgPaid ? +avgPaid.toFixed(4) : null,
    decidedSamples: decided.length,
    decidedAccuracy: decided.length ? +(decided.filter(x=>x.won).length/decided.length).toFixed(4) : null,
    decidedAvgPaid: dAvg ? +dAvg.toFixed(4) : null,
    decidedEvPerTrade: decided.length ? +(dPnl/decided.length).toFixed(3) : null,
    updated: new Date().toISOString()
  };
}

/* find the live "Bitcoin Up or Down" market ending at boundary B.
   These series have deterministic slugs (btc-updown-5m-{unixStart}),
   so address the event directly; fall back to scanning the listing. */
async function findWindowMarket(B) {
  let ev = null;
  for (const sec of [B / 1000 - 300, B / 1000]) {
    try {
      const r = await jget(`${GAMMA}/events?slug=btc-updown-5m-${sec}`, 5000);
      if (Array.isArray(r) && r[0] && r[0].markets) { ev = r[0]; break; }
    } catch (e) {}
  }
  if (!ev) {
    const evs = await jget(`${GAMMA}/events?closed=false&active=true&order=endDate&ascending=true&limit=100`);
    ev = (evs || []).find(e => /bitcoin up or down/i.test(e.title || '') && Math.abs(new Date(e.endDate || 0).getTime() - B) < 15000);
  }
  if (!ev || !ev.markets || !ev.markets[0]) return null;
  const m = ev.markets[0];
  let outs = [], tokens = [], prices = [];
  try { outs = JSON.parse(m.outcomes || '[]'); } catch (e) {}
  try { tokens = JSON.parse(m.clobTokenIds || '[]'); } catch (e) {}
  try { prices = JSON.parse(m.outcomePrices || '[]').map(Number); } catch (e) {}
  const ui = outs.findIndex(o => /up/i.test(o));
  const di = outs.findIndex(o => /down/i.test(o));
  return {
    title: ev.title, slug: ev.slug,
    upToken: tokens[ui] || null, downToken: tokens[di] || null,
    upPrice: prices[ui] ?? null, downPrice: prices[di] ?? null
  };
}

/* the price you would actually pay: CLOB best ask for that token */
async function bestAsk(tokenId, fallback) {
  if (!tokenId) return fallback ?? 0;
  try {
    const r = await jget(`${CLOB}/price?token_id=${tokenId}&side=BUY`, 5000);
    const p = Number(r.price);
    if (p > 0 && p < 1) return p;
  } catch (e) {}
  return fallback ?? 0;
}

async function sampleBoundary(B, lab) {
  const candleStart = B - 300000;
  try {
    /* T-5s snapshot */
    const [px, k] = await Promise.all([
      binGet(`/ticker/price?symbol=BTCUSDT`, 5000),
      binGet(`/klines?symbol=BTCUSDT&interval=5m&startTime=${candleStart}&limit=1`, 6000)
    ]);
    const spot = Number(px.price);
    const open = Number(k[0][1]);
    const dir = spot >= open ? 'UP' : 'DOWN';
    const leadPct = ((spot - open) / open) * 100;

    let paid = 0, mktTitle = '', mktNote = 'not found';
    try {
      const mkt = await findWindowMarket(B);
      if (mkt) {
        mktTitle = mkt.title;
        const tok = dir === 'UP' ? mkt.upToken : mkt.downToken;
        const fb = dir === 'UP' ? mkt.upPrice : mkt.downPrice;
        paid = await bestAsk(tok, fb);
        /* GUARD: at T-30s the visible-direction side is the favorite but only
           mildly so — it can legitimately price anywhere from ~0.50 to ~0.95.
           A price below ~0.20 means we grabbed the wrong token or a market that
           has already started resolving (prices snapping toward 0/1). Reject
           those rather than logging a fake 100x payout. We do NOT require the
           opposite side to be cheaper here (at 30s the two sides can be close). */
        if (paid > 0 && paid < 0.20) { mktNote = 'rejected: paid ' + paid + ' implausible (late/wrong-token)'; paid = 0; }
        else { mktNote = paid > 0 ? 'ok' : ('found but no price (token ' + (tok ? 'present' : 'missing') + ', gamma price ' + fb + ')'); }
      }
    } catch (e) { mktNote = 'lookup error: ' + e.message.slice(0, 60); log('market lookup failed: ' + e.message); }

    log(`T-30s ${new Date(B).toISOString().slice(11, 19)}Z dir=${dir} (${leadPct >= 0 ? '+' : ''}${leadPct.toFixed(3)}%) ask=${paid ? (paid * 100).toFixed(1) + 'c' : 'n/a'} ${mktTitle.slice(0, 40)}`);

    /* wait for resolution */
    await sleep(Math.max(0, B + SETTLE_DELAY - Date.now()));
    const k2 = await binGet(`/klines?symbol=BTCUSDT&interval=5m&startTime=${candleStart}&limit=1`, 6000);
    const actualUp = Number(k2[0][4]) >= Number(k2[0][1]);
    const actual = actualUp ? 'UP' : 'DOWN';
    const won = dir === actual;

    lab.samples.push({
      win: candleStart, t: new Date(B).toISOString(), dir, leadPct: +leadPct.toFixed(4),
      paid: +(+paid).toFixed(4), mkt: mktNote, actual, won,
      flips: !won && Math.abs(leadPct) < 0.02 ? 'knife-edge flip' : (!won ? 'reversed in final seconds' : null)
    });
    lab.samples = lab.samples.slice(-5000);
    summarize(lab);
    fs.writeFileSync(OUT_FILE, JSON.stringify(lab));
    log(`settled: actual=${actual} -> ${won ? 'CORRECT' : 'WRONG'} | running accuracy ${(lab.summary.directionAccuracy * 100).toFixed(1)}% over ${lab.summary.samples}, EV/trade $${lab.summary.evPerTrade ?? '—'}`);
  } catch (e) {
    log(`boundary ${new Date(B).toISOString()} skipped: ${e.message}`);
  }
}

(async () => {
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  const lab = loadLab();
  const endAt = Date.now() + DURATION_MS;
  log(`Sniper Lab alive for ${(DURATION_MS / 60000).toFixed(1)} min. Samples so far: ${lab.samples.length}.`);
  while (Date.now() < endAt) {
    const nextB = (Math.floor(Date.now() / 300000) + 1) * 300000;
    const wake = nextB - LEAD_MS;
    if (wake > endAt) break;
    await sleep(Math.max(0, wake - Date.now()));
    await sampleBoundary(nextB, lab);
  }
  summarize(lab);
  fs.writeFileSync(OUT_FILE, JSON.stringify(lab));
  log(`Lab run done. ${JSON.stringify(lab.summary)}`);
})();
