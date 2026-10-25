import type { AuditFinding } from "@tapeverify/shared";
import type { HistFill, HistOrder } from "./fetch.js";

/** Two decimals agree to far more precision than any price or size is quoted at. */
export const same = (a: number, b: number) =>
  Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

const SLACK_MS = 2_000;
const LIMIT_TYPES = new Set(["limit", "stop_limit", "take_profit_limit"]);

export interface OrderChecks {
  checked: number;
  consistent: number;
  skipped: number;
  findings: AuditFinding[];
}

/**
 * Checks that each order's own record and its fills tell the same story: the fills add up to what it filled, a limit
 * order never filled at a worse price than its limit, the fills sit inside the order's life, and its status fits.
 * Orders not wholly inside the window are skipped, because their fills may be missing from what was read.
 */
export function checkOrders(
  orders: HistOrder[],
  fills: HistFill[],
  win: { fromMs: number; toMs: number },
): OrderChecks {
  const byOrder = new Map<string, HistFill[]>();
  for (const f of fills) {
    const list = byOrder.get(f.order_id);
    if (list) list.push(f);
    else byOrder.set(f.order_id, [f]);
  }
  const out: OrderChecks = { checked: 0, consistent: 0, skipped: 0, findings: [] };
  for (const o of orders) {
    if (o.create_timestamp < win.fromMs || o.event_timestamp > win.toMs) {
      out.skipped++;
      continue;
    }
    out.checked++;
    const mine = byOrder.get(o.id) ?? [];
    const found: AuditFinding[] = [];
    const at = o.event_timestamp;
    const add = (kind: AuditFinding["kind"], detail: string, fillId?: string) =>
      found.push({ kind, symbol: o.symbol, at, orderId: o.id, fillId, detail });

    const size = Number(o.size);
    const filled = Number(o.filled);
    const sum = mine.reduce((a, f) => a + Number(f.size), 0);
    if (!same(sum, filled))
      add("order_fills", `Order says it filled ${o.filled} but its fills add up to ${sum}.`);
    if (filled > size && !same(filled, size))
      add("order_status", `Order filled ${o.filled}, more than its size ${o.size}.`);
    if (o.status === "filled" && !same(filled, size))
      add("order_status", `Order is marked filled but filled ${o.filled} of ${o.size}.`);
    if (["rejected", "untriggered", "pending"].includes(o.status) && (filled > 0 || mine.length))
      add("order_status", `Order is ${o.status} but has fills.`);

    for (const f of mine) {
      if (f.timestamp < o.create_timestamp - SLACK_MS || f.timestamp > o.event_timestamp + SLACK_MS)
        add("order_timing", `Fill at ${f.timestamp} is outside the order's life.`, f.id);
      if (LIMIT_TYPES.has(o.type) && Number(o.price) > 0) {
        const limit = Number(o.price);
        const price = Number(f.price);
        const worse = o.side === "buy" ? price > limit : price < limit;
        if (worse && !same(price, limit))
          add(
            "limit_price",
            `${o.side === "buy" ? "Buy" : "Sell"} limit ${o.price} filled at ${f.price}.`,
            f.id,
          );
      }
    }
    if (found.length === 0) out.consistent++;
    out.findings.push(...found);
  }
  return out;
}

export interface BookUpdate {
  orderId: string;
  side: "buy" | "sell";
  price: string;
  /** Size taken from the resting order (always positive). */
  size: string;
}

/**
 * The account's fill against the order book's record of the same trade. A trade is a taker order hitting one
 * resting order; the book says which resting order, at what price and size, and the fill must agree.
 */
export function checkFillAgainstBook(
  fill: HistFill,
  u: BookUpdate,
  standing: { ahead: number; price: string; bestPrice: string } | null,
): AuditFinding[] {
  const out: AuditFinding[] = [];
  const base = { symbol: fill.symbol, at: fill.timestamp, fillId: fill.id, orderId: fill.order_id };
  if (!same(Number(fill.price), Number(u.price)))
    out.push({
      ...base,
      kind: "book_mismatch",
      detail: `Fill price ${fill.price} but the book recorded the trade at ${u.price}.`,
    });
  if (!same(Number(fill.size), Number(u.size)))
    out.push({
      ...base,
      kind: "book_mismatch",
      detail: `Fill size ${fill.size} but the book recorded ${u.size}.`,
    });
  // The book's side is the resting order's. A maker fill is on that side, a taker fill on the other.
  const wantSide = fill.role === "maker" ? u.side : u.side === "buy" ? "sell" : "buy";
  if (fill.side !== wantSide)
    out.push({
      ...base,
      kind: "book_mismatch",
      detail: `A ${fill.role} ${fill.side} fill doesn't fit a resting ${u.side} order in the book.`,
    });
  if (standing) {
    if (!same(Number(standing.price), Number(standing.bestPrice)))
      out.push({
        ...base,
        kind: "priority",
        detail: `Filled against ${standing.price} while better-priced orders were resting (best ${standing.bestPrice}).`,
      });
    else if (standing.ahead > 0)
      out.push({
        ...base,
        kind: "priority",
        detail: `Filled at ${standing.price} with ${standing.ahead} older order${standing.ahead === 1 ? "" : "s"} still ahead in the queue.`,
      });
  }
  return out;
}
