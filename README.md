# Dip Buyer — deep-dip-only cbBTC bot

A long-only dip buyer for the make.fun 24-hour BTC race
(`btc-race-24h-20261115-0828`). It trades one asset, cbBTC against USDC,
starting from 1,000 USDC of paper money.

## How it works

The bot spends most of the window in cash. It only buys after a real
washout: the price must fall hard off its recent high — 2% off the 120-bar
high, or 1.2% off the 30-bar high while under the slow EMA — and then show
a confirmed bounce above its recent low and above the previous close.
Thresholds are floored by the live round-trip cost and by current
volatility, so it never chases a dip smaller than the cost of trading it.

Once in, it manages the position three ways: a hard stop 2.5% below the
average entry; a 3% take-profit (or a trend ride — if the profit clears
the take and the trend is genuinely up, it switches to trend mode and
exits on a trailing pullback instead); and a stale-hold exit after 180
bars without progress. A circuit breaker halts new entries forever once
equity drops 12% below its peak. There is deliberately no averaging
down — the second leg is switched off, so a falling position is cut,
never fed.

## Tuned numbers

- EMAs: fast 18, slow 120; warmup 18 bars
- Deep dip 2.0% off the 120-bar high; shallow dip 1.2% off the 30-bar high
- Take profit 3.0%; base trailing pullback 0.25%; hard stop 2.5%
- Stale-hold patience 180 bars; cooldown 30 bars after an exit
- First leg 45% of equity; second leg OFF
- Trend needs a fast-over-slow gap above 0.1%, price above the fast EMA,
  a rising fast EMA and path efficiency above 0.45
- Max slippage 200 bps on every order

## Run it locally

From inside the unpacked kit directory:

```sh
node cli/makefun.mjs grade-local --kit . --bot /path/to/this/repo --driver process
```

The entrypoint is `main.ts` (Node 22, standard library only plus the
`vendor/makefun-bars.ts` shim). The bot is fully deterministic: no clock,
no randomness, no network.

## Dev-gate result

Grade-local on the dev window (kit's `grade-local`, process driver,
two executions, L1 regrade reproduced byte for byte):

- Net PnL **+10.672012 USDC** (return 0.010672012) — above the $0 dev gate
- 6 trades, win rate 0.667, max drawdown 1.467%, exposure 0.153
- Fees 1.083649 USDC; net PnL at 2x fees still +9.585115 USDC
- Guardrails met (trades ok, symbols ok, drawdown ok), 0 rejected
