import type pg from "pg";
import type { WorkerConfig } from "./config.js";
import type { Logger } from "./log.js";

const DAY = 86_400_000;

/** Prunes high-volume tables. Candles, fills and funding are kept indefinitely. */
export async function runRetention(
  pool: pg.Pool,
  cfg: WorkerConfig,
  log: Logger,
  now = Date.now(),
) {
  const del = async (label: string, sql: string, cutoff: number) => {
    const r = await pool.query(sql, [cutoff]);
    if (r.rowCount) log.info("retention", { table: label, deleted: r.rowCount });
    return r.rowCount ?? 0;
  };
  return {
    l3: await del(
      "l3_segments",
      "DELETE FROM l3_segments WHERE end_ts IS NOT NULL AND end_ts < $1",
      now - cfg.l3RetentionHours * 3_600_000,
    ),
    marks: await del(
      "mark_prices",
      "DELETE FROM mark_prices WHERE ts_ms < $1",
      now - cfg.markRetentionDays * DAY,
    ),
    depth: await del(
      "depth_snapshots",
      "DELETE FROM depth_snapshots WHERE ts_ms < $1",
      now - cfg.depthRetentionDays * DAY,
    ),
    trades: await del(
      "market_trades",
      "DELETE FROM market_trades WHERE time_ms < $1",
      now - cfg.tradesRetentionDays * DAY,
    ),
  };
}
