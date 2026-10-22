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
