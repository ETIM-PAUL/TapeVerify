/** Wording for posts and notifications, and the bar for graduating to a vault. Pure, so every surface says the same thing. */

export interface PostCall {
  code: string;
  symbol: string;
  side: "long" | "short";
  leverage: number;
  entryPrice: string | null;
  tpPrice: string | null;
  slPrice: string | null;
  exitPrice: string | null;
  exitReason: string | null;
  trader: string;
}

const num = (s: string) =>
  Number(s).toLocaleString("en-US", { maximumFractionDigits: Number(s) < 1 ? 6 : 4 });

/** Leveraged move from entry to exit, in percent, signed for the call's direction. Null until it has closed. */
export function resultPct(
  c: Pick<PostCall, "side" | "leverage" | "entryPrice" | "exitPrice">,
): number | null {
  if (!c.entryPrice || !c.exitPrice) return null;
  const entry = Number(c.entryPrice);
  if (!(entry > 0)) return null;
  const dir = c.side === "long" ? 1 : -1;
  return ((Number(c.exitPrice) - entry) / entry) * 100 * dir * c.leverage;
}

const REASON: Record<string, string> = {
  tp: "take-profit",
  sl: "stop-loss",
  manual: "closed by the trader",
  liquidation: "liquidated",
  external: "closed on Strike",
};

/** One-paragraph summary used by Telegram and X. Claims only what Strike's fills show. */
export function callLines(event: "opened" | "closed", c: PostCall): string[] {
  const head = `${c.side === "long" ? "LONG" : "SHORT"} ${c.symbol} ${c.leverage}x by ${c.trader}`;
  if (event === "opened") {
    const lv = [`Entry ${c.entryPrice ? num(c.entryPrice) : "pending"} (from the fill)`];
    if (c.tpPrice) lv.push(`TP ${num(c.tpPrice)}`);
    if (c.slPrice) lv.push(`SL ${num(c.slPrice)}`);
    return [head, lv.join(" · ")];
  }
  const r = resultPct(c);
  const res = r === null ? "Closed" : `Closed ${r >= 0 ? "+" : ""}${r.toFixed(2)}%`;
  return [head, `${res}${c.exitReason ? ` (${REASON[c.exitReason] ?? c.exitReason})` : ""}`];
}

export const escapeTelegramHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function telegramText(event: "opened" | "closed", c: PostCall): string {
  const [head, detail] = callLines(event, c);
  return `<b>${escapeTelegramHtml(head as string)}</b>\n${escapeTelegramHtml(detail as string)}`;
}

/** A post that fits X's limit: links count as 23 characters whatever their length. */
export function xText(event: "opened" | "closed", c: PostCall, url: string, limit = 280): string {
  const [head, detail] = callLines(event, c);
  const tail = `\n${url}`;
  const budget = limit - 23 - 1;
  let body = `${head}\n${detail}`;
  if (body.length > budget) body = `${body.slice(0, budget - 1)}…`;
  return body + tail;
}

// ── Vault graduation ──

export interface VaultInputs {
  trades: number;
  activeDays: number;
  totalReturnPct: number | null;
  maxDrawdownPct: number | null;
  /** From the trust checks. */
  clean: boolean;
  reputation: number | null;
}

export interface VaultCriterion {
  key: string;
  label: string;
  have: string;
  need: string;
  met: boolean;
}

export const VAULT_THRESHOLDS = {
  trades: 30,
  activeDays: 14,
  maxDrawdownPct: 35,
  reputation: 60,
} as const;

/** Whether a trader has earned a pointer to Strike's vault creation. Every criterion comes from verified data. */
export function vaultEligibility(
  i: VaultInputs,
  t = VAULT_THRESHOLDS,
): { eligible: boolean; criteria: VaultCriterion[] } {
  const criteria: VaultCriterion[] = [
    {
      key: "trades",
      label: "Closed trades",
      have: String(i.trades),
      need: `at least ${t.trades}`,
      met: i.trades >= t.trades,
    },
    {
      key: "days",
      label: "Days with trades",
      have: String(i.activeDays),
      need: `at least ${t.activeDays}`,
      met: i.activeDays >= t.activeDays,
    },
    {
      key: "return",
      label: "Total return",
      have: i.totalReturnPct === null ? "n/a" : `${i.totalReturnPct.toFixed(1)}%`,
      need: "above 0%",
      met: i.totalReturnPct !== null && i.totalReturnPct > 0,
    },
    {
      key: "drawdown",
      label: "Max drawdown",
      have: i.maxDrawdownPct === null ? "n/a" : `${i.maxDrawdownPct.toFixed(1)}%`,
      need: `at most ${t.maxDrawdownPct}%`,
      met: i.maxDrawdownPct !== null && i.maxDrawdownPct <= t.maxDrawdownPct,
    },
    {
      key: "clean",
      label: "Clean record",
      have: i.clean ? "yes" : "no",
      need: "yes",
      met: i.clean,
    },
    {
      key: "reputation",
      label: "Reputation",
      have: i.reputation === null ? "n/a" : String(i.reputation),
      need: `at least ${t.reputation}`,
      met: i.reputation !== null && i.reputation >= t.reputation,
    },
  ];
  return { eligible: criteria.every((c) => c.met), criteria };
}
