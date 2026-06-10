# EdgeHound 🐕 — Autonomous Polymarket Paper-Trading Bot

A self-managed paper-trading bot that runs **24/7 on GitHub Actions** (free) — no server,
no device, nothing kept on. Every 15 minutes it scans Polymarket, places 10–20 simulated
bets a day ($100–$1000 each), manages exits, and reweights its own signal engines based
on what actually wins. The full journal is committed to this repo, so you get a
permanent, timestamped audit trail of every decision.

**No real money ever moves.** Read-only public APIs, no keys, no wallet.

## What's in this repo

| File | Purpose |
|---|---|
| `edgehound.js` | The bot — 4 signal engines, sizing, exits, learning loop |
| `.github/workflows/edgehound.yml` | Schedule: runs the bot every 15 minutes |
| `data/state.json` | The living journal — trades, weights, P&L (auto-committed) |
| `index.html` | The EdgeBook dashboard — markets, smart money, copy signals, and a live viewer for this bot |

## Setup (≈3 minutes)

1. **Create a new public repo** on GitHub (public = unlimited free Actions minutes).
2. **Upload all files from this folder**, keeping the structure (the workflow file must be
   at `.github/workflows/edgehound.yml`).
3. Go to the repo's **Actions tab → enable workflows** if prompted, then open
   "EdgeHound paper-trading bot" → **Run workflow** to trigger the first run manually.
4. Done. It now runs every ~15 minutes forever. Watch `data/state.json` grow.

### Optional: live dashboard at a URL
Enable **Settings → Pages → Deploy from branch → main / root**. Your dashboard goes live at
`https://YOURNAME.github.io/REPONAME/` and the EdgeHound tab automatically detects and
displays the cloud journal (it reads `data/state.json` from the same repo). Markets,
smart-money leaderboard and copy signals all work there too.

You can also open `index.html` locally and paste your raw journal URL
(`https://raw.githubusercontent.com/YOURNAME/REPONAME/main/data/state.json`)
into the connect box on the bot page.

## The four signal engines

1. **Short Favorite** — 78–94¢ favorites resolving within 7 days (favorite-longshot bias:
   crowds overpay longshots, underprice near-certainties). Held to resolution.
2. **Momentum** — markets that moved ≥4 points in 24h on ≥$50K volume. Target +18%,
   stop −20%, out within 3 days.
3. **Smart Consensus** — when 2+ of the top-10 monthly-PnL wallets hold the same side
   and price is still within ~6% of their average entry.
4. **Volume Spike** — ≥25% of a market's lifetime volume traded in the last 24h
   (sudden attention), bought on the cheap side with tight stops.

## How it learns

Every settled trade updates its engine's record. Engine weight =
Laplace-smoothed win rate × a P&L tilt, clamped to 0.25×–2.2×. Weights multiply
candidate scores, so winning engines get picked more often and sized bigger;
losing engines fade toward irrelevance. Judge weights only after ~30 settled
trades per engine.

## Honest caveats

- Paper fills assume the quoted price — real trading pays spread and slippage.
- Short-favorite engines win often and lose big when favorites flip; judge on
  long-run P&L, not win rate.
- GitHub's cron can delay runs by several minutes during busy periods — harmless,
  the bot always catches up.
- This is an analytics experiment, not financial advice.
