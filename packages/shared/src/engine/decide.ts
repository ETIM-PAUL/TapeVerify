import type { Condition, Operand, StrategySpec } from "../strategy/spec.js";
import type { Bar, IndicatorSet, Series } from "./indicators.js";

const DAY = 86_400_000;

function value(o: Operand, bars: Bar[], ind: IndicatorSet, idx: number): number | null {
  if (idx < 0) return null;
  if (o.kind === "number") return o.value;
  if (o.kind === "price") {
    const b = bars[idx];
    if (!b) return null;
    return o.price === "open" ? b.o : o.price === "high" ? b.h : o.price === "low" ? b.l : b.c;
  }
  const series: Series | undefined = o.indicator ? ind.byId.get(o.indicator) : undefined;
  return series?.[idx] ?? null;
}

/** Does a rule set hold on the candle at index `i`? Missing data (warm-up, no funding) makes a rule false. */
export function matchesCondition(c: Condition, bars: Bar[], ind: IndicatorSet, i: number): boolean {
  const hit = (r: Condition["rules"][number]): boolean => {
    const l = value(r.left, bars, ind, i);
    const rr = value(r.right, bars, ind, i);
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
        const pl = value(r.left, bars, ind, i - 1);
        const pr = value(r.right, bars, ind, i - 1);
        if (pl === null || pr === null) return false;
        return r.op === "crosses_above" ? pl <= pr && l > rr : pl >= pr && l < rr;
      }
    }
  };
  return c.match === "all" ? c.rules.every(hit) : c.rules.some(hit);
}

/** What the runner knows when a candle closes. The engine and the live runner build this from their own state. */
export interface DecisionInput {
  halted: boolean;
  position: { side: "long" | "short"; barsHeld: number } | null;
  /** A signal from an earlier close is still waiting to be acted on. */
  pending: boolean;
  /** Candle closes since the last exit (this one included), or null if there hasn't been an exit. */
  barsSinceExit: number | null;
  /** Entries already taken on the UTC day of this candle. */
  tradesToday: number;
}

export type Decision =
  | { kind: "exit"; reason: "rule" | "max_hold" | "halt" }
  | { kind: "enter"; side: "long" | "short" }
  | {
      kind: "none";
      why: "pending" | "holding" | "halted" | "cooldown" | "daily_limit" | "conflict" | "no_signal";
    };

/**
 * The strategy's decision at a candle close. One function, used by the backtester, paper mode and live
 * trading, so all three behave identically on the same candles.
 */
export function decideOnClose(
  spec: StrategySpec,
  input: DecisionInput,
  bars: Bar[],
  ind: IndicatorSet,
  i: number,
): Decision {
  if (input.halted)
    return input.position ? { kind: "exit", reason: "halt" } : { kind: "none", why: "halted" };
  if (input.pending) return { kind: "none", why: "pending" };

  if (input.position) {
    const cond = input.position.side === "long" ? spec.exit.exitLong : spec.exit.exitShort;
    if (cond && matchesCondition(cond, bars, ind, i)) return { kind: "exit", reason: "rule" };
    if (spec.exit.maxHoldBars !== null && input.position.barsHeld >= spec.exit.maxHoldBars)
      return { kind: "exit", reason: "max_hold" };
    return { kind: "none", why: "holding" };
  }

  const { cooldownBars, maxTradesPerDay } = spec.risk;
  if (input.barsSinceExit !== null && input.barsSinceExit <= cooldownBars)
    return { kind: "none", why: "cooldown" };
  if (maxTradesPerDay !== null && input.tradesToday >= maxTradesPerDay)
    return { kind: "none", why: "daily_limit" };
  const wantsLong = spec.entry.long !== null && matchesCondition(spec.entry.long, bars, ind, i);
  const wantsShort = spec.entry.short !== null && matchesCondition(spec.entry.short, bars, ind, i);
  // Contradictory signals on one candle: stand aside
  if (wantsLong === wantsShort) return { kind: "none", why: wantsLong ? "conflict" : "no_signal" };
  return { kind: "enter", side: wantsLong ? "long" : "short" };
}

/** UTC day number of a candle, for the daily trade limit. */
export const dayOf = (bar: Bar): number => Math.floor((bar.t + 1) / DAY);
