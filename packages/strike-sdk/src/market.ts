import type { StrikeClient } from "./client.js";

const priceBase = (c: StrikeClient) => c.opts.priceUrl ?? `${c.opts.baseUrl}/price`;

export type KlineInterval =
  | "1m"
  | "3m"
  | "5m"
  | "15m"
  | "30m"
  | "1h"
  | "2h"
  | "4h"
  | "6h"
  | "8h"
  | "12h"
  | "1d"
  | "3d"
  | "1w"
  | "1M";
export type PriceType = "last" | "mark" | "index";

export interface Kline {
  openTime: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  closeTime: number;
  quoteVolume: string;
  trades: number;
}

export function parseKline(row: Array<string | number>): Kline {
  return {
    openTime: Number(row[0]),
    open: String(row[1]),
    high: String(row[2]),
    low: String(row[3]),
    close: String(row[4]),
    volume: String(row[5]),
    closeTime: Number(row[6]),
    quoteVolume: String(row[7]),
    trades: Number(row[8]),
  };
}

/** `/price/v2/klines`: max 1500 rows per call. Gaps are filled with the previous close and zero volume. */
export async function getKlines(
  c: StrikeClient,
  q: {
    symbol: string;
    interval: KlineInterval;
    priceType?: PriceType;
    startTime?: number;
    endTime?: number;
    limit?: number;
  },
): Promise<Kline[]> {
  const p = new URLSearchParams({
    symbol: q.symbol,
    interval: q.interval,
    priceType: q.priceType ?? "last",
  });
  if (q.startTime !== undefined) p.set("startTime", String(q.startTime));
  if (q.endTime !== undefined) p.set("endTime", String(q.endTime));
  p.set("limit", String(Math.min(q.limit ?? 1500, 1500)));
  const rows = await c.publicGet<Array<Array<string | number>>>(`/v2/klines?${p}`, priceBase(c));
  return Array.isArray(rows) ? rows.map(parseKline) : [];
}

export interface PublicTrade {
  id: number;
  price: string;
  qty: string;
  quoteQty: string;
  time: number;
  isBuyerMaker: boolean;
}

/** Latest trades only (max 1000): the endpoint has no pagination, so history must be streamed. */
export const getTrades = (c: StrikeClient, symbol: string, limit = 1000) =>
  c.publicGet<PublicTrade[]>(
    `/v2/trades?symbol=${encodeURIComponent(symbol)}&limit=${limit}`,
    priceBase(c),
  );

export interface DepthSnapshot {
  lastUpdateId: number;
  /** Event time, ms. */
  E: number;
  bids: Array<[string, string]>;
  asks: Array<[string, string]>;
}

export const getDepth = (c: StrikeClient, symbol: string, limit = 20) =>
  c.publicGet<DepthSnapshot>(
    `/v2/depth?symbol=${encodeURIComponent(symbol)}&limit=${limit}`,
    priceBase(c),
  );

export interface MarkPrice {
  s: string;
  /** Mark price. */
  p: string;
  /** Index price. */
  i: string;
  /** Funding rate. */
  r: string;
  E: number;
}

export const getMarkPrice = (c: StrikeClient, symbol: string) =>
  c.publicGet<MarkPrice>(`/v2/markPrice?symbol=${encodeURIComponent(symbol)}`, priceBase(c));

export const getMarketSymbols = async (c: StrikeClient): Promise<string[]> =>
  Object.keys((await c.publicGet<{ markets: Record<string, unknown> }>("/v2/markets")).markets);

// ── L3 (order-level book) ──

export interface L3SnapshotOrder {
  order_id: string;
  size: string;
}
export interface L3PriceLevel {
  price: string;
  orders: L3SnapshotOrder[];
}
export interface L3Snapshot {
  type: "l3_snapshot";
  symbol: string;
  last_sequence: number;
  timestamp: number;
  bids: L3PriceLevel[];
  asks: L3PriceLevel[];
}

export type L3Action = "open" | "modify" | "cancel" | "partial_fill" | "full_fill" | "clear";

export interface L3Update {
  type: "l3_update";
  symbol: string;
  action: L3Action;
  sequence: number;
  timestamp: number;
  order_id?: string;
  taker_order_id?: string;
  side?: "buy" | "sell";
  price?: string;
  delta_size?: string;
  remaining_size?: string;
  trade_id?: number;
}

export const getL3Snapshot = (c: StrikeClient, symbol: string) =>
  c.publicGet<L3Snapshot>(`/v2/l3/snapshot?symbol=${encodeURIComponent(symbol)}`);

/** Per-market trading rules from `/v2/markets` (decimals are strings). */
export interface MarketRules {
  symbol: string;
  base_asset: string;
  status: string;
  reduce_only: boolean;
  default_leverage: number;
  margin_tiers: Array<{
    max_notional: string;
    max_leverage: number;
    maintenance_margin_rate: string;
  }>;
  order_tick_price: string;
  order_min_price: string;
  order_max_price: string;
  order_market_step_size: string;
  order_market_min_size: string;
  order_market_max_size: string;
  order_min_notional: string;
  trigger_protect?: string;
  mark_price: string;
  [k: string]: unknown;
}

export const getMarketRules = async (c: StrikeClient): Promise<Record<string, MarketRules>> =>
  (await c.publicGet<{ markets: Record<string, MarketRules> }>("/v2/markets")).markets;

export interface FeeTier {
  Tier: number;
  MinVolume: number;
  TakerRate: number;
  MakerRate: number;
}

/** Public fee schedule (`/v2/fee-tiers`). Tier 0 is what a new account pays. */
export const getFeeTiers = (c: StrikeClient) =>
  c.publicGet<{ feeTiers: FeeTier[] }>("/v2/fee-tiers");
