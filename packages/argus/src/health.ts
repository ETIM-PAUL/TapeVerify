export interface SlpVault {
  vaultId: string;
  name: string;
  status: string;
  equity: number;
  walletBalance: number;
  sharePrice: number;
  totalShares: number;
  depositors: number;
  allTimePnl: number;
  allTimeDeposits: number;
  allTimeWithdrawals: number;
}

export type HealthStatus = "ok" | "watch" | "alert" | "unknown";

export interface HealthReading {
  status: HealthStatus;
  reasons: string[];
}

export interface HealthThresholds {
  /** Share price falling this far (fraction) over the window moves the badge to watch / alert. */
  sharePriceDropWatch: number;
  sharePriceDropAlert: number;
  /** Equity falling this far (fraction) over the window, beyond withdrawals, is a watch / alert. */
  equityDropWatch: number;
  equityDropAlert: number;
  /** Equity under this share of the wallet balance means large unrealized losses. */
  equityToWalletWatch: number;
}

export const DEFAULT_HEALTH: HealthThresholds = {
  sharePriceDropWatch: 0.02,
  sharePriceDropAlert: 0.1,
  equityDropWatch: 0.15,
  equityDropAlert: 0.4,
  equityToWalletWatch: 0.9,
};

const rank = { ok: 0, watch: 1, alert: 2, unknown: -1 } as const;

/** Reads Strike's protocol vault (the SLP, which backstops liquidations) against its own recent past. */
export function assessSlp(
  now: SlpVault | null,
  past: SlpVault | null,
  t: HealthThresholds = DEFAULT_HEALTH,
): HealthReading {
  if (!now)
    return { status: "unknown", reasons: ["The protocol vault couldn't be read from Strike."] };
  let status: HealthStatus = "ok";
  const reasons: string[] = [];
  const raise = (s: HealthStatus, why: string) => {
    if (rank[s] > rank[status]) status = s;
    reasons.push(why);
  };
  if (now.status !== "active") raise("alert", `The protocol vault is ${now.status}.`);
  if (now.equity <= 0) raise("alert", "The protocol vault has no equity.");
  if (now.walletBalance > 0 && now.equity / now.walletBalance < t.equityToWalletWatch)
    raise(
      "watch",
      `Open positions are down ${((1 - now.equity / now.walletBalance) * 100).toFixed(1)}% against the vault's cash.`,
    );
  if (now.sharePrice < 1)
    raise("watch", `Share price is ${now.sharePrice.toFixed(4)}, under its starting value of 1.`);
  if (past && past.sharePrice > 0) {
    const drop = (past.sharePrice - now.sharePrice) / past.sharePrice;
    if (drop >= t.sharePriceDropAlert)
      raise("alert", `Share price fell ${(drop * 100).toFixed(1)}% over the window.`);
    else if (drop >= t.sharePriceDropWatch)
      raise("watch", `Share price fell ${(drop * 100).toFixed(1)}% over the window.`);
    // Equity that left through withdrawals isn't a loss: compare equity net of withdrawals since then.
    const withdrawn = Math.max(0, now.allTimeWithdrawals - past.allTimeWithdrawals);
    const deposited = Math.max(0, now.allTimeDeposits - past.allTimeDeposits);
    const expected = past.equity - withdrawn + deposited;
    if (expected > 0) {
      const lost = (expected - now.equity) / expected;
      if (lost >= t.equityDropAlert)
        raise(
          "alert",
          `Equity is ${(lost * 100).toFixed(1)}% below where deposits and withdrawals leave it.`,
        );
      else if (lost >= t.equityDropWatch)
        raise(
          "watch",
          `Equity is ${(lost * 100).toFixed(1)}% below where deposits and withdrawals leave it.`,
        );
    }
  }
  if (reasons.length === 0) reasons.push("The protocol vault is active and has held its value.");
  return { status, reasons };
}

export function parseSlp(raw: Record<string, unknown> | undefined): SlpVault | null {
  if (!raw) return null;
  const n = (k: string) => Number(raw[k] ?? 0);
  return {
    vaultId: String(raw.vault_id),
    name: String(raw.name ?? "SLP"),
    status: String(raw.status ?? "unknown"),
    equity: n("equity"),
    walletBalance: n("wallet_balance"),
    sharePrice: n("share_price"),
    totalShares: n("total_shares"),
    depositors: n("depositors"),
    allTimePnl: n("all_time_pnl"),
    allTimeDeposits: n("all_time_deposits"),
    allTimeWithdrawals: n("all_time_withdrawals"),
  };
}
