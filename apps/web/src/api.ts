const BASE = import.meta.env.VITE_PIT_API_URL ?? "http://localhost:3001";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly data?: Record<string, unknown>,
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
  if (!res.ok) throw new ApiError(res.status, data.error ?? res.statusText, data.code, data);
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
export interface ArgusInfo {
  score: number;
  performance: number;
  confidence: number;
  clean: boolean;
  cleanReasons: string[];
  underReview: boolean;
  worst: "low" | "medium" | "high" | "critical" | null;
  penalties: Array<{
    kind: string;
    severity: string;
    status: string;
    summary: string;
    points: number;
  }>;
}
export interface ArgusFinding {
  id: string;
  kind: string;
  severity: string;
  status: string;
  summary: string;
  detectedAt: number;
  reviewNote: string | null;
  canAppeal: boolean;
  appeal: { status: string; message: string; decisionNote: string | null } | null;
}
export interface MyArgus {
  reputation: ArgusInfo | null;
  findings: ArgusFinding[];
  history: Array<{ ts: number; score: number; previous: number | null; reason: string }>;
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
  argus: ArgusInfo | null;
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
  argus: ArgusInfo | null;
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
  argus: ArgusInfo | null;
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

export interface SimTradeOut {
  id: number;
  side: "long" | "short";
  entryTs: number;
  exitTs: number;
  entryPrice: number;
  exitPrice: number;
  size: number;
  notional: number;
  margin: number;
  leverage: number;
  grossPnl: number;
  fees: number;
  netPnl: number;
  returnPct: number;
  barsHeld: number;
  reason: string;
  liquidated: boolean;
}
export interface BacktestStatsOut {
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  netPnl: number;
  returnPct: number;
  maxDrawdownPct: number;
  profitFactor: number | null;
  expectancy: number | null;
  avgHoldBars: number | null;
  totalFees: number;
  liquidations: number;
  longestLosingStreak: number;
  exposurePct: number;
  consistency: number | null;
  buyAndHoldPct: number | null;
}
export interface BacktestOut {
  id: string;
  params: {
    days: number;
    slippageBps: number;
    startEquity: number;
    takerRate: number;
    builderBps: number;
  };
  result: {
    stats: BacktestStatsOut;
    startEquity: number;
    endEquity: number;
    equityCurve: Array<{ t: number; equity: number }>;
    trades: SimTradeOut[];
    halted: string | null;
    skipped: Record<string, number>;
    coverage: {
      bars: number;
      from: number | null;
      to: number | null;
      missingBars: number;
      warmupBars: number;
    };
    warnings: string[];
  };
}
export interface PaperSummary {
  id: string;
  strategyId: string | null;
  name: string;
  status: "running" | "stopping" | "stopped" | "halted";
  market: string;
  timeframe: string;
  startEquity: number;
  equity: number;
  realizedPnl: number;
  inPosition: boolean;
  startedAt: number;
}
export interface PaperDetail {
  id: string;
  name: string;
  status: PaperSummary["status"];
  stopReason: string | null;
  startEquity: number;
  startedAt: number;
  lastPrice: number | null;
  lastTickAt: number | null;
  equity: number;
  markedEquity: number;
  realizedPnl: number;
  halted: string | null;
  position: {
    side: string;
    entryPrice: number;
    size: number;
    leverage: number;
    stop: number;
    tp: number | null;
    liq: number;
    unrealizedPnl: number | null;
  } | null;
  trades: SimTradeOut[];
  equityCurve: Array<{ t: number; equity: number }>;
  notes: string[];
}

export interface LiveStatus {
  enabled: boolean;
  network: string;
  emergencyStop: boolean;
  maxLeverage: number;
}
export interface LiveRunSummary {
  id: string;
  name: string;
  market: string;
  status: "active" | "stopping" | "stopped" | "halted" | "error";
  stopReason: string | null;
  budget: { maxMarginUsd: number; maxLossUsd: number };
  startedAt: number;
  subAccountId: string | null;
  netPnl: number;
  closedTrades: number;
  inPosition: boolean;
}
export interface LiveRunDetail extends Omit<LiveRunSummary, "closedTrades" | "inPosition"> {
  network: string;
  lastBarAt: number | null;
  lossCap: number | null;
  failures: number;
  trades: Array<{
    seq: number;
    side: string;
    status: string;
    size: string;
    marginUsd: string;
    leverage: number;
    slPrice: string;
    tpPrice: string | null;
    entryPrice: string | null;
    exitPrice: string | null;
    exitReason: string | null;
    realizedPnl: string | null;
    fees: string;
    failReason: string | null;
  }>;
  events: Array<{ id: number; at: number; kind: string; data: Record<string, unknown> }>;
}

export interface ListingSummary {
  id: string;
  title: string;
  creator: { handle: string | null; chain: string; address: string };
  version: number;
  publishedAt: number;
  market: string;
  timeframe: string;
  direction: string;
  leverage: number;
  clones: number;
  liveClones: number;
  creatorShareBps: number;
  record: {
    trades: number;
    winRate: number | null;
    netPnl: number;
    maxDrawdownUsd: number;
    profitFactor: number | null;
    avgReturnOnMarginPct: number | null;
  };
}
export interface ListingDetail {
  id: string;
  title: string;
  description: string;
  status: string;
  version: number;
  creator: ListingSummary["creator"];
  rules: Description;
  market: string;
  timeframe: string;
  direction: string;
  leverage: number;
  record: ListingSummary["record"] & {
    wins: number;
    losses: number;
    volumeUsd: number;
    avgHoldMs: number | null;
    liquidations: number;
    firstTradeMs: number | null;
    lastTradeMs: number | null;
  };
  clones: number;
  liveClones: number;
  terms: { creatorShareBps: number; builderBps: number; note: string };
  warnings: string[];
  trades: Array<{
    seq: number;
    side: string;
    entryPrice: string;
    exitPrice: string;
    entryTs: number;
    exitTs: number;
    net: number;
    reason: string | null;
    orderId: string | null;
    clientOrderId: string;
  }>;
  verification: { source: string; strikeAccountIds: string[]; check: string };
}
export interface Earnings {
  totals: {
    accrued: string;
    paid: string;
    builderFees: string;
    volume: string;
    trades: number;
    payingClones: number;
  };
  listings: Array<{
    id: string;
    title: string;
    status: string;
    version: number;
    creatorShareBps: number;
    accrued: string;
    paid: string;
    volume: string;
    trades: number;
    clones: number;
    liveClones: number;
  }>;
  recent: Array<{
    id: number;
    listingId: string;
    title: string;
    amount: string;
    builderFee: string;
    builderBps: number;
    shareBps: number;
    notional: string;
    status: string;
    at: number;
    payoutRef: string | null;
  }>;
  daily: Array<{ day: string; amount: string }>;
  note: string;
}
