import type { StrikeClient } from "./client.js";

export interface CreateOrderRequest {
  symbol: string;
  side: "buy" | "sell";
  type: "market" | "limit" | "stop" | "stop_limit" | "take_profit" | "take_profit_limit";
  size: string;
  price?: string;
  time_in_force?: "GTC" | "FOK" | "IOC";
  reduce_only?: boolean;
  client_order_id?: string;
  sub_account_id?: string;
  vault_id?: string;
}

export interface StrategyLeg {
  type: "take_profit" | "stop";
  size: string;
  stop_price: string;
  working_type?: "mark_price" | "last_price";
}

export interface CreateStrategyOrderRequest extends CreateOrderRequest {
  strategy_id: string;
  tp_order?: StrategyLeg;
  sl_order?: StrategyLeg;
}

type Json = Record<string, unknown>;

// Order placement is never auto-retried (POST); callers use client_order_id for idempotency.
export const placeOrder = (c: StrikeClient, req: CreateOrderRequest, feeBps?: number) =>
  c.post<Json>("/v2/order", req, { headers: c.builderFeeHeaders(feeBps) });

export const placeStrategyOrder = (
  c: StrikeClient,
  req: CreateStrategyOrderRequest,
  feeBps?: number,
) => c.post<Json>("/v2/order/strategy", req, { headers: c.builderFeeHeaders(feeBps) });

export const cancelOrder = (
  c: StrikeClient,
  req: { symbol: string; order_id?: number; client_order_id?: string; sub_account_id?: string },
) => c.delete<Json>("/v2/order/cancel", req);

export const cancelAllOrders = (c: StrikeClient, symbol?: string) =>
  c.delete<Json>("/v2/order/cancel-all", symbol ? { symbol } : {});

/** Per-symbol leverage (1..125, capped by the market's tier). Applies to the whole account for that symbol. */
export const setLeverage = (
  c: StrikeClient,
  symbol: string,
  leverage: number,
  subAccountId?: string,
) =>
  c.post<{ leverage: number; maxNotionalValue: string; symbol: string; request_id: string }>(
    "/v2/leverage",
    {
      symbol,
      leverage,
      ...(subAccountId ? { sub_account_id: subAccountId } : {}),
    },
  );

/** Market close of the whole position: opposite side, reduce-only. */
export const closePositionOrder = (
  c: StrikeClient,
  p: {
    symbol: string;
    side: "buy" | "sell";
    size: string;
    client_order_id?: string;
    sub_account_id?: string;
  },
  feeBps?: number,
) =>
  c.post<Json>(
    "/v2/order",
    { ...p, type: "market", reduce_only: true, close_position: true },
    { headers: c.builderFeeHeaders(feeBps) },
  );

/** Reduce-only trailing stop (callback 0.1 to 5 percent). Placed after the entry has filled. */
export const placeTrailingStop = (
  c: StrikeClient,
  p: {
    symbol: string;
    side: "buy" | "sell";
    size: string;
    callbackRate: string;
    client_order_id?: string;
    sub_account_id?: string;
  },
  feeBps?: number,
) =>
  c.post<Json>(
    "/v2/order",
    {
      symbol: p.symbol,
      side: p.side,
      type: "trailing_stop_market",
      size: p.size,
      callback_rate: p.callbackRate,
      reduce_only: true,
      ...(p.client_order_id ? { client_order_id: p.client_order_id } : {}),
      ...(p.sub_account_id ? { sub_account_id: p.sub_account_id } : {}),
    },
    { headers: c.builderFeeHeaders(feeBps) },
  );
