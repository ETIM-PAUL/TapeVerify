import { describe, expect, it } from "vitest";
import { BookResetError, L3Book, type L3BookSnapshot, sameBook } from "./book.js";
import { compareDecimals, normalizeDecimal, sumDecimals } from "./decimal.js";

const snap = (): L3BookSnapshot => ({
  symbol: "BTC-USD",
  last_sequence: 10,
  timestamp: 1000,
  bids: [
    {
      price: "100.0",
      orders: [
        { order_id: "b1", size: "1" },
        { order_id: "b2", size: "0.5" },
      ],
    },
    { price: "99", orders: [{ order_id: "b3", size: "2" }] },
  ],
  asks: [{ price: "101.50", orders: [{ order_id: "a1", size: "1" }] }],
});

const up = (sequence: number, action: string, extra: Record<string, unknown>) =>
  ({ sequence, timestamp: 1000 + sequence, action, ...extra }) as Parameters<L3Book["apply"]>[0];

describe("decimals", () => {
  it("normalizes, sums exactly and compares", () => {
    expect(normalizeDecimal("117500.00")).toBe("117500");
    expect(normalizeDecimal("72247.30")).toBe("72247.3");
    expect(normalizeDecimal("007.50")).toBe("7.5");
    expect(sumDecimals(["0.1", "0.2"])).toBe("0.3");
    expect(sumDecimals(["1", "0.00000001"])).toBe("1.00000001");
    expect(compareDecimals("72247.3", "81597.2")).toBe(-1);
    expect(compareDecimals("100", "100.0")).toBe(0);
    expect(() => normalizeDecimal("-1")).toThrow();
  });
});

describe("L3Book", () => {
  it("round-trips a snapshot with normalized prices and keeps FIFO order", () => {
    const b = L3Book.fromSnapshot(snap());
    const s = b.toSnapshot();
    expect(s.bids[0]?.price).toBe("100");
    expect(s.bids[0]?.orders.map((o) => o.order_id)).toEqual(["b1", "b2"]);
    expect(s.asks[0]?.price).toBe("101.5");
    expect(sameBook(s, snap())).toBe(true);
    expect(b.bestBid()).toBe("100");
    expect(b.bestAsk()).toBe("101.5");
  });

  it("applies open, partial fill, full fill and cancel", () => {
    const b = L3Book.fromSnapshot(snap());
    b.apply(up(11, "open", { order_id: "b4", side: "buy", price: "100.00", remaining_size: "3" }));
    expect(b.depth("buy", 1)).toEqual([{ price: "100", size: "4.5", orders: 3 }]);
    b.apply(
      up(12, "partial_fill", { order_id: "b1", side: "buy", price: "100", remaining_size: "0.4" }),
    );
    expect(b.depth("buy", 1)[0]?.size).toBe("3.9");
    b.apply(
      up(13, "full_fill", { order_id: "b1", side: "buy", price: "100", remaining_size: "0" }),
    );
    b.apply(
      up(14, "cancel", { order_id: "a1", side: "sell", price: "101.5", remaining_size: "0" }),
    );
    expect(b.bestAsk()).toBeNull();
    const s = b.toSnapshot();
    expect(s.bids[0]?.orders.map((o) => o.order_id)).toEqual(["b2", "b4"]); // new order queues last
    expect(s.last_sequence).toBe(14);
    expect(b.orderCount).toBe(3);
  });

  it("removes an emptied level and re-sorts", () => {
    const b = L3Book.fromSnapshot(snap());
    b.apply(up(11, "cancel", { order_id: "b3", side: "buy", price: "99", remaining_size: "0" }));
    expect(b.depth("buy", 5).map((l) => l.price)).toEqual(["100"]);
  });

  it("a modify to a new price loses queue priority", () => {
    const b = L3Book.fromSnapshot(snap());
    b.apply(up(11, "modify", { order_id: "b1", side: "buy", price: "99", remaining_size: "1" }));
    expect(b.toSnapshot().bids.map((l) => [l.price, l.orders.map((o) => o.order_id)])).toEqual([
      ["100", ["b2"]],
      ["99", ["b3", "b1"]],
    ]);
  });

  it("demands contiguous sequences", () => {
    const b = L3Book.fromSnapshot(snap());
    for (const seq of [10, 12]) {
      expect(() =>
        b.apply(up(seq, "open", { order_id: "x", side: "buy", price: "1", remaining_size: "1" })),
      ).toThrow(expect.objectContaining({ reason: "gap" }));
    }
    expect(b.sequence).toBe(10); // a rejected update leaves the book untouched
  });

  it("treats clear and inconsistent updates as a reset", () => {
    const b = L3Book.fromSnapshot(snap());
    expect(() => b.apply(up(11, "clear", {}))).toThrow(BookResetError);
    expect(() =>
      b.apply(up(11, "cancel", { order_id: "nope", side: "buy", price: "1", remaining_size: "0" })),
    ).toThrow(expect.objectContaining({ reason: "inconsistent" }));
    expect(() =>
      b.apply(up(11, "open", { order_id: "b1", side: "buy", price: "1", remaining_size: "1" })),
    ).toThrow(expect.objectContaining({ reason: "inconsistent" }));
    expect(() => b.apply(up(11, "open", { side: "buy" }))).toThrow(BookResetError);
  });
});
