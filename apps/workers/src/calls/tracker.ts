import { aggregateFills, compareDecimals, sumSigned } from "@pit/shared";
import {
  getAccountFills,
  getAccountOrders,
  getOrderFills,
  type StrikeClient,
  type StrikeFill,
  type StrikeOrder,
} from "@pit/strike-sdk";
import type pg from "pg";
import { errMsg, type Logger } from "../log.js";

/** Columns of `calls` the tracker reads (pg returns numerics and bigints as strings). */
export interface TrackedCall {
  id: string;
  user_id: string;
  symbol: string;
  side: "long" | "short";
  status: "pending" | "open" | "expired";
  strategy_id: string | null;
  primary_client_order_id: string | null;
  tp_client_order_id: string | null;
  sl_client_order_id: string | null;
  /** Live runs only. */
  trail_client_order_id?: string | null;
  entry_trade_id: string | null;
  entry_size: string | null;
  entry_ts_ms: string | null;
  created_ms: string;
  strike_account_id: string | null;
}

/** A pending call with no order on Strike's books after this long was never placed. */
const ORDER_GRACE_MS = 90_000;
const PAGE = 1000;

const sum = sumSigned;

/**
 * Moves one call forward from Strike's own records:
 *   pending -> open    when the primary order fills (entry = VWAP of its real fills)
 *   pending -> failed  when it is rejected, canceled with no fill, or never appears
 *   open/expired -> closed when closing fills cover the entry size (exit = VWAP, reason from the closing order)
 * Nothing here trusts user input: prices and times all come from fills.
 */
/** Both calls and follows are tracked the same way; the table name is whitelisted, never user input. */
export type TrackedTable = "calls" | "follows" | "live_trades";

export async function trackCall(
  client: StrikeClient,
  pool: pg.Pool,
  call: TrackedCall,
  now = Date.now(),
  table: TrackedTable = "calls",
): Promise<"unchanged" | "opened" | "failed" | "closed"> {
  const accountId = call.strike_account_id;
  const fail = async (reason: string) => {
    await pool.query(
      `UPDATE ${table} SET status = 'failed', fail_reason = $2, updated_at = now() WHERE id = $1 AND status = 'pending'`,
      [call.id, reason],
    );
    return "failed" as const;
  };
  if (!accountId) return call.status === "pending" ? fail("no_strike_account") : "unchanged";

  const orders = await getAccountOrders(client, accountId, { symbol: call.symbol, limit: 100 });

  if (call.status === "pending") {
    const primary = findPrimary(orders, call);
    if (!primary) {
      return now - Number(call.created_ms) > ORDER_GRACE_MS ? fail("order_not_found") : "unchanged";
    }
    const filled = Number(primary.filled) > 0;
    if (
      primary.status === "rejected" ||
      ((primary.status === "canceled" || primary.status === "expired") && !filled)
    ) {
      return fail(primary.error_message || primary.close_reason || primary.status);
    }
    if (
      !filled ||
      primary.status === "pending" ||
      primary.status === "open" ||
      primary.status === "untriggered"
    ) {
      return "unchanged";
    }
    const fills = await getOrderFills(client, accountId, primary.id);
    const agg = aggregateFills(fills);
    if (!agg) return "unchanged"; // fills not visible yet; try again next tick
    const done = await pool.query(
      `UPDATE ${table} SET status = 'open', entry_order_id = $2, entry_trade_id = $3, entry_price = $4,
              entry_size = $5, entry_fee = $6, entry_ts_ms = $7, updated_at = now()
        WHERE id = $1 AND status = 'pending'`,
      [
        call.id,
        primary.id,
        Math.max(...fills.map((f) => Number(f.trade_id))),
        agg.price,
        agg.size,
        sum(fills.map((f) => f.fee ?? "0")),
        Math.min(...fills.map((f) => Number(f.timestamp))),
      ],
    );
    return done.rowCount ? "opened" : "unchanged";
  }

  // open or expired: has the position been closed?
  if (!call.entry_trade_id || !call.entry_size || !call.entry_ts_ms) return "unchanged";
  const entryTrade = Number(call.entry_trade_id);
  const entryTs = Number(call.entry_ts_ms);
  const opposite = call.side === "long" ? "sell" : "buy";

  const closing: StrikeFill[] = [];
  let since = Math.max(0, entryTrade - 1);
  for (;;) {
    const page = await getAccountFills(client, accountId, { sinceTradeId: since, limit: PAGE });
    for (const f of page) {
      if (
        f.symbol === call.symbol &&
        f.side === opposite &&
        Number(f.trade_id) > entryTrade &&
        f.timestamp >= entryTs
      ) {
        closing.push(f);
      }
    }
    const top = page.length ? Math.max(...page.map((f) => Number(f.trade_id))) : since;
    if (page.length < PAGE || top <= since) break;
    since = top - 1;
  }
  const agg = aggregateFills(closing);
  if (!agg || compareDecimals(agg.size, call.entry_size) < 0) return "unchanged"; // still (partly) open

  const last = closing.reduce((a, b) => (Number(b.trade_id) > Number(a.trade_id) ? b : a));
  const reason = exitReason(last, orders, call);
  const res = await pool.query(
    `UPDATE ${table} SET status = 'closed', exit_price = $2, exit_size = $3, exit_ts_ms = $4, exit_reason = $5,
            realized_pnl = $6, exit_fee = $7, updated_at = now()
      WHERE id = $1 AND status IN ('open', 'expired')`,
    [
      call.id,
      agg.price,
      agg.size,
      Math.max(...closing.map((f) => Number(f.timestamp))),
      reason,
      sum(closing.map((f) => f.realized_pnl ?? "0")),
      sum(closing.map((f) => f.fee ?? "0")),
    ],
  );
  return res.rowCount ? "closed" : "unchanged";
}

function findPrimary(orders: StrikeOrder[], call: TrackedCall): StrikeOrder | undefined {
  return (
    orders.find((o) => o.client_order_id === call.primary_client_order_id) ??
    orders.find(
      (o) => call.strategy_id !== null && o.strategy_id === call.strategy_id && o.is_primary,
    )
  );
}

function exitReason(last: StrikeFill, orders: StrikeOrder[], call: TrackedCall): string {
  if (last.fee_type === "liquidation") return "liquidation";
  const order = orders.find((o) => o.id === Number(last.order_id));
  const cid = order?.client_order_id;
  if (cid && cid === call.tp_client_order_id) return "tp";
  if (cid && cid === call.sl_client_order_id) return "sl";
  if (cid && cid === call.trail_client_order_id) return "trailing_stop";
  if (cid?.startsWith("pit-close-") || cid?.startsWith("pitlive-close-")) return "manual";
  return "external"; // closed outside Pit (e.g. in Strike's own app)
}

export class CallTracker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  constructor(
    private readonly client: StrikeClient,
    private readonly pool: pg.Pool,
    private readonly log: Logger,
    private readonly intervalMs = 5000,
  ) {}

  async tick(now = Date.now()): Promise<void> {
    // The follow window is independent of the trade: past it the call reads as expired, but stays tracked.
    await this.pool.query(
      "UPDATE calls SET status = 'expired', updated_at = now() WHERE status = 'open' AND expires_at <= $1",
      [now],
    );
    // Live trades are tracked by the live runner itself, in the same pass that decides what to do next.
    for (const table of ["calls", "follows"] as const) {
      const { rows } = await this.pool.query(
        `SELECT c.id, c.user_id, c.symbol, c.side, c.status, c.strategy_id, c.primary_client_order_id,
                c.tp_client_order_id, c.sl_client_order_id, c.entry_trade_id, c.entry_size, c.entry_ts_ms,
                (extract(epoch FROM c.created_at) * 1000)::bigint AS created_ms, u.strike_account_id
           FROM ${table} c JOIN users u ON u.id = c.user_id
          WHERE c.status IN ('pending', 'open', 'expired')`,
      );
      for (const row of rows as TrackedCall[]) {
        try {
          const r = await trackCall(this.client, this.pool, row, now, table);
          if (r !== "unchanged") this.log.info(`${table} updated`, { id: row.id, result: r });
        } catch (e) {
          this.log.warn(`${table} tracking failed`, { id: row.id, err: errMsg(e) });
        }
      }
    }
  }

  start(): void {
    this.timer = setInterval(async () => {
      if (this.busy) return;
      this.busy = true;
      try {
        await this.tick();
      } catch (e) {
        this.log.error("call tracker tick failed", { err: errMsg(e) });
      } finally {
        this.busy = false;
      }
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
