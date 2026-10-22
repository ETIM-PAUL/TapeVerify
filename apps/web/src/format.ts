export function usd(v: unknown): string {
  const n = Number(v);
  return Number.isFinite(n)
    ? n.toLocaleString("en-US", { style: "currency", currency: "USD" })
    : "—";
}

export const shortAddr = (a: string) => (a.length > 16 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a);

export function hexToText(hex: string): string {
  try {
    const bytes = Uint8Array.from(hex.match(/../g) ?? [], (h) => Number.parseInt(h, 16));
    return new TextDecoder().decode(bytes);
  } catch {
    return hex;
  }
}

export const TX_STATUS: Record<number, string> = {
  1: "pending",
  2: "completed",
  3: "pending settlement",
  4: "settled",
  5: "failed",
  6: "cancelled",
};
export const TX_TYPE: Record<number, string> = { 1: "Deposit", 2: "Withdrawal" };

export const pctText = (v: number | null | undefined, digits = 2) =>
  v === null || v === undefined ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`;

export function duration(ms: number | null): string {
  if (ms === null) return "—";
  const m = ms / 60_000;
  if (m < 60) return `${Math.round(m)}m`;
  const h = m / 60;
  return h < 48 ? `${h.toFixed(1)}h` : `${(h / 24).toFixed(1)}d`;
}
