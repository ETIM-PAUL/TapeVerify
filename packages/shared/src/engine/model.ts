/** Strike's trading rules as the simulator applies them (ported from the engine's published formulas). */

export interface MarginTier {
  maxNotional: number;
  maxLeverage: number;
  maintenanceMarginRate: number;
  maintenanceAmount: number;
}

export interface MarketModel {
  symbol: string;
  tiers: MarginTier[];
  /** Fee charged on the notional when a position is liquidated. */
  liquidationFeeRate: number;
  quotePrec: number;
  minNotional: number;
}

export interface FeeModel {
  /** Strike taker commission rate (tier 0 unless overridden). */
  takerRate: number;
  /** Pit's builder fee on every fill, in bps. */
  builderBps: number;
  /** Adverse price movement assumed on every market-type fill, in bps. */
  slippageBps: number;
}

/** Round half to even at `places` decimals (the engine's rounding for commissions). */
export function roundHalfEven(x: number, places: number): number {
  const f = 10 ** places;
  const y = x * f;
  const r = Math.round(y);
  const diff = Math.abs(y - Math.trunc(y));
  if (Math.abs(diff - 0.5) < 1e-9) {
    const floor = Math.floor(y);
    return (floor % 2 === 0 ? floor : floor + 1) / f;
  }
  return r / f;
}

/** First tier whose max notional covers `notional`; above the last tier the last one applies. */
export function tierFor(m: MarketModel, notional: number): MarginTier {
  for (const t of m.tiers) if (t.maxNotional >= notional) return t;
  return m.tiers[m.tiers.length - 1] as MarginTier;
}

/** commission = round(notional x rate, quote precision). */
export const commission = (notional: number, rate: number, quotePrec: number) =>
  roundHalfEven(notional * rate, quotePrec);

/** floor(notional x bps / 10000, 2 decimals): charged on every fill. */
export function builderFee(notional: number, bps: number): number {
  if (bps <= 0 || notional <= 0) return 0;
  return Math.floor(((notional * bps) / 10_000) * 100) / 100;
}

/**
 * Isolated liquidation price: LP = (EP - (isoBalance + MA) / size) / (1 - direction x MMR), with the
 * margin tier chosen by the position's notional. Zero when no liquidation price exists.
 */
export function liquidationPrice(
  m: MarketModel,
  side: "long" | "short",
  entry: number,
  size: number,
  isoBalance: number,
): number {
  const tier = tierFor(m, entry * size);
  const signed = side === "long" ? size : -size;
  const dir = side === "long" ? 1 : -1;
  const lp =
    (entry - (isoBalance + tier.maintenanceAmount) / signed) /
    (1 - dir * tier.maintenanceMarginRate);
  return Number.isFinite(lp) && lp > 0 ? lp : 0;
}
