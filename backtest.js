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
const HOURS = Number(process.env.BACKTEST_HOURS || 24);
const OUT = path.join(__dirname, 'data', 'backtest.json');

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

/* Binance 1m klines over the whole lookback — gives spot open + T-60s price per window */
async function binanceMap(startMs, endMs) {
  const px = new Map(); /* minute-ts -> {open, close} */
  let cur = startMs;
  while (cur < endMs) {
    const k = await jget(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&startTime=${cur}&endTime=${Math.min(cur + 999 * 60000, endMs)}&limit=1000`);
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

(async () => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const endB = Math.floor(Date.now() / 300000) * 300000;          /* last completed boundary */
  const startB = endB - HOURS * 3600e3;
  log(`Backtest ${HOURS}h: ${new Date(startB).toISOString()} -> ${new Date(endB).toISOString()}`);

  log('loading Binance 1m klines…');
  const spot = await binanceMap(startB - 60000, endB + 60000);
  log(`${spot.size} minute candles loaded`);

  const rows = []; const skip = { noMarket: 0, noTokens: 0, unresolved: 0, noHistory: 0, noSpot: 0 };
  let done = 0;
  for (let B = startB + 300000; B <= endB; B += 300000) {
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
      if (!toks[ui] || !toks[di]) { skip.noTokens++; continue; }
      if (!(res[ui] === 1 || res[ui] === 0)) { skip.unresolved++; continue; }
      const actual = res[ui] === 1 ? 'UP' : 'DOWN';

      /* spot direction at T-60s: window open vs close of minute-4 candle */
      const openC = spot.get(t0), m4 = spot.get(t0 + 3 * 60000); /* candle [t0+3m,t0+4m) closes at T-60s */
      if (!openC || !m4) { skip.noSpot++; continue; }
      const dir = m4.close >= openC.open ? 'UP' : 'DOWN';

      /* Polymarket price of the bet side at T-60s from CLOB history */
      const tok = dir === 'UP' ? toks[ui] : toks[di];
      const h = await jget(`${CLOB}/prices-history?market=${tok}&startTs=${sec0}&endTs=${sec0 + 300}&fidelity=1`);
      const pt = priceAt((h && h.history) || [], sec0 + 240);      /* T-60s = t0 + 4 min */
      if (!pt) { skip.noHistory++; continue; }

      const paid = pt.p;
      const won = dir === actual;
      rows.push({
        t: new Date(B).toISOString(), dir, paid: +paid.toFixed(4), priceDriftSec: pt.drift,
        actual, won, cheap: paid > 0 && paid < 0.70,
        pnl: paid > 0 && paid < 0.70 ? +( won ? 10 * (1 - paid) / paid : -10 ).toFixed(2) : 0,
        spotOpen: openC.open, spotT60: m4.close, resolvedBy: 'polymarket-outcome'
      });
    } catch (e) { skip.noHistory++; }
    if (++done % 40 === 0) { log(`${done} windows processed, ${rows.length} rows`); await sleep(80); }
    await sleep(110);
  }

  /* summary */
  const cheap = rows.filter(r => r.cheap);
  const wins = cheap.filter(r => r.won).length;
  const exp = cheap.reduce((a, r) => a + r.paid, 0);
  const va = cheap.reduce((a, r) => a + r.paid * (1 - r.paid), 0);
  const z = va > 0 ? (wins - exp) / Math.sqrt(va) : null;
  const pnl = cheap.reduce((a, r) => a + r.pnl, 0);
  const expected = HOURS * 12;
  const summary = {
    hours: HOURS, windowsExpected: expected, windowsCovered: rows.length,
    coveragePct: +(rows.length / expected * 100).toFixed(1), skip,
    allWindows: { n: rows.length, dirWins: rows.filter(r => r.won).length },
    cheapUnderdog: {
      bets: cheap.length, wins, winRate: cheap.length ? +(wins / cheap.length).toFixed(4) : null,
      marketImplied: cheap.length ? +(exp / cheap.length).toFixed(4) : null,
      zScore: z != null ? +z.toFixed(2) : null,
      pnl: +pnl.toFixed(2), staked: cheap.length * 10,
      perTen: cheap.length ? +(10 + pnl / cheap.length).toFixed(2) : null
    },
    ranAt: new Date().toISOString()
  };
  fs.writeFileSync(OUT, JSON.stringify({ summary, rows }));
  log('DONE ' + JSON.stringify(summary.cheapUnderdog));
  log(`coverage ${summary.coveragePct}% (${rows.length}/${expected}) skips=${JSON.stringify(skip)}`);
})();
