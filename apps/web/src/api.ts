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
  put: <T>(p: string, b: unknown = {}) => request<T>("PUT", p, b),
  del: <T>(p: string) => request<T>("DELETE", p),
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

export type Timeframe = "24h" | "7d" | "30d" | "all";
export interface StatsOut {
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  netPnl: string;
  totalReturnPct: number | null;
  maxDrawdownPct: number | null;
  avgHoldMs: number | null;
  consistency: number | null;
  effectiveLeverage: number | null;
  activeDays: number;
  tradesWithoutCapital: number;
  bestTradePnl: string | null;
  worstTradePnl: string | null;
}
export interface LeaderEntry {
  rank: number;
  ref: string;
  handle: string | null;
  chain: string;
  address: string;
  stats: StatsOut;
  volume: string;
  risk: "low" | "medium" | "high" | "unknown";
}
export interface Leaderboard {
  timeframe: Timeframe;
  minimums: { trades: number; activeDays: number; volumeUsd: number };
  total: number;
  entries: LeaderEntry[];
}
export interface TradeRow {
  id: string;
  symbol: string;
  side: "long" | "short";
  openedAt: number;
  closedAt: number;
  size: string;
  entryPrice: string;
  exitPrice: string;
  grossPnl: string;
  fees: string;
  funding: string;
  netPnl: string;
  liquidated: boolean;
  split: boolean;
  fills: number;
}
export interface Profile {
  trader: { ref: string; handle: string | null; chain: string; address: string };
  stats: StatsOut;
  volume: string;
  risk: LeaderEntry["risk"];
  ranked: boolean;
  unrankedReason: string | null;
  minimums: Leaderboard["minimums"];
  curve: Array<{ ts: number; index: number }>;
  calls: Array<{
    code: string;
    symbol: string;
    side: string;
    leverage: number;
    status: string;
    entry: { price: string } | null;
    exit: { price: string; reason: string | null; realizedPnl: string | null } | null;
    createdAt: number;
  }>;
  followers: { count: number; notionalFollowed: string };
  verification: {
    source: string;
    fills: number;
    trades: number;
    capitalFlows: number;
    firstFillAt: number | null;
    lastFillAt: number | null;
    method: Record<string, string>;
  };
}

export interface Issue {
  path: string;
  message: string;
}
export interface RuleLine {
  label: string;
  text: string;
}
export interface Description {
  headline: string;
  lines: RuleLine[];
}
// biome-ignore lint/suspicious/noExplicitAny: the strategy spec is edited as JSON; the server validates it
export type SpecJson = any;
export interface DraftOut {
  spec: SpecJson;
  assumptions: string[];
  description: Description;
  warnings: Issue[];
  attempts: number;
}
export interface TemplateOut {
  id: string;
  title: string;
  blurb: string;
  needsFundingHistory: boolean;
  spec: SpecJson;
  description: Description;
  warnings: Issue[];
}
export interface SavedStrategy {
  id: string;
  name: string;
  source: string;
  status: string;
  market: string;
  timeframe: string;
  direction: string;
  updatedAt: number;
}
export interface ValidateOut {
  ok: boolean;
  issues: Issue[];
  warnings: Issue[];
  description: Description | null;
}
