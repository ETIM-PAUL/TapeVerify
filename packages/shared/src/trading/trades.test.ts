import { describe, expect, it } from "vitest";
import { buildTrades, type FillInput } from "./trades.js";

let n = 0;
const f = (o: Partial<FillInput> & Pick<FillInput, "side" | "price" | "size">): FillInput => ({
  id: `f${++n}`,
  tradeId: n,
  symbol: "BTC-USD",
  realizedPnl: "0",
  fee: "0.1",
  feeType: "commission",
  ts: 1000 + n * 10,
  ...o,
});

describe("buildTrades", () => {
  it("turns an open and a close into one trade with exact values", () => {
    const { trades, open } = buildTrades([
      f({ side: "buy", price: "80000", size: "0.002" }),
      f({ side: "sell", price: "84000", size: "0.002", realizedPnl: "8", fee: "0.17" }),
    ]);
    expect(open).toEqual([]);
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({
      symbol: "BTC-USD",
      side: "long",
      size: "0.002",
      entryPrice: "80000",
      exitPrice: "84000",
      grossPnl: "8",
      fees: "0.27",
      liquidated: false,
      split: false,
    });
    expect(trades[0]?.entryLegs.map((l) => l.fillId)).toEqual(["f1"]);
    expect(trades[0]?.exitLegs.map((l) => l.fillId)).toEqual(["f2"]);
  });

  it("averages scaled-in entries and scaled-out exits by volume", () => {
    const { trades } = buildTrades([
      f({ side: "sell", price: "100", size: "1" }),
      f({ side: "sell", price: "110", size: "3" }), // short 4 @ 107.5
      f({ side: "buy", price: "100", size: "1", realizedPnl: "7.5" }),
      f({ side: "buy", price: "90", size: "3", realizedPnl: "52.5" }),
    ]);
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({
      side: "short",
      size: "4",
      entryPrice: "107.5",
      exitPrice: "92.5",
      grossPnl: "60",
      fees: "0.4",
    });
    expect(trades[0]?.entryLegs).toHaveLength(2);
    expect(trades[0]?.exitLegs).toHaveLength(2);
  });

  it("keeps markets separate and reports positions that are still open", () => {
    const { trades, open } = buildTrades([
      f({ side: "buy", price: "80000", size: "0.1" }),
      f({ side: "buy", price: "2400", size: "1", symbol: "ETH-USD" }),
      f({ side: "sell", price: "2500", size: "1", symbol: "ETH-USD", realizedPnl: "100" }),
    ]);
    expect(trades.map((t) => t.symbol)).toEqual(["ETH-USD"]);
    expect(open).toEqual([{ symbol: "BTC-USD", side: "long", size: "0.1" }]);
  });

  it("splits a fill that flips the position through zero, giving all realized PnL to the closing part", () => {
    const first = f({ side: "buy", price: "100", size: "2" });
    const flip = f({ side: "sell", price: "110", size: "3", realizedPnl: "20", fee: "0.3" }); // closes 2, opens 1 short
    const last = f({ side: "buy", price: "105", size: "1", realizedPnl: "5" });
    const { trades, open } = buildTrades([first, flip, last]);
    expect(trades).toHaveLength(2);
    expect(trades[0]).toMatchObject({ side: "long", grossPnl: "20", split: true });
    expect(trades[0]?.exitLegs[0]).toMatchObject({ fillId: flip.id, qty: "2" });
    expect(trades[0]?.fees).toBe("0.3"); // 0.1 entry + 2/3 of 0.3 = 0.2
    expect(trades[1]).toMatchObject({
      side: "short",
      size: "1",
      entryPrice: "110",
      exitPrice: "105",
      grossPnl: "5",
      split: true,
    });
    expect(trades[1]?.entryLegs[0]).toMatchObject({ fillId: flip.id, qty: "1" });
    expect(trades[1]?.fees).toBe("0.2"); // 1/3 of 0.3 + 0.1 close
    expect(open).toEqual([]);
  });

  it("handles negative fees (maker rebates), including when a flip splits them", () => {
    const { trades } = buildTrades([
      f({ side: "buy", price: "100", size: "1", fee: "-0.05" }),
      f({ side: "sell", price: "110", size: "1", realizedPnl: "10", fee: "0.1" }),
    ]);
    expect(trades[0]?.fees).toBe("0.05");
    const flip = buildTrades([
      f({ side: "buy", price: "100", size: "2", fee: "0" }),
      f({ side: "sell", price: "110", size: "3", realizedPnl: "20", fee: "-0.3" }),
    ]);
    expect(flip.trades[0]?.fees).toBe("-0.2");
  });

  it("flags liquidations", () => {
    const { trades } = buildTrades([
      f({ side: "buy", price: "100", size: "1" }),
      f({ side: "sell", price: "50", size: "1", realizedPnl: "-50", feeType: "liquidation" }),
    ]);
    expect(trades[0]).toMatchObject({ liquidated: true, grossPnl: "-50" });
  });

  it("is independent of input order and handles ties by trade id", () => {
    const a = f({ side: "buy", price: "100", size: "1", ts: 5000, tradeId: 1 });
    const b = f({ side: "sell", price: "110", size: "1", ts: 5000, tradeId: 2, realizedPnl: "10" });
    expect(buildTrades([b, a]).trades).toEqual(buildTrades([a, b]).trades);
    expect(buildTrades([b, a]).trades).toHaveLength(1);
  });

  it("ignores zero-size fills and never loses or invents quantity", () => {
    const fills = [
      f({ side: "buy", price: "10", size: "0.000000000000000003" }),
      f({ side: "buy", price: "10", size: "0" }),
      f({ side: "sell", price: "12", size: "0.000000000000000001", realizedPnl: "0" }),
      f({ side: "sell", price: "12", size: "0.000000000000000002", realizedPnl: "0" }),
    ];
    const { trades, open } = buildTrades(fills);
    expect(open).toEqual([]);
    expect(trades[0]?.size).toBe("0.000000000000000003");
    expect(trades[0]?.exitLegs.map((l) => l.qty)).toEqual([
      "0.000000000000000001",
      "0.000000000000000002",
    ]);
  });
});
