import { describe, expect, it } from "vitest";
import { attachWitnessSet, isFullTx, itemEnd } from "./cardano-tx";

const hex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => Number.parseInt(x, 16));

// [ {0: [], 1: [], 2: 1}, {}, true, null ]
const BODY = "a3008001800201";
const TX = `84${BODY}a0f5f6`;
// {0: [[h'11'*32, h'22'*64]]}
const WITNESS = `a10081825820${"11".repeat(32)}5840${"22".repeat(64)}`;

describe("cardano tx witness attach", () => {
  it("replaces the empty witness set and leaves the body bytes untouched", () => {
    expect(attachWitnessSet(TX, WITNESS)).toBe(`84${BODY}${WITNESS}f5f6`);
  });

  it("passes a full transaction through", () => {
    expect(isFullTx(TX)).toBe(true);
    expect(isFullTx(WITNESS)).toBe(false);
    expect(attachWitnessSet(TX, TX)).toBe(TX);
  });

  it("keeps a body with an indefinite-length array intact", () => {
    const body = "a3009f01ff01800201"; // {0: [_ 1 break], 1: [], 2: 1}
    expect(attachWitnessSet(`84${body}a0f5f6`, WITNESS)).toBe(`84${body}${WITNESS}f5f6`);
    expect(itemEnd(hex("9f0102ff"), 0)).toBe(4);
  });

  it("refuses to merge when the original already has witnesses", () => {
    const withWit = `84${BODY}a10080f5f6`;
    expect(() => attachWitnessSet(withWit, WITNESS)).toThrow(/already has witnesses/);
  });

  it("rejects junk", () => {
    expect(() => attachWitnessSet("zz", WITNESS)).toThrow();
    expect(() => attachWitnessSet(TX, "00")).toThrow();
  });

  it("skips nested and long-form items correctly", () => {
    // [ "abc", {1: [2, 3]}, h'..' (25 bytes, 1-byte length) ]
    const item = `83636162 63a101820203 5819${"aa".repeat(25)}`.replace(/ /g, "");
    expect(itemEnd(hex(item), 0)).toBe(item.length / 2);
  });
});
