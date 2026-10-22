import { type FindingKind, SEVERITY_WEIGHT, type Severity } from "./types.js";

export interface PerformanceInput {
  /** Closed trades behind the numbers (from Strike's fills). */
  trades: number;
  totalReturnPct: number | null;
  maxDrawdownPct: number | null;
  consistency: number | null;
}

export interface Performance {
  score: number;
  /** 0 to 1: how much the score reflects the record rather than the neutral starting point. */
  confidence: number;
}

/**
 * Performance on a 0 to 100 scale from verified stats only. A trader with little history stays near the
 * neutral 50: the score earns its way away from 50 as the number of trades grows (full weight at 30 trades).
 */
export function performanceScore(p: PerformanceInput): Performance {
  if (p.trades < 5) return { score: 50, confidence: 0 };
  const confidence = Math.min(1, p.trades / 30);
  const ret = Math.tanh((p.totalReturnPct ?? 0) / 25); // +-1: around +-25% return
  const cons = Math.tanh(p.consistency ?? 0);
  const dd = 1 - Math.min(1, (p.maxDrawdownPct ?? 0) / 40); // 1 with no drawdown, 0 at 40%+
  const raw = 50 + 20 * ret + 15 * cons + 15 * (dd - 0.5) * 2;
  return { score: Math.max(5, Math.min(95, 50 + confidence * (raw - 50))), confidence };
}

export type FindingStatus = "open" | "appealed" | "confirmed" | "dismissed" | "cleared";

export interface FindingRecord {
  id: string;
  kind: FindingKind;
  severity: Severity;
  status: FindingStatus;
  summary: string;
  baseKey: string;
  generation: number;
  detectedAt: number;
}

/** Findings that cost reputation: the latest generation of each behaviour, while open, appealed or confirmed. */
export function activeFindings(all: FindingRecord[]): FindingRecord[] {
  const latest = new Map<string, FindingRecord>();
  for (const f of all) {
    const cur = latest.get(f.baseKey);
    if (
      !cur ||
      f.generation > cur.generation ||
      (f.generation === cur.generation && f.detectedAt > cur.detectedAt)
    )
      latest.set(f.baseKey, f);
  }
  return [...latest.values()].filter(
    (f) => f.status === "open" || f.status === "appealed" || f.status === "confirmed",
  );
}

export interface Reputation {
  score: number;
  performance: number;
  confidence: number;
  penalty: number;
  penalties: Array<{
    id: string;
    kind: FindingKind;
    severity: Severity;
    status: FindingStatus;
    summary: string;
    points: number;
  }>;
}

/** Reputation = performance minus the weight of every active finding (never below 0). */
export function reputation(perf: PerformanceInput, findings: FindingRecord[]): Reputation {
  const p = performanceScore(perf);
  const active = activeFindings(findings);
  const penalties = active.map((f) => ({
    id: f.id,
    kind: f.kind,
    severity: f.severity,
    status: f.status,
    summary: f.summary,
    points: SEVERITY_WEIGHT[f.severity],
  }));
  const penalty = Math.min(
    100,
    penalties.reduce((a, x) => a + x.points, 0),
  );
  return {
    score: Math.max(0, Math.round(p.score - penalty)),
    performance: Math.round(p.score),
    confidence: p.confidence,
    penalty,
    penalties,
  };
}

export const CLEAN_MIN_TRADES = 10;
export const CLEAN_MIN_ACTIVE_DAYS = 3;
export const CLEAN_LOOKBACK_MS = 180 * 86_400_000;

export interface CleanRecord {
  clean: boolean;
  /** Why not, in plain words (empty when clean). */
  reasons: string[];
}

/**
 * The clean-record badge: a real track record AND no unresolved flags. Findings that were dismissed or cleared
 * on review don't count against it; one that was confirmed does for 180 days.
 */
export function cleanRecord(i: {
  trades: number;
  activeDays: number;
  findings: FindingRecord[];
  now: number;
}): CleanRecord {
  const reasons: string[] = [];
  if (i.trades < CLEAN_MIN_TRADES)
    reasons.push(`Needs at least ${CLEAN_MIN_TRADES} closed trades (has ${i.trades}).`);
  if (i.activeDays < CLEAN_MIN_ACTIVE_DAYS)
    reasons.push(
      `Needs trades on at least ${CLEAN_MIN_ACTIVE_DAYS} different days (has ${i.activeDays}).`,
    );
  const active = activeFindings(i.findings);
  if (active.some((f) => f.status !== "confirmed"))
    reasons.push("Has flags that are still under review.");
  if (active.some((f) => f.status === "confirmed")) reasons.push("Has a confirmed flag.");
  const recentConfirmed = i.findings.some(
    (f) => f.status === "confirmed" && i.now - f.detectedAt <= CLEAN_LOOKBACK_MS,
  );
  if (recentConfirmed && !reasons.includes("Has a confirmed flag."))
    reasons.push("Had a confirmed flag in the last 180 days.");
  return { clean: reasons.length === 0, reasons };
}
