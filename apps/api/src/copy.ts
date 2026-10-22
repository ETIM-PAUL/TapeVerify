import {
  applyGuardrails,
  type GuardResult,
  type Guardrails,
  NO_GUARDRAILS,
} from "@tapeverify/shared";
import type pg from "pg";
import { seriousFlags } from "./verify.js";

const DAY = 86_400_000;

export async function loadGuardrails(pool: pg.Pool, userId: string): Promise<Guardrails> {
  const r = (await pool.query("SELECT * FROM copy_guardrails WHERE user_id = $1", [userId]))
    .rows[0];
  if (!r) return NO_GUARDRAILS;
  const n = (v: unknown) => (v === null ? null : Number(v));
  return {
    maxMarginUsd: n(r.max_margin_usd),
    maxLossUsd: n(r.max_loss_usd),
    maxLeverage: n(r.max_leverage),
    maxDriftBps: n(r.max_drift_bps),
    maxOpenCopies: n(r.max_open_copies),
    dailyLossLimitUsd: n(r.daily_loss_limit_usd),
    requireCleanCaller: r.require_clean_caller,
  };
}

export interface GuardedCall {
  user_id: string;
  side: "long" | "short";
  leverage: number;
  sl_price: string | null;
}

/** Runs a person's guardrails against a call they are about to copy at the current price. */
export async function evaluateGuardrails(
  pool: pg.Pool,
  userId: string,
  call: GuardedCall,
  mark: string,
  driftBps: number,
  requestedMarginUsd: number,
  now = Date.now(),
): Promise<{ guardrails: Guardrails; result: GuardResult }> {
  const guardrails = await loadGuardrails(pool, userId);
  if (guardrails === NO_GUARDRAILS)
    return {
      guardrails,
      result: { ok: true, marginUsd: requestedMarginUsd, leverage: call.leverage, adjustments: [] },
    };
  const open = await pool.query(
    "SELECT count(*) AS n FROM follows WHERE user_id = $1 AND status IN ('pending', 'open')",
    [userId],
  );
  const lost = await pool.query(
    "SELECT COALESCE(sum(-realized_pnl), 0) AS n FROM follows WHERE user_id = $1 AND status = 'closed' AND realized_pnl < 0 AND exit_ts_ms > $2",
    [userId, now - DAY],
  );
  const flagged = guardrails.requireCleanCaller
    ? (await seriousFlags(pool, call.user_id)).length > 0
    : false;
  const result = applyGuardrails(
    requestedMarginUsd,
    {
      side: call.side,
      leverage: call.leverage,
      entryPrice: Number(mark),
      slPrice: call.sl_price === null ? null : Number(call.sl_price),
    },
    guardrails,
    {
      openCopies: Number(open.rows[0].n),
      lossTodayUsd: Number(lost.rows[0].n),
      driftBps,
      callerFlagged: flagged,
    },
  );
  return { guardrails, result };
}
