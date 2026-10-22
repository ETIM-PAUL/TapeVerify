import { creatorShare, notionalOf, tradeBuilderFee } from "@pit/shared";
import type pg from "pg";
import { errMsg, type Logger } from "../log.js";

/**
 * Creator revenue share (Option B: Pit is the builder, creators get a share of Pit's builder fee).
 *
 * Each closed live trade of a run that was cloned from a listing, and still trades that listing's signals,
 * accrues exactly one row: the creator's share of the builder fee Strike charged on that trade's entry and
 * exit. The fee is computed from the trade's fills with Strike's published formula (floor to cents per fill,
 * at the rate the order actually carried), and the row's unique key on the trade makes the job safe to repeat.
 * Self-clones, failed trades and runs that no longer follow the listing's rules never accrue.
 */
export async function accrueEarnings(pool: pg.Pool, log?: Logger, limit = 500): Promise<number> {
  const { rows } = await pool.query(
    `SELECT t.id AS trade_id, t.run_id, t.user_id AS clone_user_id, t.entry_price, t.entry_size, t.exit_price, t.exit_size, t.builder_bps,
            l.id AS listing_id, l.creator_id, l.creator_share_bps
       FROM live_trades t
       JOIN live_runs r ON r.id = t.run_id
       JOIN listings l ON l.id = r.listing_id
      WHERE t.status = 'closed' AND t.entry_price IS NOT NULL AND t.exit_price IS NOT NULL AND t.builder_bps IS NOT NULL
        AND l.creator_id <> t.user_id
        AND NOT EXISTS (SELECT 1 FROM creator_earnings e WHERE e.live_trade_id = t.id)
      ORDER BY t.id LIMIT $1`,
    [limit],
  );
  let n = 0;
  for (const r of rows) {
    try {
      const entryNotional = notionalOf(String(r.entry_price), String(r.entry_size));
      const exitNotional = notionalOf(String(r.exit_price), String(r.exit_size ?? r.entry_size));
      const fee = tradeBuilderFee({ entryNotional, exitNotional, bps: Number(r.builder_bps) });
      const amount = creatorShare(fee, Number(r.creator_share_bps));
      const res = await pool.query(
        `INSERT INTO creator_earnings (listing_id, creator_id, clone_user_id, run_id, live_trade_id, entry_notional, exit_notional, builder_bps, builder_fee, creator_share_bps, creator_amount)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (live_trade_id) DO NOTHING`,
        [
          r.listing_id,
          r.creator_id,
          r.clone_user_id,
          r.run_id,
          r.trade_id,
          entryNotional,
          exitNotional,
          r.builder_bps,
          fee,
          r.creator_share_bps,
          amount,
        ],
      );
      n += res.rowCount ?? 0;
    } catch (e) {
      log?.warn("earnings accrual failed", { tradeId: r.trade_id, err: errMsg(e) });
    }
  }
  if (n) log?.info("creator earnings accrued", { trades: n });
  return n;
}

export class EarningsJob {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  constructor(
    private readonly pool: pg.Pool,
    private readonly log: Logger,
    private readonly intervalMs = 60_000,
  ) {}

  start(): void {
    this.timer = setInterval(async () => {
      if (this.busy) return;
      this.busy = true;
      try {
        await accrueEarnings(this.pool, this.log);
      } catch (e) {
        this.log.error("earnings job failed", { err: errMsg(e) });
      } finally {
        this.busy = false;
      }
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
