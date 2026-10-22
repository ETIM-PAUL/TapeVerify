import { driftBps, type Followability, followability } from "@tapeverify/shared";
import type pg from "pg";
import type { CallRow } from "./model.js";

export interface LiveView {
  mark: string;
  /** Distance from the caller's entry in bps, either direction. */
  driftBps: number | null;
  /** Unleveraged move since entry in the call's direction, percent (display only). */
  movePct: number | null;
  /** Same, times leverage. */
  leveragedPct: number | null;
  followable: Followability;
}

/** Live comparison of a call's real entry against the current mark, plus whether following is allowed now. */
export function liveView(call: CallRow, mark: string, now = Date.now()): LiveView {
  const entry = call.entry_price;
  const status = call.status;
  let drift: number | null = null;
  let move: number | null = null;
  if (entry && Number(entry) > 0) {
    drift = driftBps(entry, mark);
    const dir = call.side === "long" ? 1 : -1;
    move = ((Number(mark) - Number(entry)) / Number(entry)) * 100 * dir;
  }
  return {
    mark,
    driftBps: drift,
    movePct: move,
    leveragedPct: move === null ? null : move * call.leverage,
    followable: followability(
      {
        status,
        side: call.side,
        entryPrice: entry,
        expiresAt: Number(call.expires_at),
        maxDriftBps: call.max_drift_bps,
      },
      now,
      mark,
    ),
  };
}

export interface TraderStats {
  calls: number;
  closed: number;
  wins: number;
  winRate: number | null;
  totalPnl: string;
  followers: number;
}

/** Headline numbers from this trader's TapeVerify calls (all derived from Strike fills). Phase 7 builds full verified stats. */
export async function traderStats(pool: pg.Pool, userId: string): Promise<TraderStats> {
  const { rows } = await pool.query(
    `SELECT count(*) FILTER (WHERE status IN ('open', 'expired', 'closed')) AS calls,
            count(*) FILTER (WHERE status = 'closed') AS closed,
            count(*) FILTER (WHERE status = 'closed' AND realized_pnl > 0) AS wins,
            COALESCE(sum(realized_pnl) FILTER (WHERE status = 'closed'), 0) AS pnl
       FROM calls WHERE user_id = $1`,
    [userId],
  );
  const f = await pool.query(
    `SELECT count(DISTINCT f.user_id) AS n FROM follows f JOIN calls c ON c.id = f.call_id
      WHERE c.user_id = $1 AND f.status <> 'failed'`,
    [userId],
  );
  const closed = Number(rows[0].closed);
  return {
    calls: Number(rows[0].calls),
    closed,
    wins: Number(rows[0].wins),
    winRate: closed ? Number(rows[0].wins) / closed : null,
    totalPnl: String(rows[0].pnl),
    followers: Number(f.rows[0].n),
  };
}

/** Does the user already have an unfinished call or follow in this market? */
export async function hasUnfinished(
  pool: pg.Pool,
  userId: string,
  symbol: string,
): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM calls WHERE user_id = $1 AND symbol = $2 AND status IN ('pending', 'open', 'expired')
     UNION ALL
     SELECT 1 FROM follows WHERE user_id = $1 AND symbol = $2 AND status IN ('pending', 'open') LIMIT 1`,
    [userId, symbol],
  );
  return rows.length > 0;
}
