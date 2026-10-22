import { CARDANO_NETWORK_ID } from "./network";
import type { ActiveWallet } from "./wallet-context";
import { type Chain, connectCardano, connectEvm, connectSolana } from "./wallets";

export function connectWallet(chain: Chain, id: string): Promise<ActiveWallet> {
  switch (chain) {
    case "solana":
      return connectSolana(id);
    case "ethereum":
      return connectEvm(id);
    case "cardano":
      return connectCardano(id, CARDANO_NETWORK_ID);
  }
}
