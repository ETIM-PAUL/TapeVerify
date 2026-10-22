import { createHash } from "node:crypto";
import { divFloor, format, mul, parse, rescale } from "./trading/decimal-math.js";

/** Canonical JSON: object keys sorted, so the same rules always hash the same however they were written. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/** Fingerprint of a strategy's rules (not its name or summary): equal hashes mean identical behaviour. */
export function specHash(spec: unknown): string {
  const { name: _n, summary: _s, ...rules } = (spec ?? {}) as Record<string, unknown>;
  return createHash("sha256").update(canonical(rules)).digest("hex");
}

/**
 * Fingerprint of only the signal rules (market, timeframe, direction, indicators, entries, exits), leaving out
 * sizing and risk limits. Two strategies with the same rules hash trade the same signals, so a clone that only
 * changes its own size or loss limit is still the listed strategy.
 */
export function rulesHash(spec: unknown): string {
  const {
    name: _n,
    summary: _s,
    sizing: _z,
    risk: _r,
    ...rules
  } = (spec ?? {}) as Record<string, unknown>;
  return createHash("sha256").update(canonical(rules)).digest("hex");
}

// ── Verified live record ──

export interface RecordTrade {
  id: string;
  seq: number;
  side: "long" | "short";
  marginUsd: number;
  entryPrice: number;
  entrySize: number;
  exitPrice: number;
  entryTs: number;
  exitTs: number;
  realizedPnl: number;
  fees: number;
  exitReason: string | null;
}

export interface LiveRecord {
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  netPnl: number;
  profitFactor: number | null;
  /** Average net result per trade as a percent of the margin used. */
  avgReturnOnMarginPct: number | null;
  /** Largest peak-to-trough fall of cumulative net PnL, in USD. */
  maxDrawdownUsd: number;
  volumeUsd: number;
  avgHoldMs: number | null;
  liquidations: number;
  firstTradeMs: number | null;
  lastTradeMs: number | null;
}

/** Summary of closed live trades. Every input is a Strike fill-derived number from the live trade tables. */
export function liveRecord(trades: RecordTrade[]): LiveRecord {
  const sorted = [...trades].sort((a, b) => a.exitTs - b.exitTs || a.seq - b.seq);
  const net = (t: RecordTrade) => t.realizedPnl - t.fees;
  let cum = 0;
  let peak = 0;
  let dd = 0;
  for (const t of sorted) {
    cum += net(t);
    peak = Math.max(peak, cum);
    dd = Math.max(dd, peak - cum);
  }
  const wins = sorted.filter((t) => net(t) > 0);
  const losses = sorted.filter((t) => net(t) < 0);
  const gw = wins.reduce((a, t) => a + net(t), 0);
  const gl = losses.reduce((a, t) => a - net(t), 0);
  return {
    trades: sorted.length,
    wins: wins.length,
    losses: losses.length,
    winRate: sorted.length ? wins.length / sorted.length : null,
    netPnl: sorted.reduce((a, t) => a + net(t), 0),
    profitFactor: gl > 0 ? gw / gl : null,
    avgReturnOnMarginPct: sorted.length
      ? (sorted.reduce((a, t) => a + (t.marginUsd > 0 ? net(t) / t.marginUsd : 0), 0) /
          sorted.length) *
        100
      : null,
    maxDrawdownUsd: dd,
    volumeUsd: sorted.reduce(
      (a, t) => a + t.entryPrice * t.entrySize + t.exitPrice * t.entrySize,
      0,
    ),
    avgHoldMs: sorted.length
      ? sorted.reduce((a, t) => a + (t.exitTs - t.entryTs), 0) / sorted.length
      : null,
    liquidations: sorted.filter((t) => t.exitReason === "liquidation").length,
    firstTradeMs: sorted[0]?.entryTs ?? null,
    lastTradeMs: sorted[sorted.length - 1]?.exitTs ?? null,
  };
}

// ── Creator revenue share (exact decimals) ──

const D = (s: string | number) => {
  const str = typeof s === "number" ? String(s) : s;
  if (!/^\d+(\.\d+)?$/.test(str)) throw new Error(`Invalid decimal: ${str}`);
  return str;
};

/** Strike's builder fee on one amount of notional: floor(notional x bps / 10000, 2 decimals). */
export function builderFeeOn(notional: string | number, bps: number): string {
  if (bps <= 0) return "0";
  return divFloor(mul(D(notional), String(bps)), "10000", 2);
}

/** A closed trade's total builder fee: the entry and the exit each charged separately, as Strike does. */
export function tradeBuilderFee(t: {
  entryNotional: string | number;
  exitNotional: string | number;
  bps: number;
}): string {
  const sum =
    rescale(parse(builderFeeOn(t.entryNotional, t.bps)), 2) +
    rescale(parse(builderFeeOn(t.exitNotional, t.bps)), 2);
  return format(sum, 2);
}

/** The creator's cut of that fee: floor(fee x shareBps / 10000, 4 decimals). */
export function creatorShare(builderFee: string, shareBps: number): string {
  if (shareBps <= 0) return "0";
  return divFloor(mul(D(builderFee), String(shareBps)), "10000", 4);
}

/** Exact decimal product, for notionals (price x size). */
export const notionalOf = (price: string | number, size: string | number): string =>
  mul(D(price), D(size));
