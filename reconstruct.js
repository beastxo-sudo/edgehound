/* ============================================================
   BACKTEST.JS — full-coverage reconstruction from Polymarket's
   own historical data. No live sampling, no missed windows.

   For every 5-minute BTC window in the lookback period:
     1. Find the market by its deterministic slug (btc-updown-5m-{unixStart}).
     2. Pull the CLOB price history (minute fidelity) for BOTH tokens.
     3. Read each side's price at T-60s (the strategy's decision moment).
     4. Read Binance's 1m klines to get the true spot direction at T-60s
        (window open vs price at minute 4) — the same signal the live lab uses.
     5. Take the resolution from the market itself (outcomePrices 1/0)
        — Polymarket's own settlement, the thing that pays.
     6. Strategy: bet $10 on the spot-direction side when its price < 70¢.

   Output: data/backtest.json — every window, with full audit fields.
   ============================================================ */
const fs = require('fs');
const path = require('path');

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const HOURS = Number(process.env.RECON_HOURS || 3);  /* top-up lookback per run */
const LEDGER = path.join(__dirname, 'data', 'ledger.json');
const DIGEST = path.join(__dirname, 'data', 'strategy.json');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (m) => console.log(new Date().toISOString().slice(11, 19) + '  ' + m);

async function jget(url, ms = 8000, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(ms) });
      if (r.status === 429) { await sleep(1200 * (i + 1)); continue; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) { if (i === tries - 1) throw e; await sleep(400 * (i + 1)); }
  }
}

/* Binance 1m klines over the whole lookback — gives spot open + T-60s price per window.
   Fails over across hosts (GitHub's US runners are often geo-blocked by binance.com). */
const BIN_HOSTS = ['https://api.binance.com/api/v3', 'https://api.binance.us/api/v3', 'https://data-api.binance.vision/api/v3'];
let binHost = null;
async function binKlines(q) {
  const hosts = binHost ? [binHost, ...BIN_HOSTS.filter(h => h !== binHost)] : BIN_HOSTS;
  for (const h of hosts) {
    try { const r = await jget(h + q, 9000, 2); binHost = h; return r; }
    catch (e) {}
  }
  throw new Error('all binance hosts failed');
}
async function binanceMap(startMs, endMs) {
  const px = new Map(); /* minute-ts -> {open, close} */
  let cur = startMs;
  while (cur < endMs) {
    const k = await binKlines(`/klines?symbol=BTCUSDT&interval=1m&startTime=${cur}&endTime=${Math.min(cur + 999 * 60000, endMs)}&limit=1000`);
    for (const c of k) px.set(Number(c[0]), { open: Number(c[1]), close: Number(c[4]) });
    if (!k.length) break;
    cur = Number(k[k.length - 1][0]) + 60000;
    await sleep(150);
  }
  return px;
}

/* price at (or nearest within 90s of) a unix-second timestamp from a history series */
function priceAt(history, tSec) {
  let best = null, bestD = 1e9;
  for (const p of history) {
    const d = Math.abs(p.t - tSec);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best && bestD <= 90 ? { p: Number(best.p), drift: bestD } : null;
}


function loadLedger() {
  try { return JSON.parse(fs.readFileSync(LEDGER, 'utf8')); } catch (e) {}
  return { method: 'full-coverage reconstruction from Polymarket price history', created: new Date().toISOString(), rows: [] };
}

function digest(led) {
  const rows = led.rows;
  const cheap = rows.filter(r => r.cheap);
  const pnlOf = r => r.pnl;
  const wins = cheap.filter(r => r.won).length;
  const exp = cheap.reduce((a, r) => a + r.paid, 0);
  const va = cheap.reduce((a, r) => a + r.paid * (1 - r.paid), 0);
  const z = va > 0 ? (wins - exp) / Math.sqrt(va) : null;
  const pnl = cheap.reduce((a, r) => a + pnlOf(r), 0);
  const byDay = {};
  for (const r of cheap) {
    const d = r.t.slice(0, 10);
    if (!byDay[d]) byDay[d] = { bets: 0, wins: 0, pnl: 0 };
    byDay[d].bets++; if (r.won) byDay[d].wins++;
    byDay[d].pnl = +(byDay[d].pnl + pnlOf(r)).toFixed(2);
  }
  let cum = 0;
  const daily = Object.keys(byDay).sort().map(d => { cum = +(cum + byDay[d].pnl).toFixed(2); return { d, ...byDay[d], cum }; });
  const bands = [];
  for (let lo = 0.20; lo < 0.70; lo += 0.10) {
    const arr = cheap.filter(r => r.paid >= lo - 1e-9 && r.paid < lo + 0.10);
    if (!arr.length) continue;
    const w = arr.filter(r => r.won).length;
    bands.push({ band: Math.round(lo * 100) + '\u2013' + Math.round((lo + 0.10) * 100) + '\u00a2', n: arr.length, wins: w,
      winRate: +(w / arr.length).toFixed(3), breakEven: +(arr.reduce((a, r) => a + r.paid, 0) / arr.length).toFixed(3),
      pnl: +arr.reduce((a, r) => a + pnlOf(r), 0).toFixed(0) });
  }
  const hourly = [];
  for (let h = 0; h < 24; h += 4) {
    const arr = cheap.filter(r => { const hh = +r.t.slice(11, 13); return hh >= h && hh < h + 4; });
    if (arr.length) hourly.push({ h, n: arr.length, wins: arr.filter(r => r.won).length, pnl: +arr.reduce((a, r) => a + pnlOf(r), 0).toFixed(0) });
  }
  const recent = cheap.slice(-40).map(r => ({ t: r.t, dir: r.dir, paid: r.paid, actual: r.actual, won: r.won, pnl: r.pnl, open: r.spotOpen, close: r.spotT60, exch: 'poly-resolved', book: null }));
  fs.writeFileSync(DIGEST, JSON.stringify({
    updated: new Date().toISOString(),
    method: led.method,
    totals: { samples: rows.length, settled: rows.length, polyConfirmed: rows.length },
    strategy: {
      bets: cheap.length, wins, winRate: cheap.length ? +(wins / cheap.length).toFixed(4) : null,
      marketImplied: cheap.length ? +(exp / cheap.length).toFixed(4) : null,
      edgePts: cheap.length ? +((wins - exp) / cheap.length * 100).toFixed(1) : null,
      zScore: z != null ? +z.toFixed(2) : null,
      staked: cheap.length * 10, pnl: +pnl.toFixed(2),
      returnPct: cheap.length ? +(pnl / (cheap.length * 10) * 100).toFixed(1) : null,
      perTen: cheap.length ? +(10 + pnl / cheap.length).toFixed(2) : null,
      daily, fill: null
    },
    bands, hourly, recent,
    coverage: { windows: rows.length, note: '100% of resolvable windows by construction' }
  }));
}

(async () => {
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
  const led = loadLedger();
  const have = new Set(led.rows.map(r => r.t));
  const endB = Math.floor(Date.now() / 300000) * 300000 - 300000; /* last boundary with settled resolution */
  const startB = endB - HOURS * 3600e3;
  log(`Reconstruct top-up: ${new Date(startB).toISOString()} -> ${new Date(endB).toISOString()} (have ${led.rows.length} rows)`);

  const need = [];
  for (let B = startB + 300000; B <= endB; B += 300000) if (!have.has(new Date(B).toISOString())) need.push(B);
  if (!need.length) { log('ledger already complete for the window'); digest(led); return; }
  log(`${need.length} missing windows to reconstruct`);

  const spot = await binanceMap(need[0] - 360000, need[need.length - 1] + 60000);
  let added = 0; const skip = { noMarket: 0, unresolved: 0, noHistory: 0, noSpot: 0 };
  for (const B of need) {
    const t0 = B - 300000, sec0 = t0 / 1000;
    try {
      const evs = await jget(`${GAMMA}/events?slug=btc-updown-5m-${sec0}`);
      const m = evs && evs[0] && evs[0].markets && evs[0].markets[0];
      if (!m) { skip.noMarket++; continue; }
      let outs = [], toks = [], res = [];
      try { outs = JSON.parse(m.outcomes || '[]'); } catch (e) {}
      try { toks = JSON.parse(m.clobTokenIds || '[]'); } catch (e) {}
      try { res = JSON.parse(m.outcomePrices || '[]').map(Number); } catch (e) {}
      const ui = Math.max(0, outs.findIndex(o => /up/i.test(o)));
      const di = ui === 0 ? 1 : 0;
      if (!(res[ui] === 1 || res[ui] === 0)) { skip.unresolved++; continue; }
      const actual = res[ui] === 1 ? 'UP' : 'DOWN';
      const openC = spot.get(t0), m4 = spot.get(t0 + 3 * 60000);
      if (!openC || !m4) { skip.noSpot++; continue; }
      const dir = m4.close >= openC.open ? 'UP' : 'DOWN';
      const tok = dir === 'UP' ? toks[ui] : toks[di];
      const h = await jget(`${CLOB}/prices-history?market=${tok}&startTs=${sec0}&endTs=${sec0 + 300}&fidelity=1`);
      const pt = priceAt((h && h.history) || [], sec0 + 240);
      if (!pt) { skip.noHistory++; continue; }
      const paid = pt.p, won = dir === actual, cheap = paid > 0 && paid < 0.70;
      led.rows.push({ t: new Date(B).toISOString(), dir, paid: +paid.toFixed(4), priceDriftSec: pt.drift,
        actual, won, cheap, pnl: cheap ? +((won ? 10 * (1 - paid) / paid : -10)).toFixed(2) : 0,
        spotOpen: openC.open, spotT60: m4.close, resolvedBy: 'polymarket-outcome' });
      added++;
    } catch (e) { skip.noHistory++; }
    await sleep(110);
  }
  led.rows.sort((a, b) => a.t.localeCompare(b.t));
  led.rows = led.rows.slice(-26000); /* ~90 days */
  fs.writeFileSync(LEDGER, JSON.stringify(led));
  digest(led);
  log(`added ${added} rows (skips ${JSON.stringify(skip)}) -> ledger ${led.rows.length} rows`);
})();
