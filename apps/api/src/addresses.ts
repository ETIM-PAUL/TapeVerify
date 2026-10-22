import { base58, bech32 } from "@scure/base";

export type Chain = "cardano" | "ethereum" | "solana";

/** Validates a wallet address for the chain and returns its canonical form. Throws on bad input. */
export function normalizeAddress(
  chain: Chain,
  address: string,
  network: "testnet" | "mainnet",
): string {
  switch (chain) {
    case "solana": {
      if (base58.decode(address).length !== 32) throw new Error("Invalid Solana address");
      return address;
    }
    case "ethereum": {
      if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("Invalid Ethereum address");
      return address.toLowerCase();
    }
    case "cardano": {
      const { prefix } = bech32.decodeUnsafe(address, 1023) ?? {};
      const want = network === "mainnet" ? "addr" : "addr_test";
      if (prefix !== want) throw new Error(`Cardano address must start with ${want}1`);
      return address;
    }
  }
}
