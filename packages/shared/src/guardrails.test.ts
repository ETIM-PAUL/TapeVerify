import { describe, expect, it } from "vitest";
import {
  applyGuardrails,
  describeGuardrails,
  type GuardCall,
  type GuardState,
  lossPerMargin,
  NO_GUARDRAILS,
  RECOMMENDED_GUARDRAILS,
} from "./guardrails.js";
import { type ReplayCall, type ReplayParams, replayFollow } from "./replay.js";

const call: GuardCall = { side: "long", leverage: 20, entryPrice: 100, slPrice: 98 };
const calm: GuardState = { openCopies: 0, lossTodayUsd: 0, driftBps: 5, callerFlagged: false };

describe("guardrails", () => {
  it("changes nothing when there are none", () => {
    expect(applyGuardrails(50, call, NO_GUARDRAILS, calm)).toEqual({
      ok: true,
      marginUsd: 50,
      leverage: 20,
      adjustments: [],
    });
  });

  it("caps margin and leverage, and says what it did", () => {
    const r = applyGuardrails(
      250,
      call,
      { ...NO_GUARDRAILS, maxMarginUsd: 100, maxLeverage: 10 },
      calm,
    );
    expect(r).toMatchObject({ ok: true, marginUsd: 100, leverage: 10 });
    expect(r.ok && r.adjustments).toEqual([
      "Leverage lowered from 20x to 10x.",
      "Margin lowered from $250.00 to your $100.00 limit.",
    ]);
  });

  it("sizes margin so a stop-loss costs at most the loss limit", () => {
    // 2% to the stop at 10x is 20% of margin lost: a $20 limit allows $100 of margin.
    const r = applyGuardrails(
      500,
      { ...call, leverage: 10 },
      { ...NO_GUARDRAILS, maxLossUsd: 20 },
      calm,
    );
    expect(r).toMatchObject({ ok: true, marginUsd: 100 });
    expect(lossPerMargin({ ...call, leverage: 10 }, 10)).toBeCloseTo(0.2, 9);
  });

  it("treats a missing or useless stop-loss as risking all of the margin", () => {
    const g = { ...NO_GUARDRAILS, maxLossUsd: 25 };
    expect(applyGuardrails(500, { ...call, slPrice: null }, g, calm)).toMatchObject({
      ok: true,
      marginUsd: 25,
    });
    expect(applyGuardrails(500, { ...call, slPrice: 101 }, g, calm)).toMatchObject({
      ok: true,
      marginUsd: 25,
    }); // stop above a long's entry
    // a stop further away than liquidation can't lose more than the margin
    expect(lossPerMargin({ ...call, slPrice: 60 }, 20)).toBe(1);
  });

  it("handles shorts", () => {
    const short: GuardCall = { side: "short", leverage: 5, entryPrice: 100, slPrice: 104 };
    expect(lossPerMargin(short, 5)).toBeCloseTo(0.2, 9);
  });

  it("blocks instead of adjusting when the situation is wrong", () => {
    const g = {
      ...NO_GUARDRAILS,
      maxOpenCopies: 2,
      dailyLossLimitUsd: 50,
      maxDriftBps: 20,
      requireCleanCaller: true,
    };
    expect(applyGuardrails(50, call, g, { ...calm, callerFlagged: true })).toMatchObject({
      ok: false,
      code: "caller_flagged",
    });
    expect(applyGuardrails(50, call, g, { ...calm, openCopies: 2 })).toMatchObject({
      ok: false,
      code: "too_many_open",
    });
    expect(applyGuardrails(50, call, g, { ...calm, lossTodayUsd: 50 })).toMatchObject({
      ok: false,
      code: "daily_loss",
    });
    expect(applyGuardrails(50, call, g, { ...calm, driftBps: 21 })).toMatchObject({
      ok: false,
      code: "drift",
    });
    expect(
      applyGuardrails(50, call, g, { ...calm, openCopies: 1, lossTodayUsd: 49, driftBps: 20 }),
    ).toMatchObject({ ok: true });
  });

  it("refuses a copy that would shrink to nothing", () => {
    expect(
      applyGuardrails(50, { ...call, slPrice: null }, { ...NO_GUARDRAILS, maxLossUsd: 0.5 }, calm),
    ).toMatchObject({ ok: false, code: "too_small" });
  });

  it("describes what is set in plain words", () => {
    expect(describeGuardrails(NO_GUARDRAILS)).toEqual([]);
    expect(describeGuardrails(RECOMMENDED_GUARDRAILS)).toHaveLength(7);
    expect(describeGuardrails({ ...NO_GUARDRAILS, maxLeverage: 5 })).toEqual([
      "Leverage capped at 5x",
    ]);
  });
});

const H = 3_600_000;
const mk = (n: number, over: Partial<ReplayCall> = {}): ReplayCall => ({
  code: `c${n}`,
  symbol: "BTC-USD",
  side: "long",
  leverage: 10,
  entryPrice: 100,
  entryTs: n * 10 * H,
  exitPrice: 102,
  exitTs: n * 10 * H + H,
  exitReason: "manual",
  slPrice: 98,
  ...over,
});
const params = (over: Partial<ReplayParams> = {}): ReplayParams => ({
  marginUsd: 100,
  takerRate: 0.0005,
  builderBps: 10,
  entrySlippageBps: 0,
  exitSlippageBps: 0,
  guardrails: null,
  ...over,
});

describe("replaying a trader's calls as a follower", () => {
  it("matches hand arithmetic: gross move minus fees on both legs", () => {
    // $100 margin at 10x = $1,000 notional, 2% up = $20 gross. Fees: 0.15% of ($1,000 + $1,020) = $3.03.
    const { rows, summary } = replayFollow([mk(1)], params());
    expect(rows[0]?.netPnl).toBeCloseTo(20 - 3.03, 6);
    expect(rows[0]?.fees).toBeCloseTo(3.03, 6);
    expect(rows[0]?.callerReturnPct).toBeCloseTo(20, 9);
    expect(rows[0]?.yourReturnPct).toBeCloseTo(16.97, 6);
    expect(summary).toMatchObject({ copied: 1, skipped: 0, winRate: 1, liquidations: 0 });
  });

  it("charges for entering after the caller and for exiting at the market, but not for a take-profit", () => {
    const base = replayFollow([mk(1)], params()).summary.netPnl;
    const slipped = replayFollow([mk(1)], params({ entrySlippageBps: 20, exitSlippageBps: 10 }));
    expect(slipped.summary.netPnl).toBeLessThan(base);
    expect(slipped.rows[0]?.slippageCost).toBeCloseTo(base - slipped.summary.netPnl, 9);
    // a take-profit is a resting order: only the entry costs anything
    const tp = replayFollow(
      [mk(1, { exitReason: "tp" })],
      params({ entrySlippageBps: 20, exitSlippageBps: 50 }),
    );
    const tpEntryOnly = replayFollow(
      [mk(1, { exitReason: "tp" })],
      params({ entrySlippageBps: 20, exitSlippageBps: 0 }),
    );
    expect(tp.summary.netPnl).toBeCloseTo(tpEntryOnly.summary.netPnl, 9);
  });

  it("works for shorts and never loses more than the margin", () => {
    const short = replayFollow(
      [mk(1, { side: "short", entryPrice: 100, exitPrice: 98 })],
      params(),
    );
    expect(short.rows[0]?.netPnl).toBeGreaterThan(0);
    const wipe = replayFollow([mk(1, { exitPrice: 80, slPrice: null })], params()); // -20% at 10x: gone, and stops at the margin
    expect(wipe.rows[0]).toMatchObject({ netPnl: -100, liquidated: true });
    const liq = replayFollow([mk(1, { exitPrice: 95, exitReason: "liquidation" })], params());
    expect(liq.rows[0]).toMatchObject({ netPnl: -100, liquidated: true });
    expect(liq.summary.liquidations).toBe(1);
  });

  it("compounds into an equity curve and a drawdown", () => {
    const calls = [mk(1), mk(2, { exitPrice: 99 }), mk(3, { exitPrice: 99 }), mk(4)];
    const { summary, curve, rows } = replayFollow(calls, params());
    expect(curve).toHaveLength(4);
    expect(rows.at(-1)?.equityAfter).toBeCloseTo(summary.netPnl, 9);
    expect(summary.maxDrawdownUsd).toBeGreaterThan(0);
    expect(summary.winRate).toBe(0.5);
    expect(summary.worstCall).toBe(Math.min(...rows.map((r) => r.netPnl)));
  });

  it("applies guardrails the way a real follow would, and reports what it skipped and why", () => {
    const overlapping = [
      mk(1, { exitTs: 10 * H + 5 * H }),
      mk(1, { code: "c1b", entryTs: 10 * H + 1 * H, exitTs: 10 * H + 4 * H }),
    ];
    const r = replayFollow(
      overlapping,
      params({ guardrails: { ...NO_GUARDRAILS, maxOpenCopies: 1 } }),
    );
    expect(r.rows.map((x) => x.copied)).toEqual([true, false]);
    expect(r.rows[1]?.skipReason).toMatch(/already have 1 copied calls open/);
    expect(r.summary).toMatchObject({ copied: 1, skipped: 1, considered: 2 });

    const capped = replayFollow(
      [mk(1)],
      params({ guardrails: { ...NO_GUARDRAILS, maxLossUsd: 10 } }),
    );
    expect(capped.rows[0]?.marginUsd).toBe(50); // 2% stop at 10x risks 20% of margin: $10 allows $50
    expect(capped.rows[0]?.adjustments[0]).toMatch(/at most \$10.00/);
  });

  it("stops copying for the day after enough losses, then resumes the next day", () => {
    const loss = (n: number, entryTs: number) =>
      mk(n, { entryTs, exitTs: entryTs + H, exitPrice: 98 });
    const g = { ...NO_GUARDRAILS, dailyLossLimitUsd: 30 };
    const day = 24 * H;
    const { rows } = replayFollow(
      [loss(1, 0), loss(2, 3 * H), loss(3, 6 * H), loss(4, day + 8 * H)],
      params({ guardrails: g }),
    );
    expect(rows.map((r) => r.copied)).toEqual([true, true, false, true]);
    expect(rows[2]?.skipReason).toMatch(/lost \$/);
  });

  it("can show that guardrails would have helped, and that slippage and fees explain the gap to the caller", () => {
    const calls = [mk(1), mk(2, { exitPrice: 90, slPrice: 97, exitReason: "sl" }), mk(3)];
    const without = replayFollow(calls, params({ entrySlippageBps: 15, exitSlippageBps: 10 }));
    const withG = replayFollow(
      calls,
      params({
        entrySlippageBps: 15,
        exitSlippageBps: 10,
        guardrails: { ...NO_GUARDRAILS, maxLossUsd: 5 },
      }),
    );
    expect(withG.summary.worstCall as number).toBeGreaterThan(without.summary.worstCall as number);
    expect(without.summary.yourAvgReturnPct as number).toBeLessThan(
      without.summary.callerAvgReturnPct as number,
    );
  });

  it("handles no calls", () => {
    expect(replayFollow([], params()).summary).toMatchObject({
      considered: 0,
      copied: 0,
      netPnl: 0,
      returnOnMarginPct: null,
      winRate: null,
      worstCall: null,
    });
  });
});
