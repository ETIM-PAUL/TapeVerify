import type { Condition, Operand, StrategySpec } from "../strategy/spec.js";
import type { Bar, IndicatorSet, Series } from "./indicators.js";
import {
  builderFee,
  commission,
  type FeeModel,
  liquidationPrice,
  type MarketModel,
  tierFor,
} from "./model.js";

export type SimExitReason =
  | "stop_loss"
  | "take_profit"
  | "trailing_stop"
  | "rule"
  | "max_hold"
  | "liquidation"
  | "halt"
  | "end_of_data"
  | "manual";

export type SkipReason =
  | "below_min_notional"
  | "insufficient_equity"
  | "position_too_large"
  | "leverage_too_high";

export interface SimPosition {
  side: "long" | "short";
  entryTs: number;
  entryPrice: number;
  size: number;
  notional: number;
  margin: number;
  leverage: number;
  liq: number;
  stop: number;
  tp: number | null;
  trailPct: number | null;
  /** Best price since entry (highest for longs, lowest for shorts), from candles before the current one. */
  best: number;
  barsHeld: number;
  entryFees: number;
  /** Set when the position was opened mid-candle (live): that candle's OHLC predates the fill. */
  midBarT: number | null;
}

export interface SimTrade {
  id: number;
  side: "long" | "short";
  entryTs: number;
  exitTs: number;
  entryPrice: number;
  exitPrice: number;
  size: number;
  notional: number;
  margin: number;
  leverage: number;
  grossPnl: number;
  fees: number;
  netPnl: number;
  /** Net PnL over the margin put up. */
  returnPct: number;
  barsHeld: number;
  reason: SimExitReason;
  liquidated: boolean;
}

export type SimPending =
  | { kind: "enter"; side: "long" | "short" }
  | { kind: "exit"; reason: SimExitReason }
  | null;

/** Everything needed to resume a run: plain JSON. */
export interface EngineState {
  equity: number;
  startEquity: number;
  cumNetPnl: number;
  position: SimPosition | null;
  halted: string | null;
  barIndex: number;
  lastExitBar: number | null;
  day: number | null;
  tradesToday: number;
  pending: SimPending;
  tradeSeq: number;
}

export type EngineEvent =
  | { type: "entry"; ts: number; position: SimPosition }
  | { type: "trade"; trade: SimTrade }
  | { type: "halt"; ts: number; reason: string }
  | { type: "skip"; ts: number; reason: SkipReason };

export interface EngineConfig {
  spec: StrategySpec;
  market: MarketModel;
  fees: FeeModel;
}

const DAY = 86_400_000;
const slip = (bps: number) => bps / 10_000;

export function initialState(startEquity: number): EngineState {
  return {
    equity: startEquity,
    startEquity,
    cumNetPnl: 0,
    position: null,
    halted: null,
    barIndex: 0,
    lastExitBar: null,
    day: null,
    tradesToday: 0,
    pending: null,
    tradeSeq: 0,
  };
}

/**
 * The strategy runner's core, shared by the backtester and paper mode (and, later, the live runner).
 * It is a plain state machine: feed it closed candles (and, live, price ticks) and it emits trades.
 *
 * Per candle the order is: fill any signal from the previous close at this candle's open, check the stop,
 * take-profit, trailing stop and liquidation inside the candle, then evaluate the rules on the close.
 * Inside one candle adverse moves are assumed to come first (pessimistic: a candle touching both the
 * stop and the target counts as a stop).
 */
export class StrategyEngine {
  state: EngineState;

  constructor(
    readonly cfg: EngineConfig,
    state?: EngineState,
    startEquity = 10_000,
  ) {
    this.state = state ?? initialState(startEquity);
  }

  // ── Filling ──

  /** Executes the signal left by the last close at `price`. */
  fillPending(price: number, ts: number, opts: { midBarT?: number } = {}): EngineEvent[] {
    const s = this.state;
    const p = s.pending;
    if (!p) return [];
    s.pending = null;
    if (p.kind === "exit") {
      if (!s.position) return [];
      const dir = s.position.side === "long" ? 1 : -1;
      return this.close(price * (1 - dir * slip(this.cfg.fees.slippageBps)), ts, p.reason);
    }
    if (s.position || s.halted) return [];
    return this.open(p.side, price, ts, opts.midBarT ?? null);
  }

  private open(
    side: "long" | "short",
    price: number,
    ts: number,
    midBarT: number | null,
  ): EngineEvent[] {
    const { spec, market, fees } = this.cfg;
    const s = this.state;
    const dir = side === "long" ? 1 : -1;
    const margin =
      spec.sizing.mode === "fixed_margin_usd"
        ? spec.sizing.value
        : (s.equity * spec.sizing.value) / 100;
    const leverage = spec.sizing.leverage;
    const notional = margin * leverage;
    const skip = (reason: SkipReason): EngineEvent[] => [{ type: "skip", ts, reason }];
    if (notional < market.minNotional) return skip("below_min_notional");
    if (margin > s.equity) return skip("insufficient_equity");
    const top = market.tiers[market.tiers.length - 1];
    if (top && notional > top.maxNotional) return skip("position_too_large");
    if (leverage > tierFor(market, notional).maxLeverage) return skip("leverage_too_high");

    const fill = price * (1 + dir * slip(fees.slippageBps));
    const size = notional / fill;
    const entryFees =
      commission(notional, fees.takerRate, market.quotePrec) +
      builderFee(notional, fees.builderBps);
    const x = spec.exit;
    const pos: SimPosition = {
      side,
      entryTs: ts,
      entryPrice: fill,
      size,
      notional,
      margin,
      leverage,
      liq: liquidationPrice(market, side, fill, size, margin),
      stop: fill * (1 - (dir * x.stopLossPct) / 100),
      tp: x.takeProfitPct === null ? null : fill * (1 + (dir * x.takeProfitPct) / 100),
      trailPct: x.trailingStopPct,
      best: fill,
      barsHeld: 0,
      entryFees,
      midBarT,
    };
    s.equity -= entryFees;
    s.position = pos;
    const day = Math.floor(ts / DAY);
    if (s.day !== day) {
      s.day = day;
      s.tradesToday = 0;
    }
    s.tradesToday++;
    return [{ type: "entry", ts, position: structuredClone(pos) }];
  }

  private close(exitPrice: number, ts: number, reason: SimExitReason): EngineEvent[] {
    const { market, fees } = this.cfg;
    const s = this.state;
    const pos = s.position;
    if (!pos) return [];
    const dir = pos.side === "long" ? 1 : -1;
    const exitNotional = exitPrice * pos.size;
    const liquidated = reason === "liquidation";
    let gross = (exitPrice - pos.entryPrice) * pos.size * dir;
    if (liquidated) gross = Math.max(gross, -pos.margin); // an isolated position can't lose more than its margin
    const exitFees =
      commission(exitNotional, fees.takerRate, market.quotePrec) +
      builderFee(exitNotional, fees.builderBps) +
      (liquidated
        ? Math.min(exitNotional * market.liquidationFeeRate, Math.max(0, pos.margin + gross))
        : 0);
    const net = gross - pos.entryFees - exitFees;
    s.equity += gross - exitFees;
    s.cumNetPnl += net;
    s.tradeSeq++;
    s.position = null;
    s.lastExitBar = s.barIndex;
    const trade: SimTrade = {
      id: s.tradeSeq,
      side: pos.side,
      entryTs: pos.entryTs,
      exitTs: ts,
      entryPrice: pos.entryPrice,
      exitPrice,
      size: pos.size,
      notional: pos.notional,
      margin: pos.margin,
      leverage: pos.leverage,
      grossPnl: gross,
      fees: pos.entryFees + exitFees,
      netPnl: net,
      returnPct: pos.margin > 0 ? (net / pos.margin) * 100 : 0,
      barsHeld: pos.barsHeld,
      reason,
      liquidated,
    };
    const ev: EngineEvent[] = [{ type: "trade", trade }];
    if (!s.halted && s.cumNetPnl <= -this.cfg.spec.risk.maxLossUsd) {
      s.halted = "max_loss";
      s.pending = null;
      ev.push({ type: "halt", ts, reason: "max_loss" });
    }
    return ev;
  }

  // ── Protective exits ──

  /**
   * Checks stop, trailing stop, liquidation and take-profit against one candle's range, or a single live
   * price (`tick`). Returns the exit if one triggered.
   */
  protective(
    bar: { o: number; h: number; l: number },
    ts: number,
    opts: { tick?: boolean; barT?: number } = {},
  ): EngineEvent[] {
    const s = this.state;
    const pos = s.position;
    if (!pos) return [];
    if (!opts.tick && pos.midBarT !== null && pos.midBarT === opts.barT) {
      pos.midBarT = null; // this candle's range includes prices from before the fill; live ticks covered it
      return [];
    }
    const long = pos.side === "long";
    const dir = long ? 1 : -1;
    const sl = slip(this.cfg.fees.slippageBps);
    const trail =
      pos.trailPct === null
        ? null
        : long
          ? pos.best * (1 - pos.trailPct / 100)
          : pos.best * (1 + pos.trailPct / 100);
    const stop =
      trail === null ? pos.stop : long ? Math.max(pos.stop, trail) : Math.min(pos.stop, trail);
    const stopReason: SimExitReason =
      trail !== null && (long ? trail > pos.stop : trail < pos.stop)
        ? "trailing_stop"
        : "stop_loss";

    const adverse = long ? bar.l : bar.h; // the worst price reached
    const favourable = long ? bar.h : bar.l;
    const beyond = (price: number, level: number) => (long ? price <= level : price >= level);

    // Liquidation first when the candle opens already past the liquidation price (a gap)
    if (pos.liq > 0 && beyond(bar.o, pos.liq)) return this.close(pos.liq, ts, "liquidation");
    if (beyond(adverse, stop)) {
      const gap = beyond(bar.o, stop);
      const fill = (gap ? bar.o : stop) * (1 - dir * sl);
      if (pos.liq > 0 && beyond(fill, pos.liq)) return this.close(pos.liq, ts, "liquidation");
      return this.close(fill, ts, stopReason);
    }
    if (pos.liq > 0 && beyond(adverse, pos.liq)) return this.close(pos.liq, ts, "liquidation");
    if (pos.tp !== null && (long ? favourable >= pos.tp : favourable <= pos.tp)) {
      // A live tick is not a candle open: the target fills at its level, as in a backtest.
      const gap = !opts.tick && (long ? bar.o >= pos.tp : bar.o <= pos.tp);
      return this.close(gap ? bar.o : pos.tp, ts, "take_profit");
    }
    pos.best = long ? Math.max(pos.best, bar.h) : Math.min(pos.best, bar.l);
    return [];
  }

  // ── Rules at the close of a candle ──

  /** Evaluates the spec's rules on the candle that just closed (bars[i]) and queues any signal. */
  onClose(bars: Bar[], ind: IndicatorSet, i: number): EngineEvent[] {
    const { spec } = this.cfg;
    const s = this.state;
    const bar = bars[i] as Bar;
    s.barIndex++;
    if (s.position) s.position.barsHeld++;

    if (s.halted) {
      if (s.position) s.pending = { kind: "exit", reason: "halt" };
      return [];
    }
    if (s.pending) return [];

    if (s.position) {
      const cond = s.position.side === "long" ? spec.exit.exitLong : spec.exit.exitShort;
      if (cond && this.matches(cond, bars, ind, i)) s.pending = { kind: "exit", reason: "rule" };
      else if (spec.exit.maxHoldBars !== null && s.position.barsHeld >= spec.exit.maxHoldBars)
        s.pending = { kind: "exit", reason: "max_hold" };
      return [];
    }

    const { cooldownBars, maxTradesPerDay } = spec.risk;
    if (s.lastExitBar !== null && s.barIndex - s.lastExitBar <= cooldownBars) return [];
    if (maxTradesPerDay !== null) {
      const day = Math.floor((bar.t + 1) / DAY);
      const used = s.day === day ? s.tradesToday : 0;
      if (used >= maxTradesPerDay) return [];
    }
    const wantsLong = spec.entry.long !== null && this.matches(spec.entry.long, bars, ind, i);
    const wantsShort = spec.entry.short !== null && this.matches(spec.entry.short, bars, ind, i);
    // Contradictory signals on one candle: stand aside
    if (wantsLong !== wantsShort) s.pending = { kind: "enter", side: wantsLong ? "long" : "short" };
    return [];
  }

  /** Full candle step for replays: fill, protect, then evaluate. */
  step(bars: Bar[], ind: IndicatorSet, i: number): EngineEvent[] {
    const bar = bars[i] as Bar;
    const ev = [...this.fillPending(bar.o, bar.t)];
    ev.push(...this.protective(bar, bar.t, { barT: bar.t }));
    ev.push(...this.onClose(bars, ind, i));
    return ev;
  }

  /** Account value including the open position, marked at `price`. */
  markToMarket(price: number): number {
    const pos = this.state.position;
    if (!pos) return this.state.equity;
    return this.state.equity + (price - pos.entryPrice) * pos.size * (pos.side === "long" ? 1 : -1);
  }

  /** Flatten the book now (end of a backtest, or a manual stop). */
  flatten(price: number, ts: number, reason: SimExitReason): EngineEvent[] {
    const pos = this.state.position;
    if (!pos) return [];
    const dir = pos.side === "long" ? 1 : -1;
    this.state.pending = null;
    return this.close(price * (1 - dir * slip(this.cfg.fees.slippageBps)), ts, reason);
  }

  // ── Rule evaluation ──

  private value(o: Operand, bars: Bar[], ind: IndicatorSet, idx: number): number | null {
    if (idx < 0) return null;
    if (o.kind === "number") return o.value;
    if (o.kind === "price")
      return (
        bars[idx]?.[
          (o.price as "open" | "high" | "low" | "close") === "open"
            ? "o"
            : o.price === "high"
              ? "h"
              : o.price === "low"
                ? "l"
                : "c"
        ] ?? null
      );
    const series: Series | undefined = o.indicator ? ind.byId.get(o.indicator) : undefined;
    return series?.[idx] ?? null;
  }

  matches(c: Condition, bars: Bar[], ind: IndicatorSet, i: number): boolean {
    const hit = (r: Condition["rules"][number]): boolean => {
      const l = this.value(r.left, bars, ind, i);
      const rr = this.value(r.right, bars, ind, i);
      if (l === null || rr === null) return false;
      switch (r.op) {
        case ">":
          return l > rr;
        case "<":
          return l < rr;
        case ">=":
          return l >= rr;
        case "<=":
          return l <= rr;
        case "crosses_above":
        case "crosses_below": {
          const pl = this.value(r.left, bars, ind, i - 1);
          const pr = this.value(r.right, bars, ind, i - 1);
          if (pl === null || pr === null) return false;
          return r.op === "crosses_above" ? pl <= pr && l > rr : pl >= pr && l < rr;
        }
      }
    };
    return c.match === "all" ? c.rules.every(hit) : c.rules.some(hit);
  }
}
