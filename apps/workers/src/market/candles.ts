import {
  getKlines,
  type Kline,
  type KlineInterval,
  type PriceType,
  type StrikeClient,
} from "@tapeverify/strike-sdk";
import type pg from "pg";
import type { WorkerConfig } from "../config.js";
import { errMsg, type Logger } from "../log.js";
import { insertRows } from "../sql.js";

const INTERVAL_MS: Record<string, number> = {
  "1m": 60_000,
  "3m": 180_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "2h": 7_200_000,
  "4h": 14_400_000,
  "6h": 21_600_000,
  "8h": 28_800_000,
  "12h": 43_200_000,
  "1d": 86_400_000,
};
const FINE = new Set(["1m", "3m", "5m"]);
/**
 * Earliest start we ask for. Strike treats startTime=0 as "not given" and returns the *latest* page,
 * which would silently skip all older history, so "from the beginning" must be a real timestamp.
 */
export const HISTORY_FLOOR = 1_700_000_000_000;
const PRICE_TYPES: PriceType[] = ["last", "mark"];
const COLS = [
  "symbol",
  "interval",
  "price_type",
  "open_time",
  "close_time",
  "open",
  "high",
  "low",
  "close",
  "volume",
  "quote_volume",
  "trades",
];

export async function upsertCandles(
  pool: pg.Pool,
  symbol: string,
  interval: string,
  priceType: PriceType,
  ks: Kline[],
) {
  return insertRows(
    pool,
    "candles",
    COLS,
    ks.map((k) => [
      symbol,
      interval,
      priceType,
      k.openTime,
      k.closeTime,
      k.open,
      k.high,
      k.low,
      k.close,
      k.volume,
      k.quoteVolume,
      k.trades,
    ]),
    `ON CONFLICT (symbol, interval, price_type, open_time) DO UPDATE SET
       close_time = EXCLUDED.close_time, open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
       close = EXCLUDED.close, volume = EXCLUDED.volume, quote_volume = EXCLUDED.quote_volume, trades = EXCLUDED.trades`,
  );
}

/**
 * Fetches closed candles forward from the last stored one (or `since`) up to now, 1500 per call.
 * The still-forming candle is never stored. Returns the number of rows written.
 */
export async function backfillCandles(
  client: StrikeClient,
  pool: pg.Pool,
  symbol: string,
  interval: KlineInterval,
  priceType: PriceType,
  since: number,
  now = Date.now(),
): Promise<number> {
  const last = await pool.query(
    "SELECT max(open_time) AS t FROM candles WHERE symbol = $1 AND interval = $2 AND price_type = $3",
    [symbol, interval, priceType],
  );
  let start =
    last.rows[0]?.t !== null && last.rows[0]?.t !== undefined
      ? Number(last.rows[0].t) + 1
      : Math.max(since, HISTORY_FLOOR);
  let total = 0;
  for (;;) {
    const ks = (
      await getKlines(client, { symbol, interval, priceType, startTime: start, limit: 1500 })
    ).filter((k) => k.closeTime < now);
    if (ks.length === 0) return total;
    total += await upsertCandles(pool, symbol, interval, priceType, ks);
    const lastOpen = ks[ks.length - 1]?.openTime ?? start;
    if (lastOpen + 1 <= start) return total; // no progress
    start = lastOpen + 1;
    if (ks.length < 1500) return total;
  }
}

/** Initial history window per interval: fine intervals are capped, coarse ones go back to the start. */
export function backfillStart(interval: string, cfg: WorkerConfig, now = Date.now()): number {
  return FINE.has(interval) ? now - cfg.candleBackfillDaysFine * 86_400_000 : HISTORY_FLOOR;
}

export class CandleIndexer {
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(
    private readonly client: StrikeClient,
    private readonly pool: pg.Pool,
    private readonly cfg: WorkerConfig,
    private readonly symbols: string[],
    private readonly log: Logger,
  ) {}

  async backfillAll(): Promise<void> {
    for (const symbol of this.symbols) {
      for (const interval of this.cfg.candleIntervals as KlineInterval[]) {
        for (const pt of PRICE_TYPES) {
          try {
            const n = await backfillCandles(
              this.client,
              this.pool,
              symbol,
              interval,
              pt,
              backfillStart(interval, this.cfg),
            );
            if (n)
              this.log.info("candles backfilled", { symbol, interval, priceType: pt, rows: n });
          } catch (e) {
            this.log.warn("candle backfill failed", {
              symbol,
              interval,
              priceType: pt,
              err: errMsg(e),
            });
          }
        }
      }
    }
  }

  /** Keeps every interval current by re-reading its tail, which also repairs anything missed over WS. */
  start(): void {
    void this.backfillAll();
    this.timer = setInterval(() => void this.backfillAll(), this.cfg.candleRefreshMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

export { INTERVAL_MS };
