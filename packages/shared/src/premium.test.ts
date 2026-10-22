import { describe, expect, it } from "vitest";
import { extendSubscription, isLocked, usdcToBaseUnits } from "./premium.js";

describe("premium locks", () => {
  const now = 1_000_000;
  it("hides a premium call until it closes or its public time passes", () => {
    expect(isLocked({ premium: false, status: "open", publicAtMs: null }, now)).toBe(false);
    expect(isLocked({ premium: true, status: "open", publicAtMs: null }, now)).toBe(true);
    expect(isLocked({ premium: true, status: "pending", publicAtMs: null }, now)).toBe(true);
    expect(isLocked({ premium: true, status: "open", publicAtMs: now + 1 }, now)).toBe(true);
    expect(isLocked({ premium: true, status: "open", publicAtMs: now }, now)).toBe(false);
    expect(isLocked({ premium: true, status: "closed", publicAtMs: null }, now)).toBe(false);
  });
});

describe("renewals", () => {
  it("starts now for a new subscriber and at the old end for an early renewal", () => {
    const D = 86_400_000;
    expect(extendSubscription(null, 5 * D, 30)).toEqual({ startedMs: 5 * D, endsMs: 35 * D });
    expect(extendSubscription(3 * D, 5 * D, 30)).toEqual({ startedMs: 5 * D, endsMs: 35 * D }); // lapsed: starts now
    expect(extendSubscription(20 * D, 5 * D, 30)).toEqual({ startedMs: 20 * D, endsMs: 50 * D }); // still active: no days lost
  });
});

describe("USDC amounts", () => {
  it("is exact", () => {
    expect(usdcToBaseUnits("12.5")).toBe(12_500_000n);
    expect(usdcToBaseUnits("1")).toBe(1_000_000n);
    expect(usdcToBaseUnits("0.000001")).toBe(1n);
    expect(usdcToBaseUnits(9.99)).toBe(9_990_000n);
    expect(usdcToBaseUnits("1.1000000")).toBe(1_100_000n);
    expect(() => usdcToBaseUnits("1.0000001")).toThrow();
    expect(() => usdcToBaseUnits("abc")).toThrow();
    expect(() => usdcToBaseUnits("-1")).toThrow();
  });
});
