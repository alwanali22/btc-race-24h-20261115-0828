# Dip Buyer — variant C

A deep-dip-only bot for the 24-hour cbBTC race (`btc-race-24h-20261115-0828`).

## Idea

Most bars do nothing. The bot waits for a real washout — price far below its
recent high, with a bounce already starting — then buys one leg worth 45% of
equity and manages the exit: a hard stop at −2.5%, a trailing pullback once
the rebound turns into a trend, and a patience exit when a trade goes stale.
There is no averaging down: the second-leg code is present but gated off, so
a falling knife never gets a second buy. Entries are rare by design; the bot
would rather sit in cash than chase chop.

## What differs from variant D

Variant D (already submitted) uses a 3% take-profit and a 180-bar patience
limit. Variant C changes exactly two numbers:

- take-profit: **4%** instead of 3%
- patience: **240 bars** instead of 180

Everything else — thresholds, EMA spans, volatility handling, trailing,
cooldown, halt — is identical. In simulation the wider take and longer
patience leave variant C positive on **both** dev windows (about +$6.30 on
the new window, about +$0.55 on the old one), while variant D is positive
only on the new window.

## Grade-local

Run with the kit's process driver (`node cli/makefun.mjs grade-local
--kit . --bot <workdir> --driver process`), two executions each, L1 regrade
reproduced byte for byte.

New dev window (`btc-race-24h-20261115-0828`, 1440 bars): net PnL
**+6.303071 USDC**, 6 trades, win rate 0.6667, max drawdown 0.019041,
fees 1.078726 USDC (at 2x fees +5.223073), 0 rejected, guardrails met.
action_log_sha256
`a9d8a621b115c3694c0a9d4b1717d4a60a0dc90c941a26fdd2318d513ccdf6ae`.

Old window (`btc-race-24h-20261113-2314`, sanity check): net PnL
**+0.546080 USDC**, 4 trades, win rate 0.5000, max drawdown 0.009692,
fees 0.719823 USDC (at 2x fees −0.173661), 0 rejected, guardrails met.
action_log_sha256
`75d657d94e4deca33c1f7c09880c1313390a90bea3be396941c9b3cbcd060aca`.

Dev gate (net PnL > $0 on the new window): **PASSED**. Positive on both
windows, as the simulation predicted (+$6.30 / +$0.55).
