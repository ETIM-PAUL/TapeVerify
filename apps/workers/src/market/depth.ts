import { getDepth, getTrades, type StrikeClient } from "@pit/strike-sdk";
import type pg from "pg";
import type { WorkerConfig } from "../config.js";
import { errMsg, type Logger } from "../log.js";
import { insertRows } from "../sql.js";

/**
 * Aggregated top-of-book samples for every market. Coarse by design (poll interval); the exact
 * order-level book is the L3 recorder's job, where Strike offers it.
 */
export class DepthPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  constructor(
    private readonly client: StrikeClient,
    private readonly pool: pg.Pool,
    private readonly cfg: WorkerConfig,
    private readonly symbols: string[],
    private readonly log: Logger,
  ) {}

  async pollOnce(): Promise<void> {
    for (const symbol of this.symbols) {
      try {
        const d = await getDepth(this.client, symbol, this.cfg.depthLevels);
        await this.pool.query(
          "INSERT INTO depth_snapshots (symbol, ts_ms, bids, asks) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
          [symbol, d.E, JSON.stringify(d.bids), JSON.stringify(d.asks)],
        );
      } catch (e) {
        this.log.warn("depth poll failed", { symbol, err: errMsg(e) });
      }
    }
  }

  /** Seeds trades from the REST endpoint (latest 1000) so a fresh start isn't empty. */
  async seedTrades(): Promise<void> {
    for (const symbol of this.symbols) {
      try {
        const ts = await getTrades(this.client, symbol, 1000);
        await insertRows(
          this.pool,
          "market_trades",
          ["symbol", "trade_id", "price", "qty", "time_ms", "is_buyer_maker"],
          ts.map((t) => [symbol, t.id, t.price, t.qty, t.time, t.isBuyerMaker]),
          "ON CONFLICT DO NOTHING",
        );
      } catch (e) {
        this.log.warn("trade seed failed", { symbol, err: errMsg(e) });
      }
    }
  }

  start(): void {
    void this.seedTrades();
    this.timer = setInterval(async () => {
      if (this.busy) return;
      this.busy = true;
      try {
        await this.pollOnce();
      } finally {
        this.busy = false;
      }
    }, this.cfg.depthPollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
