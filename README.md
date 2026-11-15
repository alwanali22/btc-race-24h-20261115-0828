# Dip Buyer v3 — confirmed-recovery dip buyer

An original, long-only dip buyer for [make.fun's 24-hour BTC race](https://make.fun/bounty/btc-race-24h-20261111-0801).

## What it does

Dip Buyer v3 buys cbBTC only after a real dip **and** a real bounce. Two entry
channels on closes only: a deep dip off the rolling 120-bar high, or a smaller
dip off the 30-bar high while price sits below the slow EMA(120). A buy needs
the close to have bounced off the recent low by more than the round-trip cost /
volatility floor and to tick up versus the previous bar, so the bot never buys
a falling knife. The first leg buys 40% of equity; a second leg adds the rest
(to 95%) if the close falls a further 0.40% below the first fill. Exits bank a
modest profit (+0.70%), trail a pullback from the peak since entry, cut a hard
loss (-1.50%), or time out a stale hold after 480 minutes; a strong, orderly
uptrend can extend a winning hold behind the trailing exit. A 12% portfolio
drawdown halts new entries for the rest of the run. All thresholds are dynamic:
each is the max of its base value, a multiple of the estimated round-trip cost
(fee + slippage + price impact on the latest close depth), and a multiple of
recent volatility, so the bot tightens when the market gets expensive or choppy.

The design is inspired by the previous race's winning entry (Tideguard:
confirmed recoveries, dynamic thresholds, two horizons) and by the current
race's dev leaderboard (the top 15 are all multi-stage dip buyers trading
5–15 times; the v2 bot traded only twice). The implementation is original.

## Validation (dev window, official kit grade-local, --driver process)

| Measure | Result |
| --- | --- |
| Starting capital | 1,000 USDC |
| Net PnL after terminal flatten and costs | **+18.074164 USDC (+1.81%)** |
| Maximum marked-equity drawdown | 0.617% |
| Own filled trades | 8 (3 round trips) |
| Win rate (closed round trips) | 1.00 |
| Sharpe (per bar) | 0.035 |
| Fees | 1.899 USDC |
| Net PnL at 2x fees (fixed actions) | +16.168126 USDC |
| Average exposure | 33.0% |
| Rejected orders | 0 |
| L1 regrade | reproduced byte for byte |
| action_log_sha256 | 129b5d328f7d7ae9e9f73d1e528a19e66c5a0977a5df79c2f3cd7603573551d0 |
| result_sha256 | 61df0654183687945ac012b4419648e1a8493787b4283246a931afac42d1588c |

The offline simulator (sim3.py, in the parent directory of this repo) models
the harness exactly — fills at the next bar's open, 4 bps fee, 2 bps slippage,
constant-product impact on the fill bar's open depth, 200 bps max slippage,
final flatten — and predicted +18.08 / +16.17 at 2x fees, matching the real
grade to within 0.01 USDC. v2 graded +12.256257 on the same window, so v3
beats v2 by +5.82 USDC.

## Run

`node main.ts` under Node 22 with TypeScript stripping. Send one hello,
successive batch messages and a final done message using
agent-fun/bars-replay/v1. The bot replies with one orders message per batch,
echoing its sequence number.

MIT licensed. Paper competition only.
