import { cancelOrder, closePositionOrder } from "@tapeverify/strike-sdk";
import type { AppDeps } from "../app.js";

export interface Closable {
  id: string;
  user_id: string;
  symbol: string;
  side: "long" | "short";
  size: string;
  entry_size: string | null;
  tp_client_order_id: string | null;
  sl_client_order_id: string | null;
}

/**
 * Market-closes a tracked position (reduce-only, builder fee applied) and cancels leftover TP/SL legs.
 * The tracker records the real exit fills. Claims `close_requested_at` first so it can't be sent twice.
 */
export async function closeTracked(
  d: AppDeps,
  table: "calls" | "follows",
  row: Closable,
): Promise<"closed" | "already_requested"> {
  const claimed = await d.pool.query(
    `UPDATE ${table} SET close_requested_at = $2, updated_at = now() WHERE id = $1 AND close_requested_at IS NULL RETURNING id`,
    [row.id, Date.now()],
  );
  if (!claimed.rowCount) return "already_requested";
  const exitSide = row.side === "long" ? "sell" : "buy";
  try {
    await d.gateway.run(row.user_id, async (c) => {
      await closePositionOrder(
        c,
        {
          symbol: row.symbol,
          side: exitSide,
          size: row.entry_size ?? row.size,
          client_order_id: `tape-close-${row.id}`,
        },
        d.gateway.cfg.builderFeeBps,
      );
      for (const cid of [row.tp_client_order_id, row.sl_client_order_id]) {
        if (cid)
          await cancelOrder(c, { symbol: row.symbol, client_order_id: cid }).catch(() => undefined);
      }
    });
  } catch (e) {
    await d.pool.query(`UPDATE ${table} SET close_requested_at = NULL WHERE id = $1`, [row.id]);
    throw e;
  }
  return "closed";
}
