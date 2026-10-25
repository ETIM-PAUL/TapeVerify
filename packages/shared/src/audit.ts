/** What a fair-execution audit looks at, and what it found. Shared by the API, the workers and the web app. */

export type AuditSelectorKind = "id" | "blockchain_address";

export interface AuditSelector {
  /** `id` is a UUID: an account id, or a vault id (the worker finds out which). */
  kind: AuditSelectorKind;
  value: string;
  /** Only for a wallet address. Left out, Strike searches the supported chains. */
  blockchain?: "ethereum" | "solana" | "cardano";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** A pasted account id, vault id or wallet address, or null if it is none of those. */
export function parseAuditSelector(raw: string): AuditSelector | null {
  const q = raw.trim().replace(/^["'`]|["'`]$/g, "");
  if (UUID.test(q)) return { kind: "id", value: q.toLowerCase() };
  if (/^0x[0-9a-fA-F]{40}$/.test(q))
    return { kind: "blockchain_address", value: q.toLowerCase(), blockchain: "ethereum" };
  if (/^addr(_test)?1[0-9a-z]{50,120}$/.test(q))
    return { kind: "blockchain_address", value: q, blockchain: "cardano" };
  if (BASE58.test(q)) return { kind: "blockchain_address", value: q, blockchain: "solana" };
  return null;
}

export const auditKey = (s: AuditSelector) => `${s.kind}:${s.value}`;

export type FindingKind =
  /** A fill didn't hit the order at the front of the queue at the best price on its side. */
  | "priority"
  /** The account's fill and the order book's record of the same trade disagree on price or size. */
  | "book_mismatch"
  /** An order's fills don't add up to what the order says it filled. */
  | "order_fills"
  /** A limit order filled at a worse price than its limit. */
  | "limit_price"
  /** A fill is dated outside its order's life. */
  | "order_timing"
  /** An order's status contradicts its fills. */
  | "order_status";

export interface AuditFinding {
  kind: FindingKind;
  symbol: string;
  at: number;
  fillId?: string;
  orderId?: string;
  detail: string;
}

export interface AuditReport {
  version: 1;
  generatedMs: number;
  subject: { accountId: string | null; selector: AuditSelector };
  /** `export` is Strike's bulk history export; `history` is the paged history endpoints, used when the export isn't available. */
  source: "export" | "history";
  /** Why the export wasn't used, when it wasn't. */
  sourceNote: string | null;
  window: { fromMs: number; toMs: number };
  /** For each market the account traded: how much of the window the order book was recorded for. */
  coverage: Array<{
    symbol: string;
    recordedMs: number;
    windowMs: number;
    gaps: number;
    fills: number;
  }>;
  fills: {
    /** Fills the account has in the window. */
    inWindow: number;
    /** Fills checked against the recorded order book. */
    checked: number;
    /** Checked fills that passed every check. */
    clean: number;
    /** Fills that could not be checked, and why. */
    unverifiable: Array<{ reason: string; count: number }>;
    /** True when a limit stopped the audit before every fill was read. */
    truncated: boolean;
  };
  orders: { checked: number; consistent: number; skipped: number };
  findings: AuditFinding[];
  /** More findings were found than listed. */
  findingsTotal: number;
  verdict: "clean" | "findings" | "insufficient_coverage";
  notes: string[];
}

export type AuditStatus = "queued" | "running" | "done" | "failed";
