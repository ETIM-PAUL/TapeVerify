import type { StrikeClient } from "./client.js";

export interface Account {
  [k: string]: unknown;
}

export const getAccount = (c: StrikeClient) => c.get<Account>("/v2/account");
export const getPortfolio = (c: StrikeClient) => c.get<Record<string, unknown>>("/v2/portfolio");
export const getSubAccounts = (c: StrikeClient) =>
  c.get<{ sub_accounts: Array<Record<string, unknown>> }>("/v2/sub-accounts");

export const getPositions = async (c: StrikeClient, subAccountId?: string) => {
  const qs = subAccountId ? `?sub_account_id=${encodeURIComponent(subAccountId)}` : "";
  const r = await c.get<{ positions?: Array<Record<string, unknown>> }>(`/v2/positions${qs}`);
  return r.positions ?? [];
};

export const getMarkets = (c: StrikeClient) =>
  c.publicGet<{ markets: Record<string, Record<string, unknown>> }>("/v2/markets");

export interface FillHistoryQuery {
  /** Public selector: no auth needed. */
  blockchainAddress?: string;
  accountId?: string;
  limit?: number;
  fromId?: string;
  sinceTradeId?: string;
  symbol?: string;
}

/** `/v2/history/fill`. `sinceTradeId` polls forward, `fromId` pages backward. */
export function getFills(c: StrikeClient, q: FillHistoryQuery = {}) {
  const p = new URLSearchParams();
  if (q.blockchainAddress) p.set("blockchain_address", q.blockchainAddress);
  if (q.accountId) p.set("account_id", q.accountId);
  if (q.symbol) p.set("symbol", q.symbol);
  if (q.limit) p.set("limit", String(q.limit));
  if (q.fromId) p.set("fromId", q.fromId);
  if (q.sinceTradeId) p.set("since_trade_id", q.sinceTradeId);
  const qs = p.toString();
  const path = `/v2/history/fill${qs ? `?${qs}` : ""}`;
  const publicSel = q.blockchainAddress || q.accountId;
  return publicSel
    ? c.publicGet<{ fills: Array<Record<string, unknown>>; count: number }>(path)
    : c.get<{ fills: Array<Record<string, unknown>>; count: number }>(path);
}

export interface StrikeFill {
  id: string;
  trade_id: number;
  order_id: string;
  account_id: string;
  symbol: string;
  side: "buy" | "sell";
  role: "maker" | "taker";
  price: string;
  size: string;
  realized_pnl: string;
  fee: string;
  fee_type: string;
  timestamp: number;
  auto_close_type?: string;
  liquidation_fee?: string;
  entry_price?: string;
  close_price?: string;
  margin?: string;
  roi_pct?: string;
  leverage?: number | string;
}

/** Public fill history by account id (no auth): `since_trade_id` polls forward in ascending order. */
export async function getAccountFills(
  c: StrikeClient,
  accountId: string,
  q: { sinceTradeId?: number; fromId?: string; limit?: number } = {},
): Promise<StrikeFill[]> {
  const p = new URLSearchParams({ account_id: accountId, limit: String(q.limit ?? 1000) });
  if (q.sinceTradeId !== undefined) p.set("since_trade_id", String(q.sinceTradeId));
  if (q.fromId) p.set("fromId", q.fromId);
  const r = await c.publicGet<{ fills: StrikeFill[] | null }>(`/v2/history/fill?${p}`);
  return r.fills ?? [];
}

export interface StrikeFunding {
  id: string;
  transaction_id?: string;
  account_id: string;
  position_id?: string;
  symbol: string;
  position_size: string;
  position_side: string;
  funding_rate: string;
  amount: string;
  timestamp: number;
}

/** Public funding history by account id; pages backward from the newest with `fromId`. */
export async function getAccountFunding(
  c: StrikeClient,
  accountId: string,
  q: { fromId?: string; limit?: number } = {},
): Promise<StrikeFunding[]> {
  const p = new URLSearchParams({ account_id: accountId, limit: String(q.limit ?? 1000) });
  if (q.fromId) p.set("fromId", q.fromId);
  const r = await c.publicGet<{ funding: StrikeFunding[] | null }>(`/v2/history/funding?${p}`);
  return r.funding ?? [];
}

export interface StrikeOrder {
  id: number;
  client_order_id: string;
  account_id: string;
  symbol: string;
  strategy_id?: string;
  is_primary?: boolean;
  close_reason?: string;
  error_message?: string;
  side: "buy" | "sell";
  status: "pending" | "open" | "filled" | "canceled" | "untriggered" | "rejected" | "expired";
  type: string;
  auto_close_type?: string;
  size: string;
  filled: string;
  price: string;
  stop_price: string;
  create_timestamp: number;
  entry_timestamp: number;
  event_timestamp: number;
}

/** Public order history by account id (newest first). Rejections appear here with `error_message`. */
export async function getAccountOrders(
  c: StrikeClient,
  accountId: string,
  q: { symbol?: string; limit?: number } = {},
): Promise<StrikeOrder[]> {
  const p = new URLSearchParams({ account_id: accountId, limit: String(q.limit ?? 100) });
  if (q.symbol) p.set("symbol", q.symbol);
  const r = await c.publicGet<{ orders: StrikeOrder[] | null }>(`/v2/history/order?${p}`);
  return r.orders ?? [];
}

/** Fills of one order (public). */
export async function getOrderFills(
  c: StrikeClient,
  accountId: string,
  orderId: number,
): Promise<StrikeFill[]> {
  const p = new URLSearchParams({
    account_id: accountId,
    order_id: String(orderId),
    limit: "1000",
  });
  const r = await c.publicGet<{ fills: StrikeFill[] | null }>(`/v2/history/fill?${p}`);
  return r.fills ?? [];
}

export interface StrikePosition {
  id: number;
  symbol: string;
  /** Signed size in base units (non-zero when open). */
  size: string;
  entry_price: string;
  leverage: number;
  margin_mode: string;
  liquidation_price: string;
  upnl: string;
  create_timestamp: number;
}

/** Open positions by account id (public). */
export async function getAccountPositions(
  c: StrikeClient,
  accountId: string,
  symbol?: string,
): Promise<StrikePosition[]> {
  const p = new URLSearchParams({ account_id: accountId });
  if (symbol) p.set("symbol", symbol);
  const r = await c.publicGet<{ positions: StrikePosition[] | null }>(`/v2/positions?${p}`);
  return (r.positions ?? []).filter((x) => Number(x.size) !== 0);
}
