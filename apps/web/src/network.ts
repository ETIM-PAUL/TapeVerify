/** Cardano network id the wallet must be on: 0 = preprod/testnet, 1 = mainnet. */
export const CARDANO_NETWORK_ID: 0 | 1 =
  (import.meta.env.VITE_STRIKE_NETWORK ?? "testnet") === "mainnet" ? 1 : 0;
