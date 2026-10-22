export type AlertLevel = "warn" | "danger" | "critical";

export interface PositionFacts {
  side: "long" | "short";
  entryPrice: number;
  markPrice: number;
  liqPrice: number;
}

/** Share of the way from entry to liquidation the mark has travelled: 0 at entry, 1 at liquidation. Never negative. */
export function usedFraction(p: PositionFacts): number | null {
  const span = p.side === "long" ? p.entryPrice - p.liqPrice : p.liqPrice - p.entryPrice;
  if (!(span > 0) || !(p.entryPrice > 0) || !(p.liqPrice > 0)) return null;
  const moved = p.side === "long" ? p.entryPrice - p.markPrice : p.markPrice - p.entryPrice;
  return Math.max(0, moved / span);
}

/** Scale-free so it fits any leverage: a 2x and a 50x position both alert at the same share of their runway. */
export const LEVELS: Array<[AlertLevel, number]> = [
  ["critical", 0.92],
  ["danger", 0.8],
  ["warn", 0.6],
];

export const levelFor = (used: number): AlertLevel | null =>
  LEVELS.find(([, at]) => used >= at)?.[0] ?? null;

/** Hysteresis: an alert only clears once the position is well back from the level that raised it. */
export const CLEAR_BELOW = 0.5;
