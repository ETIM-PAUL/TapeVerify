// On localhost the API is on its own port. Opened through a tunnel, the same address serves the API too.
const LOCAL = ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
const BASE = import.meta.env.VITE_TAPE_API_URL ?? (LOCAL ? "http://localhost:3001" : "");

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

/** The server's "Invalid request" is useless on its own; say which field was wrong. */
export function explainError(e: unknown): string {
  if (e instanceof ApiError && Array.isArray(e.data?.issues)) {
    const issues = (e.data.issues as unknown[]).map((i) =>
      typeof i === "string"
        ? i
        : `${String((i as { path?: unknown[] }).path?.join(".") || "request")}: ${(i as { message?: string }).message ?? "invalid"}`,
    );
    if (issues.length) return `${(e as Error).message}: ${issues.join("; ")}`;
  }
  return (e as Error).message;
}

export const OFFLINE =
  "TapeVerify's server isn't responding. Make sure the API is running, then try again.";

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      credentials: "include",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, OFFLINE, "offline");
  }
  const data = await res.json().catch(() => ({}));
  // A dev proxy answers with an empty 5xx when the API behind it is down.
  if (!res.ok && data.error === undefined && res.status >= 500)
    throw new ApiError(res.status, OFFLINE, "offline", data);
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
  premium?: boolean;
  publicAt?: number | null;
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
  minPrice: string;
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
export interface VerifyInfo {
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
export interface VerifyFinding {
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
export interface MyVerify {
  reputation: VerifyInfo | null;
  findings: VerifyFinding[];
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
  /** A premium call the viewer hasn't unlocked: `call` then holds only the teaser. */
  locked?: boolean;
  creator?: string;
  plan?: { priceUsdc: string; periodDays: number } | null;
  call: Call;
  live: LiveView | null;
  stats: TraderStats;
  verify: VerifyInfo | null;
  followerFills: { fills: number; avgScore: number; avgSlippageBps: number | null } | null;
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
  verify: VerifyInfo | null;
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
  fairFill: FairTrade | null;
}
export type FillBasis = "l3" | "depth" | "mark" | "candle" | "maker" | "none";
export interface FairTrade {
  score: number | null;
  slippageBps: number | null;
  basis: FillBasis;
  scored: number;
  of: number;
}
export interface FairFillInfo {
  basis: FillBasis;
  refPrice: string | null;
  expectedPrice: string | null;
  slippageBps: number | null;
  score: number | null;
  note: string | null;
}
export interface FairSummary {
  trades: number;
  scoredTrades: number;
  avgScore: number | null;
  avgSlippageBps: number | null;
}
export interface RecordRow {
  id: number;
  seq: number;
  takenAt: number;
  recordHash: string;
  tradeCount: number;
  stats: Record<string, unknown>;
  batchId: number | null;
  anchor: { chain: string; cluster: string; signature: string } | null;
}
export interface RecordCheck {
  name: string;
  ok: boolean;
  detail?: string;
}
export interface RecordVerification {
  publicKey: string;
  recordHash: string;
  checks: RecordCheck[];
  verified: boolean;
  anchor: { chain: string; cluster: string; signature: string; memo: string } | null;
}
export interface HealthOut {
  status: "ok" | "watch" | "alert" | "unknown";
  reasons: string[];
  sampledAt: number | null;
  slp: {
    name: string;
    equity: number;
    walletBalance: number;
    sharePrice: number;
    depositors: number;
    allTimePnl: number;
    status: string;
  } | null;
  series: Array<{ t: number; equity: number; sharePrice: number }>;
  lockers: { status: string; reason: string };
  network: string;
}
export interface AlertOut {
  id: string;
  followId: string;
  callCode: string;
  symbol: string;
  side: "long" | "short";
  leverage: number;
  level: "warn" | "danger" | "critical";
  entryPrice: string;
  markPrice: string;
  liquidationPrice: string;
  used: number;
  raisedAt: number;
  resolvedAt: number | null;
  resolution: string | null;
}
export interface Profile {
  fans: number;
  viewer: { isSelf: boolean; following: boolean } | null;
  fairFill: FairSummary | null;
  trader: { ref: string; handle: string | null; chain: string; address: string };
  verify: VerifyInfo | null;
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
    locked?: boolean;
    side?: string;
    leverage?: number;
    status: string;
    entry?: { price: string } | null;
    exit?: { price: string; reason: string | null; realizedPnl: string | null } | null;
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

export interface FeedEvent {
  kind: "call_opened" | "call_closed" | "trade_closed";
  at: number;
  trader: {
    ref: string;
    name: string;
    chain: string;
    verify: { clean?: boolean; underReview?: boolean; score?: number } | null;
  };
  call?: {
    code: string;
    symbol: string;
    locked?: boolean;
    side?: "long" | "short";
    leverage?: number;
    status?: "open" | "expired" | "closed";
    entryPrice?: string;
    exitPrice?: string | null;
    exitReason?: string | null;
    comments: number;
  };
  trade?: {
    symbol: string;
    side: "long" | "short";
    entryPrice: string;
    exitPrice: string;
    netPnl: string;
    liquidated: boolean;
  };
}
export interface CommentOut {
  id: string;
  body: string;
  at: number;
  author: { ref: string; name: string; isCaller: boolean };
  canDelete: boolean;
}
export interface NotificationOut {
  id: string;
  kind: string;
  title: string;
  body: string;
  url: string | null;
  at: number;
  read: boolean;
}
export interface ConnectionsOut {
  telegram: { available: boolean; bot: string | null; linked: boolean; username: string | null };
  x: { available: boolean };
  channels: Array<{ id: string; kind: "telegram" | "x"; title: string; active: boolean }>;
}
export interface VaultOut {
  eligible: boolean;
  criteria: Array<{ key: string; label: string; have: string; need: string; met: boolean }>;
  vault: {
    id: string;
    name: string;
    status: string;
    equity: string;
    sharePrice: string;
    depositors: number;
    allTimePnl: string;
    leaderCommissionBps: number;
  } | null;
  lookupFailed: boolean;
  handedOffAt: number | null;
  steps: string[];
  note: string;
}

export interface GuardrailsData {
  maxMarginUsd: number | null;
  maxLossUsd: number | null;
  maxLeverage: number | null;
  maxDriftBps: number | null;
  maxOpenCopies: number | null;
  dailyLossLimitUsd: number | null;
  requireCleanCaller: boolean;
}
export interface GuardrailsOut {
  guardrails: GuardrailsData;
  summary: string[];
  recommended: GuardrailsData;
  isSet: boolean;
}
export type GuardResultOut =
  | { ok: true; marginUsd: number; leverage: number; adjustments: string[] }
  | { ok: false; code: string; reason: string };
export interface FollowPreview {
  followable: boolean;
  guard: GuardResultOut;
  guardrails: string[];
  requested: { marginUsd: string; leverage: number };
}
export interface ReplayRowOut {
  code: string;
  symbol: string;
  side: "long" | "short";
  leverage: number;
  entryTs: number;
  copied: boolean;
  skipReason: string | null;
  adjustments: string[];
  marginUsd: number;
  leverageUsed: number;
  netPnl: number;
  fees: number;
  slippageCost: number;
  liquidated: boolean;
  callerReturnPct: number;
  yourReturnPct: number | null;
}
export interface ReplayOut {
  params: { calls: number; marginUsd: number; entrySlippageBps: number; exitSlippageBps: number };
  guardrails: string[];
  assumptions: string[];
  caveats: string[];
  measuredFollowers: number;
  rows: ReplayRowOut[];
  curve: Array<{ t: number; equity: number }>;
  summary: {
    considered: number;
    copied: number;
    skipped: number;
    netPnl: number;
    fees: number;
    slippageCost: number;
    marginDeployed: number;
    returnOnMarginPct: number | null;
    winRate: number | null;
    maxDrawdownUsd: number;
    worstCall: number | null;
    callerAvgReturnPct: number | null;
    yourAvgReturnPct: number | null;
    liquidations: number;
  };
}

export interface PlanInfo {
  creator: { ref: string; name: string };
  plan: { priceUsdc: string; periodDays: number; chains: Chain[] } | null;
  subscribers: number;
  premiumOpen: number;
  viewer: {
    isSelf: boolean;
    chain: Chain | null;
    subscribed: boolean;
    endsAt: number | null;
  } | null;
}
export interface MyPlan {
  plan: {
    priceUsdc: string;
    periodDays: number;
    payAddress: string | null;
    ethAddress: string | null;
    adaAddress: string | null;
    active: boolean;
  } | null;
  activeSubscribers: number;
  subscribers: Array<{ name: string; endsAt: number; active: boolean }>;
  revenueUsdc: string;
  payments: number;
  recent: Array<{ name: string; amountUsdc: string; at: number; signature: string }>;
  network: string;
}
export interface SubIntent {
  paymentId: string;
  pay: {
    address: string;
    amountUsdc: string;
    /** What to send, in the asset below (for ADA this differs from the USD price). */
    amount: string;
    asset: "USDC" | "ADA";
    /** Ethereum and Cardano payments must match this amount exactly: it identifies the payer. */
    exact: boolean;
    mint: string;
    memo: string | null;
    chain: Chain;
    network: string;
  };
  periodDays: number;
  expiresAt: number;
  steps: string[];
}
export interface MySubscription {
  ref: string;
  name: string;
  endsAt: number;
  active: boolean;
  premiumOpen: number;
}

export interface LookupCheck {
  name: string;
  ok: boolean;
  detail?: string;
}
export type LookupOut =
  | { type: "unknown"; message: string }
  | {
      type: "record";
      recordId: number;
      trader: string;
      seq: number;
      takenAt: number;
      batched: boolean;
    }
  | {
      type: "call";
      locked: true;
      trader: { ref: string; name: string };
      code: string;
      message: string;
    }
  | {
      type: "call";
      locked: false;
      trader: { ref: string; name: string };
      call: {
        code: string;
        symbol: string;
        side: "long" | "short";
        leverage: number;
        status: string;
        entry: { price: string; size: string | null; at: number | null } | null;
        exit: { price: string; reason: string | null; at: number | null } | null;
        resultPct: number | null;
      };
      checks: LookupCheck[];
      fills: Array<{
        leg: string;
        id: string;
        side: string;
        price: string;
        size: string;
        role: string;
        at: number;
      }>;
      entryFill: { basis: string; slippageBps: number | null; score: number | null } | null;
      links: { call: string; trader: string };
    }
  | {
      type: "batch";
      batch: {
        id: number;
        v: number;
        createdMs: number;
        count: number;
        merkleRoot: string;
        batchHash: string;
        prevHash: string | null;
        signature: string;
        signerKey: string;
        anchor: { signature: string; cluster: string; memo: string } | null;
      };
      records: Array<{ id: number; seq: number; trader: string }>;
      checks: LookupCheck[];
      ok: boolean;
    };

export interface AuditFinding {
  kind:
    | "priority"
    | "book_mismatch"
    | "order_fills"
    | "limit_price"
    | "order_timing"
    | "order_status";
  symbol: string;
  at: number;
  fillId?: string;
  orderId?: string;
  detail: string;
}
export interface AuditReport {
  generatedMs: number;
  subject: { accountId: string | null; selector: { kind: string; value: string } };
  source: "export" | "history";
  sourceNote: string | null;
  window: { fromMs: number; toMs: number };
  coverage: Array<{
    symbol: string;
    recordedMs: number;
    windowMs: number;
    gaps: number;
    fills: number;
  }>;
  fills: {
    inWindow: number;
    checked: number;
    clean: number;
    unverifiable: Array<{ reason: string; count: number }>;
    truncated: boolean;
  };
  orders: { checked: number; consistent: number; skipped: number };
  findings: AuditFinding[];
  findingsTotal: number;
  verdict: "clean" | "findings" | "insufficient_coverage";
  notes: string[];
}
export interface AuditJob {
  id: string;
  status: "queued" | "running" | "done" | "failed";
  createdMs: number;
  finishedMs: number | null;
  error: string | null;
  report: AuditReport | null;
}
