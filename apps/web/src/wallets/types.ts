export type Chain = "cardano" | "ethereum" | "solana";

export interface WalletInfo {
  id: string;
  name: string;
  chain: Chain;
  icon?: string;
}

/** A connected browser wallet. Chain-specific signing lives behind these three methods. */
export interface ConnectedWallet {
  chain: Chain;
  walletId: string;
  address: string;
  /** Sign the plain-text challenge or withdraw message. `payloadIsHex` only matters for Cardano. */
  signMessage(message: string, payloadIsHex?: boolean): Promise<string>;
}

type Untyped = any;
export type EvmWallet = ConnectedWallet & { chain: "ethereum"; provider: Untyped };
export type SolanaWallet = ConnectedWallet & { chain: "solana"; provider: Untyped };
export type CardanoWallet = ConnectedWallet & { chain: "cardano"; api: Untyped };
