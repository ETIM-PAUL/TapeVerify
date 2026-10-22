import { describe, expect, it } from "vitest";
import { type CallFacts, detectFrontRunning } from "./frontrun.js";
import {
  activeFindings,
  cleanRecord,
  type FindingRecord,
  performanceScore,
  reputation,
} from "./reputation.js";
import { detectSelfTrading, type FillFacts } from "./selftrade.js";
import { detectSybilFollowers, type FollowerFacts } from "./sybil.js";
import { binomialTail, generationOf } from "./types.js";

const S = 1000;
const HOUR = 3_600_000;

describe("binomial tail", () => {
  it("matches known values", () => {
    expect(binomialTail(10, 0, 0.3)).toBe(1);
    expect(binomialTail(10, 11, 0.3)).toBe(0);
    expect(binomialTail(10, 10, 0.5)).toBeCloseTo(1 / 1024, 12);
    expect(binomialTail(4, 2, 0.5)).toBeCloseTo(11 / 16, 12);
    expect(binomialTail(100, 6, 0.033)).toBeGreaterThan(0.05);
    expect(binomialTail(20, 12, 0.033)).toBeLessThan(1e-9);
  });
  it("buckets generations by doubling", () => {
    expect([1, 2, 3, 4, 7, 8, 100].map(generationOf)).toEqual([0, 1, 1, 2, 2, 3, 6]);
  });
});

/** A closed call: caller in at 0, out after `durationMs`; followers enter `lagsBeforeExit` ms before the exit. */
function call(
  id: string,
  over: Partial<CallFacts> & { lags?: number[]; durationMs?: number } = {},
): CallFacts {
  const duration = over.durationMs ?? HOUR;
  const exitTs = (over.entryTs ?? 0) + duration;
  return {
    callId: id,
    callerId: "caller",
    side: "long",
    entryTs: over.entryTs ?? 0,
    entryPrice: 100,
    exitTs,
    exitPrice: over.exitPrice ?? 103,
    exitReason: over.exitReason ?? "manual",
    follows: (over.lags ?? []).map((lag, i) => ({
      followId: `${id}-f${i}`,
      followerId: `follower-${id}-${i}`,
      entryTs: exitTs - lag,
      entryPrice: 101,
    })),
    ...over,
  } as CallFacts;
}

describe("front-running", () => {
  it("leaves honest callers alone: one early exit, TP/SL exits, entries after the exit, unfilled follows", () => {
    expect(detectFrontRunning([call("a", { lags: [30 * S] })])).toEqual([]); // one follower isn't enough
    expect(detectFrontRunning([call("a", { lags: [10 * S, 20 * S], exitReason: "tp" })])).toEqual(
      [],
    ); // a target firing isn't a choice
    expect(detectFrontRunning([call("a", { lags: [10 * S, 20 * S], exitReason: "sl" })])).toEqual(
      [],
    );
    expect(detectFrontRunning([call("a", { lags: [10 * 60 * S, 20 * 60 * S] })])).toEqual([]); // followers long before the exit
    const late = call("a", { lags: [] });
    late.follows = [
      {
        followId: "x",
        followerId: "f1",
        entryTs: (late.exitTs as number) + 5 * S,
        entryPrice: 101,
      },
      { followId: "y", followerId: "f2", entryTs: null, entryPrice: null },
    ];
    expect(detectFrontRunning([late])).toEqual([]);
    expect(
      detectFrontRunning([
        { ...call("open", { lags: [5 * S, 5 * S] }), exitTs: null, exitPrice: null },
      ]),
    ).toEqual([]); // still open
  });

  it("flags a call where several followers entered just before a manual exit, without naming them publicly", () => {
    const [f, ...rest] = detectFrontRunning([call("c1", { lags: [30 * S, 70 * S] })]);
    expect(rest).toEqual([]);
    expect(f).toMatchObject({
      kind: "front_running",
      subjectId: "caller",
      severity: "medium",
      baseKey: "front_running:c1",
      generation: 0,
    });
    expect(f?.summary).toContain("2 followers");
    expect(f?.summary).not.toContain("follower-c1");
    expect((f?.evidence.followers as Array<{ lagMs: number }>).map((x) => x.lagMs)).toEqual([
      30 * S,
      70 * S,
    ]);
    expect(f?.evidence.callerGain).toBe(true);
  });

  it("is low severity when the caller did not exit into the followers' price or gain", () => {
    const [f] = detectFrontRunning([call("c1", { lags: [30 * S, 40 * S], exitPrice: 99 })]); // exited below follower entry (101) at a loss
    expect(f?.severity).toBe("low");
  });

  it("recognises a pattern across calls, escalating with repetition and speed", () => {
    const calls = (n: number, lag: number) =>
      Array.from({ length: n }, (_, i) =>
        call(`c${i}`, { entryTs: i * 10 * HOUR, lags: [lag, lag + 5 * S] }),
      );
    const three = detectFrontRunning(calls(3, 60 * S)).filter(
      (f) => f.kind === "front_running_pattern",
    );
    expect(three).toHaveLength(1);
    expect(three[0]).toMatchObject({ severity: "high", generation: 1 });
    expect(three[0]?.evidence.probabilityOfThisByChance as number).toBeLessThan(0.001);
    expect(three[0]?.evidence.flaggedCalls).toHaveLength(3);
    const fast = detectFrontRunning(calls(3, 10 * S)).find(
      (f) => f.kind === "front_running_pattern",
    );
    expect(fast?.severity).toBe("critical"); // median lag under 30s
    const many = detectFrontRunning(calls(6, 60 * S)).find(
      (f) => f.kind === "front_running_pattern",
    );
    expect(many?.severity).toBe("critical");
    expect(many?.generation).toBe(2);
  });

  it("doesn't call it a pattern when it is within what chance would produce", () => {
    // Three calls each flagged (2 close followers), but with 100 follower entries overall: 6 of 100 is ordinary for 1-hour calls.
    const calls = Array.from({ length: 3 }, (_, i) => {
      const c = call(`c${i}`, { entryTs: i * 10 * HOUR, lags: [30 * S, 50 * S] });
      for (let k = 0; k < 31; k++)
        c.follows.push({
          followId: `${c.callId}-x${k}`,
          followerId: `x-${c.callId}-${k}`,
          entryTs: (c.exitTs as number) - (10 + k) * 60 * S,
          entryPrice: 101,
        });
      return c;
    });
    const found = detectFrontRunning(calls);
    expect(found.filter((f) => f.kind === "front_running")).toHaveLength(3);
    expect(found.filter((f) => f.kind === "front_running_pattern")).toHaveLength(0);
  });

  it("treats each caller separately", () => {
    const a = call("a1", { lags: [20 * S, 30 * S] });
    const b = { ...call("b1", { lags: [] }), callerId: "other" } as CallFacts;
    const found = detectFrontRunning([a, b]);
    expect(found.map((f) => f.subjectId)).toEqual(["caller"]);
  });
});

const fill = (
  o: Partial<FillFacts> & Pick<FillFacts, "accountId" | "tradeId" | "side">,
): FillFacts => ({
  userId: `user-${o.accountId}`,
  symbol: "BTC-USD",
  role: "taker",
  price: 100,
  size: 10,
  ts: 0,
  ...o,
});

describe("self-trading", () => {
  const ctx = (
    vols: Record<string, number>,
    market: Record<string, number> = { "BTC-USD": 1e9 },
  ) => ({
    accountVolume: new Map(Object.entries(vols)),
    marketVolume: new Map(Object.entries(market)),
  });

  it("flags an account on both sides of one match, always", () => {
    const one = detectSelfTrading(
      [
        fill({ accountId: "A", tradeId: 1, side: "buy", role: "maker" }),
        fill({ accountId: "A", tradeId: 1, side: "sell" }),
      ],
      ctx({ A: 1e6 }),
    );
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({
      kind: "self_trade",
      subjectId: "user-A",
      severity: "medium",
      baseKey: "self_trade:A",
    });
    const six = detectSelfTrading(
      Array.from({ length: 6 }, (_, i) => [
        fill({ accountId: "A", tradeId: i, side: "buy", role: "maker" }),
        fill({ accountId: "A", tradeId: i, side: "sell" }),
      ]).flat(),
      ctx({ A: 1e6 }),
    );
    expect(six[0]?.severity).toBe("high");
    expect(six[0]?.evidence.selfMatchedTrades).toBe(6);
  });

  /** n matches between A and B at 1,000 notional each, alternating who is the maker. */
  const pair = (n: number, alternate = true) =>
    Array.from({ length: n }, (_, i) => [
      fill({
        accountId: "A",
        tradeId: i,
        side: "buy",
        role: !alternate || i % 2 === 0 ? "maker" : "taker",
      }),
      fill({
        accountId: "B",
        tradeId: i,
        side: "sell",
        role: !alternate || i % 2 === 0 ? "taker" : "maker",
      }),
    ]).flat();

  it("flags a pair that trades mostly with each other on a deep market, both accounts affected", () => {
    const found = detectSelfTrading(pair(10), ctx({ A: 10_000, B: 10_000 }));
    expect(found.map((f) => [f.kind, f.subjectId, f.severity])).toEqual([
      ["collusion_pair", "user-A", "high"],
      ["collusion_pair", "user-B", "high"],
    ]);
    expect(found[0]?.summary).not.toContain("user-B");
    expect(found[0]?.evidence).toMatchObject({
      matchedTrades: 10,
      matchedVolume: 10_000,
      shareOfOwnVolume: 1,
    });
    expect(found[0]?.evidence.shareOfWholeMarket as number).toBeLessThan(0.001);
  });

  it("downgrades a pair where one side is always the maker (looks like ordinary market making)", () => {
    expect(detectSelfTrading(pair(10, false), ctx({ A: 10_000, B: 10_000 }))[0]?.severity).toBe(
      "medium",
    );
  });

  it("stays silent on a thin market: two accounts meet because nobody else is there", () => {
    // matched 10,000 of a 12,000 market
    expect(
      detectSelfTrading(pair(10), ctx({ A: 10_000, B: 10_000 }, { "BTC-USD": 12_000 })),
    ).toEqual([]);
  });

  it("won't accuse anyone when the market's volume is unknown", () => {
    expect(detectSelfTrading(pair(10), ctx({ A: 10_000, B: 10_000 }, {}))).toEqual([]);
  });

  it("needs enough trades, and the concentration has to be mutual", () => {
    expect(detectSelfTrading(pair(5), ctx({ A: 5000, B: 5000 }))).toEqual([]); // too few
    expect(detectSelfTrading(pair(10), ctx({ A: 10_000, B: 100_000 }))).toEqual([]); // B trades mostly with others
  });

  it("ignores fills on the same side of a trade id and unrelated accounts", () => {
    const f = [
      fill({ accountId: "A", tradeId: 1, side: "buy" }),
      fill({ accountId: "B", tradeId: 1, side: "buy" }),
    ];
    expect(detectSelfTrading(f, ctx({ A: 1000, B: 1000 }))).toEqual([]);
    expect(
      detectSelfTrading(
        [
          fill({ accountId: "A", tradeId: 1, side: "buy" }),
          fill({ accountId: "C", tradeId: 2, side: "sell" }),
        ],
        ctx({ A: 1000, C: 1000 }),
      ),
    ).toEqual([]);
  });

  it("matches real testnet data: a hub bot against two accounts on a market they make up is not collusion", () => {
    // from the indexed accounts: 6,147 matches = 71% of one account's volume, but 78% of the whole market
    const fills = Array.from({ length: 12 }, (_, i) => [
      fill({ accountId: "HUB", tradeId: i, side: "buy", role: "taker" }),
      fill({ accountId: "B", tradeId: i, side: "sell", role: "maker" }),
    ]).flat();
    expect(
      detectSelfTrading(fills, ctx({ HUB: 20_000, B: 14_000 }, { "BTC-USD": 15_000 })),
    ).toEqual([]);
  });
});

const fol = (id: string, o: Partial<FollowerFacts> = {}): FollowerFacts => ({
  userId: id,
  createdTs: 1_000_000,
  ipHashes: [`ip-${id}`],
  deposits: [],
  callersFollowed: 3,
  fastFollowShare: 0,
  followMargins: [10 + id.length],
  ...o,
});

describe("sybil followers", () => {
  it("links accounts that share a network and look alike, and reports the cluster against the caller", () => {
    const bots = ["b1", "b2", "b3", "b4"].map((id) =>
      fol(id, { ipHashes: ["shared"], callersFollowed: 1, followMargins: [50] }),
    );
    const real = ["r1", "r2", "r3", "r4", "r5", "r6"].map((id, i) =>
      fol(id, { createdTs: i * 400 * HOUR }),
    );
    const [f, ...rest] = detectSybilFollowers([
      { callerId: "caller", followers: [...bots, ...real] },
    ]);
    expect(rest).toEqual([]);
    expect(f).toMatchObject({ kind: "sybil_cluster", subjectId: "caller", severity: "medium" });
    expect(f?.evidence).toMatchObject({ clusterSize: 4, followerCount: 10 });
    expect([...(f?.evidence.members as string[])].sort()).toEqual(["b1", "b2", "b3", "b4"]);
    expect(f?.summary).toContain("4 of 10 followers (40%)");
    expect(f?.summary).not.toContain("b1");
    expect(f?.evidence.signals).toEqual(
      expect.arrayContaining([
        "shared_network",
        "created_together",
        "follow_only_this_caller",
        "identical_sizes",
      ]),
    );
  });

  it("scales severity with cluster size and share", () => {
    const mk = (n: number, total: number) =>
      detectSybilFollowers([
        {
          callerId: "c",
          followers: [
            ...Array.from({ length: n }, (_, i) =>
              fol(`s${i}`, { ipHashes: ["x"], callersFollowed: 1, followMargins: [5] }),
            ),
            ...Array.from({ length: total - n }, (_, i) =>
              fol(`o${i}`, { createdTs: i * 500 * HOUR }),
            ),
          ],
        },
      ])[0]?.severity;
    expect(mk(3, 30)).toBe("medium");
    expect(mk(5, 30)).toBe("high");
    expect(mk(4, 5)).toBe("high"); // 80% of followers
    expect(mk(10, 12)).toBe("critical");
  });

  it("links accounts funded with matching deposits at the same time", () => {
    const f = ["d1", "d2", "d3"].map((id, i) =>
      fol(id, {
        deposits: [{ ts: 5_000_000 + i * 60_000, amount: 250 }],
        callersFollowed: 1,
        followMargins: [20],
      }),
    );
    const found = detectSybilFollowers([{ callerId: "c", followers: f }]);
    expect(found).toHaveLength(1);
    expect(found[0]?.evidence.signals).toContain("matching_deposits");
  });

  it("does not flag organic growth: new users following one viral caller with similar sizes, no strong links", () => {
    const viral = Array.from({ length: 12 }, (_, i) =>
      fol(`v${i}`, {
        createdTs: 1_000_000 + i * 60_000,
        callersFollowed: 1,
        fastFollowShare: 1,
        followMargins: [50],
      }),
    );
    expect(detectSybilFollowers([{ callerId: "c", followers: viral }])).toEqual([]);
  });

  it("needs three linked accounts", () => {
    const two = ["a", "b"].map((id) =>
      fol(id, { ipHashes: ["same"], callersFollowed: 1, followMargins: [9] }),
    );
    expect(
      detectSybilFollowers([{ callerId: "c", followers: [...two, fol("z", { createdTs: 9e12 })] }]),
    ).toEqual([]);
  });

  it("reports separate clusters separately", () => {
    const g = (p: string, ip: string) =>
      [0, 1, 2].map((i) =>
        fol(`${p}${i}`, { ipHashes: [ip], callersFollowed: 1, followMargins: [7] }),
      );
    const found = detectSybilFollowers([
      { callerId: "c", followers: [...g("x", "ip-x"), ...g("y", "ip-y")] },
    ]);
    expect(found).toHaveLength(2);
    expect(new Set(found.map((f) => f.baseKey)).size).toBe(2);
  });
});

const finding = (o: Partial<FindingRecord> & Pick<FindingRecord, "severity">): FindingRecord => ({
  id: o.id ?? Math.random().toString(36).slice(2),
  kind: "front_running",
  status: "open",
  summary: "s",
  baseKey: o.baseKey ?? Math.random().toString(36),
  generation: 0,
  detectedAt: 0,
  ...o,
});

describe("reputation", () => {
  const good = { trades: 40, totalReturnPct: 30, maxDrawdownPct: 5, consistency: 0.8 };

  it("stays neutral without history and earns its way with trades", () => {
    expect(
      performanceScore({ trades: 2, totalReturnPct: 99, maxDrawdownPct: 0, consistency: 3 }),
    ).toEqual({ score: 50, confidence: 0 });
    const some = performanceScore({ ...good, trades: 10 });
    const full = performanceScore({ ...good, trades: 60 });
    expect(some.score).toBeGreaterThan(50);
    expect(full.score).toBeGreaterThan(some.score);
    expect(full.confidence).toBe(1);
  });

  it("rewards returns and consistency and punishes drawdown, within bounds", () => {
    const base = performanceScore(good).score;
    expect(performanceScore({ ...good, totalReturnPct: -30 }).score).toBeLessThan(base);
    expect(performanceScore({ ...good, maxDrawdownPct: 60 }).score).toBeLessThan(base);
    expect(performanceScore({ ...good, consistency: -1 }).score).toBeLessThan(base);
    const best = performanceScore({
      trades: 99,
      totalReturnPct: 500,
      maxDrawdownPct: 0,
      consistency: 9,
    }).score;
    const worst = performanceScore({
      trades: 99,
      totalReturnPct: -99,
      maxDrawdownPct: 99,
      consistency: -9,
    }).score;
    expect(best).toBeLessThanOrEqual(95);
    expect(worst).toBeGreaterThanOrEqual(5);
  });

  it("subtracts every active finding, and only those", () => {
    const clean = reputation(good, []);
    expect(clean).toMatchObject({ penalty: 0, score: clean.performance });
    const r = reputation(good, [
      finding({ severity: "high" }),
      finding({ severity: "medium", status: "confirmed" }),
      finding({ severity: "critical", status: "dismissed" }),
      finding({ severity: "critical", status: "cleared" }),
      finding({ severity: "low", status: "appealed" }),
    ]);
    expect(r.penalty).toBe(25 + 10 + 3);
    expect(r.score).toBe(Math.round(r.performance - 38));
    expect(r.penalties.map((p) => p.severity).sort()).toEqual(["high", "low", "medium"]);
  });

  it("counts only the latest generation of one behaviour, and never goes below zero", () => {
    const old = finding({ severity: "medium", baseKey: "k", generation: 0, status: "confirmed" });
    const latest = finding({ severity: "high", baseKey: "k", generation: 2 });
    expect(activeFindings([old, latest]).map((f) => f.generation)).toEqual([2]);
    expect(reputation(good, [old, latest]).penalty).toBe(25);
    const dismissedLatest = finding({
      severity: "high",
      baseKey: "k",
      generation: 3,
      status: "dismissed",
    });
    expect(activeFindings([old, latest, dismissedLatest])).toEqual([]);
    const many = Array.from({ length: 6 }, (_, i) =>
      finding({ severity: "critical", baseKey: `k${i}` }),
    );
    expect(reputation(good, many)).toMatchObject({ score: 0, penalty: 100 });
  });
});

describe("clean record", () => {
  const now = 400 * 86_400_000;
  it("needs a real record and no unresolved flags", () => {
    expect(cleanRecord({ trades: 25, activeDays: 8, findings: [], now })).toEqual({
      clean: true,
      reasons: [],
    });
    expect(cleanRecord({ trades: 4, activeDays: 8, findings: [], now }).reasons[0]).toContain(
      "at least 10 closed trades",
    );
    expect(cleanRecord({ trades: 25, activeDays: 1, findings: [], now }).reasons[0]).toContain(
      "3 different days",
    );
  });

  it("is lost to any open flag, even a low one, and returns when the flag is cleared", () => {
    const low = finding({ severity: "low", detectedAt: now });
    expect(cleanRecord({ trades: 25, activeDays: 8, findings: [low], now })).toMatchObject({
      clean: false,
      reasons: ["Has flags that are still under review."],
    });
    expect(
      cleanRecord({ trades: 25, activeDays: 8, findings: [{ ...low, status: "appealed" }], now })
        .clean,
    ).toBe(false);
    expect(
      cleanRecord({ trades: 25, activeDays: 8, findings: [{ ...low, status: "dismissed" }], now })
        .clean,
    ).toBe(true);
    expect(
      cleanRecord({ trades: 25, activeDays: 8, findings: [{ ...low, status: "cleared" }], now })
        .clean,
    ).toBe(true);
  });

  it("a confirmed flag blocks the badge for six months", () => {
    const confirmed = finding({
      severity: "high",
      status: "confirmed",
      detectedAt: now - 10 * 86_400_000,
    });
    expect(
      cleanRecord({ trades: 25, activeDays: 8, findings: [confirmed], now }).reasons,
    ).toContain("Has a confirmed flag.");
    const gone = { ...confirmed, status: "cleared" as const, detectedAt: now - 10 * 86_400_000 };
    expect(cleanRecord({ trades: 25, activeDays: 8, findings: [gone], now }).clean).toBe(true);
  });
});
