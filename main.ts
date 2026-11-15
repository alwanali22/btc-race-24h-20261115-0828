// Dip Buyer, variant C — deep-dip-only retune for the 24-hour cbBTC race.
// Same shape as the earlier four-percent family: wait for a real washout,
// buy one leg, ride the rebound, never average down. What changes here is
// the exit patience: a four percent take-profit and a 240-bar patience
// limit, which in simulation leaves the bot positive on both dev windows
// instead of only the new one. No clock, no randomness, no network —
// every decision comes from closes, bar sequence and the replayed account.
import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

// Fixed configuration for variant C. Everything is a plain number so the
// strategy stays deterministic and easy to reason about.
const CFG = {
  fastSpan: 18,
  slowSpan: 120,
  warmupBars: 18,
  deepDip: 0.02,
  shallowDip: 0.012,
  reboundFloor: 0,
  lowWindow: 12,
  takeProfit: 0.04,
  trailBase: 0.0025,
  hardStop: 0.025,
  patience: 240,
  cooldown: 30,
  firstLeg: 0.45,
  fullSize: 0.95,
  secondLegDrop: 0.005,
  secondLegOn: false,
  trendGap: 0.001,
  pathFloor: 0.45,
  confirmVol: 1,
  maxSlipBps: 200,
};

// What one decision returns: hold, buy a dollar amount, or sell everything.
type Decision =
  | { action: 'hold' }
  | { action: 'buy'; amount: number }
  | { action: 'sell' };

// The strategy: one bot, one symbol, one position at a time.
class DipBuyer {
  closes: number[] = [];
  fastEma = 0;
  slowEma = 0;
  vol = 0.0005;
  prevClose: number | null = null;
  prevFast = 0;
  entryPrice = 0;
  entrySeq = 0;
  peakSinceEntry = 0;
  secondLegFired = false;
  lastExitSeq = -1000000000;
  mode = '';
  peakEquity = 1000;
  halted = false;
  wasHolding = false;

  private alpha(span: number): number {
    return 1 - Math.exp(-1 / span);
  }

  // Fold one bar's close into the rolling state.
  onClose(price: number): void {
    if (this.prevClose !== null && this.prevClose > 0) {
      this.vol = 0.95 * this.vol + 0.05 * Math.abs(Math.log(price / this.prevClose));
    }
    this.prevFast = this.fastEma;
    if (this.fastEma === 0) {
      this.fastEma = price;
      this.slowEma = price;
    } else {
      this.fastEma += this.alpha(CFG.fastSpan) * (price - this.fastEma);
      this.slowEma += this.alpha(CFG.slowSpan) * (price - this.slowEma);
    }
    this.prevClose = price;
    this.closes.push(price);
    if (this.closes.length > 120) this.closes.shift();
  }

  private highest(n: number): number {
    const w = this.closes.slice(-n);
    let m = -Infinity;
    for (const c of w) if (c > m) m = c;
    return m;
  }

  private lowest(n: number): number {
    const w = this.closes.slice(-n);
    let m = Infinity;
    for (const c of w) if (c < m) m = c;
    return m;
  }

  // How straight the last 60 closes run: net move over total path.
  private pathEfficiency(): number {
    const w = this.closes.slice(-60);
    if (w.length < 2) return 0;
    let path = 0;
    for (let i = 1; i < w.length; i++) {
      const a = w[i];
      const b = w[i - 1];
      if (a === undefined || b === undefined) continue;
      path += Math.abs(a - b);
    }
    if (path === 0) return 0;
    const first = w[0];
    const last = w[w.length - 1];
    if (first === undefined || last === undefined) return 0;
    return Math.abs(last - first) / path;
  }

  // An uptrend needs a wide fast-over-slow gap, price above the fast line,
  // a rising fast line, and a straight recent path.
  private isUptrend(price: number): boolean {
    const gap = (this.fastEma - this.slowEma) / this.slowEma;
    return (
      gap > CFG.trendGap &&
      price > this.fastEma &&
      this.fastEma > this.prevFast &&
      this.pathEfficiency() > CFG.pathFloor
    );
  }

  // True when a washout channel fires and the price is already bouncing.
  private entrySignal(price: number, rt: number): boolean {
    const deepThreshold = Math.max(CFG.deepDip, 1.2 * rt, 3 * this.vol);
    const shallowThreshold = Math.max(CFG.shallowDip, 1.2 * rt, 3 * this.vol);
    const high120 = this.highest(120);
    const high30 = this.highest(30);
    const deep = (high120 - price) / high120 > deepThreshold;
    const shallow = price < this.slowEma && (high30 - price) / high30 > shallowThreshold;
    if (!deep && !shallow) return false;
    const confirm = Math.max(CFG.reboundFloor, CFG.confirmVol * this.vol, 0.5 * rt);
    const low12 = this.lowest(CFG.lowWindow);
    const prevBar = this.closes.length >= 2 ? this.closes[this.closes.length - 2] : undefined;
    const prev = prevBar === undefined ? price : prevBar;
    return price > low12 * (1 + confirm) && price > prev;
  }

  // One decision per bar. Amounts are in USDC; price is USDC per unit.
  decide(seq: number, price: number, equity: number, cash: number, posValue: number, cost: number, rt: number): Decision {
    if (equity > this.peakEquity) this.peakEquity = equity;
    if (equity < 0.88 * this.peakEquity) this.halted = true;

    const holding = posValue > 1;
    if (holding && !this.wasHolding) {
      this.entrySeq = seq;
      this.peakSinceEntry = price;
      if (this.entryPrice === 0) this.entryPrice = price;
    }
    if (this.wasHolding && !holding) {
      this.lastExitSeq = seq;
      this.mode = '';
      this.entryPrice = 0;
      this.secondLegFired = false;
    }
    this.wasHolding = holding;

    if (this.closes.length < CFG.warmupBars) return { action: 'hold' };
    if (holding) return this.manage(seq, price, equity, cash, posValue, cost, rt);
    if (this.halted) return { action: 'hold' };
    if (seq - this.lastExitSeq < CFG.cooldown) return { action: 'hold' };
    if (this.entrySignal(price, rt)) {
      this.mode = 'recovery';
      return { action: 'buy', amount: CFG.firstLeg * equity };
    }
    return { action: 'hold' };
  }

  // Exit logic for a live position.
  private manage(seq: number, price: number, equity: number, cash: number, posValue: number, cost: number, rt: number): Decision {
    if (price > this.peakSinceEntry) this.peakSinceEntry = price;
    const profit = cost > 0 ? posValue / cost - 1 : 0;
    const age = seq - this.entrySeq;
    const trail = Math.max(CFG.trailBase, 4 * this.vol, 1.5 * rt);
    const trendGap = (this.fastEma - this.slowEma) / this.slowEma;
    const pullback = (this.peakSinceEntry - price) / this.peakSinceEntry;

    if (profit < -CFG.hardStop) return { action: 'sell' };
    if (profit > Math.max(CFG.takeProfit, rt) && this.isUptrend(price)) this.mode = 'trend';
    if (this.mode === 'trend') {
      if (pullback > trail && (price < this.fastEma || trendGap < 0)) return { action: 'sell' };
    } else {
      if (profit >= Math.max(CFG.takeProfit, 0.75 * rt)) return { action: 'sell' };
      if (profit > rt && pullback > trail) return { action: 'sell' };
    }
    if (age > CFG.patience && profit < rt && !this.isUptrend(price)) return { action: 'sell' };
    if (
      CFG.secondLegOn &&
      !this.secondLegFired &&
      this.entryPrice > 0 &&
      price <= this.entryPrice * (1 - CFG.secondLegDrop) &&
      cash > 1
    ) {
      const amount = Math.min(cash, CFG.fullSize * equity - posValue);
      if (amount >= 1) {
        this.secondLegFired = true;
        return { action: 'buy', amount };
      }
    }
    return { action: 'hold' };
  }
}

// The adapter: one callback per batch, at most one order per batch.
const bot = new DipBuyer();

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    const first = state.hello.symbols[0];
    if (first === undefined) return [];
    const symbol = first.symbol;
    const bar = batch.bars.find((b) => b.symbol === symbol);
    if (bar === undefined) return [];
    const closeRaw = state.close(symbol);
    if (closeRaw === null) return [];
    const meta = state.symbols.get(symbol);
    if (meta === undefined) return [];

    const priceScale = 10 ** meta.price_scale;
    const price = Number(closeRaw) / priceScale;
    const quoteUnit = 10 ** state.hello.capital.quote_scale;
    const held = state.positions.get(symbol);
    const qty = held === undefined ? 0n : held.qty;
    const posValueRaw = qty === 0n ? 0n : state.value(symbol, qty);
    const costRaw = held === undefined ? 0n : held.cost;
    const equity = Number(state.equity) / quoteUnit;
    const cash = Number(state.cash) / quoteUnit;
    const posValue = Number(posValueRaw) / quoteUnit;
    const cost = Number(costRaw) / quoteUnit;

    // Round-trip cost at a probe of 95% of equity: impact plus fees both ways.
    const probeSize = (state.equity * 950n) / 1000n;
    const impact = state.impactBps(symbol, probeSize);
    const impactFrac = impact === null ? 0 : Number(impact) / 10000;
    const rt =
      (2 * (state.hello.fees.fee_bps + state.hello.fees.slippage_bps)) / 10000 +
      2 * impactFrac;

    bot.onClose(price);

    // A real fill price beats the bar price as the entry reference.
    for (const fill of batch.fills) {
      if (fill.symbol === symbol && fill.side === 'buy' && fill.status === 'filled') {
        bot.entryPrice = Number(fill.price) / priceScale;
      }
    }

    const decision = bot.decide(batch.seq, price, equity, cash, posValue, cost, rt);
    if (decision.action === 'sell') {
      if (qty === 0n) return [];
      return [{ side: 'sell', symbol, qty: qty.toString(), max_slippage_bps: CFG.maxSlipBps }];
    }
    if (decision.action === 'buy') {
      let size = BigInt(Math.floor(decision.amount * quoteUnit));
      if (size > state.cash) size = state.cash;
      const room = state.weightRoom(symbol);
      if (size > room) size = room;
      if (size < BigInt(state.hello.fees.min_notional_quote_units)) return [];
      return [{ side: 'buy', symbol, notional_quote_units: size.toString(), max_slippage_bps: CFG.maxSlipBps }];
    }
    return [];
  },
});
