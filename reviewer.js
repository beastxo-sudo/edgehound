/* =====================================================
   EDGEHOUND REVIEWER — the 2-hourly AI auditor.

   The deterministic audit.js catches known invariant
   violations. This adds JUDGMENT for the things rules
   can't anticipate: subtle logic smells, emerging
   patterns, "this number looks wrong," design issues.

   It reads the full picture (bot state, sniper lab,
   deterministic audit findings, configs) and asks Claude,
   acting as a senior engineer reviewing the system, to:
     - confirm or dismiss the deterministic findings
     - surface NEW issues the invariants don't cover
     - prioritise them and say which need a code change
     - propose a concrete, specific fix for each

   It does NOT rewrite code. Bounded, reversible fixes
   (data quarantine flags, config nudges within the
   Analyst's existing rails) it may mark for application;
   code changes are written as precise, actionable
   findings to data/review.json for a human/coding pass.
   This keeps an intelligence gate on self-modifying code.
===================================================== */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const D = path.join(__dirname, 'data');
const OUT = path.join(D, 'review.json');
const load = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return fb; } };
const log = m => console.log(new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') + ' IST  ' + m);

const SYSTEM_PROMPT = `You are a senior software engineer and quant reviewing an autonomous paper-trading system called EdgeHound, plus a research sub-experiment called the Sniper Lab (which bets a paper $10 on the direction of 5-minute Bitcoin up/down markets, 60 seconds before close, and settles against Polymarket's own resolution with exchange cross-checks).

You are given: the bot's state and performance, the sniper lab's recent samples and summary, the latest deterministic audit findings, and the current config.

Your job is a code review and data sanity review. Be skeptical and specific. Look for:
- Numbers that don't make sense (impossible returns, stats that contradict the underlying samples, win/loss that contradicts the price move).
- Logic smells (a flag that should be derived but looks hardcoded, a stat that mixes incompatible populations, a guard that's too loose or too tight).
- Emerging patterns worth acting on (an engine quietly bleeding, the bot finding candidates but never trading, a settlement source that's frequently unavailable).
- Things the deterministic audit might have missed or mis-judged.

Be honest. If everything looks healthy, say so plainly rather than inventing problems. Do NOT recommend risky changes. Prefer the smallest correct fix.

Respond ONLY with JSON, no prose, no markdown fences:
{
 "overallHealth": "healthy | minor-issues | needs-attention",
 "headline": "one-sentence summary a busy founder can read",
 "findings": [
   {
     "area": "bot | sniper | analyst | dashboard",
     "severity": "info | warn | critical",
     "title": "short title",
     "diagnosis": "what's wrong and the evidence for it",
     "fix": "the specific, concrete change to make",
     "needsCode": true,
     "confidence": "low | medium | high"
   }
 ],
 "confirmedAuditFindings": ["ids of deterministic findings you agree with"],
 "dismissedAuditFindings": [{"id":"...","why":"..."}]
}`;

function buildBriefing() {
  const state = load(path.join(D, 'state.json'), {});
  const sniper = load(path.join(D, 'sniper.json'), {});
  const audit = load(path.join(D, 'audit.json'), {});
  const config = load(path.join(__dirname, 'config.json'), {});

  const journal = (state.journal || []);
  const closed = journal.filter(t => t.status === 'closed');
  const byEngine = {};
  for (const t of closed) {
    const e = byEngine[t.signal] || { n: 0, w: 0, pnl: 0 };
    e.n++; if (t.pnl > 0) e.w++; e.pnl = Math.round((e.pnl + (t.pnl || 0)));
    byEngine[t.signal] = e;
  }
  /* sniper: send a compact, recent slice — enough to spot contradictions */
  const recentSniper = (sniper.samples || []).slice(-25).map(x => ({
    t: x.t, dir: x.dir, actual: x.actual, won: x.won,
    candleOpen: x.candleOpen, btcAtClose: x.btcAtClose,
    paid: x.paid, priceSrc: x.priceSrc, polyConfirmed: x.polyConfirmed,
    verified: x.verified, sources: (x.sources || []).map(s => s.src + ':' + s.dir)
  }));

  return {
    now: new Date().toISOString(),
    bot: {
      summary: state.summary, config, lastScan: state.lastScan,
      brain: state.brain ? { nUpdates: state.brain.nUpdates, brier: state.summary && state.summary.brier, weights: state.brain.w, bias: state.brain.b, hypotheses: state.brain.hypotheses } : null,
      enginePerformance: byEngine,
      tradeCount: journal.length
    },
    sniper: { mode: sniper.mode, summary: sniper.summary, recentSamples: recentSniper },
    deterministicAudit: audit.summary ? { summary: audit.summary, findings: (audit.findings || []).map(f => ({ id: f.id, area: f.area, severity: f.severity, msg: f.msg, autoFixed: f.autoFixed })) } : 'none yet'
  };
}

async function askClaude(briefing) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: 'Review this system and respond with your JSON verdict.\n\n' + JSON.stringify(briefing) }]
    }),
    signal: AbortSignal.timeout(90000)
  });
  if (!r.ok) throw new Error('Anthropic API ' + r.status + ': ' + (await r.text()).slice(0, 200));
  const d = await r.json();
  const text = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  return JSON.parse(text.replace(/```json|```/g, '').trim());
}

(async () => {
  fs.mkdirSync(D, { recursive: true });
  if (!process.env.ANTHROPIC_API_KEY) {
    log('No ANTHROPIC_API_KEY — reviewer dormant.');
    fs.writeFileSync(OUT, JSON.stringify({ status: 'dormant', ranAt: new Date().toISOString(), headline: 'Reviewer waiting for API key.' }, null, 2));
    return;
  }
  try {
    const briefing = buildBriefing();
    const verdict = await askClaude(briefing);
    const prev = load(OUT, { history: [] });
    const codeIssues = (verdict.findings || []).filter(f => f.needsCode);
    const report = {
      status: 'ok',
      ranAt: new Date().toISOString(),
      ranAtIST: new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') + ' IST',
      overallHealth: verdict.overallHealth,
      headline: verdict.headline,
      findings: verdict.findings || [],
      openCodeIssues: codeIssues.map(f => ({ area: f.area, title: f.title, severity: f.severity, diagnosis: f.diagnosis, fix: f.fix, confidence: f.confidence })),
      confirmedAuditFindings: verdict.confirmedAuditFindings || [],
      dismissedAuditFindings: verdict.dismissedAuditFindings || [],
      history: [
        { at: new Date().toISOString(), health: verdict.overallHealth, findings: (verdict.findings || []).length, codeIssues: codeIssues.length, headline: verdict.headline },
        ...((prev.history) || [])
      ].slice(0, 60)
    };
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
    log(`Review: ${verdict.overallHealth} — ${verdict.headline}`);
    log(`${(verdict.findings || []).length} findings, ${codeIssues.length} need code.`);
    for (const f of codeIssues) log(`  [${f.severity}] ${f.title}: ${f.fix}`);
  } catch (e) {
    log('Reviewer error: ' + e.message);
    const prev = load(OUT, {});
    fs.writeFileSync(OUT, JSON.stringify({ ...prev, status: 'error', ranAt: new Date().toISOString(), error: e.message }, null, 2));
  }
})();
