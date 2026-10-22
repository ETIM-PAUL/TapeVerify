import { createHash } from "node:crypto";
import { activeFindings, type FindingRecord, findingsFor } from "@tapeverify/verify";
import type pg from "pg";

export interface VerifyPublic {
  score: number;
  performance: number;
  confidence: number;
  clean: boolean;
  cleanReasons: string[];
  /** A flag is open or under appeal: not yet decided by a reviewer. */
  underReview: boolean;
  /** The highest severity among findings that still count, if any. */
  worst: "low" | "medium" | "high" | "critical" | null;
  penalties: Array<{
    kind: string;
    severity: string;
    status: string;
    summary: string;
    points: number;
  }>;
}

const RANK = { low: 1, medium: 2, high: 3, critical: 4 } as const;

/** What anyone may see about a trader's trust record. Never includes evidence or other accounts. */
export async function verifyFor(
  pool: pg.Pool,
  userIds: string[],
): Promise<Map<string, VerifyPublic>> {
  const out = new Map<string, VerifyPublic>();
  if (userIds.length === 0) return out;
  const { rows } = await pool.query(
    "SELECT user_id, score, performance, confidence, clean, clean_reasons, penalties FROM trader_reputation WHERE user_id = ANY($1)",
    [userIds],
  );
  for (const r of rows) {
    const penalties = (r.penalties as Array<Record<string, unknown>>).map((p) => ({
      kind: String(p.kind),
      severity: String(p.severity),
      status: String(p.status),
      summary: String(p.summary),
      points: Number(p.points),
    }));
    let worst: VerifyPublic["worst"] = null;
    for (const p of penalties) {
      const s = p.severity as keyof typeof RANK;
      if (!worst || RANK[s] > RANK[worst]) worst = s;
    }
    out.set(r.user_id, {
      score: Number(r.score),
      performance: Number(r.performance),
      confidence: Number(r.confidence),
      clean: r.clean,
      cleanReasons: r.clean_reasons,
      underReview: penalties.some((p) => p.status === "open" || p.status === "appealed"),
      worst,
      penalties,
    });
  }
  return out;
}

/** Findings that should make a follower stop and think: high or critical and still counting against the caller. */
export async function seriousFlags(pool: pg.Pool, userId: string): Promise<FindingRecord[]> {
  const all = (await findingsFor(pool, [userId])).get(userId) ?? [];
  return activeFindings(all).filter((f) => f.severity === "high" || f.severity === "critical");
}

/** Salted, so the stored value can compare two accounts but can't be turned back into an address. */
export function hashWithSalt(salt: string, value: string): string {
  return createHash("sha256").update(`${salt}:${value}`).digest("hex").slice(0, 32);
}

export async function recordLogin(
  pool: pg.Pool,
  salt: string,
  userId: string,
  ip: string | undefined,
  ua: string | undefined,
) {
  if (!ip) return;
  await pool.query(
    "INSERT INTO login_events (user_id, ip_hash, ua_hash, ts_ms) VALUES ($1,$2,$3,$4)",
    [userId, hashWithSalt(salt, ip), ua ? hashWithSalt(salt, ua) : null, Date.now()],
  );
}
