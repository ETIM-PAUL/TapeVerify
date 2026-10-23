import { cmp, isOnGrid, mul, roundToGrid } from "./decimal-math.js";

/** The subset of `/v2/markets` rules needed to check a market order with TP/SL. */
export interface MarketRulesLite {
  symbol: string;
  base_asset: string;
  status: string;
  reduce_only: boolean;
  margin_tiers: Array<{ max_notional: string; max_leverage: number }>;
  order_tick_price: string;
  order_min_price: string;
  order_max_price: string;
  order_market_step_size: string;
  order_market_min_size: string;
  order_market_max_size: string;
  order_min_notional: string;
  mark_price: string;
}

export type CallSide = "long" | "short";

export interface CallOrderInput {
  side: CallSide;
  size: string;
  leverage: number;
  tpPrice?: string;
  slPrice?: string;
}

export type ValidationCode =
  | "market_unavailable"
  | "bad_size"
  | "bad_leverage"
  | "bad_exit"
  | "no_exit";

export type CallOrderCheck =
  | {
      ok: true;
      size: string;
      tpPrice?: string;
      slPrice?: string;
      notional: string;
      maxLeverage: number;
    }
  | { ok: false; code: ValidationCode; error: string };

const fail = (code: ValidationCode, error: string): CallOrderCheck => ({ ok: false, code, error });

/**
 * Checks a market order with TP/SL against Strike's published rules (mirrors the engine's admission
 * checks for market orders). TP/SL prices are rounded to the market's tick; the rounded values are returned.
 */
export function validateCallOrder(m: MarketRulesLite, input: CallOrderInput): CallOrderCheck {
  if (m.status !== "trading") return fail("market_unavailable", `${m.symbol} is ${m.status}`);
  if (m.reduce_only) return fail("market_unavailable", `${m.symbol} is reduce-only`);

  const size = input.size;
  if (!/^\d+(\.\d+)?$/.test(size)) return fail("bad_size", "Size must be a positive number");
  if (cmp(size, m.order_market_min_size) < 0)
    return fail("bad_size", `Minimum size is ${m.order_market_min_size} ${m.base_asset}`);
  if (cmp(size, m.order_market_max_size) > 0)
    return fail("bad_size", `Maximum size is ${m.order_market_max_size} ${m.base_asset}`);
  if (!isOnGrid(size, m.order_market_min_size, m.order_market_step_size)) {
    return fail(
      "bad_size",
      `Size must be ${m.order_market_min_size} plus a multiple of ${m.order_market_step_size}`,
    );
  }

  const mark = m.mark_price;
  const notional = mul(size, mark);
  if (cmp(notional, m.order_min_notional) < 0) {
    return fail(
      "bad_size",
      `Minimum order value is $${m.order_min_notional} (this is about $${notional.split(".")[0]})`,
    );
  }

  if (!Number.isInteger(input.leverage) || input.leverage < 1 || input.leverage > 125) {
    return fail("bad_leverage", "Leverage must be a whole number from 1 to 125");
  }
  const tier = m.margin_tiers.find((t) => cmp(notional, t.max_notional) <= 0);
  if (!tier) return fail("bad_size", "Position is larger than the market allows");
  if (input.leverage > tier.max_leverage) {
    return fail("bad_leverage", `Maximum leverage at this size is ${tier.max_leverage}x`);
  }

  if (!input.tpPrice && !input.slPrice)
    return fail("no_exit", "Set a take-profit, a stop-loss, or both");

  const long = input.side === "long";
  const exit = (
    label: "Take-profit" | "Stop-loss",
    raw: string | undefined,
    shouldBeAbove: boolean,
  ) => {
    if (!raw) return { value: undefined as string | undefined };
    if (!/^\d+(\.\d+)?$/.test(raw)) return { error: `${label} must be a positive price` };
    if (cmp(raw, m.order_min_price) < 0)
      return {
        error: `${label} must be at least $${m.order_min_price} on ${m.symbol} (Strike's minimum price)`,
      };
    const price = roundToGrid(raw, m.order_min_price, m.order_tick_price);
    if (cmp(price, "0") === 0) return { error: `${label} must be above zero` };
    if (cmp(m.order_max_price, "0") > 0 && cmp(price, m.order_max_price) > 0)
      return { error: `${label} is above the maximum price` };
    const above = cmp(price, mark) > 0;
    if (cmp(price, mark) === 0 || above !== shouldBeAbove) {
      return {
        error: `${label} must be ${shouldBeAbove ? "above" : "below"} the current price (${mark}) for a ${input.side}`,
      };
    }
    return { value: price };
  };
  const tp = exit("Take-profit", input.tpPrice, long);
  if ("error" in tp) return fail("bad_exit", tp.error as string);
  const sl = exit("Stop-loss", input.slPrice, !long);
  if ("error" in sl) return fail("bad_exit", sl.error as string);

  return {
    ok: true,
    size,
    tpPrice: tp.value,
    slPrice: sl.value,
    notional,
    maxLeverage: tier.max_leverage,
  };
}
