import { type FindingDraft, generationOf, type Severity } from "./types.js";

/** One Strike fill of an account Pit knows. `tradeId` is shared by both sides of the same match. */
export interface FillFacts {
  userId: string;
  accountId: string;
  tradeId: number;
  symbol: string;
  side: "buy" | "sell";
  role: "maker" | "taker";
  price: number;
  size: number;
  ts: number;
}

export interface SelfTradeContext {
  /** Each account's total traded volume (USD) over the analysis window. */
  accountVolume: Map<string, number>;
  /** Whole-market volume (USD) per symbol over the same window, to tell thin markets from collusion. */
  marketVolume: Map<string, number>;
}

export interface SelfTradeOptions {
  minPairTrades: number;
  /** Matched volume must be at least this share of BOTH accounts' volume for a pair to look coordinated. */
  minMutualShare: number;
  /** If the pair's matched volume is more than this share of the whole market, thin liquidity explains it. */
  maxMarketShare: number;
}

export const DEFAULT_SELFTRADE: SelfTradeOptions = {
  minPairTrades: 8,
  minMutualShare: 0.5,
  maxMarketShare: 0.25,
};

const notional = (f: FillFacts) => f.price * f.size;

/**
 * Self-trading and wash trading.
 *
 * 1. One account on both sides of the same match: never legitimate, always flagged.
 * 2. Two accounts matched against each other for most of both their volumes. This only counts when the
 *    market is deep enough that it can't be coincidence: on a thin market (the pair's matches are a large
 *    share of everything traded) two accounts meet each other simply because nobody else is there, which is
 *    why the market-share guard exists. Real testnet data shows exactly that, with a handful of bots
 *    making up most of the volume.
 */
export function detectSelfTrading(
  fills: FillFacts[],
  ctx: SelfTradeContext,
  opts: SelfTradeOptions = DEFAULT_SELFTRADE,
): FindingDraft[] {
  const out: FindingDraft[] = [];
  const byTrade = new Map<string, FillFacts[]>();
  for (const f of fills) {
    const k = `${f.symbol}:${f.tradeId}`;
    byTrade.set(k, [...(byTrade.get(k) ?? []), f]);
  }

  // 1. same account on both sides
  const selfByAccount = new Map<
    string,
    { user: string; trades: number; volume: number; sample: string[] }
  >();
  for (const [key, group] of byTrade) {
    const sides = new Map<string, Set<string>>();
    for (const f of group)
      sides.set(f.accountId, (sides.get(f.accountId) ?? new Set()).add(f.side));
    for (const [acct, s] of sides) {
      if (s.size < 2) continue;
      const user = group.find((f) => f.accountId === acct)?.userId as string;
      const mine = group.filter((f) => f.accountId === acct);
      const cur = selfByAccount.get(acct) ?? { user, trades: 0, volume: 0, sample: [] };
      cur.trades++;
      cur.volume += Math.min(
        ...[mine.filter((f) => f.side === "buy"), mine.filter((f) => f.side === "sell")].map((x) =>
          x.reduce((a, f) => a + notional(f), 0),
        ),
      );
      if (cur.sample.length < 10) cur.sample.push(key);
      selfByAccount.set(acct, cur);
    }
  }
  for (const [acct, s] of selfByAccount) {
    const total = ctx.accountVolume.get(acct) ?? 0;
    const share = total > 0 ? s.volume / total : 0;
    const severity: Severity = s.trades >= 5 || share >= 0.05 ? "high" : "medium";
    out.push({
      kind: "self_trade",
      subjectId: s.user,
      severity,
      summary: `Traded against itself ${s.trades} time${s.trades === 1 ? "" : "s"}: the same account was on both sides of a match.`,
      evidence: {
        accountId: acct,
        selfMatchedTrades: s.trades,
        selfMatchedVolume: s.volume,
        shareOfAccountVolume: share,
        sampleTrades: s.sample,
      },
      baseKey: `self_trade:${acct}`,
      generation: generationOf(s.trades),
    });
  }

  // 2. two accounts matched against each other
  interface Pair {
    a: string;
    b: string;
    userA: string;
    userB: string;
    trades: number;
    volume: number;
    makerA: number;
    bySymbol: Map<string, number>;
  }
  const pairs = new Map<string, Pair>();
  for (const group of byTrade.values()) {
    const accts = [...new Set(group.map((f) => f.accountId))];
    if (accts.length < 2) continue;
    for (let i = 0; i < accts.length; i++) {
      for (let j = i + 1; j < accts.length; j++) {
        const [a, b] = [accts[i] as string, accts[j] as string].sort();
        const key = `${a}|${b}`;
        const fa = group.find((f) => f.accountId === a) as FillFacts;
        const fb = group.find((f) => f.accountId === b) as FillFacts;
        if (fa.side === fb.side) continue; // not opposite sides of one match
        const p = pairs.get(key) ?? {
          a: a as string,
          b: b as string,
          userA: fa.userId,
          userB: fb.userId,
          trades: 0,
          volume: 0,
          makerA: 0,
          bySymbol: new Map(),
        };
        p.trades++;
        const v = Math.min(notional(fa), notional(fb));
        p.volume += v;
        if (fa.role === "maker") p.makerA++;
        p.bySymbol.set(fa.symbol, (p.bySymbol.get(fa.symbol) ?? 0) + v);
        pairs.set(key, p);
      }
    }
  }
  for (const p of pairs.values()) {
    if (p.trades < opts.minPairTrades) continue;
    const va = ctx.accountVolume.get(p.a) ?? 0;
    const vb = ctx.accountVolume.get(p.b) ?? 0;
    if (va <= 0 || vb <= 0) continue;
    const shareA = p.volume / va;
    const shareB = p.volume / vb;
    const mutual = Math.min(shareA, shareB);
    if (mutual < opts.minMutualShare) continue;
    // Thin-market guard: how much of the whole market's volume is this pair's matched volume?
    let marketVol = 0;
    for (const sym of p.bySymbol.keys()) marketVol += ctx.marketVolume.get(sym) ?? 0;
    // Unknown market volume can't clear anyone of thin liquidity, and can't convict them either: skip.
    if (marketVol <= 0) continue;
    const marketShare = p.volume / marketVol;
    if (marketShare > opts.maxMarketShare) continue; // inconclusive: thin liquidity explains it
    const makerShareA = p.makerA / p.trades;
    const severity: Severity =
      mutual >= 0.8 && Math.min(makerShareA, 1 - makerShareA) >= 0.2 ? "high" : "medium";
    for (const [subject, other, share] of [
      [p.userA, p.userB, shareA],
      [p.userB, p.userA, shareB],
    ] as const) {
      out.push({
        kind: "collusion_pair",
        subjectId: subject,
        severity,
        summary: `${Math.round(share * 100)}% of this account's volume was matched against one other account, in a market where that is not explained by thin liquidity.`,
        evidence: {
          pair: [p.a, p.b],
          counterpartyUserId: other,
          matchedTrades: p.trades,
          matchedVolume: p.volume,
          shareOfOwnVolume: share,
          shareOfCounterpartyVolume: subject === p.userA ? shareB : shareA,
          shareOfWholeMarket: marketShare,
          makerShareOfFirstAccount: makerShareA,
        },
        baseKey: `collusion_pair:${p.a}|${p.b}:${subject}`,
        generation: generationOf(p.trades),
      });
    }
  }
  return out;
}
