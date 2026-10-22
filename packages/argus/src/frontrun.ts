import { binomialTail, type FindingDraft, generationOf, type Severity } from "./types.js";

export interface FollowFacts {
  followId: string;
  followerId: string;
  /** When the follower's entry filled (from Strike's fills), or null if it never filled. */
  entryTs: number | null;
  entryPrice: number | null;
}

/** A call after it has closed, with what followers did on it. All times and prices come from Strike's fills. */
export interface CallFacts {
  callId: string;
  callerId: string;
  side: "long" | "short";
  entryTs: number;
  entryPrice: number;
  exitTs: number | null;
  exitPrice: number | null;
  /** 'tp' | 'sl' | 'manual' | 'liquidation' | 'external'. Only voluntary exits can be front-running. */
  exitReason: string | null;
  follows: FollowFacts[];
}

export interface FrontRunOptions {
  /** A caller exit this soon after a follower's entry is suspicious. */
  windowMs: number;
  /** Followers who must be caught this way on one call before it is flagged. */
  minFollowersPerCall: number;
  /** Flagged calls before the pattern test applies. */
  minCallsForPattern: number;
  /** The pattern is flagged when it would happen by chance less often than this. */
  significance: number;
}

export const DEFAULT_FRONTRUN: FrontRunOptions = {
  windowMs: 120_000,
  minFollowersPerCall: 2,
  minCallsForPattern: 3,
  significance: 0.001,
};

const voluntary = (r: string | null) => r === "manual" || r === "external";
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length === 0
    ? 0
    : s.length % 2
      ? (s[m] as number)
      : ((s[m - 1] as number) + (s[m] as number)) / 2;
};

interface Hit {
  callId: string;
  followId: string;
  followerId: string;
  lagMs: number;
  /** The caller sold into (long) or bought into (short) the price the follower paid, or better. */
  exitedIntoFollower: boolean;
}

/**
 * Front-running: a caller who exits just after followers pile in is selling into the demand the call created.
 *
 * Per call: followers whose entry filled while the call was open and within `windowMs` before a voluntary
 * (manual) exit. Across a caller's history: how many of all follower entries fall that close to a manual
 * exit, tested against the chance of that happening if exits were unrelated to follower entries (a binomial
 * test, with the chance estimated from how long this caller's calls usually last). One unlucky call is never
 * enough: a call needs two followers caught, and the pattern needs several calls and statistical significance.
 */
export function detectFrontRunning(
  calls: CallFacts[],
  opts: FrontRunOptions = DEFAULT_FRONTRUN,
): FindingDraft[] {
  const out: FindingDraft[] = [];
  const byCaller = new Map<string, CallFacts[]>();
  for (const c of calls) {
    if (c.exitTs === null || c.exitPrice === null) continue;
    byCaller.set(c.callerId, [...(byCaller.get(c.callerId) ?? []), c]);
  }

  for (const [callerId, list] of byCaller) {
    const flaggedCalls: Array<{ call: CallFacts; hits: Hit[] }> = [];
    let followEntries = 0;
    let closeToExit = 0;
    const durations = list.map((c) => (c.exitTs as number) - c.entryTs).filter((d) => d > 0);

    for (const c of list) {
      const dir = c.side === "long" ? 1 : -1;
      const exitTs = c.exitTs as number;
      const exitPrice = c.exitPrice as number;
      const hits: Hit[] = [];
      for (const f of c.follows) {
        if (f.entryTs === null || f.entryPrice === null || f.entryTs > exitTs) continue;
        followEntries++;
        const lag = exitTs - f.entryTs;
        if (!voluntary(c.exitReason) || lag > opts.windowMs) continue;
        closeToExit++;
        hits.push({
          callId: c.callId,
          followId: f.followId,
          followerId: f.followerId,
          lagMs: lag,
          exitedIntoFollower: (exitPrice - f.entryPrice) * dir >= 0,
        });
      }
      if (new Set(hits.map((h) => h.followerId)).size >= opts.minFollowersPerCall)
        flaggedCalls.push({ call: c, hits });
    }

    for (const { call, hits } of flaggedCalls) {
      const into = hits.filter((h) => h.exitedIntoFollower).length;
      const callerGain =
        ((call.exitPrice as number) - call.entryPrice) * (call.side === "long" ? 1 : -1) > 0;
      const severity: Severity = into > hits.length / 2 && callerGain ? "medium" : "low";
      out.push({
        kind: "front_running",
        subjectId: callerId,
        severity,
        summary: `Exited a call by hand within ${Math.round(Math.max(...hits.map((h) => h.lagMs)) / 1000)}s of ${hits.length} followers entering.`,
        evidence: {
          callId: call.callId,
          exitReason: call.exitReason,
          callerEntry: { ts: call.entryTs, price: call.entryPrice },
          callerExit: { ts: call.exitTs, price: call.exitPrice },
          callerGain,
          followers: hits.map((h) => ({
            followId: h.followId,
            followerId: h.followerId,
            lagMs: h.lagMs,
            exitedIntoFollower: h.exitedIntoFollower,
          })),
        },
        baseKey: `front_running:${call.callId}`,
        generation: 0,
      });
    }

    if (flaggedCalls.length >= opts.minCallsForPattern && followEntries > 0) {
      // Chance a follower's entry lands within the window before an unrelated exit: window / typical call length.
      const p0 = Math.min(
        0.5,
        Math.max(0.02, opts.windowMs / Math.max(median(durations), opts.windowMs)),
      );
      const tail = binomialTail(followEntries, closeToExit, p0);
      if (tail < opts.significance) {
        const lags = flaggedCalls.flatMap((f) => f.hits.map((h) => h.lagMs));
        const severity: Severity =
          flaggedCalls.length >= 5 || median(lags) <= 30_000 ? "critical" : "high";
        out.push({
          kind: "front_running_pattern",
          subjectId: callerId,
          severity,
          summary: `Repeatedly exits by hand right after followers enter: ${flaggedCalls.length} calls, far more than chance.`,
          evidence: {
            flaggedCalls: flaggedCalls.map((f) => f.call.callId),
            followerEntries: followEntries,
            closeToManualExit: closeToExit,
            chanceUnderIndependence: p0,
            probabilityOfThisByChance: tail,
            medianLagMs: median(lags),
            windowMs: opts.windowMs,
          },
          baseKey: `front_running_pattern:${callerId}`,
          generation: generationOf(flaggedCalls.length),
        });
      }
    }
  }
  return out;
}
