/**
 * Copy guardrails: limits a follower sets once, enforced on every follow. The same function runs when a
 * follow is placed and when a replay asks "what if I had followed", so the two can never disagree.
 */

export interface Guardrails {
  /** Most margin to put into one copied call. */
  maxMarginUsd: number | null;
  /** Most you can lose on one copied call if its stop-loss is hit (a call with no stop-loss can lose all its margin). */
  maxLossUsd: number | null;
  /** Leverage is lowered to this if the call uses more. */
  maxLeverage: number | null;
  /** Skip a call whose price has moved this far from the caller's entry (stricter than the caller's own limit). */
  maxDriftBps: number | null;
  /** Copied calls open at the same time. */
  maxOpenCopies: number | null;
  /** Stop copying for the rest of the day once copied calls have lost this much in the last 24 hours. */
  dailyLossLimitUsd: number | null;
  /** Refuse callers with unresolved trust flags, with no way to override. */
  requireCleanCaller: boolean;
}

export const NO_GUARDRAILS: Guardrails = {
  maxMarginUsd: null,
  maxLossUsd: null,
  maxLeverage: null,
  maxDriftBps: null,
  maxOpenCopies: null,
  dailyLossLimitUsd: null,
  requireCleanCaller: false,
};

/** A cautious starting point a person can accept or edit. Never applied silently. */
export const RECOMMENDED_GUARDRAILS: Guardrails = {
  maxMarginUsd: 100,
  maxLossUsd: 20,
  maxLeverage: 10,
  maxDriftBps: 30,
  maxOpenCopies: 3,
  dailyLossLimitUsd: 50,
  requireCleanCaller: true,
};

export interface GuardCall {
  side: "long" | "short";
  leverage: number;
  /** The price the copy would enter at (the live mark). */
  entryPrice: number;
  slPrice: number | null;
}

export interface GuardState {
  openCopies: number;
  /** Losses realized by copied calls in the last 24 hours, as a positive number. */
  lossTodayUsd: number;
  /** How far the price has moved from the caller's entry, against the follower. */
  driftBps: number;
  callerFlagged: boolean;
}

export type GuardBlock = "caller_flagged" | "too_many_open" | "daily_loss" | "drift" | "too_small";

export type GuardResult =
  | { ok: true; marginUsd: number; leverage: number; adjustments: string[] }
  | { ok: false; code: GuardBlock; reason: string };

const usd = (n: number) => `$${n.toFixed(2)}`;
const MIN_MARGIN = 1;
const floorCents = (n: number) => Math.floor(n * 100 + 1e-9) / 100;

/** The most a call can lose per dollar of margin: its stop-loss distance times leverage, never more than all of it. */
export function lossPerMargin(call: GuardCall, leverage: number): number {
  if (call.slPrice === null || !(call.entryPrice > 0)) return 1;
  const move =
    call.side === "long" ? call.entryPrice - call.slPrice : call.slPrice - call.entryPrice;
  if (!(move > 0)) return 1; // a stop on the wrong side protects nothing: assume the worst
  return Math.min(1, (move / call.entryPrice) * leverage);
}

export function applyGuardrails(
  requestedMarginUsd: number,
  call: GuardCall,
  g: Guardrails,
  s: GuardState,
): GuardResult {
  if (g.requireCleanCaller && s.callerFlagged)
    return {
      ok: false,
      code: "caller_flagged",
      reason:
        "This caller has unresolved trust flags, and your guardrails don't allow copying them.",
    };
  if (g.maxOpenCopies !== null && s.openCopies >= g.maxOpenCopies)
    return {
      ok: false,
      code: "too_many_open",
      reason: `You already have ${s.openCopies} copied calls open (your limit is ${g.maxOpenCopies}).`,
    };
  if (g.dailyLossLimitUsd !== null && s.lossTodayUsd >= g.dailyLossLimitUsd)
    return {
      ok: false,
      code: "daily_loss",
      reason: `Copied calls have lost ${usd(s.lossTodayUsd)} in the last 24 hours (your limit is ${usd(g.dailyLossLimitUsd)}).`,
    };
  if (g.maxDriftBps !== null && s.driftBps > g.maxDriftBps)
    return {
      ok: false,
      code: "drift",
      reason: `The price has moved ${Math.round(s.driftBps)} bps from the caller's entry (your limit is ${g.maxDriftBps}).`,
    };

  const adjustments: string[] = [];
  let leverage = call.leverage;
  if (g.maxLeverage !== null && leverage > g.maxLeverage) {
    adjustments.push(`Leverage lowered from ${leverage}x to ${g.maxLeverage}x.`);
    leverage = g.maxLeverage;
  }
  let margin = requestedMarginUsd;
  if (g.maxMarginUsd !== null && margin > g.maxMarginUsd) {
    adjustments.push(`Margin lowered from ${usd(margin)} to your ${usd(g.maxMarginUsd)} limit.`);
    margin = g.maxMarginUsd;
  }
  if (g.maxLossUsd !== null) {
    const perMargin = lossPerMargin(call, leverage);
    const cap = floorCents(g.maxLossUsd / perMargin);
    if (margin > cap) {
      adjustments.push(
        call.slPrice === null
          ? `This call has no stop-loss, so margin is limited to your ${usd(g.maxLossUsd)} loss limit.`
          : `Margin lowered to ${usd(cap)} so hitting the stop-loss costs at most ${usd(g.maxLossUsd)}.`,
      );
      margin = cap;
    }
  }
  margin = floorCents(margin);
  if (margin < MIN_MARGIN)
    return {
      ok: false,
      code: "too_small",
      reason:
        "Your guardrails reduce this copy to almost nothing. Raise a limit or skip this call.",
    };
  return { ok: true, marginUsd: margin, leverage, adjustments };
}

/** Plain-language lines describing the settings, for confirmation screens. */
export function describeGuardrails(g: Guardrails): string[] {
  const out: string[] = [];
  if (g.maxMarginUsd !== null) out.push(`At most ${usd(g.maxMarginUsd)} of margin per call`);
  if (g.maxLossUsd !== null)
    out.push(`At most ${usd(g.maxLossUsd)} lost per call if the stop-loss is hit`);
  if (g.maxLeverage !== null) out.push(`Leverage capped at ${g.maxLeverage}x`);
  if (g.maxDriftBps !== null)
    out.push(`Skip calls whose price has moved over ${g.maxDriftBps} bps`);
  if (g.maxOpenCopies !== null) out.push(`At most ${g.maxOpenCopies} copied calls open at once`);
  if (g.dailyLossLimitUsd !== null)
    out.push(`Pause copying after ${usd(g.dailyLossLimitUsd)} of losses in a day`);
  if (g.requireCleanCaller) out.push("Never copy a caller with unresolved trust flags");
  return out;
}
