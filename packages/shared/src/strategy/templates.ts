import type { Condition, StrategySpec } from "./spec.js";

export interface TemplateParams {
  market: string;
  leverage: number;
  marginUsd: number;
  maxLossUsd: number;
}

export interface TemplateInfo {
  id: "dip_buyer" | "trend_follower" | "funding_rate" | "breakout";
  title: string;
  blurb: string;
  /** True when the strategy needs data the backtester doesn't have yet. */
  needsFundingHistory: boolean;
}

export const TEMPLATE_DEFAULTS: TemplateParams = {
  market: "BTC-USD",
  leverage: 3,
  marginUsd: 100,
  maxLossUsd: 100,
};

const ind = (indicator: string) => ({
  kind: "indicator" as const,
  indicator,
  value: null,
  price: null,
});
const price = (p: "open" | "high" | "low" | "close") => ({
  kind: "price" as const,
  indicator: null,
  value: null,
  price: p,
});
const n = (value: number) => ({ kind: "number" as const, indicator: null, value, price: null });
const all = (...rules: Condition["rules"]): Condition => ({ match: "all", rules });

export const TEMPLATES: TemplateInfo[] = [
  {
    id: "dip_buyer",
    title: "Dip buyer",
    blurb: "Buys oversold dips while the longer trend is still up, takes profit on the bounce.",
    needsFundingHistory: false,
  },
  {
    id: "trend_follower",
    title: "Trend follower",
    blurb: "Rides moving-average crossovers long and short with a trailing stop.",
    needsFundingHistory: false,
  },
  {
    id: "funding_rate",
    title: "Funding-rate fader",
    blurb: "Leans against crowded positioning when funding is stretched.",
    needsFundingHistory: true,
  },
  {
    id: "breakout",
    title: "Breakout",
    blurb: "Buys a break above the recent high, sells a break below the recent low.",
    needsFundingHistory: false,
  },
];

export function instantiateTemplate(
  id: TemplateInfo["id"],
  p: Partial<TemplateParams> = {},
): StrategySpec {
  const t = { ...TEMPLATE_DEFAULTS, ...p };
  const sizing = { mode: "fixed_margin_usd" as const, value: t.marginUsd, leverage: t.leverage };
  const base = { version: 1 as const, market: t.market, sizing };

  switch (id) {
    case "dip_buyer":
      return {
        ...base,
        name: "Dip buyer",
        summary:
          "Buy when RSI is oversold but price holds above its long-term average; exit on the bounce.",
        timeframe: "1h",
        direction: "long",
        indicators: [
          { id: "rsi14", type: "rsi", period: 14 },
          { id: "ema200", type: "ema", period: 200 },
        ],
        entry: {
          long: all(
            { left: ind("rsi14"), op: "<", right: n(30) },
            { left: price("close"), op: ">", right: ind("ema200") },
          ),
          short: null,
        },
        exit: {
          stopLossPct: 3,
          takeProfitPct: 5,
          trailingStopPct: null,
          maxHoldBars: 72,
          exitLong: all({ left: ind("rsi14"), op: ">", right: n(60) }),
          exitShort: null,
        },
        risk: { maxLossUsd: t.maxLossUsd, maxTradesPerDay: 3, cooldownBars: 4 },
      };
    case "trend_follower":
      return {
        ...base,
        name: "Trend follower",
        summary: "Go with the trend when the fast average crosses the slow one; trail the stop.",
        timeframe: "4h",
        direction: "both",
        indicators: [
          { id: "fast", type: "ema", period: 20 },
          { id: "slow", type: "ema", period: 50 },
        ],
        entry: {
          long: all({ left: ind("fast"), op: "crosses_above", right: ind("slow") }),
          short: all({ left: ind("fast"), op: "crosses_below", right: ind("slow") }),
        },
        exit: {
          stopLossPct: 4,
          takeProfitPct: null,
          trailingStopPct: 3,
          maxHoldBars: null,
          exitLong: all({ left: ind("fast"), op: "crosses_below", right: ind("slow") }),
          exitShort: all({ left: ind("fast"), op: "crosses_above", right: ind("slow") }),
        },
        risk: { maxLossUsd: t.maxLossUsd, maxTradesPerDay: 2, cooldownBars: 2 },
      };
    case "funding_rate":
      return {
        ...base,
        name: "Funding-rate fader",
        summary: "Short when longs are paying heavy funding, long when shorts are; quick exits.",
        timeframe: "1h",
        direction: "both",
        indicators: [{ id: "funding", type: "funding_rate", period: null }],
        entry: {
          long: all({ left: ind("funding"), op: "<", right: n(-0.0001) }),
          short: all({ left: ind("funding"), op: ">", right: n(0.0001) }),
        },
        exit: {
          stopLossPct: 2,
          takeProfitPct: 1.5,
          trailingStopPct: null,
          maxHoldBars: 24,
          exitLong: null,
          exitShort: null,
        },
        risk: { maxLossUsd: t.maxLossUsd, maxTradesPerDay: 2, cooldownBars: 6 },
      };
    case "breakout":
      return {
        ...base,
        name: "Breakout",
        summary: "Trade a close beyond the 20-candle range in the direction of the break.",
        timeframe: "1h",
        direction: "both",
        indicators: [
          { id: "hi20", type: "highest", period: 20 },
          { id: "lo20", type: "lowest", period: 20 },
        ],
        entry: {
          long: all({ left: price("close"), op: "crosses_above", right: ind("hi20") }),
          short: all({ left: price("close"), op: "crosses_below", right: ind("lo20") }),
        },
        exit: {
          stopLossPct: 2,
          takeProfitPct: 6,
          trailingStopPct: 2,
          maxHoldBars: 48,
          exitLong: null,
          exitShort: null,
        },
        risk: { maxLossUsd: t.maxLossUsd, maxTradesPerDay: 3, cooldownBars: 3 },
      };
  }
}
