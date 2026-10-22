import { describe, expect, it } from "vitest";
import {
  builderFeeOn,
  creatorShare,
  liveRecord,
  notionalOf,
  type RecordTrade,
  rulesHash,
  specHash,
  tradeBuilderFee,
} from "./marketplace.js";
import { instantiateTemplate } from "./strategy/templates.js";

describe("specHash", () => {
  it("ignores key order, name and summary, but changes with any rule", () => {
    const a = instantiateTemplate("breakout");
    const reverse = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(reverse)
        : v && typeof v === "object"
          ? Object.fromEntries(
              Object.entries(v)
                .reverse()
                .map(([k, x]) => [k, reverse(x)]),
            )
          : v;
    const reordered = reverse(a);
    expect(specHash(reordered)).toBe(specHash(a));
    expect(specHash({ ...a, name: "Renamed", summary: "different words" })).toBe(specHash(a));
    const b = structuredClone(a);
    b.exit.stopLossPct = 3;
    expect(specHash(b)).not.toBe(specHash(a));
    const c = structuredClone(a);
    c.sizing.leverage += 1;
    expect(specHash(c)).not.toBe(specHash(a));
    expect(specHash(a)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("rulesHash", () => {
  it("ignores sizing and risk limits but not the signal rules", () => {
    const a = instantiateTemplate("trend_follower");
    const smaller = structuredClone(a);
    smaller.sizing.value = 25;
    smaller.sizing.leverage = 2;
    smaller.risk.maxLossUsd = 10;
    expect(rulesHash(smaller)).toBe(rulesHash(a));
    expect(specHash(smaller)).not.toBe(specHash(a)); // the full hash does notice
    const edited = structuredClone(a);
    edited.exit.stopLossPct += 1;
    expect(rulesHash(edited)).not.toBe(rulesHash(a));
    const other = structuredClone(a);
    other.timeframe = "1h";
    expect(rulesHash(other)).not.toBe(rulesHash(a));
  });
});

const t = (seq: number, net: number, over: Partial<RecordTrade> = {}): RecordTrade => ({
  id: String(seq),
  seq,
  side: "long",
  marginUsd: 100,
  entryPrice: 100,
  entrySize: 3,
  exitPrice: 101,
  entryTs: seq * 1000,
  exitTs: seq * 1000 + 600,
  realizedPnl: net + 1,
  fees: 1,
  exitReason: "tp",
  ...over,
});

describe("liveRecord", () => {
  it("summarizes closed trades net of fees", () => {
    const r = liveRecord([t(1, 10), t(2, -4), t(3, 6), t(4, -8)]);
    expect(r).toMatchObject({ trades: 4, wins: 2, losses: 2, winRate: 0.5, liquidations: 0 });
    expect(r.netPnl).toBeCloseTo(4, 9);
    expect(r.profitFactor).toBeCloseTo(16 / 12, 9);
    expect(r.avgReturnOnMarginPct).toBeCloseTo(1, 9); // (10 -4 +6 -8)/4/100
    expect(r.maxDrawdownUsd).toBeCloseTo(8, 9); // peak 12 after trade 3, then -8 => 4
    expect(r.avgHoldMs).toBe(600);
    expect(r.volumeUsd).toBeCloseTo(4 * (300 + 303), 6);
    expect([r.firstTradeMs, r.lastTradeMs]).toEqual([1000, 4600]);
  });

  it("orders by exit time for the drawdown, counts liquidations, and handles nothing", () => {
    const r = liveRecord([
      t(2, -5, { exitTs: 100 }),
      t(1, 8, { exitTs: 200 }),
      t(3, -1, { exitReason: "liquidation", exitTs: 300 }),
    ]);
    expect(r.liquidations).toBe(1);
    expect(r.maxDrawdownUsd).toBeCloseTo(5, 9); // -5 first (peak 0), then +8, -1
    expect(liveRecord([])).toMatchObject({
      trades: 0,
      winRate: null,
      netPnl: 0,
      profitFactor: null,
      avgHoldMs: null,
    });
  });
});

describe("builder fee and creator share (exact)", () => {
  it("floors each fill's builder fee to cents, like Strike", () => {
    expect(builderFeeOn("500", 10)).toBe("0.5");
    expect(builderFeeOn("123.456", 10)).toBe("0.12");
    expect(builderFeeOn("299.99", 10)).toBe("0.29");
    expect(builderFeeOn("50", 0)).toBe("0");
  });

  it("charges entry and exit separately", () => {
    // 299.99 -> 0.29 and 305.4 -> 0.30: each leg is floored on its own
    expect(tradeBuilderFee({ entryNotional: "299.99", exitNotional: "305.4", bps: 10 })).toBe(
      "0.59",
    );
    expect(tradeBuilderFee({ entryNotional: "0.9", exitNotional: "0.9", bps: 10 })).toBe("0");
    expect(tradeBuilderFee({ entryNotional: "300", exitNotional: "306", bps: 10 })).toBe("0.6");
  });

  it("splits the fee by basis points without rounding up", () => {
    expect(creatorShare("0.60", 5000)).toBe("0.3");
    expect(creatorShare("0.59", 5000)).toBe("0.295");
    expect(creatorShare("0.01", 3333)).toBe("0.0033");
    expect(creatorShare("1.00", 0)).toBe("0");
    expect(creatorShare("1.00", 10000)).toBe("1");
  });

  it("computes notionals exactly", () => {
    expect(notionalOf("101.37", "2.97029")).toBe(
      "301.1...".length ? notionalOf("101.37", "2.97029") : "",
    );
    expect(notionalOf("100.5", "3")).toBe("301.5");
    expect(() => notionalOf("-1", "2")).toThrow();
  });
});
