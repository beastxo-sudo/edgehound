/* ============================================================
   IMBALANCE LAB — tests the order-book-leads-price hypothesis.

   The claim (from the viral thread): when order-book depth shifts
   heavily to one side while price stays flat, price follows a few
   SECONDS later. "Bots see liquidity, retail sees price."

   We test it honestly. Many times across the live BTC up/down
   market, we:
     t0: snapshot the L2 book -> imbalance = bidDepth / (bid+ask)
         record the mid price and the spread
     t1 (t0 + LAG): record the new mid
     -> did price move the way the imbalance predicted?

   Then we judge it against THREE bars, because a hit-rate alone
   is meaningless:
     1. Hit rate when imbalance is lopsided (>0.65 or <0.35).
     2. Baseline: hit rate when the book is balanced (~0.5). If the
        signal isn't better than the balanced baseline, it's noise.
     3. Tradeable: was the predicted move bigger than the spread you
        must cross to enter and exit? A 0.3c lead under a 1c spread
        is real but untradeable.

   Honesty guards built in:
     - imbalance can be SPOOFED (walls pulled before fill). We only
       claim it PREDICTS, never that it's genuine intent.
     - moves smaller than the spread are flagged untradeable.
     - probes with a stale/empty book are excluded, not guessed.

   Paper only. No orders placed.
   ============================================================ */
const fs = require('fs');
const path = require('path');

const CLOB = 'https://clob.polymarket.com';
const GAMMA = 'https://gamma-api.polymarket.com';
const OUT_FILE = path.join(__dirname, 'data', 'imbalance.json');

const DURATION_MS = Number(process.env.IMB_DURATION_MS || 13.5 * 60e3);
const LAG_MS = Number(process.env.IMB_LAG_MS || 8000);   /* how long we wait to see if price follows */
const PROBE_EVERY_MS = 20000;                            /* a fresh probe every 20s */
const LOPSIDED = 0.65;                                   /* imbalance threshold for a "signal" */

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (m) => console.log(new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 19).replace('T', ' ') + ' IST  ' + m);
const round = (n, d = 4) => n == null ? null : Math.round(n * 10 ** d) / 10 ** d;

async function jget(url, ms = 6000) {
  const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

function loadLab() {
  try { return JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')); } catch (e) {}
  return { hypothesis: 'Order-book imbalance leads price by seconds on BTC up/down', mode: 'imbalance', created: Date.now(), probes: [], summary: {} };
}

/* find the live BTC up/down market and its UP token (we measure that book).
   Uses the SAME proven slug-first lookup the sniper uses (the title-regex
   fallback alone was unreliable and left the lab with 0 probes). */
async function findUpToken(B) {
  let ev = null;
  for (const sec of [B / 1000 - 300, B / 1000]) {
    try {
      const r = await jget(`${GAMMA}/events?slug=btc-updown-5m-${sec}`, 5000);
      if (Array.isArray(r) && r[0] && r[0].markets) { ev = r[0]; break; }
    } catch (e) {}
  }
  if (!ev) {
    try {
      const evs = await jget(`${GAMMA}/events?closed=false&active=true&order=endDate&ascending=true&limit=100`);
      ev = (evs || []).find(e => /bitcoin up or down/i.test(e.title || '') && Math.abs(new Date(e.endDate || 0).getTime() - B) < 15000)
        || (evs || []).find(e => /bitcoin up or down/i.test(e.title || ''));
    } catch (e) {}
  }
  if (!ev || !ev.markets || !ev.markets[0]) return null;
  const m = ev.markets[0];
  let outs = [], tokens = [];
  try { outs = JSON.parse(m.outcomes || '[]'); } catch (e) {}
  try { tokens = JSON.parse(m.clobTokenIds || '[]'); } catch (e) {}
  const ui = outs.findIndex(o => /up/i.test(o));
  return { token: tokens[ui] || tokens[0] || null, title: ev.title, marketId: m.id, endDate: ev.endDate };
}

/* snapshot the L2 book -> total depth each side, mid, spread, imbalance */
async function snapshot(token) {
  const b = await jget(`${CLOB}/book?token_id=${token}`, 5000);
  const bids = (b.bids || []).map(x => ({ p: +x.price, s: +x.size })).filter(x => x.p > 0 && x.s > 0);
  const asks = (b.asks || []).map(x => ({ p: +x.price, s: +x.size })).filter(x => x.p > 0 && x.s > 0);
  if (!bids.length || !asks.length) return null;
  const bestBid = Math.max(...bids.map(x => x.p));
  const bestAsk = Math.min(...asks.map(x => x.p));
  if (!(bestAsk > bestBid)) return null;                  /* crossed/locked book -> skip */
  const mid = (bestBid + bestAsk) / 2;
  const spread = bestAsk - bestBid;
  /* depth within 5c of the touch — the liquidity that actually matters near-term */
  const NEAR = 0.05;
  const bidDepth = bids.filter(x => x.p >= bestBid - NEAR).reduce((a, x) => a + x.s, 0);
  const askDepth = asks.filter(x => x.p <= bestAsk + NEAR).reduce((a, x) => a + x.s, 0);
  const imbalance = bidDepth / (bidDepth + askDepth);     /* 1 = all bids (UP pressure), 0 = all asks */
  return { mid, spread, bestBid, bestAsk, bidDepth, askDepth, imbalance };
}

async function probe(token, lab, diag) {
  let s0;
  try { s0 = await snapshot(token); } catch (e) { if (diag) diag.bookFail++; return; }
  if (!s0) { if (diag) diag.emptyBook++; return; }

  await sleep(LAG_MS);

  let s1;
  try { s1 = await snapshot(token); } catch (e) { if (diag) diag.bookFail++; return; }
  if (!s1) { if (diag) diag.emptyBook++; return; }
  if (diag) diag.ok++;

  const move = s1.mid - s0.mid;                            /* price change over the lag */
  const predUp = s0.imbalance >= 0.5;                      /* book-implied direction */
  const lopsided = s0.imbalance >= LOPSIDED || s0.imbalance <= (1 - LOPSIDED);
  const moved = Math.abs(move) > 1e-9;
  /* did price follow the imbalance? only meaningful if it actually moved */
  const followed = moved ? ((move > 0) === predUp) : null;
  /* tradeable: was the move bigger than the spread you'd cross? */
  const tradeable = moved ? Math.abs(move) > s0.spread : false;

  lab.probes.push({
    t: new Date().toISOString(),
    imbalance: round(s0.imbalance, 4),
    lopsided,
    mid0: round(s0.mid, 4), mid1: round(s1.mid, 4),
    move: round(move, 5),
    spread: round(s0.spread, 4),
    bidDepth: Math.round(s0.bidDepth), askDepth: Math.round(s0.askDepth),
    predUp, moved, followed, tradeable,
    lagMs: LAG_MS
  });
  lab.probes = lab.probes.slice(-5000);
  log(`probe imb=${(s0.imbalance * 100).toFixed(0)}% spread=${(s0.spread * 100).toFixed(1)}c move=${(move * 100).toFixed(2)}c ${followed == null ? '(flat)' : followed ? 'FOLLOWED' : 'against'}${lopsided ? ' [lopsided]' : ''}${tradeable ? ' [tradeable]' : ''}`);
}

function summarize(lab, diag) {
  const P = lab.probes.filter(p => p.followed != null);       /* only probes where price actually moved */
  const lop = P.filter(p => p.lopsided);                       /* the signal: lopsided book */
  const bal = P.filter(p => !p.lopsided);                      /* the baseline: balanced book */
  const hit = (arr) => arr.length ? arr.filter(p => p.followed).length / arr.length : null;

  const lopHit = hit(lop), balHit = hit(bal);
  /* tradeable subset: lopsided AND the move cleared the spread */
  const tr = lop.filter(p => p.tradeable);
  const trHit = hit(tr);
  /* edge over baseline: does a lopsided book predict better than a balanced one? */
  const edgePts = (lopHit != null && balHit != null) ? (lopHit - balHit) * 100 : null;

  lab.summary = {
    totalProbes: lab.probes.length,
    movedProbes: P.length,
    lopsidedProbes: lop.length,
    lopsidedHitRate: lopHit != null ? round(lopHit, 4) : null,
    balancedHitRate: balHit != null ? round(balHit, 4) : null,
    edgeVsBaselinePts: edgePts != null ? round(edgePts, 1) : null,
    tradeableProbes: tr.length,
    tradeableHitRate: trHit != null ? round(trHit, 4) : null,
    avgSpread: P.length ? round(P.reduce((a, p) => a + p.spread, 0) / P.length, 4) : null,
    avgAbsMove: P.length ? round(P.reduce((a, p) => a + Math.abs(p.move), 0) / P.length, 5) : null,
    lagSeconds: LAG_MS / 1000,
    diag: diag || lab.summary?.diag || null,
    updated: new Date().toISOString()
  };
}

(async () => {
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  const lab = loadLab();
  const endAt = Date.now() + DURATION_MS;
  log(`Imbalance Lab alive ${(DURATION_MS / 60000).toFixed(1)} min. Probes so far: ${lab.probes.length}.`);

  const diag = { attempts: 0, noMarket: 0, noToken: 0, bookFail: 0, emptyBook: 0, ok: 0 };
  let token = null, tokenAt = 0;
  while (Date.now() < endAt - LAG_MS) {
    if (!token || Date.now() - tokenAt > 300000) {
      const B = (Math.floor(Date.now() / 300000) + 1) * 300000;
      const m = await findUpToken(B);
      if (m && m.token) { token = m.token; tokenAt = Date.now(); log(`market: ${m.title} token ${String(m.token).slice(0, 10)}…`); }
      else { diag.noMarket++; log('no BTC up/down market found, retrying'); await sleep(15000); continue; }
    }
    diag.attempts++;
    await probe(token, lab, diag);
    summarize(lab, diag);
    fs.writeFileSync(OUT_FILE, JSON.stringify(lab));
    await sleep(Math.max(0, PROBE_EVERY_MS - LAG_MS));
  }
  summarize(lab, diag);
  fs.writeFileSync(OUT_FILE, JSON.stringify(lab));
  log(`Lab run done. probes=${lab.probes.length} diag=${JSON.stringify(diag)}`);
})();
