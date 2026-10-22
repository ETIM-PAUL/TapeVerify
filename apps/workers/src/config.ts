import { z } from "zod";

const list = (v: string) =>
  v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const schema = z.object({
  /** Empty = every market Strike lists. */
  INDEXER_SYMBOLS: z.string().default(""),
  /** Markets with an order-level (L3) feed. Strike only enables BTC-USD at first. */
  L3_SYMBOLS: z.string().default("BTC-USD"),
  L3_CHECKPOINT_SECONDS: z.coerce.number().int().positive().default(300),
  L3_FLUSH_MS: z.coerce.number().int().positive().default(500),
  L3_RETENTION_HOURS: z.coerce.number().int().positive().default(72),
  DEPTH_POLL_SECONDS: z.coerce.number().int().positive().default(5),
  DEPTH_LEVELS: z.coerce.number().int().positive().default(20),
  CANDLE_INTERVALS: z.string().default("1m,5m,15m,1h,4h,1d"),
  /** Initial backfill window for 1m and 5m candles (days). Larger intervals backfill everything. */
  CANDLE_BACKFILL_DAYS_FINE: z.coerce.number().int().positive().default(14),
  CANDLE_REFRESH_SECONDS: z.coerce.number().int().positive().default(60),
  FILLS_POLL_SECONDS: z.coerce.number().int().positive().default(15),
  MARK_PRICE_RETENTION_DAYS: z.coerce.number().int().positive().default(7),
  DEPTH_RETENTION_DAYS: z.coerce.number().int().positive().default(7),
  TRADES_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
});

export interface WorkerConfig {
  symbols: string[];
  l3Symbols: string[];
  l3CheckpointMs: number;
  l3FlushMs: number;
  l3RetentionHours: number;
  depthPollMs: number;
  depthLevels: number;
  candleIntervals: string[];
  candleBackfillDaysFine: number;
  candleRefreshMs: number;
  fillsPollMs: number;
  markRetentionDays: number;
  depthRetentionDays: number;
  tradesRetentionDays: number;
}

export function loadWorkerConfig(
  env: Record<string, string | undefined> = process.env,
): WorkerConfig {
  const e = schema.parse(env);
  return {
    symbols: list(e.INDEXER_SYMBOLS),
    l3Symbols: list(e.L3_SYMBOLS),
    l3CheckpointMs: e.L3_CHECKPOINT_SECONDS * 1000,
    l3FlushMs: e.L3_FLUSH_MS,
    l3RetentionHours: e.L3_RETENTION_HOURS,
    depthPollMs: e.DEPTH_POLL_SECONDS * 1000,
    depthLevels: e.DEPTH_LEVELS,
    candleIntervals: list(e.CANDLE_INTERVALS),
    candleBackfillDaysFine: e.CANDLE_BACKFILL_DAYS_FINE,
    candleRefreshMs: e.CANDLE_REFRESH_SECONDS * 1000,
    fillsPollMs: e.FILLS_POLL_SECONDS * 1000,
    markRetentionDays: e.MARK_PRICE_RETENTION_DAYS,
    depthRetentionDays: e.DEPTH_RETENTION_DAYS,
    tradesRetentionDays: e.TRADES_RETENTION_DAYS,
  };
}
