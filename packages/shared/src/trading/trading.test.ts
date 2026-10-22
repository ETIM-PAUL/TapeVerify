import { describe, expect, it } from "vitest";
import { aggregateFills, driftBps, followability, sumSigned } from "./calls.js";
import { divFloor, floorToGrid, isOnGrid, roundToGrid } from "./decimal-math.js";
import { sizeFromMargin } from "./size.js";
import { type MarketRulesLite, validateCallOrder } from "./validate.js";

const BTC: MarketRulesLite = {
  symbol: "BTC-USD",
  base_asset: "BTC",
  status: "trading",
  reduce_only: false,
  margin_tiers: [
    { max_notional: "300000", max_leverage: 150 },
    { max_notional: "800000", max_leverage: 100 },
    { max_notional: "3000000", max_leverage: 75 },
  ],
  order_tick_price: "0.10",
  order_min_price: "0.10",
  order_max_price: "0",
  order_market_step_size: "0.00001",
  order_market_min_size: "0.00001",
  order_market_max_size: "120",
  order_min_notional: "100",
  mark_price: "80000",
};

describe("grid math", () => {
  it("checks and rounds grids exactly", () => {
    expect(isOnGrid("0.00130", "0.00001", "0.00001")).toBe(true);
    expect(isOnGrid("0.000015", "0.00001", "0.00001")).toBe(false);
    expect(isOnGrid("81000.1", "0.10", "0.10")).toBe(true);
    expect(isOnGrid("81000.15", "0.10", "0.10")).toBe(false);
    expect(roundToGrid("81000.14", "0.10", "0.10")).toBe("81000.1");
    expect(roundToGrid("81000.15", "0.10", "0.10")).toBe("81000.2");
    expect(roundToGrid("5", "0.1", "0.1")).toBe("5");
  });
});

describe("validateCallOrder", () => {
  const ok = {
    side: "long" as const,
    size: "0.002",
    leverage: 10,
    tpPrice: "84000",
    slPrice: "78000",
  };

  it("accepts a good order and returns tick-rounded exits", () => {
    const r = validateCallOrder(BTC, { ...ok, tpPrice: "84000.04", slPrice: "77999.96" });
    expect(r).toMatchObject({
      ok: true,
      size: "0.002",
      tpPrice: "84000",
      slPrice: "78000",
      notional: "160",
      maxLeverage: 150,
    });
  });

  it("enforces size rules and the minimum order value", () => {
    expect(validateCallOrder(BTC, { ...ok, size: "0.000001" })).toMatchObject({
      ok: false,
      code: "bad_size",
    });
    expect(validateCallOrder(BTC, { ...ok, size: "121" })).toMatchObject({
      ok: false,
      code: "bad_size",
    });
    expect(validateCallOrder(BTC, { ...ok, size: "0.0020001" })).toMatchObject({
      ok: false,
      code: "bad_size",
    });
    const min = validateCallOrder(BTC, { ...ok, size: "0.001" }); // $80 < $100
    expect(min).toMatchObject({ ok: false, code: "bad_size" });
    expect((min as { error: string }).error).toMatch(/Minimum order value/);
    expect(validateCallOrder(BTC, { ...ok, size: "abc" })).toMatchObject({
      ok: false,
      code: "bad_size",
    });
  });

  it("caps leverage by the position's tier", () => {
    expect(validateCallOrder(BTC, { ...ok, leverage: 151 })).toMatchObject({
      ok: false,
      code: "bad_leverage",
    });
    expect(validateCallOrder(BTC, { ...ok, leverage: 0 })).toMatchObject({
      ok: false,
      code: "bad_leverage",
    });
    expect(validateCallOrder(BTC, { ...ok, leverage: 2.5 })).toMatchObject({
      ok: false,
      code: "bad_leverage",
    });
    const big = validateCallOrder(BTC, { ...ok, size: "6", leverage: 120 }); // $480k -> tier max 100x
    expect(big).toMatchObject({ ok: false, code: "bad_leverage" });
    expect((big as { error: string }).error).toContain("100x");
  });

  it("requires an exit on the correct side of the price", () => {
    expect(validateCallOrder(BTC, { ...ok, tpPrice: undefined, slPrice: undefined })).toMatchObject(
      { ok: false, code: "no_exit" },
    );
    expect(validateCallOrder(BTC, { ...ok, tpPrice: "79000" })).toMatchObject({
      ok: false,
      code: "bad_exit",
    }); // long TP below mark
    expect(validateCallOrder(BTC, { ...ok, slPrice: "81000" })).toMatchObject({
      ok: false,
      code: "bad_exit",
    }); // long SL above mark
    expect(
      validateCallOrder(BTC, { ...ok, side: "short", tpPrice: "76000", slPrice: "82000" }),
    ).toMatchObject({ ok: true });
    expect(validateCallOrder(BTC, { ...ok, side: "short" })).toMatchObject({
      ok: false,
      code: "bad_exit",
    });
    expect(validateCallOrder(BTC, { ...ok, slPrice: undefined })).toMatchObject({
      ok: true,
      slPrice: undefined,
    });
  });

  it("refuses closed or reduce-only markets", () => {
    expect(validateCallOrder({ ...BTC, status: "break" }, ok)).toMatchObject({
      ok: false,
      code: "market_unavailable",
    });
    expect(validateCallOrder({ ...BTC, reduce_only: true }, ok)).toMatchObject({
      ok: false,
      code: "market_unavailable",
    });
  });
});

describe("aggregateFills", () => {
  it("is volume-weighted and exact", () => {
    expect(
      aggregateFills([
        { price: "100", size: "1" },
        { price: "110", size: "3" },
      ]),
    ).toEqual({ price: "107.5", size: "4" });
    expect(aggregateFills([{ price: "81805.1", size: "0.00130" }])).toEqual({
      price: "81805.1",
      size: "0.0013",
    });
    expect(
      aggregateFills([
        { price: "0.1", size: "3" },
        { price: "0.2", size: "3" },
      ])?.price,
    ).toBe("0.15");
    expect(aggregateFills([])).toBeNull();
  });
});

describe("followability", () => {
  const call = {
    status: "open" as const,
    side: "long" as const,
    entryPrice: "80000",
    expiresAt: 1_000_000,
    maxDriftBps: 50,
  };
  it("measures drift in bps in either direction", () => {
    expect(driftBps("80000", "80400")).toBe(50);
    expect(driftBps("80000", "79600")).toBe(50);
    expect(driftBps("80000", "80000")).toBe(0);
  });
  it("allows within window and drift", () => {
    expect(followability(call, 500_000, "80300")).toEqual({ ok: true, driftBps: 38 });
  });
  it("blocks past expiry, over-drift and non-open calls", () => {
    expect(followability(call, 1_000_000, "80000")).toEqual({ ok: false, reason: "expired" });
    expect(followability({ ...call, status: "expired" }, 1, "80000")).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(followability(call, 1, "80500")).toMatchObject({
      ok: false,
      reason: "drifted",
      driftBps: 63,
    });
    expect(followability(call, 1, "79500")).toMatchObject({ ok: false, reason: "drifted" });
    for (const status of ["pending", "closed", "failed"] as const) {
      expect(followability({ ...call, status }, 1, "80000")).toEqual({
        ok: false,
        reason: "not_open",
      });
    }
    expect(followability({ ...call, entryPrice: null }, 1, "80000")).toEqual({
      ok: false,
      reason: "not_open",
    });
  });
});

describe("sumSigned", () => {
  it("adds signed decimals exactly", () => {
    expect(sumSigned(["1.5", "-0.25", "0.1"])).toBe("1.35");
    expect(sumSigned(["-20"])).toBe("-20");
    expect(sumSigned(["0.04", "-0.04"])).toBe("0");
    expect(sumSigned([])).toBe("0");
  });
});

describe("sizeFromMargin", () => {
  it("divides exactly and floors onto the size grid", () => {
    expect(divFloor("100", "3", 4)).toBe("33.3333");
    expect(floorToGrid("0.00129999", "0.00001", "0.00001")).toBe("0.00129");
    expect(floorToGrid("0.000009", "0.00001", "0.00001")).toBeNull();
    // $50 margin x 10 / $80,000 = 0.00625 BTC
    expect(sizeFromMargin("50", 10, "80000", "0.00001", "0.00001")).toBe("0.00625");
    // never rounds up: $10 x 3 / $81,805.1 = 0.000366...
    expect(sizeFromMargin("10", 3, "81805.1", "0.00001", "0.00001")).toBe("0.00036");
    expect(sizeFromMargin("0.01", 1, "80000", "0.00001", "0.00001")).toBeNull();
  });
});
