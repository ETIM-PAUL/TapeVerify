import { sumSigned } from "./calls.js";

export interface StatsTrade {
  id: string;
  symbol: string;
  openedMs: number;
  closedMs: number;
  /** entry price x size, USD. */
  entryNotional: string;
  /** Realized PnL - fees + funding for the trade's lifetime, USD. */
  netPnl: string;
}

export interface CapitalFlow {
  ts: number;
  /** Deposits positive, withdrawals negative, USD. */
  amount: string;
}

export interface StatsOptions {
  from?: number;
  to?: number;
  symbol?: string;
}

export interface TraderStatsResult {
  /** Trades closed in the window (and market, if filtered). */
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  /** Exact sum of the trades' net PnL (USD). */
  netPnl: string;
  /** Time-weighted return over the window, percent. Null when no trade had capital behind it. */
  totalReturnPct: number | null;
  /** Largest peak-to-trough fall of the compounded return curve, percent. */
  maxDrawdownPct: number | null;
  avgHoldMs: number | null;
  /** mean / stdev of per-trade returns (a Sharpe-style score without annualization). Null under 2 trades. */
  consistency: number | null;
  /** Average entry notional as a multiple of account equity at the time. */
  effectiveLeverage: number | null;
  activeDays: number;
  /** Trades that closed while account equity was zero or unknown; they count in PnL but not in returns. */
  tradesWithoutCapital: number;
  bestTradePnl: string | null;
  worstTradePnl: string | null;
  /** Compounded return index after each return-bearing trade (starts at 1). For charts. */
  curve: Array<{ ts: number; index: number }>;
}

const DAY = 86_400_000;

export const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
export function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

type Event =
  | { kind: "flow"; ts: number; flow: CapitalFlow }
  | { kind: "trade"; ts: number; trade: StatsTrade };

/**
 * Verified-profile statistics from reconstructed trades and capital flows only.
 *
 * Equity is walked in time order: deposits and withdrawals move it, and each closed trade moves it by
 * its net PnL. A trade's return is its net PnL over the equity just before it closed (time-weighted, so
 * deposits don't count as performance). The whole account's equity is always used; the window and the
 * market filter only choose which trades are scored.
 */
export function computeStats(
  trades: StatsTrade[],
  flows: CapitalFlow[],
  opts: StatsOptions = {},
): TraderStatsResult {
  const events: Event[] = [
    ...flows.map((flow): Event => ({ kind: "flow", ts: flow.ts, flow })),
    ...trades.map((trade): Event => ({ kind: "trade", ts: trade.closedMs, trade })),
  ].sort(
    (a, b) =>
      a.ts - b.ts ||
      (a.kind === b.kind ? 0 : a.kind === "flow" ? -1 : 1) ||
      (a.kind === "trade" && b.kind === "trade" ? a.trade.id.localeCompare(b.trade.id) : 0),
  );

  const inSample = (t: StatsTrade) =>
    (opts.from === undefined || t.closedMs >= opts.from) &&
    (opts.to === undefined || t.closedMs <= opts.to) &&
    (opts.symbol === undefined || t.symbol === opts.symbol);

  let equity = 0;
  const sample: StatsTrade[] = [];
  const returns: number[] = [];
  const leverage: number[] = [];
  const curve: Array<{ ts: number; index: number }> = [];
  let index = 1;
  let peak = 1;
  let maxDd = 0;
  let withoutCapital = 0;

  for (const e of events) {
    if (e.kind === "flow") {
      equity += Number(e.flow.amount);
      continue;
    }
    const net = Number(e.trade.netPnl);
    if (inSample(e.trade)) {
      sample.push(e.trade);
      if (equity > 0) {
        const p = Math.max(-1, net / equity);
        returns.push(p);
        leverage.push(Number(e.trade.entryNotional) / equity);
        index *= 1 + p;
        peak = Math.max(peak, index);
        maxDd = Math.max(maxDd, (peak - index) / peak);
        curve.push({ ts: e.trade.closedMs, index });
      } else {
        withoutCapital++;
      }
    }
    equity += net;
  }

  const wins = sample.filter((t) => Number(t.netPnl) > 0).length;
  const losses = sample.filter((t) => Number(t.netPnl) < 0).length;
  const days = new Set(sample.map((t) => Math.floor(t.closedMs / DAY)));
  const sd = stdev(returns);
  const byPnl = [...sample].sort((a, b) => Number(b.netPnl) - Number(a.netPnl));
  return {
    trades: sample.length,
    wins,
    losses,
    winRate: sample.length ? wins / sample.length : null,
    netPnl: sumSigned(sample.map((t) => t.netPnl)),
    totalReturnPct: returns.length ? (index - 1) * 100 : null,
    maxDrawdownPct: returns.length ? maxDd * 100 : null,
    avgHoldMs: sample.length ? mean(sample.map((t) => t.closedMs - t.openedMs)) : null,
    consistency: returns.length >= 2 && sd > 0 ? mean(returns) / sd : null,
    effectiveLeverage: leverage.length ? mean(leverage) : null,
    activeDays: days.size,
    tradesWithoutCapital: withoutCapital,
    bestTradePnl: byPnl[0]?.netPnl ?? null,
    worstTradePnl: byPnl[byPnl.length - 1]?.netPnl ?? null,
    curve,
  };
}

export type Timeframe = "24h" | "7d" | "30d" | "all";
export type RiskLevel = "low" | "medium" | "high" | "unknown";

export const TIMEFRAME_MS: Record<Timeframe, number | null> = {
  "24h": DAY,
  "7d": 7 * DAY,
  "30d": 30 * DAY,
  all: null,
};

/** What a trader needs before they can rank: enough closed trades, on enough days, with real volume behind them. */
export const RANK_MINIMUMS: Record<
  Timeframe,
  { trades: number; activeDays: number; volumeUsd: number }
> = {
  "24h": { trades: 3, activeDays: 1, volumeUsd: 500 },
  "7d": { trades: 5, activeDays: 2, volumeUsd: 500 },
  "30d": { trades: 8, activeDays: 3, volumeUsd: 500 },
  all: { trades: 10, activeDays: 3, volumeUsd: 500 },
};

export type Unranked = "too_few_trades" | "too_few_days" | "low_volume" | "no_capital_history";

/** Null when the trader qualifies; otherwise the first minimum they miss. */
export function unrankedReason(
  s: TraderStatsResult,
  volumeUsd: number,
  tf: Timeframe,
): Unranked | null {
  const m = RANK_MINIMUMS[tf];
  if (s.tradesWithoutCapital > 0 && s.totalReturnPct === null) return "no_capital_history";
  if (s.trades < m.trades) return "too_few_trades";
  if (s.activeDays < m.activeDays) return "too_few_days";
  if (volumeUsd < m.volumeUsd) return "low_volume";
  return null;
}

/** Risk bucket from how big the positions are relative to equity and how deep the worst drawdown was. */
export function riskLevel(
  s: Pick<TraderStatsResult, "effectiveLeverage" | "maxDrawdownPct">,
): RiskLevel {
  if (s.effectiveLeverage === null || s.maxDrawdownPct === null) return "unknown";
  if (s.effectiveLeverage > 10 || s.maxDrawdownPct > 30) return "high";
  if (s.effectiveLeverage > 3 || s.maxDrawdownPct > 15) return "medium";
  return "low";
}
