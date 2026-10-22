export type Severity = "low" | "medium" | "high" | "critical";

export type FindingKind =
  | "front_running"
  | "front_running_pattern"
  | "self_trade"
  | "collusion_pair"
  | "sybil_cluster";

/** Points taken off a trader's reputation by one finding that is open or confirmed. */
export const SEVERITY_WEIGHT: Record<Severity, number> = {
  low: 3,
  medium: 10,
  high: 25,
  critical: 40,
};

/** A detector's output. The job stores it as a finding for human review. */
export interface FindingDraft {
  kind: FindingKind;
  /** The user the finding is about (the one whose reputation it affects). */
  subjectId: string;
  severity: Severity;
  /** One plain sentence, safe to show on a public profile: it never names other users. */
  summary: string;
  /** Everything a reviewer needs. Never shown publicly. */
  evidence: Record<string, unknown>;
  /**
   * Identifies the same underlying behaviour across runs, so re-running detection updates a finding instead of
   * duplicating it. Evidence that grows past a bucket gets a new generation (see `generation`).
   */
  baseKey: string;
  /** Grows when the evidence has more than doubled since a reviewer last looked. */
  generation: number;
}

const SEVERITIES: Severity[] = ["low", "medium", "high", "critical"];
export const bumpSeverity = (s: Severity, by = 1): Severity =>
  SEVERITIES[Math.min(SEVERITIES.length - 1, SEVERITIES.indexOf(s) + by)] as Severity;

/** 0 for 1-1, 1 for 2-3, 2 for 4-7, ...: a finding is reopened as a new generation only when evidence doubles. */
export const generationOf = (n: number): number => (n <= 1 ? 0 : Math.floor(Math.log2(n)));

/** P(X >= k) for X ~ Binomial(n, p), summed exactly in log space. */
export function binomialTail(n: number, k: number, p: number): number {
  if (k <= 0) return 1;
  if (k > n) return 0;
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  const logFact = (x: number) => {
    let s = 0;
    for (let i = 2; i <= x; i++) s += Math.log(i);
    return s;
  };
  const lf = logFact(n);
  let tail = 0;
  for (let i = k; i <= n; i++) {
    tail += Math.exp(
      lf - logFact(i) - logFact(n - i) + i * Math.log(p) + (n - i) * Math.log(1 - p),
    );
  }
  return Math.min(1, tail);
}
