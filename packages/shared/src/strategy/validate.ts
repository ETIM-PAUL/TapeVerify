import {
  type Condition,
  ID_PATTERN,
  type IndicatorType,
  type Operand,
  type StrategySpec,
  strategySpecSchema,
} from "./spec.js";

export interface Issue {
  path: string;
  message: string;
}

export interface MarketLimits {
  maxLeverage: number;
  minNotional: number;
}

export interface ValidationResult {
  ok: boolean;
  /** Blocking problems. */
  issues: Issue[];
  /** Things the user should know but that don't block saving. */
  warnings: Issue[];
}

export interface ValidateOptions {
  /** Markets TapeVerify supports, with their trading limits. */
  markets: Record<string, MarketLimits>;
}

/** What kind of number an indicator produces, so nonsensical comparisons (RSI vs price) are caught. */
type Scale = "price" | "oscillator" | "percent" | "rate";
const SCALE: Record<IndicatorType, Scale> = {
  sma: "price",
  ema: "price",
  highest: "price",
  lowest: "price",
  atr: "price",
  rsi: "oscillator",
  roc: "percent",
  funding_rate: "rate",
};

const MAX_RULES = 5;
const MAX_INDICATORS = 6;
/** Stop-loss distance times leverage must stay well inside the liquidation distance (~100/leverage %). */
export const LIQUIDATION_GUARD = 80;

export function validateStrategy(
  input: unknown,
  opts: ValidateOptions,
): ValidationResult & { spec: StrategySpec | null } {
  const parsed = strategySpecSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      spec: null,
      warnings: [],
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join(".") || "(root)",
        message: i.message,
      })),
    };
  }
  const s = parsed.data;
  const issues: Issue[] = [];
  const warnings: Issue[] = [];
  const err = (path: string, message: string) => issues.push({ path, message });

  if (s.name.trim().length < 1 || s.name.length > 60) err("name", "Name must be 1-60 characters");
  if (s.summary.length > 240) err("summary", "Summary must be at most 240 characters");

  const market = opts.markets[s.market];
  if (!market) err("market", `Unsupported market ${s.market}`);

  // Indicators
  const byId = new Map<string, IndicatorType>();
  if (s.indicators.length > MAX_INDICATORS)
    err("indicators", `At most ${MAX_INDICATORS} indicators`);
  s.indicators.forEach((ind, i) => {
    const p = `indicators.${i}`;
    if (!ID_PATTERN.test(ind.id))
      err(
        `${p}.id`,
        "Id must be lowercase letters, digits or underscores, starting with a letter (max 16)",
      );
    else if (byId.has(ind.id)) err(`${p}.id`, `Duplicate indicator id ${ind.id}`);
    else byId.set(ind.id, ind.type);
    if (ind.type === "funding_rate") {
      if (ind.period !== null) err(`${p}.period`, "funding_rate takes no period (use null)");
      warnings.push({
        path: p,
        message:
          "Funding-rate strategies can't be backtested on candles alone: no market-wide funding history is indexed yet.",
      });
    } else if (ind.period === null || ind.period < 2 || ind.period > 500) {
      err(`${p}.period`, "Period must be a whole number from 2 to 500");
    }
  });

  // Conditions
  const checkOperand = (o: Operand, path: string): Scale | "number" | null => {
    if (o.kind === "indicator") {
      if (!o.indicator || !byId.has(o.indicator)) {
        err(path, `Unknown indicator "${o.indicator ?? ""}": declare it in indicators first`);
        return null;
      }
      return SCALE[byId.get(o.indicator) as IndicatorType];
    }
    if (o.kind === "price") {
      if (!o.price) err(path, "price operand needs a price field");
      return "price";
    }
    if (o.value === null || !Number.isFinite(o.value)) {
      err(path, "number operand needs a finite value");
      return null;
    }
    return "number";
  };
  const checkCondition = (c: Condition | null, path: string, required: boolean) => {
    if (!c) {
      if (required) err(path, "This rule set is required");
      return;
    }
    if (c.rules.length < 1 || c.rules.length > MAX_RULES)
      err(`${path}.rules`, `Use 1 to ${MAX_RULES} rules`);
    c.rules.forEach((r, i) => {
      const p = `${path}.rules.${i}`;
      const l = checkOperand(r.left, `${p}.left`);
      const rr = checkOperand(r.right, `${p}.right`);
      if (l === "number" && rr === "number")
        err(p, "A rule must involve at least one price or indicator");
      if (l && rr && l !== "number" && rr !== "number" && l !== rr) {
        err(p, `Can't compare a ${l} value with a ${rr} value`);
      }
      const num = l === "number" ? r.left : rr === "number" ? r.right : null;
      const other = l === "number" ? rr : l;
      if (num?.value != null && other === "oscillator" && (num.value < 0 || num.value > 100)) {
        err(p, "RSI is between 0 and 100");
      }
      if (num?.value != null && other === "price" && num.value <= 0)
        err(p, "A price level must be positive");
    });
  };

  const wantsLong = s.direction === "long" || s.direction === "both";
  const wantsShort = s.direction === "short" || s.direction === "both";
  checkCondition(s.entry.long, "entry.long", wantsLong);
  checkCondition(s.entry.short, "entry.short", wantsShort);
  if (!wantsLong && s.entry.long)
    err("entry.long", `Direction is ${s.direction}: remove the long entry`);
  if (!wantsShort && s.entry.short)
    err("entry.short", `Direction is ${s.direction}: remove the short entry`);
  checkCondition(s.exit.exitLong, "exit.exitLong", false);
  checkCondition(s.exit.exitShort, "exit.exitShort", false);
  if (!wantsLong && s.exit.exitLong) err("exit.exitLong", "No long trades: remove this");
  if (!wantsShort && s.exit.exitShort) err("exit.exitShort", "No short trades: remove this");

  // Exits: a stop-loss is mandatory
  const x = s.exit;
  if (!(x.stopLossPct >= 0.1 && x.stopLossPct <= 50))
    err("exit.stopLossPct", "Stop-loss is required: between 0.1% and 50%");
  if (x.takeProfitPct !== null && !(x.takeProfitPct >= 0.1 && x.takeProfitPct <= 500))
    err("exit.takeProfitPct", "Take-profit must be between 0.1% and 500%");
  if (x.trailingStopPct !== null && !(x.trailingStopPct >= 0.1 && x.trailingStopPct <= 50))
    err("exit.trailingStopPct", "Trailing stop must be between 0.1% and 50%");
  if (x.maxHoldBars !== null && !(x.maxHoldBars >= 1 && x.maxHoldBars <= 10_000))
    err("exit.maxHoldBars", "Max hold must be 1 to 10,000 candles");

  // Sizing and leverage
  const z = s.sizing;
  const maxLev = market ? Math.min(market.maxLeverage, 125) : 125;
  if (z.leverage < 1 || z.leverage > maxLev)
    err("sizing.leverage", `Leverage must be a whole number from 1 to ${maxLev}`);
  if (z.mode === "fixed_margin_usd" && !(z.value >= 5 && z.value <= 100_000))
    err("sizing.value", "Margin must be between $5 and $100,000");
  if (z.mode === "pct_of_equity" && !(z.value >= 1 && z.value <= 100))
    err("sizing.value", "Equity share must be between 1% and 100%");
  if (x.stopLossPct * z.leverage > LIQUIDATION_GUARD) {
    err(
      "exit.stopLossPct",
      `A ${x.stopLossPct}% stop at ${z.leverage}x leverage risks liquidation before it triggers; keep stop % x leverage under ${LIQUIDATION_GUARD}`,
    );
  }
  if (market && z.mode === "fixed_margin_usd" && z.value * z.leverage < market.minNotional) {
    err(
      "sizing.value",
      `Each order must be worth at least $${market.minNotional}: raise margin or leverage (now $${(z.value * z.leverage).toFixed(0)})`,
    );
  }

  // Risk
  const r = s.risk;
  if (!(r.maxLossUsd > 0 && r.maxLossUsd <= 1_000_000))
    err("risk.maxLossUsd", "Set a maximum loss above $0");
  if (r.maxTradesPerDay !== null && !(r.maxTradesPerDay >= 1 && r.maxTradesPerDay <= 200))
    err("risk.maxTradesPerDay", "Trades per day must be 1 to 200");
  if (r.cooldownBars < 0 || r.cooldownBars > 1000)
    err("risk.cooldownBars", "Cooldown must be 0 to 1,000 candles");
  if (z.mode === "fixed_margin_usd") {
    const worst = z.value * z.leverage * (x.stopLossPct / 100);
    if (r.maxLossUsd < worst)
      warnings.push({
        path: "risk.maxLossUsd",
        message: `One stopped-out trade can lose about $${worst.toFixed(2)}, more than the $${r.maxLossUsd} limit: the strategy would stop after its first loss.`,
      });
  }
  if (x.takeProfitPct !== null && x.takeProfitPct < x.stopLossPct * 0.5)
    warnings.push({
      path: "exit.takeProfitPct",
      message:
        "Take-profit is much smaller than the stop-loss: it must win far more often than it loses.",
    });

  return { ok: issues.length === 0, issues, warnings, spec: issues.length === 0 ? s : null };
}
