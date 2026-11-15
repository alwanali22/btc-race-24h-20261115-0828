// Dip Buyer — deep-dip-only retune for the 24-hour cbBTC race.
//
// The idea is patience: sit in cash through the chop and only buy after a
// genuine washout, when the price has fallen hard off its high and then
// started to bounce. Entries are rare by design — a handful of trades per
// day at most — and there is deliberately no averaging down: the second leg
// is switched off, so a position that keeps falling is cut by the hard stop
// instead of being fed more cash. Winners are ridden while the trend holds
// and exited on a trailing pullback; stale holds are closed when the clock
// runs out on them. Everything is deterministic: the only inputs are the
// closes, the bar sequence and the account the harness reports.

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

/** One bar's worth of market state, as the strategy sees it (all in USDC). */
export interface Observation {
  barIndex: number;
  price: number;
  equity: number;
  cash: number;
  value: number;
  cost: number;
  roundTrip: number;
}

/** What the strategy wants to do on this bar. */
export type Decision =
  | { kind: 'buy'; leg: 1 | 2; amount: number }
  | { kind: 'sell' }
  | { kind: 'hold' };

/** Tuned constants for the deep-dip retune. */
const CFG = {
  fastSpan: 18,
  slowSpan: 120,
  warmupBars: 18,
  deepDip: 0.02,
  shallowDip: 0.012,
  recentLowWindow: 12,
  baseRebound: 0,
  takeProfit: 0.03,
  baseTrail: 0.0025,
  hardStop: 0.025,
  patienceBars: 180,
  cooldownBars: 30,
  firstLegShare: 0.45,
  totalShare: 0.95,
  secondLegDrop: 0.005,
  secondLegOn: false,
  trendGapFloor: 0.001,
  pathEffFloor: 0.45,
  bounceVolMult: 1.0,
  maxSlippageBps: 200,
} as const;

/** Long-only dip buyer: buys washouts, rides trends, cuts losers, never averages down. */
export class DipBuyer {
  closes: number[] = [];
  fastEma = 0;
  slowEma = 0;
  vol = 0.0005;
  prevPrice = 0;
  prevFastEma = 0;
  entryPrice = 0;
  entryBar = -1;
  peakSinceEntry = 0;
  secondLegTaken = false;
  lastExitBar = -1e15;
  mode = '';
  peakEquity = 1000;
  halted = false;
  wasHolding = false;

  /** Fold one bar's close into the indicators, in order. */
  fold(price: number): void {
    if (this.prevPrice > 0) {
      this.vol = 0.95 * this.vol + 0.05 * Math.abs(Math.log(price / this.prevPrice));
    }
    this.prevFastEma = this.fastEma;
    if (this.fastEma === 0) {
      this.fastEma = price;
      this.slowEma = price;
    } else {
      this.fastEma += (1 - Math.exp(-1 / CFG.fastSpan)) * (price - this.fastEma);
      this.slowEma += (1 - Math.exp(-1 / CFG.slowSpan)) * (price - this.slowEma);
    }
    this.prevPrice = price;
    this.closes.push(price);
    if (this.closes.length > 120) this.closes.shift();
  }

  /** Highest close over the last n closes. */
  highest(n: number): number {
    return Math.max(...this.closes.slice(-n));
  }

  /** Lowest close over the last n closes. */
  lowest(n: number): number {
    return Math.min(...this.closes.slice(-n));
  }

  /** Path efficiency over the last 60 closes: net move over total path length. */
  pathEfficiency(): number {
    const window = this.closes.slice(-60);
    if (window.length < 2) return 0;
    let path = 0;
    let prev = window[0];
    for (let i = 1; i < window.length; i++) {
      const cur = window[i];
      path += Math.abs(cur - prev);
      prev = cur;
    }
    if (path === 0) return 0;
    return Math.abs(window[window.length - 1] - window[0]) / path;
  }

  /** Uptrend: fast EMA clearly above slow, price above fast, fast rising, efficient path. */
  isUptrend(price: number): boolean {
    const gap = this.fastEma / this.slowEma - 1;
    return (
      gap > CFG.trendGapFloor &&
      price > this.fastEma &&
      this.fastEma > this.prevFastEma &&
      this.pathEfficiency() > CFG.pathEffFloor
    );
  }

  /** Entry signal, flat only: a deep or shallow dip plus a confirmed bounce. */
  entrySignal(price: number, roundTrip: number): boolean {
    const deepFloor = Math.max(CFG.deepDip, roundTrip * 1.2, 3 * this.vol);
    const shallowFloor = Math.max(CFG.shallowDip, roundTrip * 1.2, 3 * this.vol);
    const deep = price < this.highest(120) * (1 - deepFloor);
    const shallow = price < this.slowEma && price < this.highest(30) * (1 - shallowFloor);
    if (!deep && !shallow) return false;
    const confirm = Math.max(CFG.baseRebound, CFG.bounceVolMult * this.vol, 0.5 * roundTrip);
    const recentLow = this.lowest(CFG.recentLowWindow);
    const prevClose = this.closes[this.closes.length - 2];
    return price > recentLow * (1 + confirm) && price > prevClose;
  }

  /** One bar's decision. */
  decide(obs: Observation): Decision {
    if (obs.equity > this.peakEquity) this.peakEquity = obs.equity;
    if (obs.equity < 0.88 * this.peakEquity) this.halted = true;
    const holding = obs.value > 1;
    if (holding && !this.wasHolding) {
      this.entryBar = obs.barIndex;
      this.peakSinceEntry = obs.price;
      if (this.entryPrice === 0) this.entryPrice = obs.price;
    }
    if (!holding && this.wasHolding) {
      this.lastExitBar = obs.barIndex;
      this.mode = '';
      this.entryPrice = 0;
      this.secondLegTaken = false;
    }
    this.wasHolding = holding;
    if (this.closes.length < CFG.warmupBars) return { kind: 'hold' };
    if (holding) return this.managePosition(obs);
    if (this.halted) return { kind: 'hold' };
    if (obs.barIndex - this.lastExitBar < CFG.cooldownBars) return { kind: 'hold' };
    if (this.entrySignal(obs.price, obs.roundTrip)) {
      this.mode = 'recovery';
      return { kind: 'buy', leg: 1, amount: CFG.firstLegShare * obs.equity };
    }
    return { kind: 'hold' };
  }

  /** Position management, holding only. */
  managePosition(obs: Observation): Decision {
    if (obs.price > this.peakSinceEntry) this.peakSinceEntry = obs.price;
    const profit = obs.cost > 0 ? obs.value / obs.cost - 1 : 0;
    const age = obs.barIndex - this.entryBar;
    const trail = Math.max(CFG.baseTrail, 4 * this.vol, 1.5 * obs.roundTrip);
    const gap = this.fastEma / this.slowEma - 1;
    const pullback = (this.peakSinceEntry - obs.price) / this.peakSinceEntry;
    if (profit < -CFG.hardStop) return { kind: 'sell' };
    if (profit > Math.max(CFG.takeProfit, obs.roundTrip) && this.isUptrend(obs.price)) {
      this.mode = 'trend';
    }
    if (this.mode === 'trend') {
      if (pullback > trail && (obs.price < this.fastEma || gap < 0)) return { kind: 'sell' };
    } else {
      if (profit >= Math.max(CFG.takeProfit, 0.75 * obs.roundTrip)) return { kind: 'sell' };
      if (profit > obs.roundTrip && pullback > trail) return { kind: 'sell' };
    }
    if (age > CFG.patienceBars && profit < obs.roundTrip && !this.isUptrend(obs.price)) {
      return { kind: 'sell' };
    }
    if (
      CFG.secondLegOn &&
      !this.secondLegTaken &&
      obs.price < this.entryPrice * (1 - CFG.secondLegDrop) &&
      obs.cash > 0
    ) {
      const amount = Math.min(obs.cash, CFG.totalShare * obs.equity - obs.value);
      if (amount >= 1) {
        this.secondLegTaken = true;
        return { kind: 'buy', leg: 2, amount };
      }
    }
    return { kind: 'hold' };
  }
}


// ---------------------------------------------------------------- adapter

const buyer = new DipBuyer();

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    const symbol = state.hello.symbols[0]?.symbol;
    if (symbol === undefined) return [];
    const bar = batch.bars.find((b) => b.symbol === symbol);
    if (bar === undefined || bar.c === null || bar.c === undefined) return [];
    const meta = state.symbols.get(symbol);
    if (meta === undefined) return [];
    const { fees } = state.hello;
    const quoteUnit = 10 ** state.hello.capital.quote_scale;
    const price = Number(bar.c) / 10 ** meta.price_scale;
    const pos = state.positions.get(symbol);
    const qty = pos?.qty ?? 0n;
    const value = Number(state.value(symbol, qty)) / quoteUnit;
    const cost = Number(pos?.cost ?? 0n) / quoteUnit;
    const equity = Number(state.equity) / quoteUnit;
    const cash = Number(state.cash) / quoteUnit;
    const probeSize = (state.equity * 950n) / 1000n;
    const impactBps = state.impactBps(symbol, probeSize) ?? 0n;
    const roundTrip =
      (2 * (fees.fee_bps + fees.slippage_bps)) / 10000 + (2 * Number(impactBps)) / 10000;
    buyer.fold(price);
    for (const fill of batch.fills) {
      if (fill.side === 'buy' && fill.status === 'filled') {
        buyer.entryPrice = Number(fill.price) / 10 ** meta.price_scale;
      }
    }
    const decision = buyer.decide({
      barIndex: state.seq,
      price,
      equity,
      cash,
      value,
      cost,
      roundTrip,
    });
    if (decision.kind === 'sell') {
      if (qty === 0n) return [];
      return [{ side: 'sell', symbol, qty, max_slippage_bps: CFG.maxSlippageBps }];
    }
    if (decision.kind === 'buy') {
      let notional = BigInt(Math.floor(decision.amount * quoteUnit));
      if (notional > state.cash) notional = state.cash;
      const room = state.weightRoom(symbol);
      if (notional > room) notional = room;
      if (notional < BigInt(fees.min_notional_quote_units)) return [];
      return [{ side: 'buy', symbol, notional_quote_units: notional, max_slippage_bps: CFG.maxSlippageBps }];
    }
    return [];
  },
});
