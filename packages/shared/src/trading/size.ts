import { divFloor, floorToGrid, mul } from "./decimal-math.js";

/**
 * Position size a follower gets for a chosen margin: margin x leverage / price, rounded DOWN onto the
 * market's size grid (so the order never needs more margin than the follower chose). Null if below the minimum.
 */
export function sizeFromMargin(
  marginUsd: string,
  leverage: number,
  mark: string,
  minSize: string,
  stepSize: string,
): string | null {
  const notional = mul(marginUsd, String(leverage));
  const raw = divFloor(notional, mark, 12);
  return floorToGrid(raw, minSize, stepSize);
}
