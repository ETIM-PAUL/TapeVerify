import type { StrikeClient } from "./client.js";

export type FundsChain = "ethereum" | "solana" | "cardano";

/** Assets Strike accepts for deposit per chain, with base-unit decimals. */
export const DEPOSIT_ASSETS: Record<FundsChain, Record<string, number>> = {
  ethereum: { ETH: 18, USDC: 6 },
  solana: { SOL: 9, USDC: 6 },
  cardano: { ADA: 6 },
};

/** Decimal string -> integer base-unit string. Rejects more precision than the asset has. */
export function toBaseUnits(amount: string, decimals: number): string {
  if (!/^\d+(\.\d+)?$/.test(amount)) throw new Error("Invalid amount");
  const [whole = "0", frac = ""] = amount.split(".");
  if (frac.length > decimals) throw new Error(`Too many decimal places (max ${decimals})`);
  const units = BigInt(whole + frac.padEnd(decimals, "0"));
  if (units <= 0n) throw new Error("Amount must be positive");
  return units.toString();
}

export interface DepositQuote {
  request_id: string;
  quote: {
    account_id: string;
    blockchain: string;
    asset_symbol: string;
    asset_amount: string;
    usd_value: string;
    exchange_rate: string;
    confirmations: number;
    timestamp: number;
    expiration_at: number;
  };
  signature: string;
  deposit_address: string;
  confirmations_required: number;
}

export interface EvmTxParams {
  from: string;
  to: string;
  data: string;
  value: string;
  gas: string;
}

export type BuildTxResponse =
  | {
      blockchain: "ethereum";
      format: "evm_tx_params";
      unsigned_tx: EvmTxParams;
      approval_tx?: EvmTxParams;
    }
  | { blockchain: "solana"; format: "solana_base64"; unsigned_tx: string; expires_at: number }
  | { blockchain: "cardano"; format: "cardano_cbor"; unsigned_tx: string; expires_at: number };

export const getDepositQuote = (
  c: StrikeClient,
  p: { blockchain: FundsChain; asset_symbol: string; asset_amount: string },
) => c.post<DepositQuote>("/v2/deposit/quote", p);

export const buildDepositTx = (
  c: StrikeClient,
  p: { request_id: string; user_address: string; utxos?: string[] },
) => c.post<BuildTxResponse>("/v2/deposit/build-tx", p);

export const confirmDeposit = (c: StrikeClient, p: { request_id: string; tx_hash: string }) =>
  c.post<{ request_id: string; status: "pending"; tx_hash: string; message: string }>(
    "/v2/deposit",
    p,
  );

export interface WithdrawQuote {
  withdraw_id: string;
  fee: string;
  /** Plain text for EVM/Solana. For Cardano it is already hex: pass to signData as-is. */
  message_to_sign: string;
  tx_cbor?: string;
  validator_address?: string;
  [k: string]: unknown;
}

export const getWithdrawQuote = (
  c: StrikeClient,
  p: {
    usd_value: string;
    blockchain: FundsChain;
    asset: string;
    wallet_address: string;
    recipient_address?: string;
  },
) => c.post<WithdrawQuote>("/v2/withdraw/quote", p);

export const confirmWithdraw = (
  c: StrikeClient,
  p: { withdraw_id: string; wallet_signature: string; signed_tx_cbor?: string },
) =>
  c.post<{ request_id: string; status: "pending"; sequence_id: number; message_id: string }>(
    "/v2/withdraw",
    p,
  );

/** Transaction types for `/v2/history/transaction`. */
export const TX_TYPE = {
  deposit: 1,
  withdraw: 2,
  fee: 3,
  realizedPnl: 4,
  liquidation: 5,
  funding: 6,
} as const;

export interface StrikeTransaction {
  id: string;
  type: number;
  amount: string;
  asset_symbol?: string;
  asset_amount?: string;
  blockchain?: string;
  tx_hash?: string;
  status: number;
  timestamp: number;
  [k: string]: unknown;
}

export async function getTransactions(
  c: StrikeClient,
  q: { types?: number[]; limit?: number } = {},
) {
  const p = new URLSearchParams();
  if (q.types?.length) p.set("type", q.types.join(","));
  p.set("limit", String(q.limit ?? 50));
  const r = await c.get<{ transactions: StrikeTransaction[] | null; count: number }>(
    `/v2/history/transaction?${p}`,
  );
  return r.transactions ?? [];
}
