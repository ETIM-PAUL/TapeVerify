import { type FindingDraft, generationOf, type Severity } from "./types.js";

export interface FollowerFacts {
  userId: string;
  createdTs: number;
  /** Salted hashes of the addresses this account signed in from (never raw addresses). */
  ipHashes: string[];
  deposits: Array<{ ts: number; amount: number }>;
  /** How many different callers this account has ever followed. */
  callersFollowed: number;
  /** Share of this account's follows made within seconds of the call opening (faster than a person acts). */
  fastFollowShare: number;
  /** Margin amounts of its follows, to spot accounts that all follow with the same size. */
  followMargins: number[];
}

export interface SybilOptions {
  minClusterSize: number;
  /** Two followers are linked when their combined similarity reaches this and includes a strong link. */
  edgeScore: number;
  createdWithinMs: number;
  depositWithinMs: number;
}

export const DEFAULT_SYBIL: SybilOptions = {
  minClusterSize: 3,
  edgeScore: 4,
  createdWithinMs: 24 * 3_600_000,
  depositWithinMs: 3_600_000,
};

interface PairSignals {
  score: number;
  strong: boolean;
  signals: string[];
}

function pairSignals(a: FollowerFacts, b: FollowerFacts, o: SybilOptions): PairSignals {
  const signals: string[] = [];
  let score = 0;
  let strong = false;
  if (a.ipHashes.some((h) => b.ipHashes.includes(h))) {
    score += 3;
    strong = true;
    signals.push("shared_network");
  }
  const cents = (x: number) => Math.round(x * 100);
  if (
    a.deposits.some((da) =>
      b.deposits.some(
        (db) =>
          cents(da.amount) === cents(db.amount) && Math.abs(da.ts - db.ts) <= o.depositWithinMs,
      ),
    )
  ) {
    score += 2;
    strong = true;
    signals.push("matching_deposits");
  }
  if (Math.abs(a.createdTs - b.createdTs) <= o.createdWithinMs) {
    score += 1;
    signals.push("created_together");
  }
  if (a.callersFollowed === 1 && b.callersFollowed === 1) {
    score += 1;
    signals.push("follow_only_this_caller");
  }
  if (a.fastFollowShare >= 0.5 && b.fastFollowShare >= 0.5) {
    score += 1;
    signals.push("faster_than_human_follows");
  }
  const sa = new Set(a.followMargins.map(cents));
  const sb = new Set(b.followMargins.map(cents));
  if (sa.size > 0 && sa.size === sb.size && [...sa].every((x) => sb.has(x))) {
    score += 1;
    signals.push("identical_sizes");
  }
  return { score, strong, signals };
}

/**
 * Sybil followers: groups of accounts that look like one operator inflating a caller's follower count.
 *
 * Accounts are linked when they share a sign-in network or fund themselves with matching deposits at about the
 * same time (strong signals), plus weaker similarities that are common on their own (created together, follow
 * only this caller, follow faster than a person can, identical sizes). A link needs a strong signal AND enough
 * weak ones; connected groups of three or more are reported. Organic viral growth shows the weak signals
 * without the strong ones, so it isn't flagged.
 */
export function detectSybilFollowers(
  callers: Array<{ callerId: string; followers: FollowerFacts[] }>,
  opts: SybilOptions = DEFAULT_SYBIL,
): FindingDraft[] {
  const out: FindingDraft[] = [];
  for (const { callerId, followers } of callers) {
    const n = followers.length;
    if (n < opts.minClusterSize) continue;
    const parent = followers.map((_, i) => i);
    const find = (i: number): number =>
      (parent[i] as number) === i ? i : (parent[i] = find(parent[i] as number));
    const signalsBy = new Map<number, Set<string>>();
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const s = pairSignals(followers[i] as FollowerFacts, followers[j] as FollowerFacts, opts);
        if (s.strong && s.score >= opts.edgeScore) {
          parent[find(i)] = find(j);
          for (const k of [i, j])
            signalsBy.set(k, new Set([...(signalsBy.get(k) ?? []), ...s.signals]));
        }
      }
    }
    const groups = new Map<number, number[]>();
    for (let i = 0; i < n; i++) groups.set(find(i), [...(groups.get(find(i)) ?? []), i]);
    for (const idx of groups.values()) {
      if (idx.length < opts.minClusterSize) continue;
      const share = idx.length / n;
      const signals = [...new Set(idx.flatMap((i) => [...(signalsBy.get(i) ?? [])]))].sort();
      const severity: Severity =
        idx.length >= 10 && share >= 0.7
          ? "critical"
          : idx.length >= 5 || share >= 0.7
            ? "high"
            : "medium";
      out.push({
        kind: "sybil_cluster",
        subjectId: callerId,
        severity,
        summary: `${idx.length} of ${n} followers (${Math.round(share * 100)}%) look like linked accounts, so the follower count is inflated.`,
        evidence: {
          members: idx.map((i) => (followers[i] as FollowerFacts).userId),
          followerCount: n,
          clusterSize: idx.length,
          signals,
        },
        baseKey: `sybil_cluster:${callerId}:${idx.map((i) => (followers[i] as FollowerFacts).userId).sort()[0] as string}`,
        generation: generationOf(idx.length),
      });
    }
  }
  return out;
}
