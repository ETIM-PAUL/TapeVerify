import type pg from "pg";

export type AuditKind =
  | "start"
  | "evaluated"
  | "signal"
  | "entry_refused"
  | "order_planned"
  | "order_sent"
  | "order_failed"
  | "order_unknown"
  | "entry_filled"
  | "exit_requested"
  | "exit_order_failed"
  | "trade_closed"
  | "trade_failed"
  | "protection_placed"
  | "protection_missing"
  | "stale_signal"
  | "halt"
  | "stop"
  | "error";

/** Append-only audit trail of everything a live run decides and does. */
export async function audit(
  pool: pg.Pool,
  runId: string,
  kind: AuditKind,
  data: Record<string, unknown> = {},
  now = Date.now(),
) {
  await pool.query("INSERT INTO live_events (run_id, ts_ms, kind, data) VALUES ($1, $2, $3, $4)", [
    runId,
    now,
    kind,
    JSON.stringify(data),
  ]);
}
