import { compareDecimals, normalizeDecimal, sumDecimals } from "./decimal.js";

export type Side = "buy" | "sell";

export interface L3Order {
  order_id: string;
  size: string;
}
export interface L3Level {
  price: string;
  orders: L3Order[];
}
export interface L3BookSnapshot {
  symbol: string;
  last_sequence: number;
  timestamp: number;
  bids: L3Level[];
  asks: L3Level[];
}

export interface L3UpdateMessage {
  action: "open" | "modify" | "cancel" | "partial_fill" | "full_fill" | "clear";
  sequence: number;
  timestamp: number;
  order_id?: string;
  side?: Side;
  price?: string;
  remaining_size?: string;
}

/** The book can't be trusted any more (gap, clear, or inconsistent update): re-bootstrap from a snapshot. */
export class BookResetError extends Error {
  constructor(
    readonly reason: "gap" | "clear" | "inconsistent",
    message: string,
  ) {
    super(message);
  }
}

interface Resting {
  side: Side;
  price: string;
  size: string;
}

/**
 * Order-level (L3) book. Tracks every resting order in FIFO order per price level. Sizes always come
 * from the feed's `remaining_size`, so no decimal arithmetic is needed to apply updates.
 */
export class L3Book {
  private orders = new Map<string, Resting>();
  private levels: Record<Side, Map<string, string[]>> = { buy: new Map(), sell: new Map() };

  private constructor(
    readonly symbol: string,
    public sequence: number,
    public timestamp: number,
  ) {}

  static empty(symbol: string, sequence = 0): L3Book {
    return new L3Book(symbol, sequence, 0);
  }

  static fromSnapshot(s: L3BookSnapshot): L3Book {
    const b = new L3Book(s.symbol, s.last_sequence, s.timestamp);
    for (const [side, levels] of [
      ["buy", s.bids],
      ["sell", s.asks],
    ] as const) {
      for (const lvl of levels) {
        for (const o of lvl.orders) b.add(o.order_id, side, lvl.price, o.size);
      }
    }
    return b;
  }

  get orderCount(): number {
    return this.orders.size;
  }

  private add(id: string, side: Side, price: string, size: string) {
    if (this.orders.has(id)) throw new BookResetError("inconsistent", `duplicate order ${id}`);
    const p = normalizeDecimal(price);
    this.orders.set(id, { side, price: p, size: normalizeDecimal(size) });
    const lvl = this.levels[side].get(p);
    if (lvl) lvl.push(id);
    else this.levels[side].set(p, [id]);
  }

  private remove(id: string, o: Resting) {
    this.orders.delete(id);
    const lvl = this.levels[o.side].get(o.price);
    if (!lvl) return;
    const i = lvl.indexOf(id);
    if (i >= 0) lvl.splice(i, 1);
    if (lvl.length === 0) this.levels[o.side].delete(o.price);
  }

  /** Apply the next update. Throws BookResetError if it isn't exactly sequence + 1 or doesn't fit the book. */
  apply(u: L3UpdateMessage): void {
    if (u.action === "clear") throw new BookResetError("clear", "book cleared by feed");
    if (u.sequence !== this.sequence + 1) {
      throw new BookResetError("gap", `expected sequence ${this.sequence + 1}, got ${u.sequence}`);
    }
    const id = u.order_id;
    if (!id || !u.side || u.price === undefined || u.remaining_size === undefined) {
      throw new BookResetError("inconsistent", `malformed ${u.action} update`);
    }
    if (u.action === "open") {
      this.add(id, u.side, u.price, u.remaining_size);
    } else {
      const o = this.orders.get(id);
      if (!o) throw new BookResetError("inconsistent", `${u.action} for unknown order ${id}`);
      const remaining = normalizeDecimal(u.remaining_size);
      if (remaining === "0") {
        this.remove(id, o);
      } else if (u.action === "modify" && normalizeDecimal(u.price) !== o.price) {
        this.remove(id, o); // a price change loses queue priority
        this.add(id, o.side, u.price, remaining);
      } else {
        o.size = remaining;
      }
    }
    this.sequence = u.sequence;
    this.timestamp = u.timestamp;
  }

  private sortedPrices(side: Side): string[] {
    const prices = [...this.levels[side].keys()];
    prices.sort((a, b) => (side === "buy" ? -1 : 1) * compareDecimals(a, b));
    return prices;
  }

  toSnapshot(): L3BookSnapshot {
    const side = (s: Side): L3Level[] =>
      this.sortedPrices(s).map((price) => ({
        price,
        orders: (this.levels[s].get(price) ?? []).map((id) => ({
          order_id: id,
          size: this.orders.get(id)?.size ?? "0",
        })),
      }));
    return {
      symbol: this.symbol,
      last_sequence: this.sequence,
      timestamp: this.timestamp,
      bids: side("buy"),
      asks: side("sell"),
    };
  }

  /** Aggregated depth: best price first, with total size and order count per level. */
  depth(side: Side, n: number): Array<{ price: string; size: string; orders: number }> {
    return this.sortedPrices(side)
      .slice(0, n)
      .map((price) => {
        const ids = this.levels[side].get(price) ?? [];
        return {
          price,
          size: sumDecimals(ids.map((id) => this.orders.get(id)?.size ?? "0")),
          orders: ids.length,
        };
      });
  }

  /**
   * Where a resting order stands right now: the price it rests at, how many orders are queued ahead of it at that
   * price, and the best price on its side. A fill that follows price-time priority hits an order with `ahead` 0
   * whose price is the best on its side.
   */
  standing(id: string): { side: Side; price: string; ahead: number; bestPrice: string } | null {
    const o = this.orders.get(id);
    if (!o) return null;
    const queue = this.levels[o.side].get(o.price) ?? [];
    let best = o.price;
    for (const p of this.levels[o.side].keys()) {
      const better = o.side === "buy" ? compareDecimals(p, best) > 0 : compareDecimals(p, best) < 0;
      if (better) best = p;
    }
    return { side: o.side, price: o.price, ahead: queue.indexOf(id), bestPrice: best };
  }

  bestBid(): string | null {
    return this.sortedPrices("buy")[0] ?? null;
  }

  bestAsk(): string | null {
    return this.sortedPrices("sell")[0] ?? null;
  }
}

/** Same orders, same FIFO order, same sizes (price formatting ignored). */
export function sameBook(a: L3BookSnapshot, b: L3BookSnapshot): boolean {
  const norm = (lv: L3Level[]) =>
    JSON.stringify(
      lv.map((l) => [
        normalizeDecimal(l.price),
        l.orders.map((o) => [o.order_id, normalizeDecimal(o.size)]),
      ]),
    );
  return norm(a.bids) === norm(b.bids) && norm(a.asks) === norm(b.asks);
}
