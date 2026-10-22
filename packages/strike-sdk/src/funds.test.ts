import { describe, expect, it } from "vitest";
import { toBaseUnits } from "./funds.js";

describe("toBaseUnits", () => {
  it("converts decimals exactly", () => {
    expect(toBaseUnits("10", 6)).toBe("10000000");
    expect(toBaseUnits("0.1", 9)).toBe("100000000");
    expect(toBaseUnits("1.234567", 6)).toBe("1234567");
    expect(toBaseUnits("0.000000000000000001", 18)).toBe("1");
  });
  it("rejects bad input", () => {
    expect(() => toBaseUnits("1.2345678", 6)).toThrow();
    expect(() => toBaseUnits("-1", 6)).toThrow();
    expect(() => toBaseUnits("abc", 6)).toThrow();
    expect(() => toBaseUnits("0", 6)).toThrow();
    expect(() => toBaseUnits("1e3", 6)).toThrow();
  });
});
