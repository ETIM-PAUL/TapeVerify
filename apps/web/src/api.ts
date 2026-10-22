const BASE = import.meta.env.VITE_PIT_API_URL ?? "http://localhost:3001";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    credentials: "include",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? res.statusText, data.code);
  return data as T;
}

export const api = {
  get: <T>(p: string) => request<T>("GET", p),
  post: <T>(p: string, b: unknown = {}) => request<T>("POST", p, b),
};

export type Chain = "cardano" | "ethereum" | "solana";
export interface User {
  id: string;
  chain: Chain;
  address: string;
  handle: string | null;
}
export interface AccountData {
  user: User;
  account: Record<string, string | number | unknown[]>;
  positions: Array<Record<string, string>>;
}
export interface StrikeTx {
  id: string;
  type: number;
  asset_symbol?: string;
  asset_amount?: string;
  amount: string;
  status: number;
  timestamp: number;
  tx_hash?: string;
}

export type CallStatus = "pending" | "open" | "expired" | "closed" | "failed";
export interface Call {
  id: string;
  code: string;
  url: string;
  status: CallStatus;
  symbol: string;
  side: "long" | "short";
  leverage: number;
  size: string;
  tpPrice: string | null;
  slPrice: string | null;
  expiresAt: number;
  maxDriftBps: number;
  createdAt: number;
  entry: { price: string; ts: number | null; fee: string | null } | null;
  exit: {
    price: string;
    ts: number | null;
    reason: string | null;
    realizedPnl: string | null;
  } | null;
  failReason: string | null;
  trader: { handle: string | null; chain: string; address: string };
}
export interface MarketInfo {
  symbol: string;
  baseAsset: string;
  mark: string;
  minSize: string;
  stepSize: string;
  minNotional: string;
  tick: string;
  maxLeverage: number;
}

export interface LiveView {
  mark: string;
  driftBps: number | null;
  movePct: number | null;
  leveragedPct: number | null;
  followable:
    | { ok: true; driftBps: number }
    | { ok: false; reason: "not_open" | "expired" | "drifted"; driftBps?: number };
}
export interface TraderStats {
  calls: number;
  closed: number;
  wins: number;
  winRate: number | null;
  totalPnl: string;
  followers: number;
}
export interface FollowInfo {
  id: string;
  callId: string;
  status: "pending" | "open" | "closed" | "failed";
  marginUsd: string;
  size: string;
  entry: { price: string } | null;
  exit: { price: string; reason: string | null; realizedPnl: string | null } | null;
  failReason: string | null;
  callEntryPrice: string;
  code?: string;
  trader?: string;
}
export interface CallDetail {
  call: Call;
  live: LiveView | null;
  stats: TraderStats;
  viewer: { isOwner: boolean; follow: FollowInfo | null } | null;
}
