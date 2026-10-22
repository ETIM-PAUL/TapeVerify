import type { Condition, IndicatorDef, Operand, Operator, StrategySpec } from "./spec.js";

export interface RuleLine {
  label: string;
  text: string;
}

export interface Description {
  headline: string;
  lines: RuleLine[];
}

const OPS: Record<Operator, string> = {
  ">": "is above",
  "<": "is below",
  ">=": "is at or above",
  "<=": "is at or below",
  crosses_above: "crosses above",
  crosses_below: "crosses below",
};

const TF: Record<string, string> = {
  "5m": "5-minute",
  "15m": "15-minute",
  "1h": "1-hour",
  "4h": "4-hour",
  "1d": "daily",
};

function indicatorName(d: IndicatorDef): string {
  const p = d.period;
  switch (d.type) {
    case "sma":
      return `SMA(${p})`;
    case "ema":
      return `EMA(${p})`;
    case "rsi":
      return `RSI(${p})`;
    case "atr":
      return `ATR(${p})`;
    case "highest":
      return `the ${p}-candle high`;
    case "lowest":
      return `the ${p}-candle low`;
    case "roc":
      return `the ${p}-candle price change (%)`;
    case "funding_rate":
      return "the funding rate";
  }
}

function operandText(o: Operand, inds: Map<string, IndicatorDef>): string {
  if (o.kind === "indicator") {
    const d = o.indicator ? inds.get(o.indicator) : undefined;
    return d ? indicatorName(d) : `[unknown: ${o.indicator}]`;
  }
  if (o.kind === "price") return `the ${o.price} price`;
  return String(o.value);
}

function conditionText(c: Condition, inds: Map<string, IndicatorDef>): string {
  const rules = c.rules.map(
    (r) => `${operandText(r.left, inds)} ${OPS[r.op]} ${operandText(r.right, inds)}`,
  );
  if (rules.length === 1) return rules[0] as string;
  return `${c.match === "all" ? "ALL" : "ANY"} of: ${rules.join("; ")}`;
}

const usd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

/**
 * Plain-language rendering of exactly what a spec will do. Deterministic and generated from the spec
 * itself (never by the model), so what the user reads is what runs.
 */
export function describeStrategy(s: StrategySpec): Description {
  const inds = new Map(s.indicators.map((d) => [d.id, d]));
  const lines: RuleLine[] = [];
  const tf = TF[s.timeframe] ?? s.timeframe;
  lines.push({
    label: "Market",
    text: `${s.market}, ${tf} candles. Rules are checked each time a candle closes.`,
  });
  if (s.entry.long)
    lines.push({ label: "Buy (long) when", text: conditionText(s.entry.long, inds) });
  if (s.entry.short)
    lines.push({ label: "Sell (short) when", text: conditionText(s.entry.short, inds) });

  const x = s.exit;
  const exits = [`stop-loss ${x.stopLossPct}% from entry`];
  if (x.takeProfitPct !== null) exits.push(`take-profit ${x.takeProfitPct}%`);
  if (x.trailingStopPct !== null)
    exits.push(`trailing stop ${x.trailingStopPct}% behind the best price`);
  if (x.maxHoldBars !== null) exits.push(`close after ${x.maxHoldBars} candles`);
  lines.push({ label: "Exit on", text: exits.join(", ") });
  if (x.exitLong)
    lines.push({ label: "Also close a long when", text: conditionText(x.exitLong, inds) });
  if (x.exitShort)
    lines.push({ label: "Also close a short when", text: conditionText(x.exitShort, inds) });

  const z = s.sizing;
  lines.push({
    label: "Size",
    text:
      z.mode === "fixed_margin_usd"
        ? `${usd(z.value)} margin per trade at ${z.leverage}x leverage (about ${usd(z.value * z.leverage)} of exposure)`
        : `${z.value}% of account equity as margin per trade at ${z.leverage}x leverage`,
  });

  const r = s.risk;
  const limits = [`stops itself after ${usd(r.maxLossUsd)} of total losses`];
  if (r.maxTradesPerDay !== null) limits.push(`at most ${r.maxTradesPerDay} trades a day`);
  if (r.cooldownBars > 0) limits.push(`waits ${r.cooldownBars} candles between trades`);
  limits.push("one position at a time");
  lines.push({ label: "Limits", text: limits.join("; ") });

  const dir = s.direction === "both" ? "long and short" : s.direction;
  return { headline: `${s.name}: ${dir} on ${s.market}`, lines };
}
