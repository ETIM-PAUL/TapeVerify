const DAY = 86_400_000;

export interface LockFacts {
  premium: boolean;
  status: string;
  /** When a premium call becomes public; null keeps it for subscribers until it closes. */
  publicAtMs: number | null;
}

/**
 * Whether a call is hidden from people who aren't subscribed. A closed call is never hidden: its result is
 * part of the creator's verifiable record, and hiding it would let a creator bury losses.
 */
export function isLocked(c: LockFacts, now: number): boolean {
  return c.premium && c.status !== "closed" && (c.publicAtMs === null || c.publicAtMs > now);
}

/** A renewal starts when the current period ends, so paying early never wastes days. */
export function extendSubscription(
  currentEndsMs: number | null,
  now: number,
  periodDays: number,
): { startedMs: number; endsMs: number } {
  const startedMs = Math.max(now, currentEndsMs ?? 0);
  return { startedMs, endsMs: startedMs + periodDays * DAY };
}

/** "12.5" USDC at 6 decimals is 12500000, with no floating point. Throws on more precision than the token has. */
export function usdcToBaseUnits(price: string | number, decimals = 6): bigint {
  const s = typeof price === "number" ? price.toFixed(decimals) : price.trim();
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new Error("Not a decimal amount");
  const frac = m[2] ?? "";
  if (frac.length > decimals && /[1-9]/.test(frac.slice(decimals)))
    throw new Error("Too many decimal places");
  return (
    BigInt(m[1] as string) * 10n ** BigInt(decimals) +
    BigInt(frac.slice(0, decimals).padEnd(decimals, "0") || "0")
  );
}
