import { z } from "zod";

/**
 * Strategy spec v1: the only thing the AI ever produces. It is plain data (no code, no order
 * calls). A separate runner turns a validated spec into orders; the model never touches Strike.
 *
 * Evaluation model (shared by the backtester and the live runner): rules are evaluated when a candle
 * CLOSES, on closed-candle values only. "crosses_above" means left <= right on the previous candle
 * and left > right on this one.
 */

export const CANDLE_TIMEFRAMES = ["5m", "15m", "1h", "4h", "1d"] as const;
export const INDICATOR_TYPES = [
  "sma",
  "ema",
  "rsi",
  "atr",
  "highest",
  "lowest",
  "roc",
  "funding_rate",
] as const;
export const OPERATORS = [">", "<", ">=", "<=", "crosses_above", "crosses_below"] as const;
export const PRICE_FIELDS = ["open", "high", "low", "close"] as const;
export const DIRECTIONS = ["long", "short", "both"] as const;
export const SIZING_MODES = ["fixed_margin_usd", "pct_of_equity"] as const;

export type CandleTimeframe = (typeof CANDLE_TIMEFRAMES)[number];
export type IndicatorType = (typeof INDICATOR_TYPES)[number];
export type Operator = (typeof OPERATORS)[number];

export const ID_PATTERN = /^[a-z][a-z0-9_]{0,15}$/;

const nullable = <T extends z.ZodTypeAny>(t: T) => t.nullable();

export const operandSchema = z
  .object({
    kind: z.enum(["indicator", "number", "price"]),
    indicator: nullable(z.string()),
    value: nullable(z.number()),
    price: nullable(z.enum(PRICE_FIELDS)),
  })
  .strict();

export const ruleSchema = z
  .object({ left: operandSchema, op: z.enum(OPERATORS), right: operandSchema })
  .strict();

export const conditionSchema = z
  .object({ match: z.enum(["all", "any"]), rules: z.array(ruleSchema) })
  .strict();

export const indicatorSchema = z
  .object({
    id: z.string(),
    type: z.enum(INDICATOR_TYPES),
    /** Look-back in candles. Null only for funding_rate. */
    period: nullable(z.number().int()),
  })
  .strict();

export const strategySpecSchema = z
  .object({
    version: z.literal(1),
    name: z.string(),
    summary: z.string(),
    market: z.string(),
    timeframe: z.enum(CANDLE_TIMEFRAMES),
    direction: z.enum(DIRECTIONS),
    indicators: z.array(indicatorSchema),
    entry: z.object({ long: nullable(conditionSchema), short: nullable(conditionSchema) }).strict(),
    exit: z
      .object({
        stopLossPct: z.number(),
        takeProfitPct: nullable(z.number()),
        trailingStopPct: nullable(z.number()),
        maxHoldBars: nullable(z.number().int()),
        exitLong: nullable(conditionSchema),
        exitShort: nullable(conditionSchema),
      })
      .strict(),
    sizing: z
      .object({
        mode: z.enum(SIZING_MODES),
        value: z.number(),
        leverage: z.number().int(),
      })
      .strict(),
    risk: z
      .object({
        /** Cumulative loss at which the strategy stops itself. */
        maxLossUsd: z.number(),
        maxTradesPerDay: nullable(z.number().int()),
        cooldownBars: z.number().int(),
      })
      .strict(),
  })
  .strict();

export type Operand = z.infer<typeof operandSchema>;
export type Rule = z.infer<typeof ruleSchema>;
export type Condition = z.infer<typeof conditionSchema>;
export type IndicatorDef = z.infer<typeof indicatorSchema>;
export type StrategySpec = z.infer<typeof strategySpecSchema>;

/** What the model returns: a spec, or a refusal when the request isn't a trading strategy. */
export const draftEnvelopeSchema = z
  .object({
    rejected: nullable(z.string()),
    assumptions: z.array(z.string()),
    spec: nullable(strategySpecSchema),
  })
  .strict();
export type DraftEnvelope = z.infer<typeof draftEnvelopeSchema>;

// ── JSON Schema for OpenAI structured outputs (strict mode: every key required, no extras) ──

const num = { type: "number" };
const int = { type: "integer" };
const nul = (t: Record<string, unknown>) => ({ anyOf: [t, { type: "null" }] });
const str = { type: "string" };
const obj = (props: Record<string, unknown>) => ({
  type: "object",
  properties: props,
  required: Object.keys(props),
  additionalProperties: false,
});
const operand = obj({
  kind: { type: "string", enum: ["indicator", "number", "price"] },
  indicator: nul(str),
  value: nul(num),
  price: nul({ type: "string", enum: [...PRICE_FIELDS] }),
});
const rule = obj({ left: operand, op: { type: "string", enum: [...OPERATORS] }, right: operand });
const condition = obj({
  match: { type: "string", enum: ["all", "any"] },
  rules: { type: "array", items: rule },
});

export function draftJsonSchema(markets: string[]): Record<string, unknown> {
  const spec = obj({
    version: { type: "integer", enum: [1] },
    name: str,
    summary: str,
    market: { type: "string", enum: markets },
    timeframe: { type: "string", enum: [...CANDLE_TIMEFRAMES] },
    direction: { type: "string", enum: [...DIRECTIONS] },
    indicators: {
      type: "array",
      items: obj({
        id: str,
        type: { type: "string", enum: [...INDICATOR_TYPES] },
        period: nul(int),
      }),
    },
    entry: obj({ long: nul(condition), short: nul(condition) }),
    exit: obj({
      stopLossPct: num,
      takeProfitPct: nul(num),
      trailingStopPct: nul(num),
      maxHoldBars: nul(int),
      exitLong: nul(condition),
      exitShort: nul(condition),
    }),
    sizing: obj({ mode: { type: "string", enum: [...SIZING_MODES] }, value: num, leverage: int }),
    risk: obj({ maxLossUsd: num, maxTradesPerDay: nul(int), cooldownBars: int }),
  });
  return obj({ rejected: nul(str), assumptions: { type: "array", items: str }, spec: nul(spec) });
}
