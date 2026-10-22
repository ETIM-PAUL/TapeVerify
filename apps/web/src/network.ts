/** The Ethereum network the wallet must be on: Sepolia for Strike's testnet, mainnet otherwise. */
export const EVM_CHAIN =
  (import.meta.env.VITE_STRIKE_NETWORK ?? "testnet") === "mainnet" ? "mainnet" : "sepolia";

/** Cardano network id the wallet must be on: 0 = preprod/testnet, 1 = mainnet. */
export const CARDANO_NETWORK_ID: 0 | 1 =
  (import.meta.env.VITE_STRIKE_NETWORK ?? "testnet") === "mainnet" ? 1 : 0;
