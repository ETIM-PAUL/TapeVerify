import { applyGuardrails, type Guardrails, NO_GUARDRAILS } from "./guardrails.js";

/** A call the caller has finished, as Strike's fills recorded it. */
export interface ReplayCall {
  code: string;
  symbol: string;
  side: "long" | "short";
  leverage: number;
  entryPrice: number;
  entryTs: number;
  exitPrice: number;
  exitTs: number;
  exitReason: string | null;
  slPrice: number | null;
}

export interface ReplayParams {
  /** Margin the follower would put into each call. */
  marginUsd: number;
  /** Fraction, e.g. 0.0005 for 5 bps. */
  takerRate: number;
  builderBps: number;
  /** Adverse price difference on entry: followers enter after the caller, at the market. */
  entrySlippageBps: number;
  /** Adverse difference on exits the caller made at the market. Take-profit exits are limit orders and get none. */
  exitSlippageBps: number;
  guardrails: Guardrails | null;
}

export interface ReplayRow {
  code: string;
  symbol: string;
  side: "long" | "short";
  leverage: number;
  entryTs: number;
  copied: boolean;
  skipReason: string | null;
  adjustments: string[];
  marginUsd: number;
  leverageUsed: number;
  netPnl: number;
  fees: number;
  /** What slippage cost: net at the caller's exact prices minus net at the follower's. */
  slippageCost: number;
  liquidated: boolean;
  /** The caller's own leveraged result on this call, in percent. */
  callerReturnPct: number;
  /** The follower's net result as a percent of the margin used. */
  yourReturnPct: number | null;
  equityAfter: number;
}

export interface ReplaySummary {
  considered: number;
  copied: number;
  skipped: number;
  netPnl: number;
  fees: number;
  slippageCost: number;
  marginDeployed: number;
  returnOnMarginPct: number | null;
  winRate: number | null;
  maxDrawdownUsd: number;
  worstCall: number | null;
  callerAvgReturnPct: number | null;
  yourAvgReturnPct: number | null;
  liquidations: number;
}

const DAY = 86_400_000;
const dirOf = (s: "long" | "short") => (s === "long" ? 1 : -1);

interface Leg {
  net: number;
  fees: number;
  liquidated: boolean;
}

/** One copy at the given entry and exit prices, after fees. Losses stop at the margin: Strike liquidates there. */
function oneLeg(
  c: ReplayCall,
  margin: number,
  leverage: number,
  entry: number,
  exit: number,
  feeRate: number,
): Leg {
  const qty = (margin * leverage) / entry;
  const gross = (exit - entry) * qty * dirOf(c.side);
  const fees = (entry + exit) * qty * feeRate;
  const raw = gross - fees;
  const liquidated = c.exitReason === "liquidation" || raw <= -margin;
  return { net: liquidated ? -margin : raw, fees, liquidated };
}

/**
 * What following a trader's finished calls would have made, in order. Entries are worse than the caller's by
 * the slippage followers really get, fees are Strike's, and any guardrails are applied exactly as they would
 * have been when following. Funding payments are not included.
 */
export function replayFollow(
  calls: ReplayCall[],
  p: ReplayParams,
): { rows: ReplayRow[]; summary: ReplaySummary; curve: Array<{ t: number; equity: number }> } {
  const g = p.guardrails ?? NO_GUARDRAILS;
  const feeRate = p.takerRate + p.builderBps / 10_000;
  const sorted = [...calls].sort((a, b) => a.entryTs - b.entryTs);
  const rows: ReplayRow[] = [];
  const copied: Array<{ exitTs: number; net: number }> = [];
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  const curve: Array<{ t: number; equity: number }> = [];

  for (const c of sorted) {
    const dir = dirOf(c.side);
    const callerReturnPct = ((c.exitPrice - c.entryPrice) / c.entryPrice) * 100 * dir * c.leverage;
    const base = {
      code: c.code,
      symbol: c.symbol,
      side: c.side,
      leverage: c.leverage,
      entryTs: c.entryTs,
      callerReturnPct,
    };
    const entry = c.entryPrice * (1 + (dir * p.entrySlippageBps) / 10_000);
    const exitSlip = c.exitReason === "tp" ? 0 : p.exitSlippageBps;
    const exit = c.exitPrice * (1 - (dir * exitSlip) / 10_000);

    const open = copied.filter((x) => x.exitTs > c.entryTs).length;
    const lossToday = copied
      .filter((x) => x.exitTs <= c.entryTs && x.exitTs > c.entryTs - DAY && x.net < 0)
      .reduce((a, x) => a - x.net, 0);
    const guard = applyGuardrails(
      p.marginUsd,
      { side: c.side, leverage: c.leverage, entryPrice: entry, slPrice: c.slPrice },
      g,
      {
        openCopies: open,
        lossTodayUsd: lossToday,
        driftBps: p.entrySlippageBps,
        callerFlagged: false,
      },
    );
    if (!guard.ok) {
      rows.push({
        ...base,
        copied: false,
        skipReason: guard.reason,
        adjustments: [],
        marginUsd: 0,
        leverageUsed: 0,
        netPnl: 0,
        fees: 0,
        slippageCost: 0,
        liquidated: false,
        yourReturnPct: null,
        equityAfter: equity,
      });
      continue;
    }
    const real = oneLeg(c, guard.marginUsd, guard.leverage, entry, exit, feeRate);
    const ideal = oneLeg(c, guard.marginUsd, guard.leverage, c.entryPrice, c.exitPrice, feeRate);
    copied.push({ exitTs: c.exitTs, net: real.net });
    equity += real.net;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
    curve.push({ t: c.exitTs, equity });
    rows.push({
      ...base,
      copied: true,
      skipReason: null,
      adjustments: guard.adjustments,
      marginUsd: guard.marginUsd,
      leverageUsed: guard.leverage,
      netPnl: real.net,
      fees: real.fees,
      slippageCost: ideal.net - real.net,
      liquidated: real.liquidated,
      yourReturnPct: (real.net / guard.marginUsd) * 100,
      equityAfter: equity,
    });
  }

  const done = rows.filter((r) => r.copied);
  const margin = done.reduce((a, r) => a + r.marginUsd, 0);
  const net = done.reduce((a, r) => a + r.netPnl, 0);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  return {
    rows,
    curve,
    summary: {
      considered: rows.length,
      copied: done.length,
      skipped: rows.length - done.length,
      netPnl: net,
      fees: done.reduce((a, r) => a + r.fees, 0),
      slippageCost: done.reduce((a, r) => a + r.slippageCost, 0),
      marginDeployed: margin,
      returnOnMarginPct: margin > 0 ? (net / margin) * 100 : null,
      winRate: done.length ? done.filter((r) => r.netPnl > 0).length / done.length : null,
      maxDrawdownUsd: maxDd,
      worstCall: done.length ? Math.min(...done.map((r) => r.netPnl)) : null,
      callerAvgReturnPct: avg(rows.map((r) => r.callerReturnPct)),
      yourAvgReturnPct: avg(done.map((r) => r.yourReturnPct as number)),
      liquidations: done.filter((r) => r.liquidated).length,
    },
  };
}
