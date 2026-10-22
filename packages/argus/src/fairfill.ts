export type FillBasis = "l3" | "depth" | "mark" | "candle" | "maker" | "none";

export interface FillIn {
  side: "buy" | "sell";
  /** 'taker' fills cross the spread; 'maker' fills rest at the trader's own limit. */
  role: string;
  price: number;
  size: number;
}

export interface Level {
  price: number;
  size: number;
}

/** The opposite side of the book the fill hit, best price first. */
export type Side = Level[];

export interface FairFill {
  basis: FillBasis;
  /** Best price on the side hit (book bases) or the benchmark price (mark, candle). */
  refPrice: number | null;
  /** What this fill's slice of the book should have cost, when the book is known. */
  expectedPrice: number | null;
  /** Adverse slippage against refPrice in basis points (negative = better than the benchmark). */
  slippageBps: number | null;
  score: number | null;
  note: string | null;
}

/** Slippage at which the score reaches zero. Looser benchmarks get more room because they are less exact. */
export const ZERO_AT_BPS: Record<"l3" | "depth" | "mark" | "candle", number> = {
  l3: 50,
  depth: 50,
  mark: 100,
  candle: 150,
};

const bps = (adverse: number, ref: number) => (adverse / ref) * 10_000;
const adverse = (side: "buy" | "sell", price: number, ref: number) =>
  side === "buy" ? price - ref : ref - price;
const clampScore = (slip: number, zeroAt: number) =>
  Math.max(0, Math.min(100, Math.round(100 * (1 - Math.max(0, slip) / zeroAt))));

/** Volume-weighted price of the slice [from, from + size) of a book side, or null if the book is too thin. */
export function walkSlice(levels: Side, from: number, size: number): number | null {
  let skip = from;
  let need = size;
  let cost = 0;
  for (const l of levels) {
    let avail = l.size;
    if (skip > 0) {
      const s = Math.min(skip, avail);
      skip -= s;
      avail -= s;
    }
    if (avail <= 0) continue;
    const take = Math.min(avail, need);
    cost += take * l.price;
    need -= take;
    if (need <= 1e-12) return cost / size;
  }
  return null;
}

/**
 * A taker fill against the book as it stood just before the order started matching. `consumedBefore` is how
 * much of that book the same order had already taken in earlier fills, so every fill of a sweep is judged
 * against its own slice. The score measures fairness (actual vs what that slice cost), while the slippage
 * shown is against the touch, so a large order walking a thin book reads as slippage but is not marked unfair.
 */
export function scoreAgainstBook(
  fill: FillIn,
  side: Side,
  basis: "l3" | "depth",
  consumedBefore = 0,
): FairFill {
  const touch = side[0]?.price ?? null;
  if (touch === null || !(fill.price > 0))
    return {
      basis: "none",
      refPrice: null,
      expectedPrice: null,
      slippageBps: null,
      score: null,
      note: "Empty book",
    };
  const expected = walkSlice(side, consumedBefore, fill.size);
  const slip = bps(adverse(fill.side, fill.price, touch), touch);
  const fair = expected === null ? slip : bps(adverse(fill.side, fill.price, expected), expected);
  return {
    basis,
    refPrice: touch,
    expectedPrice: expected,
    slippageBps: slip,
    score: clampScore(fair, ZERO_AT_BPS[basis]),
    note:
      expected === null
        ? "Book too thin to price the whole fill; judged against the best price"
        : null,
  };
}

/** Against a single benchmark price (mark, or the minute's VWAP). Less exact, so labelled and given more room. */
export function scoreAgainstPrice(fill: FillIn, ref: number, basis: "mark" | "candle"): FairFill {
  if (!(ref > 0) || !(fill.price > 0))
    return {
      basis: "none",
      refPrice: null,
      expectedPrice: null,
      slippageBps: null,
      score: null,
      note: "No benchmark price",
    };
  const slip = bps(adverse(fill.side, fill.price, ref), ref);
  return {
    basis,
    refPrice: ref,
    expectedPrice: null,
    slippageBps: slip,
    score: clampScore(slip, ZERO_AT_BPS[basis]),
    note: null,
  };
}

/** A resting order fills at the price its owner chose, so there is no execution to grade. */
export const makerFill = (): FairFill => ({
  basis: "maker",
  refPrice: null,
  expectedPrice: null,
  slippageBps: null,
  score: 100,
  note: "Resting limit order: filled at the trader's own price",
});

export interface LegScore {
  score: number | null;
  slippageBps: number | null;
  notional: number;
  basis: FillBasis;
}

/** A trade's score is its scored fills weighted by notional. Null when none could be scored. */
export function tradeFairScore(legs: LegScore[]): {
  score: number | null;
  slippageBps: number | null;
  scored: number;
  of: number;
} {
  const ok = legs.filter((l) => l.score !== null && l.notional > 0);
  if (ok.length === 0) return { score: null, slippageBps: null, scored: 0, of: legs.length };
  const w = ok.reduce((a, l) => a + l.notional, 0);
  const score = ok.reduce((a, l) => a + (l.score as number) * l.notional, 0) / w;
  const withSlip = ok.filter((l) => l.slippageBps !== null);
  const sw = withSlip.reduce((a, l) => a + l.notional, 0);
  const slip =
    sw > 0 ? withSlip.reduce((a, l) => a + (l.slippageBps as number) * l.notional, 0) / sw : null;
  return { score: Math.round(score), slippageBps: slip, scored: ok.length, of: legs.length };
}
