import type { CandleTimeframe, StrategySpec } from "../strategy/spec.js";
import { type EngineEvent, type SimTrade, type SkipReason, StrategyEngine } from "./engine.js";
import { type Bar, computeIndicators } from "./indicators.js";
import type { FeeModel, MarketModel } from "./model.js";

export const TIMEFRAME_BAR_MS: Record<CandleTimeframe, number> = {
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
};

export class NeedsFundingHistoryError extends Error {
  constructor() {
    super(
      "This strategy uses the funding rate, and historical funding isn't available to backtest against yet. Run it in paper mode instead.",
    );
  }
}

export interface BacktestOptions {
  market: MarketModel;
  fees: FeeModel;
  startEquity: number;
  /** Candle open time (ms) of the first candle that may trade; earlier candles only warm up indicators. */
  from?: number;
  /** Which price the candles are built from, for the report. */
  priceType: "mark" | "last";
  /** What the caller asked for, to report coverage honestly. */
  requested?: { from: number; to: number };
  maxCurvePoints?: number;
}

export interface BacktestStats {
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  netPnl: number;
  returnPct: number;
  maxDrawdownPct: number;
  profitFactor: number | null;
  expectancy: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  avgHoldBars: number | null;
  totalFees: number;
  liquidations: number;
  longestLosingStreak: number;
  exposurePct: number;
  /** mean / stdev of per-trade returns on margin; null under 2 trades. */
  consistency: number | null;
  bestTrade: number | null;
  worstTrade: number | null;
  /** What simply holding the market over the same candles would have returned, percent. */
  buyAndHoldPct: number | null;
}

export interface BacktestResult {
  stats: BacktestStats;
  startEquity: number;
  endEquity: number;
  equityCurve: Array<{ t: number; equity: number }>;
  trades: SimTrade[];
  liquidations: SimTrade[];
  halted: string | null;
  skipped: Partial<Record<SkipReason, number>>;
  coverage: {
    bars: number;
    from: number | null;
    to: number | null;
    missingBars: number;
    warmupBars: number;
  };
  assumptions: {
    priceType: string;
    takerRate: number;
    builderBps: number;
    slippageBps: number;
    startEquity: number;
    fillModel: string;
  };
  warnings: string[];
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
function stdev(xs: number[]) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

function downsample<T>(xs: T[], max: number): T[] {
  if (xs.length <= max) return xs;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(xs[Math.round((i * (xs.length - 1)) / (max - 1))] as T);
  return out;
}

/**
 * Replays a spec over historical candles with Strike's fee, margin-tier and liquidation rules.
 * Deterministic: the same spec, candles and options always give the same result.
 */
export function runBacktest(
  spec: StrategySpec,
  bars: Bar[],
  opts: BacktestOptions,
): BacktestResult {
  if (spec.indicators.some((i) => i.type === "funding_rate")) throw new NeedsFundingHistoryError();

  const ind = computeIndicators(spec.indicators, bars);
  const engine = new StrategyEngine(
    { spec, market: opts.market, fees: opts.fees },
    undefined,
    opts.startEquity,
  );
  const start = Math.max(
    0,
    opts.from === undefined ? 0 : bars.findIndex((b) => b.t >= (opts.from as number)),
  );
  const first = opts.from !== undefined && start === -1 ? bars.length : start;

  const trades: SimTrade[] = [];
  const skipped: Partial<Record<SkipReason, number>> = {};
  const curve: Array<{ t: number; equity: number }> = [];
  let inPosition = 0;
  const take = (ev: EngineEvent[]) => {
    for (const e of ev) {
      if (e.type === "trade") trades.push(e.trade);
      else if (e.type === "skip") skipped[e.reason] = (skipped[e.reason] ?? 0) + 1;
    }
  };

  for (let i = first; i < bars.length; i++) {
    const bar = bars[i] as Bar;
    take(engine.step(bars, ind, i));
    if (engine.state.position) inPosition++;
    curve.push({ t: bar.t, equity: engine.markToMarket(bar.c) });
  }
  const last = bars[bars.length - 1];
  let endedOpen = false;
  if (last && engine.state.position) {
    endedOpen = true;
    take(engine.flatten(last.c, last.t, "end_of_data"));
    curve.push({ t: last.t, equity: engine.state.equity });
  }

  const tested = bars.slice(first);
  const wins = trades.filter((t) => t.netPnl > 0);
  const losses = trades.filter((t) => t.netPnl < 0);
  const grossWin = wins.reduce((a, t) => a + t.netPnl, 0);
  const grossLoss = losses.reduce((a, t) => a - t.netPnl, 0);
  let peak = opts.startEquity;
  let maxDd = 0;
  for (const p of curve) {
    peak = Math.max(peak, p.equity);
    maxDd = Math.max(maxDd, peak > 0 ? (peak - p.equity) / peak : 0);
  }
  let streak = 0;
  let longest = 0;
  for (const t of trades) {
    streak = t.netPnl < 0 ? streak + 1 : 0;
    longest = Math.max(longest, streak);
  }
  const endEquity = engine.state.equity;
  const rets = trades.map((t) => t.returnPct);
  const sd = stdev(rets);
  const stats: BacktestStats = {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? wins.length / trades.length : null,
    netPnl: endEquity - opts.startEquity,
    returnPct: ((endEquity - opts.startEquity) / opts.startEquity) * 100,
    maxDrawdownPct: maxDd * 100,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    expectancy: trades.length ? mean(trades.map((t) => t.netPnl)) : null,
    avgWin: wins.length ? grossWin / wins.length : null,
    avgLoss: losses.length ? -grossLoss / losses.length : null,
    avgHoldBars: trades.length ? mean(trades.map((t) => t.barsHeld)) : null,
    totalFees: trades.reduce((a, t) => a + t.fees, 0),
    liquidations: trades.filter((t) => t.liquidated).length,
    longestLosingStreak: longest,
    exposurePct: tested.length ? (inPosition / tested.length) * 100 : 0,
    consistency: rets.length >= 2 && sd > 0 ? mean(rets) / sd : null,
    bestTrade: trades.length ? Math.max(...trades.map((t) => t.netPnl)) : null,
    worstTrade: trades.length ? Math.min(...trades.map((t) => t.netPnl)) : null,
    buyAndHoldPct:
      tested.length >= 2
        ? ((tested[tested.length - 1] as Bar).c / (tested[0] as Bar).o - 1) * 100
        : null,
  };

  const step = TIMEFRAME_BAR_MS[spec.timeframe];
  let missing = 0;
  for (let i = 1; i < bars.length; i++) {
    const gap = Math.round(((bars[i] as Bar).t - (bars[i - 1] as Bar).t) / step) - 1;
    if (gap > 0) missing += gap;
  }

  const result: BacktestResult = {
    stats,
    startEquity: opts.startEquity,
    endEquity,
    equityCurve: downsample(curve, opts.maxCurvePoints ?? 400),
    trades,
    liquidations: trades.filter((t) => t.liquidated),
    halted: engine.state.halted,
    skipped,
    coverage: {
      bars: tested.length,
      from: tested[0]?.t ?? null,
      to: tested.length ? (tested[tested.length - 1] as Bar).t + step : null,
      missingBars: missing,
      warmupBars: first,
    },
    assumptions: {
      priceType: opts.priceType,
      takerRate: opts.fees.takerRate,
      builderBps: opts.fees.builderBps,
      slippageBps: opts.fees.slippageBps,
      startEquity: opts.startEquity,
      fillModel:
        "Signals fill at the next candle's open; stops, targets and liquidation trigger inside the candle with adverse moves assumed first.",
    },
    warnings: [],
  };
  result.warnings = backtestWarnings(spec, result, opts, endedOpen);
  return result;
}

export function backtestWarnings(
  spec: StrategySpec,
  r: BacktestResult,
  opts: BacktestOptions,
  endedOpen: boolean,
): string[] {
  const w: string[] = [];
  w.push(
    "A backtest is not a prediction: it shows what these rules would have done on past candles only.",
  );
  w.push(
    `Fills assume ${opts.fees.slippageBps} bps of slippage on market-style fills (entries, stops, rule exits), taker fees at ${(opts.fees.takerRate * 100).toFixed(3)}% plus Pit's ${opts.fees.builderBps} bps builder fee on every fill. Real fills depend on order-book depth, which isn't modelled.`,
  );
  w.push(
    "Funding payments aren't included: historical funding isn't indexed, so long-held positions will look better or worse than they were.",
  );
  w.push(
    `Candles are ${opts.priceType}-price candles. Inside a candle the order of highs and lows is unknown, so a candle that touches both a stop and a target counts as a stop.`,
  );
  if (r.stats.trades < 10)
    w.push(
      `Only ${r.stats.trades} trade${r.stats.trades === 1 ? "" : "s"}: too few to say much about how this would behave.`,
    );
  if (opts.requested) {
    const asked = opts.requested.to - opts.requested.from;
    const got =
      r.coverage.from !== null && r.coverage.to !== null ? r.coverage.to - r.coverage.from : 0;
    if (asked > 0 && got < asked * 0.9) {
      w.push(
        `History is shorter than requested: ${(got / 86_400_000).toFixed(1)} of ${(asked / 86_400_000).toFixed(1)} days are available for ${spec.market} ${spec.timeframe} candles.`,
      );
    }
  }
  if (r.coverage.missingBars > 0)
    w.push(`${r.coverage.missingBars} candles are missing from the data.`);
  if (r.coverage.warmupBars < 1 && spec.indicators.length > 0)
    w.push("No warm-up candles were available, so indicators start late.");
  if (endedOpen)
    w.push("A position was still open at the end of the data and was closed at the last price.");
  if (r.halted === "max_loss")
    w.push(`The strategy hit its $${spec.risk.maxLossUsd} loss limit and stopped itself.`);
  const sk = Object.entries(r.skipped);
  if (sk.length)
    w.push(
      `Some entry signals couldn't be taken: ${sk.map(([k, n]) => `${n} x ${k.replaceAll("_", " ")}`).join(", ")}.`,
    );
  if (r.stats.liquidations > 0)
    w.push(
      `${r.stats.liquidations} trade${r.stats.liquidations === 1 ? " was" : "s were"} liquidated: lower the leverage or tighten the stop.`,
    );
  return w;
}
