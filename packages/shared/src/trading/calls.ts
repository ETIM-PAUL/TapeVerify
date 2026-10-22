import { format, parse, rescale } from "./decimal-math.js";

export type CallStatus = "pending" | "open" | "expired" | "closed" | "failed";
export type ExitReason = "tp" | "sl" | "manual" | "liquidation" | "external";

export interface FollowableCall {
  status: CallStatus;
  side: "long" | "short";
  entryPrice: string | null;
  expiresAt: number;
  maxDriftBps: number;
}

export type Followability =
  | { ok: true; driftBps: number }
  | { ok: false; reason: "not_open" | "expired" | "drifted"; driftBps?: number };

/** Absolute move from the caller's entry, in basis points (rounded half up). Needs entry > 0. */
export function driftBps(entry: string, price: string): number {
  const e = parse(entry);
  const p = parse(price);
  const s = Math.max(e.scale, p.scale);
  const en = rescale(e, s);
  const pn = rescale(p, s);
  const diff = en > pn ? en - pn : pn - en;
  return Number((diff * 10_000n * 2n + en) / (en * 2n));
}

/**
 * Whether a follower may still copy a call right now: it has to be open, inside its expiry window,
 * and the market must not have moved more than `maxDriftBps` from the caller's real entry in either
 * direction (chasing a run-up and entering into a thesis that is already failing are both blocked).
 */
export function followability(call: FollowableCall, now: number, markPrice: string): Followability {
  if (call.status === "expired" || (call.status === "open" && now >= call.expiresAt)) {
    return { ok: false, reason: "expired" };
  }
  if (call.status !== "open" || !call.entryPrice) return { ok: false, reason: "not_open" };
  const d = driftBps(call.entryPrice, markPrice);
  if (d > call.maxDriftBps) return { ok: false, reason: "drifted", driftBps: d };
  return { ok: true, driftBps: d };
}

export interface FillLike {
  price: string;
  size: string;
}

/** Volume-weighted average price and total size of fills, computed exactly. */
export function aggregateFills(fills: FillLike[]): { price: string; size: string } | null {
  if (fills.length === 0) return null;
  let notional = 0n;
  let size = 0n;
  const scale = Math.max(...fills.flatMap((f) => [parse(f.price).scale, parse(f.size).scale]));
  const pre = 18; // extra precision for the division
  for (const f of fills) {
    notional += rescale(parse(f.price), scale) * rescale(parse(f.size), scale);
    size += rescale(parse(f.size), scale);
  }
  if (size === 0n) return null;
  const avg = (notional * 10n ** BigInt(pre)) / size; // scaled by 10^(scale + pre)
  return { price: trim(format(avg, scale + pre), 12), size: format(size, scale) };
}

function trim(dec: string, places: number): string {
  const [w = "0", f = ""] = dec.split(".");
  const t = f.slice(0, places).replace(/0+$/, "");
  return t ? `${w}.${t}` : w;
}

/** Exact sum of signed decimal strings (PnL and fees can be negative, e.g. maker rebates). */
export function sumSigned(values: string[]): string {
  const parts = values.map((v) => {
    const neg = v.startsWith("-");
    return { neg, p: parse(neg ? v.slice(1) : v) };
  });
  const scale = Math.max(0, ...parts.map((x) => x.p.scale));
  let total = 0n;
  for (const { neg, p } of parts) total += (neg ? -1n : 1n) * rescale(p, scale);
  const out = format(total < 0n ? -total : total, scale);
  return total < 0n ? `-${out}` : out;
}
