import type { StrategySpec } from "../strategy/spec.js";
import { sizeFromMargin } from "../trading/size.js";
import { type MarketRulesLite, validateCallOrder } from "../trading/validate.js";

/** What the user caps a live run at. These are hard limits enforced by the runner, not hopes. */
export interface LiveBudget {
  /** Most margin any single position may use. */
  maxMarginUsd: number;
  /** Total loss at which the run stops itself (also capped by the spec's own limit). */
  maxLossUsd: number;
}

export interface LiveEnvLimits {
  maxLeverage: number;
}

export const DEFAULT_LIVE_LIMITS: LiveEnvLimits = { maxLeverage: 10 };

/** The loss cap that applies: the stricter of the user's budget and the strategy's own limit. */
export const effectiveLossCap = (spec: StrategySpec, b: LiveBudget) =>
  Math.min(b.maxLossUsd, spec.risk.maxLossUsd);

/** Extra restrictions for trading real funds, on top of ordinary strategy validation. */
export function liveSpecIssues(spec: StrategySpec, b: LiveBudget, limits: LiveEnvLimits): string[] {
  const out: string[] = [];
  if (spec.sizing.leverage > limits.maxLeverage)
    out.push(
      `Live trading is limited to ${limits.maxLeverage}x leverage (this strategy uses ${spec.sizing.leverage}x).`,
    );
  if (spec.exit.trailingStopPct !== null && spec.exit.trailingStopPct > 5)
    out.push("Live trailing stops are limited to 5% (Strike's trailing-stop range is 0.1% to 5%).");
  if (!(b.maxMarginUsd >= 5)) out.push("The margin cap must be at least $5.");
  if (!(b.maxLossUsd > 0)) out.push("Set a maximum loss above $0.");
  if (b.maxLossUsd > b.maxMarginUsd * 20)
    out.push("The loss limit is more than 20x the margin cap: lower it.");
  return out;
}

export type PlanCode =
  | "insufficient_balance"
  | "would_exceed_loss_cap"
  | "bad_order"
  | "below_minimum_size";

export type OrderPlan =
  | {
      ok: true;
      side: "long" | "short";
      marginUsd: number;
      leverage: number;
      notional: number;
      size: string;
      slPrice: string;
      tpPrice: string | null;
      trailingPct: number | null;
      /** Most this trade can lose if its stop fills, with a slippage allowance and fees. */
      worstCaseLoss: number;
    }
  | { ok: false; code: PlanCode; reason: string };

export interface PlanInput {
  spec: StrategySpec;
  budget: LiveBudget;
  side: "long" | "short";
  /** Latest mark price. */
  mark: number;
  /** Margin available to trade with right now (account or sub-account). */
  availableUsd: number;
  /** Net loss realized so far in this run (positive number). */
  realizedLossUsd: number;
  rules: MarketRulesLite;
  takerRate: number;
  builderBps: number;
  slippageBps: number;
}

/**
 * Turns an entry signal into a concrete order, or says why not. Every cap is applied here, before any
 * order is sent: margin cap, available balance, market rules, and the loss budget — an entry is refused
 * if its stop-loss fill alone could take cumulative loss past the cap.
 */
export function planLiveEntry(i: PlanInput): OrderPlan {
  const { spec, budget } = i;
  const wanted =
    spec.sizing.mode === "fixed_margin_usd"
      ? spec.sizing.value
      : (i.availableUsd * spec.sizing.value) / 100;
  const margin = Math.floor(Math.min(wanted, budget.maxMarginUsd) * 100) / 100;
  if (margin < 5)
    return {
      ok: false,
      code: "below_minimum_size",
      reason: `Margin of $${margin.toFixed(2)} is below the $5 minimum.`,
    };
  if (margin > i.availableUsd) {
    return {
      ok: false,
      code: "insufficient_balance",
      reason: `Needs $${margin.toFixed(2)} of margin but only $${i.availableUsd.toFixed(2)} is available.`,
    };
  }
  const lev = spec.sizing.leverage;
  const size = sizeFromMargin(
    margin.toFixed(2),
    lev,
    String(i.mark),
    i.rules.order_market_min_size,
    i.rules.order_market_step_size,
  );
  if (!size)
    return {
      ok: false,
      code: "below_minimum_size",
      reason: "That margin is below the market's minimum order size.",
    };

  const dir = i.side === "long" ? 1 : -1;
  const sl = i.mark * (1 - (dir * spec.exit.stopLossPct) / 100);
  const tp =
    spec.exit.takeProfitPct === null ? null : i.mark * (1 + (dir * spec.exit.takeProfitPct) / 100);
  const check = validateCallOrder(i.rules, {
    side: i.side,
    size,
    leverage: lev,
    tpPrice: tp === null ? undefined : String(tp),
    slPrice: String(sl),
  });
  if (!check.ok) return { ok: false, code: "bad_order", reason: check.error };

  const notional = Number(size) * i.mark;
  const feeRate = i.takerRate + i.builderBps / 10_000;
  // Stop distance, with allowance for slippage on the stop fill, plus entry and exit fees.
  const worstCaseLoss =
    notional * (spec.exit.stopLossPct / 100 + (2 * i.slippageBps) / 10_000) +
    2 * notional * feeRate;
  const cap = effectiveLossCap(spec, budget);
  const remaining = cap - i.realizedLossUsd;
  if (worstCaseLoss > remaining) {
    return {
      ok: false,
      code: "would_exceed_loss_cap",
      reason: `A stopped-out trade could lose about $${worstCaseLoss.toFixed(2)}, more than the $${Math.max(0, remaining).toFixed(2)} left under the $${cap} loss cap.`,
    };
  }
  return {
    ok: true,
    side: i.side,
    marginUsd: margin,
    leverage: lev,
    notional,
    size: check.size,
    slPrice: check.slPrice as string,
    tpPrice: check.tpPrice ?? null,
    trailingPct: spec.exit.trailingStopPct,
    worstCaseLoss,
  };
}
