import { describe, expect, it } from "vitest";
import { computeStats, riskLevel, type StatsTrade, unrankedReason } from "./stats.js";

const D = 86_400_000;
const t = (
  id: string,
  closedMs: number,
  netPnl: string,
  over: Partial<StatsTrade> = {},
): StatsTrade => ({
  id,
  symbol: "BTC-USD",
  openedMs: closedMs - 3_600_000,
  closedMs,
  entryNotional: "1000",
  netPnl,
  ...over,
});

describe("computeStats", () => {
  it("scores time-weighted returns on equity, not on deposits", () => {
    // $1000 deposited; +10% then -10%: 1000 -> 1100 -> 990
    const s = computeStats(
      [t("a", 2 * D, "100"), t("b", 3 * D, "-110")],
      [{ ts: D, amount: "1000" }],
    );
    expect(s.trades).toBe(2);
    expect(s.netPnl).toBe("-10");
    expect(s.totalReturnPct).toBeCloseTo((1.1 * (1 - 110 / 1100) - 1) * 100, 6); // 1.1 x 0.9 - 1 = -1%
    expect(s.maxDrawdownPct).toBeCloseTo(10, 6);
    expect(s.winRate).toBe(0.5);
    expect(s.wins).toBe(1);
    expect(s.losses).toBe(1);
  });

  it("a later deposit doesn't inflate performance", () => {
    const flows = [
      { ts: D, amount: "1000" },
      { ts: 2.5 * D, amount: "9000" },
    ];
    const s = computeStats([t("a", 2 * D, "100"), t("b", 3 * D, "100")], flows); // +10%, then +1% of 10,100
    expect(s.totalReturnPct).toBeCloseTo((1.1 * (1 + 100 / 10_100) - 1) * 100, 6);
  });

  it("withdrawals lower the base without counting as losses", () => {
    const s = computeStats(
      [t("a", 3 * D, "50")],
      [
        { ts: D, amount: "1000" },
        { ts: 2 * D, amount: "-500" },
      ],
    );
    expect(s.totalReturnPct).toBeCloseTo(10, 6); // 50 / 500
  });

  it("the window and market choose trades but equity comes from the whole account", () => {
    const trades = [
      t("a", D, "100"),
      t("b", 5 * D, "55", { symbol: "ETH-USD" }),
      t("c", 6 * D, "-60"),
    ];
    const flows = [{ ts: 0, amount: "1000" }];
    const week = computeStats(trades, flows, { from: 4 * D });
    expect(week.trades).toBe(2);
    expect(week.netPnl).toBe("-5");
    expect(week.totalReturnPct).toBeCloseTo(((1 + 55 / 1100) * (1 - 60 / 1155) - 1) * 100, 6);
    const eth = computeStats(trades, flows, { symbol: "ETH-USD" });
    expect(eth.trades).toBe(1);
    expect(eth.netPnl).toBe("55");
  });

  it("counts trades with no capital history in PnL but not in returns", () => {
    const s = computeStats([t("a", D, "100")], []);
    expect(s.netPnl).toBe("100");
    expect(s.tradesWithoutCapital).toBe(1);
    expect(s.totalReturnPct).toBeNull();
    expect(s.maxDrawdownPct).toBeNull();
    expect(unrankedReason(s, 10_000, "all")).toBe("no_capital_history");
  });

  it("a blown-up account bottoms out at -100% and later trades have no capital", () => {
    const s = computeStats(
      [t("a", 2 * D, "-1000"), t("b", 3 * D, "50")],
      [{ ts: D, amount: "1000" }],
    );
    expect(s.totalReturnPct).toBeCloseTo(-100, 6);
    expect(s.maxDrawdownPct).toBeCloseTo(100, 6);
    expect(s.tradesWithoutCapital).toBe(1);
  });

  it("computes consistency, hold time, leverage and active days", () => {
    const trades = [
      t("a", D, "10"),
      t("b", D + 1000, "20"),
      t("c", 3 * D, "-5"),
      t("d", 4 * D, "15"),
    ];
    const s = computeStats(trades, [{ ts: 0, amount: "1000" }]);
    expect(s.activeDays).toBe(3);
    expect(s.avgHoldMs).toBe(3_600_000);
    expect(s.effectiveLeverage).toBeGreaterThan(0.9);
    expect(s.effectiveLeverage).toBeLessThan(1.1);
    expect(s.consistency).toBeGreaterThan(0);
    expect(s.bestTradePnl).toBe("20");
    expect(s.worstTradePnl).toBe("-5");
    expect(s.curve).toHaveLength(4);
    expect(computeStats([t("a", D, "10")], [{ ts: 0, amount: "1000" }]).consistency).toBeNull(); // one trade
  });

  it("is empty-safe", () => {
    const s = computeStats([], []);
    expect(s).toMatchObject({
      trades: 0,
      winRate: null,
      netPnl: "0",
      totalReturnPct: null,
      consistency: null,
    });
  });
});

describe("ranking rules", () => {
  const base = { trades: 12, activeDays: 5, totalReturnPct: 5, tradesWithoutCapital: 0 } as never;
  it("applies per-timeframe minimums", () => {
    expect(unrankedReason(base, 5000, "all")).toBeNull();
    expect(unrankedReason({ ...(base as object), trades: 9 } as never, 5000, "all")).toBe(
      "too_few_trades",
    );
    expect(unrankedReason({ ...(base as object), trades: 4 } as never, 5000, "7d")).toBe(
      "too_few_trades",
    );
    expect(unrankedReason({ ...(base as object), trades: 4 } as never, 5000, "24h")).toBeNull();
    expect(unrankedReason({ ...(base as object), activeDays: 2 } as never, 5000, "all")).toBe(
      "too_few_days",
    );
    expect(unrankedReason(base, 100, "all")).toBe("low_volume");
  });
  it("buckets risk", () => {
    expect(riskLevel({ effectiveLeverage: 1, maxDrawdownPct: 5 })).toBe("low");
    expect(riskLevel({ effectiveLeverage: 5, maxDrawdownPct: 5 })).toBe("medium");
    expect(riskLevel({ effectiveLeverage: 1, maxDrawdownPct: 20 })).toBe("medium");
    expect(riskLevel({ effectiveLeverage: 20, maxDrawdownPct: 5 })).toBe("high");
    expect(riskLevel({ effectiveLeverage: 1, maxDrawdownPct: 40 })).toBe("high");
    expect(riskLevel({ effectiveLeverage: null, maxDrawdownPct: null })).toBe("unknown");
  });
});
