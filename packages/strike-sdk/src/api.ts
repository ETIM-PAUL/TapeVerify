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
