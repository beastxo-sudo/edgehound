/* ============================================================
   AUDIT.JS — the self-audit engine.

   Encodes the diagnostic patterns we used to catch bugs by hand
   into automatic invariant checks. Runs every cycle. Three tiers:

     1. INVARIANTS (deterministic): "this must always be true."
        Violations are real bugs. The safe, reversible ones
        (corrupt data) are auto-quarantined; the rest are flagged.
     2. HEALTH SIGNALS (heuristic): patterns that USUALLY mean a
        problem (e.g. candidates exist but none ever clear ->
        possible deadlock; an engine deeply negative -> review).
     3. FINDINGS: written to data/audit.json with severity, a
        plain diagnosis, and whether it was auto-fixed or needs code.

   Nothing here rewrites code. It fixes data and flags everything,
   so a human (or a higher-reasoning pass) handles code changes.
   ============================================================ */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'data');
const STATE = path.join(DIR, 'state.json');
const SNIPER = path.join(DIR, 'sniper.json');
const OUT = path.join(DIR, 'audit.json');

const ist = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().replace('T', ' ').slice(0, 19) + ' IST';
const load = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } };
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

/* a finding: {area, id, severity (info|warn|critical), msg, autoFixed, needsCode} */
function audit() {
  const findings = [];
  const add = (f) => findings.push({ ...f, at: new Date().toISOString() });

  const state = load(STATE);
  const sniper = load(SNIPER);
  let stateChanged = false, sniperChanged = false;

  /* ===================== SNIPER INVARIANTS ===================== */
  if (sniper && Array.isArray(sniper.samples)) {
    let quarantined = 0, wonFlagWrong = 0, moveContradiction = 0, impossiblePayout = 0, badPrice = 0;
    for (const x of sniper.samples) {
      if (x.actual == null) continue;

      /* INVARIANT 1: won must equal (dir === actual). */
      const expectWon = x.dir === x.actual;
      if (x.won !== expectWon) {
        wonFlagWrong++;
        x.won = expectWon;            /* deterministic, safe to correct */
        x._audit = 'won flag corrected to match dir vs actual';
        sniperChanged = true;
      }

      /* INVARIANT 2: the outcome (actual) must match the candle open->close
         move, when we have both prices. This is the exact bug class the user
         caught — a DOWN candle resolving as an UP win. */
      if (x.candleOpen != null && x.btcAtClose != null && x.candleOpen !== x.btcAtClose) {
        const moveUp = x.btcAtClose > x.candleOpen;
        const moveDir = moveUp ? 'UP' : 'DOWN';
        /* Only trust this check to OVERRIDE when the sample is NOT
           Polymarket-confirmed. Polymarket is the real payout source and may
           legitimately differ from a raw Binance candle on a knife-edge; in
           that case we flag the disagreement rather than "correcting" it. */
        if (x.actual !== moveDir) {
          if (x.polyConfirmed) {
            add({ area: 'sniper', id: 'poly_vs_candle', severity: 'warn',
              msg: `Sample ${x.t}: Polymarket resolved ${x.actual} but the Binance candle moved ${moveDir} (open ${x.candleOpen} -> close ${x.btcAtClose}). Kept Polymarket (it pays the bet) but flagging the divergence.`,
              autoFixed: false, needsCode: false });
          } else {
            moveContradiction++;
            x.actual = moveDir;
            x.won = x.dir === moveDir;
            x._audit = `actual corrected to candle move ${moveDir}`;
            sniperChanged = true;
          }
        }
      }

      /* INVARIANT 3: a counted, priced sample can't have an impossible payout.
         paid below ~0.02 implies a 50x+ return — almost certainly wrong-token
         or a market mid-resolution. Quarantine the price. */
      if (x.paid > 0 && x.paid < 0.02) {
        impossiblePayout++;
        x.paid = 0; x.priceSrc = null;
        x._audit = 'implausible sub-2c price quarantined';
        sniperChanged = true;
      }

      /* INVARIANT 4: any priced sample must have price in (0,1). */
      if (x.paid != null && (x.paid < 0 || x.paid >= 1)) {
        badPrice++;
        x.paid = 0; x.priceSrc = null;
        x._audit = 'out-of-range price quarantined';
        sniperChanged = true;
      }

      /* INVARIANT 5: a "verified" sample must actually have backing —
         Polymarket confirmation OR 2+ agreeing exchange sources. */
      if (x.verified === true && !x.polyConfirmed) {
        const exch = (x.sources || []).filter(sv => sv.src !== 'polymarket' && sv.dir !== 'TIE');
        const agree = exch.length >= 2 && exch.every(sv => sv.dir === exch[0].dir);
        if (!agree) {
          x.verified = false;
          x._audit = 'verified flag cleared (insufficient agreeing sources)';
          quarantined++;
          sniperChanged = true;
        }
      }
    }

    if (wonFlagWrong) add({ area: 'sniper', id: 'won_flag', severity: 'critical',
      msg: `${wonFlagWrong} bet(s) had a won flag that didn't match dir vs actual — auto-corrected.`, autoFixed: true, needsCode: true });
    if (moveContradiction) add({ area: 'sniper', id: 'move_contradiction', severity: 'critical',
      msg: `${moveContradiction} bet(s) resolved against the actual candle move (e.g. DOWN candle scored as UP win) — auto-corrected from open->close. If this recurs, the settlement source logic needs a code fix.`, autoFixed: true, needsCode: true });
    if (impossiblePayout) add({ area: 'sniper', id: 'impossible_payout', severity: 'critical',
      msg: `${impossiblePayout} bet(s) had an impossible sub-2¢ price (fake 50x+ payout) — quarantined.`, autoFixed: true, needsCode: true });
    if (badPrice) add({ area: 'sniper', id: 'bad_price', severity: 'warn',
      msg: `${badPrice} bet(s) had out-of-range prices — quarantined.`, autoFixed: true, needsCode: false });
    if (quarantined) add({ area: 'sniper', id: 'unbacked_verified', severity: 'warn',
      msg: `${quarantined} bet(s) were marked verified without enough agreeing sources — unmarked.`, autoFixed: true, needsCode: false });

    /* HEALTH: is the lab even collecting? */
    const settled = sniper.samples.filter(x => x.actual != null);
    const ageMin = sniper.summary && sniper.summary.updated ? (Date.now() - new Date(sniper.summary.updated).getTime()) / 60000 : 999;
    if (settled.length === 0 && ageMin > 60) add({ area: 'sniper', id: 'no_samples', severity: 'warn',
      msg: `Sniper lab has 0 settled samples and data is ${round(ageMin, 0)} min old — the job may be failing or missing every boundary.`, autoFixed: false, needsCode: true });

    /* HEALTH: are samples ever reaching Polymarket confirmation? */
    if (settled.length >= 20) {
      const polyShare = settled.filter(x => x.polyConfirmed).length / settled.length;
      if (polyShare < 0.3) add({ area: 'sniper', id: 'low_poly_confirm', severity: 'info',
        msg: `Only ${round(polyShare * 100, 0)}% of bets reached Polymarket confirmation — most rely on exchange cross-check. The upgrade pass may not be catching up; consider widening its window.`, autoFixed: false, needsCode: true });
    }

    if (sniperChanged) {
      /* recompute the summary the same way sniper.js does, so stats reflect fixes */
      recomputeSniper(sniper);
    }
  } else {
    add({ area: 'sniper', id: 'missing', severity: 'info', msg: 'No sniper data file to audit yet.', autoFixed: false, needsCode: false });
  }

  /* Bot decommissioned 2026-07 — audit now covers the sniper lab only. */

  /* ===================== WRITE FINDINGS ===================== */
  const prev = load(OUT) || { history: [] };
  const critical = findings.filter(f => f.severity === 'critical').length;
  const warn = findings.filter(f => f.severity === 'warn').length;
  const autoFixed = findings.filter(f => f.autoFixed).length;
  const needsCode = findings.filter(f => f.needsCode && !f.autoFixed);

  const report = {
    ranAt: new Date().toISOString(),
    ranAtIST: ist(),
    summary: { total: findings.length, critical, warn, autoFixed, needsCodeReview: needsCode.length },
    findings,
    openCodeIssues: needsCode.map(f => ({ area: f.area, id: f.id, severity: f.severity, msg: f.msg })),
    history: [
      { at: new Date().toISOString(), critical, warn, autoFixed, total: findings.length },
      ...(prev.history || [])
    ].slice(0, 100)
  };

  if (sniperChanged && sniper) fs.writeFileSync(SNIPER, JSON.stringify(sniper));
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));

  console.log(`${ist()}  Audit: ${findings.length} findings (${critical} critical, ${warn} warn) · ${autoFixed} auto-fixed · ${needsCode.length} need code review`);
  for (const f of findings) console.log(`  [${f.severity}] ${f.area}/${f.id}: ${f.msg}`);
  return report;
}

/* recompute sniper summary exactly like sniper.js summarize() so audited
   fixes propagate into the headline stats. Kept in sync deliberately. */
function recomputeSniper(lab) {
  const s = lab.samples.filter(x => x.verified === true && x.actual != null);
  const excluded = lab.samples.filter(x => x.actual != null && x.verified !== true).length;
  const correct = s.filter(x => x.won);
  const withPx = s.filter(x => x.paid > 0);
  const pnl = withPx.reduce((a, x) => a + (x.won ? 10 * (1 - x.paid) / x.paid : -10), 0);
  const avgPaid = withPx.length ? withPx.reduce((a, x) => a + x.paid, 0) / withPx.length : null;
  const decided = withPx.filter(x => x.priceSrc === 'clob');
  const dPnl = decided.reduce((a, x) => a + (x.won ? 10 * (1 - x.paid) / x.paid : -10), 0);
  const dAvg = decided.length ? decided.reduce((a, x) => a + x.paid, 0) / decided.length : null;
  const roll = (n) => {
    const last = decided.slice(-n);
    const invested = last.length * 10;
    const returned = last.reduce((a, x) => a + (x.won ? 10 / x.paid : 0), 0);
    return { trades: last.length, invested: round(invested), returned: round(returned), profit: round(returned - invested), returnPct: invested ? round((returned - invested) / invested * 100, 1) : null, wins: last.filter(x => x.won).length };
  };
  lab.summary = {
    ...lab.summary,
    samples: s.length, excludedUnverified: excluded, pricedSamples: withPx.length,
    directionAccuracy: s.length ? round(correct.length / s.length, 4) : null,
    avgPricePaid: avgPaid ? round(avgPaid, 4) : null,
    decidedSamples: decided.length,
    decidedAccuracy: decided.length ? round(decided.filter(x => x.won).length / decided.length, 4) : null,
    decidedAvgPaid: dAvg ? round(dAvg, 4) : null,
    decidedEvPerTrade: decided.length ? round(dPnl / decided.length, 3) : null,
    perTenDollar: decided.length ? round(10 + dPnl / decided.length, 2) : null,
    last50: roll(50), allTime: roll(100000),
    auditedAt: new Date().toISOString()
  };
}

if (require.main === module) audit();
module.exports = { audit };
